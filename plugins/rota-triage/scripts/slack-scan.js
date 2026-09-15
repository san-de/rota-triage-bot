#!/usr/bin/env node
// Decide deterministically which Slack hits are real, new, actionable tags. The model fetches Slack data with its
// MCP tools and passes the raw material in; this script applies the monitor's rules and the ledger.
//
//   node slack-scan.js --monitor remex --file hits.json
//   cat hits.json | node slack-scan.js --monitor remex
//
// Input JSON:
// { "hits": [ { "ts": "1789182002.083939", "threadTs": "1789182000.148269", "channelId": "C0K4U8ZS7", "text": "<raw text>",
//               "user": "UKT3PK4NM", "permalink": "https://…" } ],
//   "threads": { "<threadTs>": [ { "ts": "…", "text": "<raw text>", "user": "…" }, … ] } }
// Output JSON: { candidates: [ {ts, threadTs, channelId, permalink, tokens, alertCode, kibanaLinks, tagger} ], skipped: [ {ts, reason} ] }
// Rules, in order: token present (in the hit or in its own thread message) → not only an ignored subteam →
// not already handled/replied → not stale → alert-like (SRE code or Kibana link in the thread) → not an excluded alert code.
"use strict";
const fs = require("fs");
const { resolve, pickMonitor } = require("./monitor.js");

const args = process.argv.slice(2);
let monitor = null, file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--monitor") monitor = args[++i];
  else if (args[i] === "--file") file = args[++i];
}
let cfg;
try { cfg = resolve(pickMonitor(monitor)); } catch (e) { console.error("slack-scan: " + e.message); process.exit(2); }
const input = JSON.parse(file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
const ledger = fs.existsSync(cfg.ledgerPath) ? JSON.parse(fs.readFileSync(cfg.ledgerPath, "utf8")) : { processed: {}, repliedThreads: {} };

const tokens = cfg.derived.matchTokens;
const ignored = (cfg.slack.ignoreSubteamIds || []).map(id => `<!subteam^${id}`);
const sig = (cfg.output || {}).signature || "";
const skip = cfg.skip || {};
const staleH = skip.olderThanHours || 48;
const maxPerRun = (cfg.poll || {}).maxPerRun || 5;
const nowSec = Date.now() / 1000;
const HANDLED = new Set(["posted", "team-only", "dm", "draft", "skipped"]);
const KIBANA = /https?:\/\/kibana\.[a-z0-9.-]+\/app\/(discover|r\b|r\/s\/|kibana#\/discover)/;
const SRE = /\[(SRE\d{4})\]/;

function unescape(t) { return String(t || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }

const candidates = [], skipped = [];
const seenThreads = new Set();
const hits = [...(input.hits || [])].sort((a, b) => Number(a.ts) - Number(b.ts));
for (const h of hits) {
  const threadTs = h.threadTs || h.ts;
  const thread = (input.threads || {})[threadTs] || [];
  const own = thread.find(m => m.ts === h.ts);
  const text = unescape(h.text || (own && own.text) || "");
  const found = tokens.filter(t => text.includes(t));
  if (!found.length) { skipped.push({ ts: h.ts, reason: "no match token in the message" }); continue; }
  const onlyIgnored = found.every(t => ignored.some(ig => t.startsWith(ig))) && !tokens.some(t => text.includes(t) && !ignored.some(ig => t.startsWith(ig)));
  if (ignored.length && onlyIgnored) { skipped.push({ ts: h.ts, reason: "only an ignored user group is tagged" }); continue; }
  const prev = ledger.processed[h.ts];
  if (prev && HANDLED.has(prev.status)) { skipped.push({ ts: h.ts, reason: `already handled (${prev.status})` }); continue; }
  if (ledger.repliedThreads[threadTs]) { skipped.push({ ts: h.ts, reason: "thread already replied (ledger)" }); continue; }
  if (sig && thread.some(m => unescape(m.text).startsWith(sig.slice(0, 40)))) { skipped.push({ ts: h.ts, reason: "thread already replied (signature found)" }); continue; }
  if (seenThreads.has(threadTs)) { skipped.push({ ts: h.ts, reason: "same thread already a candidate in this run" }); continue; }
  if (nowSec - Number(h.ts) > staleH * 3600) { skipped.push({ ts: h.ts, reason: `stale (> ${staleH} h)` }); continue; }
  const allText = [text, ...thread.map(m => unescape(m.text))].join("\n");
  const codeM = allText.match(SRE);
  const kibanaLinks = [...new Set((allText.match(/https?:\/\/kibana\.[^\s|>]+/g) || []))];
  if (skip.nonAlertMentions !== false && !codeM && !KIBANA.test(allText)) { skipped.push({ ts: h.ts, reason: "non-alert mention (no SRE code, no Kibana link)" }); continue; }
  if (codeM && (skip.alertCodes || []).includes(codeM[1])) { skipped.push({ ts: h.ts, reason: `alert code ${codeM[1]} excluded by config` }); continue; }
  seenThreads.add(threadTs);
  candidates.push({ ts: h.ts, threadTs, channelId: h.channelId, permalink: h.permalink || null, tokens: found, alertCode: codeM ? codeM[1] : null,
    kibanaLinks, tagger: h.user || null, ageMinutes: Math.round((nowSec - Number(h.ts)) / 60) });
}
const capped = candidates.slice(0, maxPerRun);
for (const c of candidates.slice(maxPerRun)) skipped.push({ ts: c.ts, reason: `deferred to next run (maxPerRun ${maxPerRun})`, deferred: true });
console.log(JSON.stringify({ monitor: cfg.team, candidates: capped, skipped, watermarkTs: ledger.watermarkTs || null }, null, 2));
