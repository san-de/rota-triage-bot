# rota-triage-bot

Unattended Slack alert triage for AUTO1 teams. When someone tags a team's user group in a configured channel (for
REMEX: `@remex-be` in `#bot_rota`), the bot reads the alert thread, resolves the Kibana link, analyses the logs, locates the
failing code in the owning `wkda` repo, classifies the alert and posts the analysis **in the alert thread** and **in the
team's channel** (optional DMs). It runs on a cron schedule (REMEX: hourly, `poll.cron` in the team config) as an
**Agent1 scheduled task**, one task per team; each run covers everything since the previous run's watermark, with a
`poll.sinceFallbackMinutes` overlap for Slack indexing lag (REMEX: 75 min). A run with candidates costs ≈ $5 on Agent1.

```
Slack channel ──► Agent1 task (hourly cron, team-owned agent + board)
                  ├─ scripts decide: which messages are real tags, what is new, what is already answered
                  ├─ Kibana: plugin agent + deterministic log search        (team member's Kibana key)
                  ├─ GitHub: owning repo, failing frame, config value        (team member's GitHub token)
                  └─ posts: alert thread reply · team channel summary · DMs  (team member's Slack identity)
```

The analysis playbook is the Claude Code skill in `plugins/rota-triage/skills/rota-triage/SKILL.md`; everything rule-based
lives in `plugins/rota-triage/scripts/`. Team settings live in `plugins/rota-triage/config/monitors/<team>.json`.

## Identity and accounting

Agent1's Slack tools post as the **task creator's Slack user**, so replies appear as that person, always prefixed with a fixed
signature line (`🤖 automated triage by rota-triage on behalf of @remex-be …`). Each team's task runs on a team-owned Agent1
agent and board with a team member's personal API key, so runs and their cost are visible to that team and separable from
other teams'. The config records `owner` and `agent1.keyOwner`.

## Onboarding a team

1. Copy `plugins/rota-triage/config/monitors/_example.json` to `monitors/<team>.json`. Fill: source channels (id + name),
   your user-group id (`S…`, copy it from a raw `<!subteam^S…|handle>` mention), the search term (your handle), your team
   channel id, optional DM user ids, `owner`.
2. In Agent1 PROD (as the team member who will own the task): link Slack, save a GitHub personal access token and the Kibana
   PROD key under Integrations, create a **team agent** (Slack MCP bound to the wkda-eng workspace, default plugin `kibana`)
   and a **team board**; put their ids into `agent1.agentId` / `agent1.boardId`; create a personal API key.
3. `node plugins/rota-triage/scripts/monitor.js validate --monitor <team>` must pass. Open a PR; CODEOWNERS review; merge.
4. First run, observe only:
   `AGENT1_API_KEY=… plugins/rota-triage/scripts/agent1-bootstrap.sh create --monitor <team> --repo <this repo url> --extra-args "--since 3d --dry-run" --run-now`
5. Schedule in dry-run for a day: `… create --monitor <team> --repo <url> --extra-args "--dry-run"`; check the task log and
   `ledger.js status`. Then `disable <taskId>` and create the live one without `--dry-run`.

Pause, resume, status, key rotation and watermark questions: `docs/operations.md`.

## Running locally

```
claude plugin marketplace add ~/codebase/rota-triage-bot
claude plugin install rota-triage@rota-triage-bot
/rota-triage:rota-triage poll --monitor remex --dry-run
```
Needs VPN, the Slack connector, `ELASTIC_API_KEY_PROD` in the shell (or the kibana plugin key file), and `gh auth`.
State goes to `~/.claude/rota-triage/<team>/` (`ROTA_TRIAGE_STATE_DIR` overrides).

## Repository layout

```
plugins/rota-triage/skills/rota-triage/SKILL.md          the playbook (phases 0–5)
plugins/rota-triage/skills/rota-triage/references/       link shapes, Kibana questions, thread/team/DM templates
plugins/rota-triage/config/monitors/<team>.json          per-team config (PR to onboard)
plugins/rota-triage/config/services.json                 service → repo map (grown by the skill via services.local.json)
plugins/rota-triage/scripts/                              monitor.js · ledger.js · slack-scan.js · kibana-search.js · kibana-shorturl.js · kibana-url.js · lz-decode.js · agent1-bootstrap.sh
docs/agent1-task-description.md                          the prompt the Agent1 task receives
docs/operations.md · docs/later-phases.md                runbook · parked scope (Jira, deeper code lookup, n8n shell)
```

## Phase 6 — Jira handoff to the Agent1 board (scaffolded, off by default)

When `jira.enabled` is true in the team config, every posted analysis whose classification is in `jira.createFor` also
becomes a Jira ticket under the team's epic (`bug` → bugs epic as `Bug`; `tech-improvement` → tech-improvement epic as
`Task`), labelled `agent-one` so the team's Agent1 board sync rule imports it and the board workflow turns it into a PR.
Template and mapping: `plugins/rota-triage/skills/rota-triage/references/jira-ticket-template.md`; rollout steps:
`docs/later-phases.md`. REMEX: epics REMEX-2957 (Bugs Q3-2026) and REMEX-2956 (Tech Improvement Q3-2026).

## Not in this phase

Release-diff/open-PR lookup, a bot identity (dedicated Slack app), event-driven triggering. See `docs/later-phases.md`.
