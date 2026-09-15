# Notes for agents editing this repository

- The skill (`plugins/rota-triage/skills/rota-triage/SKILL.md`) is executed unattended on Agent1. Every change must keep it
  runnable without questions: degrade and record under *Gaps*, never prompt.
- Deterministic first: anything expressible as a rule belongs in `plugins/rota-triage/scripts/` (monitor, ledger, slack-scan,
  kibana-search, kibana-shorturl, kibana-url, lz-decode). The model interprets; it does not decide dedupe, matching or state.
- Keep phase numbers stable (references and docs cite them).
- Bump `version` in **both** `.claude-plugin/marketplace.json` and `plugins/rota-triage/.claude-plugin/plugin.json` on every
  change (the marketplace pins versions).
- Never commit state: `ledger.json`, `services.local.json`, key files. State lives outside the repo
  (`ROTA_TRIAGE_STATE_DIR`, `/app/task-context/rota-triage/<team>` on Agent1, `~/.claude/rota-triage/<team>` locally).
- Team config PRs must pass `node plugins/rota-triage/scripts/monitor.js validate`.
- Secrets: Kibana keys are read only inside the scripts (env or `ELASTIC_API_KEY_FILE`); the Agent1 key only inside
  `agent1-bootstrap.sh` through a curl config fd. Nothing ever echoes a key.
- Templates (`references/*-template.md`) define the exact Slack output; change them, not the skill prose, to change what
  gets posted.
