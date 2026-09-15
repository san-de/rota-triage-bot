#!/usr/bin/env node
// Resolve a Kibana short link (/app/r/s/<id>) through the short-URL API, read-only.
//
//   node kibana-shorturl.js tgRnv [--env prod]
//   node kibana-shorturl.js "https://kibana.prod.services.auto1.team/app/r/s/tgRnv"
//
// Prints JSON { id, resolvedUrl, locatorId, state, embeddedUrl? } — for LEGACY_SHORT_URL_LOCATOR the embedded
// Discover URL is made absolute so it can be piped straight into kibana-url.js.
// Exit codes: 0 ok · 2 no key · 3 Kibana unreachable/timeout · 4 auth (401/403) · 5 unknown/expired slug (404) · 1 other.
// The key is never printed (see lib/elastic-key.js for where it comes from).
"use strict";
const https = require("https");
const { resolveElasticKey, kibanaBaseUrl } = require("./lib/elastic-key.js");

const args = process.argv.slice(2);
let env = "prod", target = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--env") env = String(args[++i] || "prod").toLowerCase();
  else target = args[i];
}
if (!target) { console.error("kibana-shorturl: give a slug or an /app/r/s/<id> URL"); process.exit(1); }
const clean = target.replace(/&amp;/g, "&").replace(/^<|>$/g, "").split("|")[0];
const m = clean.match(/\/app\/r\/s\/([A-Za-z0-9_-]+)/) || clean.match(/^([A-Za-z0-9_-]{3,})$/);
if (!m) { console.error("kibana-shorturl: not a short link: " + clean.slice(0, 120)); process.exit(1); }
const id = m[1];
const resolved = resolveElasticKey(env);
if (!resolved.key) { console.error(`kibana-shorturl: ${resolved.reason}`); process.exit(2); }
const base = kibanaBaseUrl(env);

const req = https.request(new URL(`/api/short_url/${id}`, base), {
  method: "GET", timeout: 15000,
  headers: { "Authorization": `ApiKey ${resolved.key}`, "kbn-xsrf": "true" }
}, res => {
  let data = ""; res.on("data", c => data += c);
  res.on("end", () => {
    if (res.statusCode === 401 || res.statusCode === 403) { console.error(`kibana-shorturl: HTTP ${res.statusCode} (auth)`); process.exit(4); }
    if (res.statusCode === 404) { console.error(`kibana-shorturl: HTTP 404 — slug ${id} unknown or expired`); process.exit(5); }
    if (res.statusCode !== 200) { console.error(`kibana-shorturl: HTTP ${res.statusCode} ${data.slice(0, 200)}`); process.exit(1); }
    let j; try { j = JSON.parse(data); } catch (e) { console.error("kibana-shorturl: invalid JSON"); process.exit(1); }
    const locator = j.locator || {};
    const out = { id, resolvedUrl: `${base}/app/r/s/${id}`, locatorId: locator.id, state: locator.state || null };
    if (locator.id === "LEGACY_SHORT_URL_LOCATOR" && locator.state && locator.state.url) {
      out.embeddedUrl = /^https?:/.test(locator.state.url) ? locator.state.url : base + locator.state.url;
    }
    console.log(JSON.stringify(out, null, 2));
  });
});
req.on("timeout", () => { console.error("kibana-shorturl: timeout (VPN?)"); req.destroy(); process.exit(3); });
req.on("error", e => { console.error("kibana-shorturl: " + e.message + " (VPN?)"); process.exit(3); });
req.end();
