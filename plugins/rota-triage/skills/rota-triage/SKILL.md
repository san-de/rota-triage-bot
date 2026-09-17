---
name: rota-triage
description: Unattended Slack alert triage for AUTO1 teams. Use when asked to "triage the rota pings", "check what <team> got tagged on", "analyse this Kibana alert from bot_rota", to run the poll for a team monitor (Agent1 scheduled task or `/loop`), or to re-run one message by permalink. Finds Slack messages that tag a configured user group in configured channels, resolves the Kibana link (Discover URL, /app/r/s short link, lz locator), asks the PROD Kibana App-Debugging agent and a deterministic log search what the logs say, locates the failing frame in the owning wkda repo, classifies the alert, and posts the analysis in the alert thread and the team's channel (optional DMs). Writes only to those Slack targets and its own ledger. Usage- /rota-triage:rota-triage poll --monitor <team> [--dry-run] [--max n] | --monitor <team> --since <3d> [--dry-run] | --monitor <team> <slack-permalink> [--dry-run]
---

# rota-triage — Slack tag → Kibana → GitHub → thread reply + team channel

One tagged alert in, one analysis out: **who tagged us, what Kibana says, where in the code, what to do next**, posted where the team reads it.

## Usage

```
/rota-triage:rota-triage poll --monitor remex                      # everything newer than the ledger watermark
/rota-triage:rota-triage poll --monitor remex --dry-run --max 3     # print instead of post, move nothing
/rota-triage:rota-triage --monitor remex --since 3d --dry-run       # backfill window, ignores the watermark
/rota-triage:rota-triage --monitor remex https://wkda-eng.slack.com/archives/C0K4U8ZS7/p1789354805176499?thread_ts=1789354801.516039
```

Everything team-specific comes from `config/monitors/<team>.json` (see `config/monitors/_example.json`). `${CLAUDE_PLUGIN_ROOT}` below is this plugin's directory; on Agent1 the task description names it (the repo clone's `plugins/rota-triage`).

Bundled helpers (Node, dependency-free): `scripts/monitor.js` (config + runtime facts), `scripts/ledger.js` (state), `scripts/slack-scan.js` (which hits are real tags), `scripts/kibana-url.js`, `scripts/lz-decode.js`, `scripts/kibana-shorturl.js` (link shapes → window/filters), `scripts/kibana-search.js` (deterministic log lookup). References: `references/kibana-links.md`, `references/analysis-questions.md`, `references/thread-reply-template.md`, `references/team-channel-template.md`, `references/dm-template.md`.

## Hard rules

1. **Deterministic first.** Matching, dedupe, windows, state and posting decisions come from the scripts and the config. The model interprets Kibana and code findings and fills the templates; it never decides "this looks like a tag" by eye and never edits ledger JSON by hand.
2. **Writes are limited to**: a reply in the tagged alert thread, one post in `output.teamChannelId`, DMs to `output.dmUserIds`, and the ledger. Never `reply_broadcast`, never reactions, never any other channel, never Kibana, never a repo.
3. **Read-only everywhere else.** PROD Kibana through the plugin tools and the bundled scripts only; `git`/`gh` read-only; never `git pull` a user's working tree.
4. **Match the raw mention token** (`<!subteam^S…`, `<@S…`, `|handle>`), never plain-text `@handle` (inert in Slack). `slack-scan.js` does this.
5. **Send first, mark after.** `ledger.js mark` immediately after every successful Slack write; a failed write leaves the entry untouched so the next run retries. A ledger write failure stops the run.
6. **Secrets stay inside the scripts.** Kibana keys come from the environment or `ELASTIC_API_KEY_FILE` and are only ever consumed by `kibana-search.js`/`kibana-shorturl.js`; never `cat`, print or copy the keys file.
7. **Never invent a number.** A count needs an aggregation behind it (Kibana agent `tools_run` shows `auto1.count_matching_logs` / `auto1.level_histogram` / `auto1.exceptions`, or `kibana-search.js` output).
8. **PII stays out.** Quote log lines minimally; no emails, names or full VINs beyond what identifies the signature.
9. **Unattended-safe.** Never ask a question mid-run. Degrade, record under *Gaps*, continue. Resolve MCP tools by **name suffix** (`slack_send_message`, `ask_app_debugging`, preferring the `-prod` Kibana server); the `mcp__<server>__` prefix differs between hosts.
10. **Time budget.** Stop starting new candidates 45 minutes after the run began; unprocessed ones stay for the next run because the watermark only advances past processed candidates.

## Phase 0 — Config, runtime, ledger, preflight

1. Parse args: `poll` (default) | `<permalink>` (`…/archives/<CHANNEL>/p<digits>[?thread_ts=…]` → ts = digits with a `.` before the last 6) | `--since <Nd|Nh>`; flags `--monitor <team>` (required unless exactly one enabled monitor exists), `--dry-run`, `--max <n>`.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/monitor.js" resolve --monitor <team>` → keep the JSON as **MON** for the whole run: channels, `derived.matchTokens`, output targets, kibana env, `mode` (`agent1`|`local`), `ledgerPath`, `overlayPath`, `servicesPath`, `elasticKey.source` (`env`|`file`|`none` — the value is never shown).
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.js" init --monitor <team>` (creates the v2 ledger, migrates a legacy single-team ledger once). Note `watermarkTs`.
4. Preflight table, printed once: Slack search + Slack send (**hard** — stop the run with a clear message if missing), Kibana agent tool (soft), Kibana key for scripts (soft), GitHub access (soft). Print the run start time.

## Phase 1 — Find new tagged messages (deterministic)

Search is the primary source because **`conversations.history` never returns thread replies** and most tags are the `sre` bot's thread reply `<!subteam^S…|handle>, please take a look: *[SRE00xx]: … | <service>*`.

1. `effectiveStart = min(now − poll.sinceFallbackMinutes, watermarkTs)` (poll mode); `--since` → `now − N`; permalink → that message only.
2. For each `slack.channels[i]` × `slack.searchTerms[j]`: `slack_search_public_and_private query="in:#<name> <term>" after=<effectiveStart> include_bots=true sort=timestamp sort_dir=asc include_context=false limit=20`, follow `cursor` until exhausted. **Hits from the `sre` bot come back with empty text** — for every hit call `slack_read_thread channel_id=<id> message_ts=<thread_ts or ts>` (detailed) and collect the thread messages.
3. `slack_read_channel <id> oldest=<effectiveStart>` (concise) for tagged **parent** messages that search has not indexed yet.
4. Write the material to a temp file `{ hits:[{ts, threadTs, channelId, text, user, permalink}], threads:{threadTs:[{ts,text,user}]} }` and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-scan.js" --monitor <team> --file <tmp>`. It applies, in order: match token present · not only an ignored user group · not already handled or replied (ledger `repliedThreads`, or a thread message starting with `output.signature`) · not stale (`skip.olderThanHours`) · alert-like (`[SRE00xx]` or a Kibana link in the thread, unless `skip.nonAlertMentions` is false) · not an excluded alert code · capped at `poll.maxPerRun` (or `--max`), oldest first. Use its `candidates` list as-is; record every `skipped` entry with `ledger.js mark <ts> --json '{"status":"skipped","reason":"…"}'`.
5. No candidates in poll mode: print `no new tags for <team> since <watermark local>` and `ledger.js advance <now − poll.searchLagMinutes>` (never to `now` — search indexing lags).

## Phase 2 — Build the AlertContext for each candidate

1. From the thread (already fetched): **parent** (Kibana Alerts app): alert code `SRE00xx`, title, `Account`, `Detected for: *<service.name>*`, `Error id: *<hex>*`, the `:evil_kibana:` link. **`sre` reply**: `:jenkins: Last deployment …` (age, job URL, release tag, deployer), `:jira: SI-…`, the full Discover URL, Grafana, App Cockpit. **Humans**: pasted stack traces (keep the first `wkda.`/`com.auto1.` frame), conclusions, further links. **The tagged message**: author, permalink, its own Kibana link(s), the ask.
2. **Kibana links** — the tagged message's own link first, then the `sre` reply, then the parent. Resolve per `references/kibana-links.md` with the scripts, never by eyeballing rison: `node scripts/kibana-url.js '<discover url>' '<message time ISO>'`; `node scripts/lz-decode.js '<locator url>'`; `node scripts/kibana-shorturl.js '<short url>' --env <kibana.env>` (its `embeddedUrl` is then fed to `kibana-url.js`). No window from any link → `[message_time − kibana.fallbackWindowMinutes, message_time + fallbackWindowMinutes]`; cap at `kibana.maxWindowHours` around the alert time.
3. Fix `from_utc`/`to_utc` once (ISO-8601 Z) and their Europe/Berlin rendering; reuse verbatim in every question.
4. Service → repo: `config/services.json` merged with the overlay at `overlayPath` (overlay wins): exact key, then key without `-service`. Missing → Phase 4 discovers it and appends to the overlay. `knownIssues`/`knownNoise` on the entry: a matching `error.id` or exception means "already understood" — say so in the reply.

## Phase 3 — Kibana analysis (skip gracefully when tools are absent)

Follow `references/analysis-questions.md`: one App-Debugging conversation per alert, Q1 → Q3 in order, Q4 (Performance tool) only when the thread or signature mentions timeouts, latency, DB, pools or 5xx. Pin the absolute UTC window, `service.name`, and `error.id`/`trace.id` when known. Attachment-only answers → re-ask with `Answer as INLINE PLAIN TEXT, one line per row`. Two tool errors → stop asking, `Gaps: Kibana unavailable (<class>)`. Windows older than 10 days → do not ask Q1–Q3 (retention); use the thread's pasted trace as the signature and Q5 for presence; `Gaps: window outside 10-day retention`.

### Phase 3b — Deterministic lookup (always run, not only as a fallback)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kibana-search.js" --env <kibana.env> --service <service> --error-id <error.id> --days 14 --size 3
node "${CLAUDE_PLUGIN_ROOT}/scripts/kibana-search.js" --env <kibana.env> --service <service> --from <from_utc> --to <to_utc> --levels ERROR,WARN --size 40
node "${CLAUDE_PLUGIN_ROOT}/scripts/kibana-search.js" --env <kibana.env> --service <service> --trace-id <trace.id>
```

`perDay` shows recurrence (a 14-day daily pattern is a different story from a spike), `exception`/`appFrames`/`causes` give the signature and the frame even when `error.type` is unset (the agent then reports 0), `threadHints` tell you SQS listener vs HTTP thread. The agent remains the source for counts and the trace story; the script is the source for *what* and *since when*. `error.id` is a hash of the exception line and recurs across unrelated services.

Output per alert: ERROR count in window and previous window; top signature (class, message ≤ 120, top app frame, logger, first/last seen, count, one `trace.id`); the request story (endpoint → downstream → status in ms); recurrence; optional perf numbers.

## Phase 4 — Locate the code (read-only, MVP scope)

Goal: the failing frame's `file:line`, the last commit touching it, and the config value when the cause is a setting (timeouts, limits). Nothing more in this phase — release diffs and PR searches are a later phase (`docs/later-phases.md`).

1. Repo: `services.json`/overlay → else `<service>-service` in `github.orgs` → else code search for the top frame's package. Append discoveries to the overlay (`{ "<service>": { "repo": "wkda/…" } }`).
2. Access ladder, stop at the first rung that works and note it in the run log: (a) `gh auth status` ok → `gh api repos/<repo>/contents/<path>`, `gh search code`, `gh api repos/<repo>/commits?path=…`; (b) GitHub MCP tools present (suffix `get_file_contents`, `search_code`) → same lookups; (c) `git clone --depth <github.cloneDepth> --filter=blob:none https://github.com/<repo>.git "<stateDir>/repos/<repo>"` (or `git -C … fetch` when it exists) → `grep -rn`, `git log -3 --format='%h %ad %s' --date=short -- <file>`; (d) nothing → `Gaps: repo lookup unavailable`, *Where* says "not located".
3. Config values: for timeouts/limits also look in `wkda/java-application-config` (`aws/<service>-service-*-production-aws.yml`, `config-assembly/…properties`) and quote key = value.
4. **Classify**, exactly one: `new after deploy` (the thread's deploy is inside the window and the frame's file changed recently) · `pre-existing, grew` (seen before the window, count ≥ 3× previous window) · `upstream dependency` (top frame is a Feign/HTTP client, resilience4j, or another service's DTO — name the upstream service and the limit it crossed) · `infra` (timeouts across endpoints, OOM, restarts, pools) · `expected business validation` (`UpstreamInputValidationException`, 4xx business errors humans dismissed before) · `steady noise` (matches `knownNoise`). One-line reason.

## Phase 5 — Post, then ledger

For each candidate, oldest first:

1. Render `references/thread-reply-template.md` (first line = `output.signature`); if longer than `output.maxChars`, trim *Evidence*, then *Where*. Render `references/team-channel-template.md` (needs the reply permalink → step 3). Render `references/dm-template.md` only when `output.dmUserIds` is non-empty.
2. **Dry run** (`--dry-run` or `output.dryRun`): print both renderings in fenced blocks, `ledger.js mark <ts> --json '{"status":"dry-run","threadTs":"…","service":"…","alert":"…","classification":"…"}'`, do **not** advance the watermark, continue.
3. `output.threadReply` → `slack_send_message channel_id=<alert channel id> thread_ts=<threadTs> message=<reply>` (raw channel id, no `#name`). Success → immediately `ledger.js mark <ts> --json '{"status":"posted","threadTs":"…","threadReplyTs":"<message_ts>","channelId":"…","service":"…","alert":"…","classification":"…","permalink":"…"}'`. Failure → retry once; still failing → **team-only** mode: the team post carries the full reply body with the `⚠ could not reply in thread (<reason>)` line, status `team-only`.
4. Team post → `slack_send_message channel_id=<output.teamChannelId> message=<team post>`; `ledger.js mark <ts> --json '{"teamPostTs":"<message_ts>"}'` (or `{"teamPostTs":null,"reason":"…"}` on failure — keep the thread reply).
5. DMs → `slack_send_message channel_id=<userId>`; mark `{"dmTs":{"<userId>":"<message_ts>"}}`.
6. `ledger.js advance <ts>`; next candidate. When more than `poll.maxPerRunBeforeNumbering` alerts are posted in one run, prefix the team posts with `(k/n)`.
7. End of run: `ledger.js run-note --monitor <team> --json '{"candidates":n,"posted":n,"teamOnly":n,"skipped":n,"failed":n,"durationSec":s,"gaps":"…"}'`. If it reports `lastSuccessfulRunAt` older than 2 hours, post the health line from `team-channel-template.md`. Terminal summary: one line per candidate (`posted|team-only|dry-run|skipped|failed <permalink> <service> <classification>`), then `watermark <ts> (<local time>) · ledger <path>`. On Agent1 also append one line to `/app/task-context/memory.md`.

## Phase 6 — Jira handoff (only when `jira.enabled` is true; skip silently otherwise)

Runs per candidate right after Phase 5 step 4 succeeded (thread reply **and** team post sent, not dry run, not team-only).
Follow `references/jira-ticket-template.md`: kind from the classification (`bug` → `jira.epics.bug`, `tech-improvement`
→ `jira.epics["tech-improvement"]`, none for `expected business validation` / `steady noise` / anything not in
`jira.createFor`); dedupe by JQL first (link instead of create); create with `parent` = the epic and `jira.labels`
(must contain `agent-one`, which the team's Agent1 board sync rule imports); post the key in the alert thread; mark the
ledger `{"jira":"<key>","jiraAction":"created|linked"}`. Atlassian MCP tools are resolved by suffix
(`createJiraIssue`, `searchJiraIssuesUsingJql`); absent → `Gaps: Jira unavailable`, continue. Never transition, assign or
comment on other tickets.

### Failure handling

| Situation | Behaviour |
|---|---|
| Slack search or send tool missing | Hard stop in Phase 0 with a one-line reason |
| Jira create fails (Phase 6) | Keep the Slack posts, mark `{"jira":null,"jiraError":"…"}`, continue |
| Kibana agent absent / erroring twice | Continue with `kibana-search.js`; *Gaps: Kibana agent unavailable* |
| No Kibana key for the scripts (`elasticKey.source: none`) | Continue with agent answers only; *Gaps: deterministic lookup unavailable* |
| GitHub ladder exhausted | Post with *Where: not located*; *Gaps: repo lookup unavailable* |
| Thread reply refused twice | Team-only post with the full analysis |
| Team post fails | Keep the thread reply, record `teamPostTs: null` + reason |
| Ledger write fails | Stop the run (a run that cannot record is worse than one that stops) |

## Interpretation notes (learned from the channel)

- `[SRE0058] Slow queries` links carry a `type:custom` filter (Slow SQL query / SlowQueryReport / SQL_SLOW loggers) instead of `log.level`; the finding is the slow SQL shape, its duration and the endpoint behind the trace.
- `[SRE0053] Service errors` and `[SRE0095] NPE Detected` carry an `error.id`; `[SRE0054/0077] Service errors spike` carry a `[>=N/1h]` threshold and need the level histogram; `[SRE0059] DLQ Received New Message` names a queue — the consumer service's ERROR lines in the 30 minutes before the alert show the poison message (`Error processing message <uuid>`, repeated every visibility timeout until the max receive count).
- The `sre` bot tags the team from the service's `descriptor.yml`; humans re-tag on other teams' alerts when the failing call goes into one of our services — then the code lookup belongs to **our** upstream service, not the alerting one; say so.
- `deal.error.car.is.not.available` `UpstreamInputValidationException` was dismissed before: `expected business validation`.
- Read timeouts that are consistently a few percent over a client's `read-timeout` (e.g. car-details answering in 5.1 s against a 5,000 ms limit) are `upstream dependency`; quote both numbers and the config key.

## What this skill does NOT do

- No Jira writes unless `jira.enabled` (Phase 6), no reactions, no channel posts outside the configured targets, no drafts.
- No live-incident handling — a service-wide spike is named as such in *Read* and the proposal says "escalate".
- No dashboard or Kibana writes of any kind.
