# Later phases (parked, not in the MVP)

## Jira ticket creation → Agent1 board (Phase 6, scaffolded, switched off)
Scaffolding is in the repo since 2.1.0 and gated by `jira.enabled` in `config/monitors/<team>.json`:
`references/jira-ticket-template.md` (kind → epic → issue type mapping, dedupe JQL, fields, description shape),
SKILL.md "Phase 6", `monitor.js validate` checks for the `jira` block. REMEX mapping: bugs (`new after deploy`,
`pre-existing, grew`, `infra`) → epic REMEX-2957 "Bugs Q3-2026" as `Bug`; `upstream dependency` (a limit on our side must
change) → epic REMEX-2956 "Tech Improvement Q3-2026" as `Task`; `expected business validation` and `steady noise` → no
ticket. Labels `agent-one` + `rota-triage`; the REMEX dev board sync rule "REMEX agent-one"
(`project = REMEX AND labels = agent-one AND statusCategory = "To Do"`) imports the ticket, and the board's
`board_instructions.md` workflow turns it into a PR.

To switch on: (1) the Agent1 agent needs the Atlassian MCP (already attached to `remex-rota-triage`) and the task
creator's Atlassian integration linked; (2) run two weeks of posted analyses and confirm the classifications with the
team; (3) set `jira.enabled: true` via PR; (4) enable the board sync rule (still manual after the pilot) or keep running
it by hand as the gate. Conventions come from `wkda/a1-platform-claude-code-plugin` → `skills/slack-alert-triage`
(MX-5119): `[service] Issue name - actual cause` titles, dedupe against open tickets before creating.

## Deeper code archaeology (removed from Phase 4 for the MVP)
- Release-tag diff: `git tag --sort=-v:refname`, `git log <prev>..<tag> -- <file>` to say whether the deployed release
  touched the failing file (needs full clones; Agent1 clones projects shallow).
- Open PRs touching the file: `gh pr list --search "<basename>" --state open`.
- Deploy-in-window detection from the Jenkins line + `service.version` first-seen (available in Kibana).

## Restart / autoscaling interpretation (moved out of the skill)
"Restarts" in ECS are usually CPU step scaling, not crashes: equal counts of `Started Application in` and `SIGTERM received`
lines, startups in pairs every ~8 min (cooldown_up 420 s) and one SIGTERM every ~3 min an hour later (cooldown_down 120 s),
CPU thresholds 85 % up / 45 % down, min/max from `tasks_count`/`tasks_max_count` in the service's `terraform/prod.tfvars`
(module `ops-tf-module-ecs-app`). Crashes look different: no SIGTERM before the startup, `OutOfMemoryError`, exit-code lines.
Re-add as a reference the skill reads only for `[SRE0056]`/restart alerts.

## n8n hybrid shell (event-driven or bot identity)
Deterministic n8n steps around the Agent1 analysis: Schedule → Slack read (`conversations.history` + `conversations.replies`
with a team bot token) → Data Table dedupe → `POST /api/tasks` on Agent1 (team's own Agent1 credential) → second workflow on
`Agent1 Trigger` (`awaiting_review`) → Slack node posts with the **bot** credential and `thread_ts`. Gains: bot identity,
self-service team registry (Data Table), error-handler e-mails. Constraints (verified 2026-09-14): the n8n Slack Trigger cannot
be used (internal ALB), 3 concurrent executions instance-wide, 30-min execution cap, auto-deactivation after 3 failures,
`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`. Precedents: `wkda/call-center-alert-agent-playbook` (workflow export pattern),
`wkda/slack-fwd` (Socket-Mode `<!subteam^…>` matcher, QA only) for a true event trigger.
