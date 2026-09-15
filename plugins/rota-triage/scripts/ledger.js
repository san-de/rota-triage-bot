#!/usr/bin/env node
// Deterministic per-monitor state so an unattended run never hand-edits JSON.
//
//   node ledger.js init        --monitor remex            # create v2 ledger (migrates the legacy single-team ledger once)
//   node ledger.js status      --monitor remex
//   node ledger.js has         --monitor remex <ts>       # exit 0 if <ts> is already handled (posted/team-only/dm/draft/skipped)
//   node ledger.js has-thread  --monitor remex <thread_ts># exit 0 if we already replied in that thread
//   node ledger.js mark        --monitor remex <ts> --json '{"status":"posted","threadTs":"…","threadReplyTs":"…",…}'
//   node ledger.js advance     --monitor remex <ts>       # forwards-only watermark move
//   node ledger.js run-note    --monitor remex --json '{"candidates":3,"posted":2,"skipped":1,"failed":0,"durationSec":410}'
//
// Writes are atomic (tmp + rename). Ledger path comes from monitor.js (state dir outside the plugin).
"use strict";
const fs = require("fs");
const path = require("path");
const { resolve, pickMonitor } = require("./monitor.js");

const HANDLED = new Set(["posted", "team-only", "dm", "draft", "skipped"]);   // dry-run and failed are retried by a live run

function nowIso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function nowTs() { return (Date.now() / 1000).toFixed(6); }

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, p);
}

function fresh(cfg) {
  const lookbackH = ((cfg.poll || {}).firstRunLookbackHours) || 2;
  return { version: 2, monitor: cfg.team, watermarkTs: (Date.now() / 1000 - lookbackH * 3600).toFixed(6), updatedAt: nowIso(), processed: {}, repliedThreads: {}, runs: [] };
}

function migrateLegacy(cfg, legacy) {
  const led = fresh(cfg);
  led.watermarkTs = legacy.watermarkTs || led.watermarkTs;
  for (const [ts, e] of Object.entries(legacy.processed || {})) {
    const status = e.status === "sent" ? "dm" : (e.status || "posted");
    led.processed[ts] = Object.assign({}, e, { status, migratedFrom: "v1" });
  }
  led.migratedAt = nowIso();
  return led;
}

function load(cfg) {
  if (fs.existsSync(cfg.ledgerPath)) return readJson(cfg.ledgerPath);
  return null;
}

function init(cfg) {
  let led = load(cfg);
  let created = false, migrated = false;
  if (!led) {
    created = true;
    if (fs.existsSync(cfg.legacyLedgerPath)) {
      try { led = migrateLegacy(cfg, readJson(cfg.legacyLedgerPath)); migrated = true; } catch (e) { led = fresh(cfg); }
    } else led = fresh(cfg);
    writeAtomic(cfg.ledgerPath, led);
  }
  return { path: cfg.ledgerPath, watermarkTs: led.watermarkTs, created, migrated, processed: Object.keys(led.processed).length };
}

function mustLoad(cfg) {
  const led = load(cfg);
  if (!led) { console.error(`ledger: not initialised — run: ledger.js init --monitor ${cfg.team}`); process.exit(3); }
  if (led.version !== 2) { console.error(`ledger: unexpected version ${led.version} at ${cfg.ledgerPath}`); process.exit(3); }
  return led;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = { pos: [] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--monitor") opt.monitor = args[++i];
    else if (args[i] === "--json") opt.json = args[++i];
    else opt.pos.push(args[i]);
  }
  let cfg;
  try { cfg = resolve(pickMonitor(opt.monitor)); } catch (e) { console.error("ledger: " + e.message); process.exit(2); }

  switch (cmd) {
    case "init": { console.log(JSON.stringify(init(cfg))); return; }
    case "status": {
      const led = mustLoad(cfg);
      const byStatus = {};
      for (const e of Object.values(led.processed)) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      const last = led.runs[led.runs.length - 1] || null;
      console.log(JSON.stringify({ path: cfg.ledgerPath, watermarkTs: led.watermarkTs, watermarkIso: new Date(Number(led.watermarkTs) * 1000).toISOString(),
        processed: Object.keys(led.processed).length, byStatus, repliedThreads: Object.keys(led.repliedThreads).length, lastRun: last, updatedAt: led.updatedAt }, null, 2));
      return;
    }
    case "has": {
      const led = mustLoad(cfg); const e = led.processed[opt.pos[0]];
      const yes = !!(e && HANDLED.has(e.status));
      console.log(JSON.stringify({ ts: opt.pos[0], handled: yes, status: e ? e.status : null }));
      process.exit(yes ? 0 : 1);
    }
    case "has-thread": {
      const led = mustLoad(cfg); const r = led.repliedThreads[opt.pos[0]];
      console.log(JSON.stringify({ threadTs: opt.pos[0], replied: !!r, threadReplyTs: r || null }));
      process.exit(r ? 0 : 1);
    }
    case "mark": {
      const led = mustLoad(cfg); const ts = opt.pos[0];
      if (!ts || !opt.json) { console.error("ledger mark: <ts> and --json required"); process.exit(2); }
      let entry; try { entry = JSON.parse(opt.json); } catch (e) { console.error("ledger mark: --json is not valid JSON"); process.exit(2); }
      const prev = led.processed[ts] || {};
      const merged = Object.assign({}, prev, entry, { processedAt: entry.processedAt || nowIso() });
      led.processed[ts] = merged;
      if (merged.threadTs && merged.threadReplyTs) led.repliedThreads[merged.threadTs] = merged.threadReplyTs;
      led.updatedAt = nowIso();
      writeAtomic(cfg.ledgerPath, led);
      console.log(JSON.stringify({ ts, status: merged.status, repliedThread: !!(merged.threadTs && merged.threadReplyTs) }));
      return;
    }
    case "advance": {
      const led = mustLoad(cfg); const ts = opt.pos[0];
      if (!ts || !/^\d+(\.\d+)?$/.test(ts)) { console.error("ledger advance: <ts> (Slack ts or unix seconds) required"); process.exit(2); }
      const moved = Number(ts) > Number(led.watermarkTs);
      if (moved) { led.watermarkTs = ts; led.updatedAt = nowIso(); writeAtomic(cfg.ledgerPath, led); }
      console.log(JSON.stringify({ watermarkTs: led.watermarkTs, moved }));
      return;
    }
    case "run-note": {
      const led = mustLoad(cfg);
      let note = {}; try { note = opt.json ? JSON.parse(opt.json) : {}; } catch (e) { console.error("ledger run-note: --json invalid"); process.exit(2); }
      led.runs.push(Object.assign({ at: nowIso(), mode: cfg.mode }, note));
      if (led.runs.length > 50) led.runs = led.runs.slice(-50);
      led.updatedAt = nowIso();
      writeAtomic(cfg.ledgerPath, led);
      const lastOk = [...led.runs].reverse().find(r => (r.failed || 0) === 0 && r.status !== "failed");
      console.log(JSON.stringify({ runs: led.runs.length, lastSuccessfulRunAt: lastOk ? lastOk.at : null }));
      return;
    }
    default:
      console.error("usage: ledger.js init|status|has <ts>|has-thread <thread_ts>|mark <ts> --json|advance <ts>|run-note --json  --monitor <team>");
      process.exit(2);
  }
}

main();
