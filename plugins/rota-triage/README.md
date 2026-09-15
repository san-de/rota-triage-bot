# rota-triage (plugin)

The skill and its helpers. Start with the repository README for the overall picture and onboarding.

- `skills/rota-triage/SKILL.md` — the playbook. Phase 0 config/ledger/preflight · 1 find tags (deterministic via
  `slack-scan.js`) · 2 alert context + Kibana links · 3 Kibana analysis (+ 3b deterministic lookup) · 4 code location
  (MVP scope) · 5 post, then ledger.
- `skills/rota-triage/references/` — `kibana-links.md` (three link shapes), `analysis-questions.md` (Kibana agent questions),
  `thread-reply-template.md`, `team-channel-template.md`, `dm-template.md`.
- `config/monitors/<team>.json` — one file per team; `_example.json` is the template. `config/services.json` maps
  `service.name` → repo (+ `knownNoise`, `knownIssues`).
- `scripts/monitor.js` — `list | resolve --monitor <team> | validate` (merged config, runtime mode, state paths, Kibana key source).
- `scripts/ledger.js` — `init | status | has <ts> | has-thread <thread_ts> | mark <ts> --json | advance <ts> | run-note --json`.
- `scripts/slack-scan.js` — turns the Slack search/thread material into the ordered candidate list, applying the monitor's
  rules and the ledger.
- `scripts/kibana-url.js`, `scripts/lz-decode.js`, `scripts/kibana-shorturl.js` — Discover URL / lz locator / short link →
  service, window, filters.
- `scripts/kibana-search.js` — read-only lookup through `/internal/search/es` (`--key-check` shows where the key comes from).
- `scripts/lib/elastic-key.js` — key resolution: env → `ELASTIC_API_KEY_FILE` / `~/.config/auto1-kibana/keys.json`.
- `scripts/agent1-bootstrap.sh` — create / status / disable / enable / run-now for the Agent1 scheduled task.

State (`ledger.json`, `services.local.json`) never lives here: `ROTA_TRIAGE_STATE_DIR`, else `/app/task-context/rota-triage/<team>`
on Agent1, else `~/.claude/rota-triage/<team>`.
