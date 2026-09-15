# Later phases (parked, not in the MVP)

## Jira ticket creation
When the analysis is trusted, create or link a Jira ticket per alert with the full analysis. Reuse
`wkda/a1-platform-claude-code-plugin` → `skills/slack-alert-triage` (MX-5119): it already dedupes alert signatures against
existing tickets, keeps a `ticket-cache.json`, and writes `[service] Issue name - actual cause` titles. Integration idea:
rota-triage produces the analysis and hands `{service, signature, classification, evidence links}` to that skill's ticket
step; the thread reply then carries the ticket key. Needs: Jira project per team in the monitor config, `acli` or the
Atlassian MCP on the Agent1 agent.

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
