# Operations runbook

All commands run from the repo root. `AGENT1_API_KEY` is the operator's personal Agent1 key (`cci_production_…`); it is read
from the environment only and never printed.

## See what the bot did

- Ledger: `node plugins/rota-triage/scripts/ledger.js status --monitor <team>` (locally: `~/.claude/rota-triage/<team>/ledger.json`; on Agent1 the same command inside a task, or read `/app/task-context/rota-triage/<team>/ledger.json` from a one-off task).
- Task and runs: `plugins/rota-triage/scripts/agent1-bootstrap.sh status <taskId>` — schedule state, next run, last runs with status and cost.
- Team channel: every handled alert produces one post; a `⏱ … no successful run since …` line means the task is not running.

## Pause / resume / run now

```
plugins/rota-triage/scripts/agent1-bootstrap.sh disable <taskId>
plugins/rota-triage/scripts/agent1-bootstrap.sh enable  <taskId>
plugins/rota-triage/scripts/agent1-bootstrap.sh run-now <taskId>
```

## Reset the watermark or re-triage a thread

The watermark only moves forward (`ledger.js advance`). To re-process something, run a one-off Agent1 task (or a local run)
with an explicit window: `--since 3d` ignores the watermark; `<permalink>` handles exactly one message. Both refuse to
re-post into a thread the ledger already lists under `repliedThreads` — delete that key from the ledger JSON (on Agent1: from
inside a task, since the file lives on the task's `/app/task-context` volume) if a repost is really wanted.

## Rotate the key or move the task to another owner

1. New owner: link Slack, save the GitHub PAT and the Kibana PROD key in Agent1 Integrations, create a personal API key.
2. `disable <oldTaskId>`, then `create --monitor <team> …` with the new owner's key. The new task gets a new
   `/app/task-context`; the ledger starts from `firstRunLookbackHours` (2 h), so at most two hours are re-checked and the
   replied-guard (signature line in the thread) prevents duplicates.
3. Update `owner` and `agent1.keyOwner` in `config/monitors/<team>.json` via PR.

## Promote learned service → repo mappings

The skill writes discoveries to `services.local.json` in the team state dir. Copy stable entries into
`plugins/rota-triage/config/services.json` via PR so every team benefits.

## Failure signatures

| Symptom | Likely cause | Fix |
|---|---|---|
| Runs end with `Slack search tool missing` | Agent has no Slack MCP or owner's Slack link expired | Re-link Slack in Agent1; check `mcpBindings.slack.accountKey` on the agent |
| `elasticKey.source: none` in the run log | Owner has no Kibana PROD key in Integrations | Save the key; the plugin writes it to the keys file on the next run |
| Thread replies fail, team posts carry the full analysis | Runner cannot post into the source channel | Owner must be a member of the channel; if it is externally shared, verify posting rights |
| Every run posts nothing, watermark advances | Search returns the bot's tag replies with empty text | Check `slack.searchTerms` matches the user-group handle; the skill reads threads to confirm tokens |
| Task shows `timed_out` runs | > 2 h per run | Lower `poll.maxPerRun`; check Kibana latency |
