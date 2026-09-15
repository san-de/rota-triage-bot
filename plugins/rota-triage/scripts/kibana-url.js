#!/usr/bin/env node
// Parse a Kibana Discover URL (new `/app/discover#/?_g=…&_a=…` or legacy `/app/kibana#/discover?…`)
// into { service, from, to, errorId, traceId, levels, kql, filters[] }.
// Dependency-free rison reader. Usage: node kibana-url.js '<url, Slack-escaped is fine>' [anchor-iso]
// The optional anchor is the Slack message time, used to resolve relative `now-15m` ranges.
function unslack(s) {
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const m = s.match(/<(https?:[^|>]+)(?:\|[^>]*)?>/);
  if (m) s = m[1];
  return s.trim();
}
// --- rison ---
function rison(str) {
  let i = 0;
  const idChar = c => /[A-Za-z0-9_\-./~]/.test(c);
  function ws() { while (i < str.length && str[i] === " ") i++; }
  function value() {
    ws();
    const c = str[i];
    if (c === "(") return obj();
    if (c === "!") {
      i++;
      const n = str[i++];
      if (n === "(") return arr();
      if (n === "t") return true;
      if (n === "f") return false;
      if (n === "n") return null;
      throw new Error("bad !" + n);
    }
    if (c === "'") return qstr();
    if (c === "-" || /[0-9]/.test(c)) {
      let j = i;
      while (j < str.length && /[0-9.\-eE+]/.test(str[j])) j++;
      const t = str.slice(i, j); i = j; return Number(t);
    }
    let j = i;
    while (j < str.length && idChar(str[j])) j++;
    if (j === i) throw new Error("unexpected " + c + " at " + i);
    const t = str.slice(i, j); i = j; return t;
  }
  function qstr() {
    i++;
    let out = "";
    while (i < str.length) {
      const c = str[i++];
      if (c === "!") { out += str[i++]; continue; }
      if (c === "'") return out;
      out += c;
    }
    return out;
  }
  function obj() {
    i++;
    const o = {};
    ws();
    if (str[i] === ")") { i++; return o; }
    while (i < str.length) {
      const k = value();
      ws();
      if (str[i] !== ":") throw new Error("expected : at " + i);
      i++;
      o[k] = value();
      ws();
      if (str[i] === ",") { i++; continue; }
      if (str[i] === ")") { i++; return o; }
      throw new Error("expected , or ) at " + i);
    }
    return o;
  }
  function arr() {
    const a = [];
    ws();
    if (str[i] === ")") { i++; return a; }
    while (i < str.length) {
      a.push(value());
      ws();
      if (str[i] === ",") { i++; continue; }
      if (str[i] === ")") { i++; return a; }
      throw new Error("expected , or ) in array at " + i);
    }
    return a;
  }
  return value();
}
// --- time ---
function shift(d, sign, n, unit) {
  const ms = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit] * Number(n);
  return new Date(d.getTime() + (sign === "-" ? -ms : ms));
}
function absTime(t, anchor) {
  if (typeof t !== "string") return null;
  const m = t.match(/^(.*?)\|\|([+-])(\d+)([smhd])$/);            // '<iso>||-30m'
  if (m) return shift(new Date(m[1]), m[2], m[3], m[4]);
  const r = t.match(/^now(?:([+-])(\d+)([smhd]))?(?:\/[smhd])?$/);  // now-15m
  if (r) return r[1] ? shift(anchor, r[1], r[2], r[3]) : anchor;
  // Kibana writes microseconds ("…:02.449509Z"); Date() only takes milliseconds.
  const d = new Date(t.replace(/(\.\d{3})\d+(Z|[+-]\d\d:?\d\d)$/, "$1$2"));
  return isNaN(d) ? null : d;
}
// --- main ---
const raw = process.argv[2];
if (!raw) { console.error("usage: kibana-url.js '<discover url>' [anchor-iso]"); process.exit(2); }
const anchor = process.argv[3] ? new Date(process.argv[3]) : new Date();
let url = unslack(raw);
try { url = decodeURIComponent(url); } catch (_) { /* keep as is */ }
const frag = url.includes("#") ? url.slice(url.indexOf("#")) : url;
const params = {};
// new shape: "#/?_g=…&_a=…"; legacy shape: "#/discover?_g=…&_a=…"
for (const part of frag.replace(/^#\/?(?:discover)?\??/, "").split("&")) {
  const eq = part.indexOf("=");
  if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
}
const g = params._g ? rison(params._g) : {};
const a = params._a ? rison(params._a) : {};
const out = { service: null, from: null, to: null, errorId: null, traceId: null, levels: [], kql: "", filters: [] };
if (g.time) {
  const to = absTime(g.time.to, anchor);
  const from = absTime(g.time.from, to || anchor);
  out.from = from && from.toISOString();
  out.to = to && to.toISOString();
}
for (const f of a.filters || []) {
  const meta = f.meta || {};
  if (meta.disabled === true) continue;
  let val = meta.params && meta.params.query !== undefined ? meta.params.query
          : Array.isArray(meta.params) ? meta.params
          : meta.value;
  if (val === undefined && f.query) {
    const mp = f.query.match_phrase
      || (f.query.match ? Object.fromEntries(Object.entries(f.query.match).map(([k, v]) => [k, v && v.query !== undefined ? v.query : v])) : null);
    if (mp) val = Object.values(mp)[0];
  }
  const field = meta.key;
  out.filters.push({ field, value: val, negate: !!meta.negate });
  if (meta.negate) continue;
  if (field === "service.name") out.service = String(val);
  if (field === "error.id") out.errorId = String(val);
  if (field === "trace.id") out.traceId = String(val);
  if (field === "log.level") out.levels = Array.isArray(val) ? val.map(String) : [String(val)];
}
if (a.query && a.query.query) out.kql = String(a.query.query);
console.log(JSON.stringify(out, null, 2));
