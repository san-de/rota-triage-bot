#!/usr/bin/env node
// Deterministic, read-only log lookup through Kibana's internal search endpoint.
// Use when the App-Debugging agent returns 0 for a firing alert (it only sees exceptions
// with error.type set and only the message field for keyword matches).
//
// Usage:
//   node kibana-search.js --service new-margin --error-id 2b06a360 [--from ISO --to ISO | --days 10] [--size 3]
//   node kibana-search.js --service new-margin --from 2026-09-07T00:58:21Z --to 2026-09-07T01:28:21Z --levels ERROR,WARN --size 40
//   node kibana-search.js --service new-margin --trace-id 3cfc330cb7e95847
//   node kibana-search.js --service new-margin --text "NullPointerException" --days 10
//   node kibana-search.js --key-check [--env prod]        # where would the key come from? prints source env|file|none, exit 0/2
// Key: ELASTIC_API_KEY_<ENV> from the environment, else the kibana plugin's keys file (ELASTIC_API_KEY_FILE or
// ~/.config/auto1-kibana/keys.json) — never printed. Optional KIBANA_URL (default prod).
// Index: default "*logs-auto1.services*" (the services' data stream); pass --index "*beat-*" or "*" to widen. Output carries
// partial:true + warning when ES timed out or shards failed — treat total 0 with partial:true as "unknown", not "none".
// Output: JSON summary { total, distinctTraces, perDay, services, hits:[{ts, level, logger, traceId, errorId, message, exception, appFrames, causes, threadHints, index}] }.
"use strict";
const https = require("https");
const { resolveElasticKey, kibanaBaseUrl, describe } = require("./lib/elastic-key.js");

const args = process.argv.slice(2);
const opt = { days: 10, size: 3, index: "*logs-auto1.services*", levels: null, keyCheck: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === "--service") opt.service = v, i++;
  else if (a === "--error-id") opt.errorId = v, i++;
  else if (a === "--trace-id") opt.traceId = v, i++;
  else if (a === "--text") opt.text = v, i++;
  else if (a === "--from") opt.from = v, i++;
  else if (a === "--to") opt.to = v, i++;
  else if (a === "--days") opt.days = Number(v), i++;
  else if (a === "--size") opt.size = Number(v), i++;
  else if (a === "--index") opt.index = v, i++;
  else if (a === "--levels") opt.levels = v.split(","), i++;
  else if (a === "--env") opt.env = v, i++;
  else if (a === "--key-check") opt.keyCheck = true;
}
const env = (opt.env || "prod").toLowerCase();
const resolved = resolveElasticKey(env);
if (opt.keyCheck) {
  console.log(JSON.stringify(describe(resolved)));
  process.exit(resolved.key ? 0 : 2);
}
if (!resolved.key) { console.error(`kibana-search: ${resolved.reason}`); process.exit(2); }
if (!opt.service && !opt.errorId && !opt.traceId && !opt.text) { console.error("kibana-search: give at least one of --service --error-id --trace-id --text"); process.exit(2); }
const base = kibanaBaseUrl(env);

const filter = [];
if (opt.service) filter.push({ match: { "service.name": opt.service } });
if (opt.errorId) filter.push({ match: { "error.id": opt.errorId } });
if (opt.traceId) filter.push({ match: { "trace.id": opt.traceId } });
if (opt.levels) filter.push({ terms: { "log.level": opt.levels } });
if (opt.text) filter.push({ query_string: { query: `"${opt.text.replace(/"/g, '\\"')}"`, fields: ["message", "error.stack_trace", "error.type"] } });
filter.push({ range: { "@timestamp": opt.from || opt.to ? { gte: opt.from || `now-${opt.days}d`, lte: opt.to || "now" } : { gte: `now-${opt.days}d` } } });

const body = {
  params: {
    index: opt.index, ignore_unavailable: true,
    body: {
      size: opt.size, query: { bool: { filter } },
      _source: ["@timestamp", "log.level", "log.logger", "message", "error.id", "error.type", "error.stack_trace", "trace.id", "service.name", "url.path", "http.request.method"],
      sort: [{ "@timestamp": "desc" }],
      aggs: {
        per_day: { date_histogram: { field: "@timestamp", calendar_interval: "day", min_doc_count: 1 } },
        services: { terms: { field: "service.name", size: 10 } },
        traces: { cardinality: { field: "trace.id" } }
      }
    }
  }
};

const u = new URL("/internal/search/es", base);
const req = https.request(u, {
  method: "POST", timeout: 60000,
  headers: { "Authorization": `ApiKey ${resolved.key}`, "kbn-xsrf": "true", "x-elastic-internal-origin": "Kibana", "elastic-api-version": "1", "Content-Type": "application/json" }
}, res => {
  let data = ""; res.on("data", c => data += c);
  res.on("end", () => {
    if (res.statusCode !== 200) { console.error(`kibana-search: HTTP ${res.statusCode} ${data.slice(0, 300)}`); process.exit(1); }
    const r = JSON.parse(data).rawResponse || {};
    const aggs = r.aggregations || {};
    const appFrame = /\b(wkda|com\.auto1)\./;
    // A wide index pattern over many days can time out or fail shards and ES still answers 200 with hits.total 0.
    // Surface that so a "0" is never mistaken for "no logs" (seen 2026-09-17: 14-day error.id scan over "*" → 0, 3-day → 4).
    const shards = r._shards || {};
    const partial = Boolean(r.timed_out) || (shards.failed || 0) > 0;
    const out = {
      partial,
      warning: partial ? `partial result (timed_out=${!!r.timed_out}, failed shards=${shards.failed || 0}/${shards.total || "?"}) — retry with --index "*logs-auto1.services*" or fewer --days` : undefined,
      shardFailure: partial && Array.isArray(shards.failures) && shards.failures[0] ? String((shards.failures[0].reason || {}).reason || shards.failures[0].reason || "").slice(0, 200) : undefined,
      total: (r.hits && r.hits.total && (r.hits.total.value !== undefined ? r.hits.total.value : r.hits.total)) || 0,
      distinctTraces: aggs.traces && aggs.traces.value,
      perDay: ((aggs.per_day || {}).buckets || []).map(b => [b.key_as_string.slice(0, 10), b.doc_count]),
      services: ((aggs.services || {}).buckets || []).map(b => [b.key, b.doc_count]),
      hits: ((r.hits || {}).hits || []).map(h => {
        const s = h._source || {}; const st = String(((s.error || {}).stack_trace) || ""); const lines = st.split("\n");
        return {
          ts: s["@timestamp"], level: (s.log || {}).level, logger: (s.log || {}).logger, service: (s.service || {}).name,
          traceId: (s.trace || {}).id, errorId: (s.error || {}).id, errorType: (s.error || {}).type,
          path: (s.url || {}).path, message: String(s.message || "").slice(0, 300),
          exception: lines[0] ? lines[0].slice(0, 300) : null,
          appFrames: lines.filter(l => appFrame.test(l)).slice(0, 6).map(l => l.trim()),
          causes: lines.filter(l => /^\s*(Caused by|Wrapped by)/.test(l)).slice(0, 5).map(l => l.trim().slice(0, 200)),
          threadHints: lines.filter(l => /(ThreadPoolExecutor|ForkJoin|SqsListener|Scheduled|ContextPropagator|FutureTask|TaskExecutor)/.test(l)).slice(0, 3).map(l => l.trim().slice(0, 120)),
          index: h._index
        };
      })
    };
    console.log(JSON.stringify(out, null, 2));
  });
});
req.on("timeout", () => { console.error("kibana-search: timeout"); req.destroy(); process.exit(1); });
req.on("error", e => { console.error("kibana-search: " + e.message); process.exit(1); });
req.end(JSON.stringify(body));
