#!/usr/bin/env node
// Team monitor configuration: resolve, list, validate. Deterministic, no secrets printed.
//
//   node monitor.js list
//   node monitor.js resolve [--monitor remex]        # merged config + runtime facts as JSON
//   node monitor.js validate [--monitor remex]       # exit 1 on errors; JSON report
//
// Runtime facts: mode (agent1 when /app/task-context exists, else local), pluginRoot, stateDir
// ($ROTA_TRIAGE_STATE_DIR, else /app/task-context/rota-triage on Agent1, else ~/.claude/rota-triage),
// per-team ledger/overlay paths, and where the Kibana key would come from (source only, never the value).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveElasticKey, describe } = require("./lib/elastic-key.js");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const MONITORS_DIR = path.join(PLUGIN_ROOT, "config", "monitors");
const ID = { channel: /^[CG][A-Z0-9]{8,}$/, subteam: /^S[A-Z0-9]{8,}$/, user: /^[UW][A-Z0-9]{8,}$/ };

function listMonitors() {
  if (!fs.existsSync(MONITORS_DIR)) return [];
  return fs.readdirSync(MONITORS_DIR).filter(f => f.endsWith(".json")).sort().map(f => {
    const raw = JSON.parse(fs.readFileSync(path.join(MONITORS_DIR, f), "utf8"));
    return { file: f, team: raw.team || f.replace(/\.json$/, ""), enabled: raw.enabled !== false, example: f.startsWith("_") };
  });
}

function loadMonitor(team) {
  const file = path.join(MONITORS_DIR, `${team}.json`);
  if (!fs.existsSync(file)) throw new Error(`no monitor config ${file}`);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.team = cfg.team || team;
  cfg._file = file;
  return cfg;
}

function pickMonitor(arg) {
  if (arg) return arg;
  const enabled = listMonitors().filter(m => m.enabled && !m.example);
  if (enabled.length === 1) return enabled[0].team;
  throw new Error(`--monitor is required (enabled monitors: ${enabled.map(m => m.team).join(", ") || "none"})`);
}

function runtime() {
  const agent1 = fs.existsSync("/app/task-context");
  const stateDir = process.env.ROTA_TRIAGE_STATE_DIR || (agent1 ? "/app/task-context/rota-triage" : path.join(os.homedir(), ".claude", "rota-triage"));
  return { mode: agent1 ? "agent1" : "local", stateDir, pluginRoot: PLUGIN_ROOT };
}

function derivedTokens(cfg) {
  const s = cfg.slack || {};
  if (Array.isArray(s.matchTokens) && s.matchTokens.length) return s.matchTokens;
  const t = [];
  for (const id of s.subteamIds || []) t.push(`<!subteam^${id}`, `<@${id}`);
  for (const term of s.searchTerms || []) t.push(`|${term}>`);
  return t;
}

function resolve(team) {
  const cfg = loadMonitor(team);
  const rt = runtime();
  const teamStateDir = path.join(rt.stateDir, cfg.team);
  const services = cfg.services || {};
  const out = Object.assign({}, cfg, {
    derived: { matchTokens: derivedTokens(cfg) },
    mode: rt.mode,
    pluginRoot: rt.pluginRoot,
    stateDir: rt.stateDir,
    teamStateDir,
    ledgerPath: path.join(teamStateDir, "ledger.json"),
    legacyLedgerPath: path.join(rt.stateDir, "ledger.json"),
    overlayPath: path.join(teamStateDir, services.overlay || "services.local.json"),
    reposDir: path.join(rt.stateDir, "repos"),
    servicesPath: path.join(rt.pluginRoot, services.file || "config/services.json"),
    elasticKey: describe(resolveElasticKey((cfg.kibana || {}).env || "prod")),
    nowTs: (Date.now() / 1000).toFixed(6),
  });
  return out;
}

function validate(team) {
  const errors = [], warnings = [];
  let cfg;
  try { cfg = loadMonitor(team); } catch (e) { return { team, ok: false, errors: [e.message], warnings }; }
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  const warn = (cond, msg) => { if (!cond) warnings.push(msg); };
  req(typeof cfg.team === "string" && /^[a-z0-9-]+$/.test(cfg.team), "team must be lowercase letters/digits/hyphens");
  const s = cfg.slack || {};
  req(Array.isArray(s.channels) && s.channels.length > 0, "slack.channels must list at least one {id,name}");
  for (const c of s.channels || []) {
    req(c && ID.channel.test(String(c.id || "")), `slack.channels: bad channel id ${JSON.stringify(c && c.id)} (expected C… or G…)`);
    req(c && typeof c.name === "string" && c.name && !c.name.startsWith("#"), `slack.channels: name without '#' required for ${JSON.stringify(c && c.id)}`);
  }
  req((s.subteamIds || []).length || (s.matchTokens || []).length, "slack.subteamIds or slack.matchTokens required");
  for (const id of s.subteamIds || []) req(ID.subteam.test(id), `slack.subteamIds: bad id ${id}`);
  for (const id of s.ignoreSubteamIds || []) req(ID.subteam.test(id), `slack.ignoreSubteamIds: bad id ${id}`);
  req((s.searchTerms || []).length > 0, "slack.searchTerms required (used as 'in:#channel <term>' search)");
  const o = cfg.output || {};
  if (o.teamChannelId) {
    req(ID.channel.test(o.teamChannelId), `output.teamChannelId bad id ${o.teamChannelId}`);
    req(!(s.channels || []).some(c => c.id === o.teamChannelId), "output.teamChannelId must not also be a source channel (self-triggering loop)");
  }
  warn(o.threadReply !== false || o.teamChannelId || (o.dmUserIds || []).length, "no output configured (threadReply false, no team channel, no DMs)");
  for (const u of o.dmUserIds || []) req(ID.user.test(u), `output.dmUserIds: bad id ${u}`);
  req(typeof o.signature === "string" && o.signature.length > 8, "output.signature required (first line of every post, also the replied-guard marker)");
  const own = cfg.owner || {};
  req(own.name && ID.user.test(own.slackUserId || ""), "owner.name and owner.slackUserId (U…) required");
  const a1 = cfg.agent1 || {};
  if (cfg.enabled !== false && !team.startsWith("_")) {
    req(typeof a1.agentId === "string" && a1.agentId.length > 3, "agent1.agentId required for an enabled monitor (team-owned agent → per-team accounting)");
    req(typeof a1.boardId === "string" && a1.boardId.length > 3, "agent1.boardId required for an enabled monitor (team board → cost visible per team)");
    req(typeof a1.keyOwner === "string" && a1.keyOwner.length > 0, "agent1.keyOwner required (whose personal API key runs the task)");
  }
  const k = cfg.kibana || {};
  req(["prod", "qa"].includes(k.env || "prod"), "kibana.env must be prod or qa");
  warn(!k.askTool || !k.askTool.startsWith("mcp__"), "kibana.askTool should be a tool-name suffix (ask_app_debugging), not a full mcp__ name");
  const j = cfg.jira;
  if (j && j.enabled) {
    const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
    req(typeof j.project === "string" && /^[A-Z][A-Z0-9]+$/.test(j.project), "jira.project must be a Jira project key when jira.enabled");
    req(j.epics && KEY.test(j.epics.bug || "") && KEY.test(j.epics["tech-improvement"] || ""), "jira.epics.bug and jira.epics.tech-improvement must be issue keys (PROJ-123) when jira.enabled");
    req(Array.isArray(j.labels) && j.labels.includes("agent-one"), "jira.labels must include agent-one (the board sync rule picks tickets up by that label)");
    req(Array.isArray(j.createFor) && j.createFor.length > 0, "jira.createFor must list at least one classification");
    warn(/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/.test(j.siteUrl || ""), "jira.siteUrl should be the https://<site>.atlassian.net base URL");
  }
  return { team: cfg.team, file: cfg._file, ok: errors.length === 0, errors, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const mIdx = args.indexOf("--monitor");
  const monitorArg = mIdx >= 0 ? args[mIdx + 1] : null;
  try {
    if (cmd === "list") { console.log(JSON.stringify(listMonitors(), null, 2)); return; }
    if (cmd === "resolve") { console.log(JSON.stringify(resolve(pickMonitor(monitorArg)), null, 2)); return; }
    if (cmd === "validate") {
      const teams = monitorArg ? [monitorArg] : listMonitors().filter(m => !m.example).map(m => m.team);
      const reports = teams.map(validate);
      console.log(JSON.stringify(reports, null, 2));
      process.exit(reports.every(r => r.ok) ? 0 : 1);
    }
    console.error("usage: monitor.js list | resolve [--monitor <team>] | validate [--monitor <team>]");
    process.exit(2);
  } catch (e) { console.error("monitor: " + e.message); process.exit(2); }
}

module.exports = { listMonitors, loadMonitor, pickMonitor, runtime, resolve, validate, derivedTokens, PLUGIN_ROOT, MONITORS_DIR };
if (require.main === module) main();
