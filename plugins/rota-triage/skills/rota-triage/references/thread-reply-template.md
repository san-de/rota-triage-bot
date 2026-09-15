# Thread reply template — one reply per tagged alert, posted in the alert thread

Render exactly this shape (Slack mrkdwn; `slack_send_message` with the alert **channel id** as `channel_id` and the alert's
`thread_ts`). Keep it under `output.maxChars` (default 3,500) — trim *Evidence* first, then *Where*. Never `reply_broadcast`.
The first line is always `output.signature` verbatim: it tells readers this is automated and it is the marker the
replied-guard looks for on the next run.

```
{output.signature}
*What happens:* {2–3 sentences: symptom, service, when (local time, CEST/CET), how many, delta vs the previous window}
*Where:* `{repo}` — <{blob_url}#L{line}|{path}:{line}> ({Class#method}) · last touched {sha} "{subject}" ({date}) · {config key = value when the cause is a setting}
*Read:* *{classification}* — {1–2 sentences: why it fails, ours or upstream ({upstream_service}), how long it has been happening}
*Proposal:* {one concrete next action for a human: config change with the value, code fix direction, ask the owning team about X, or "ignore — known noise (reason)"}
*Evidence:* • `{Exception}: {message ≤ 120 chars}` — {n}× in the window, first {t_local}, trace.id `{trace_id}`, error.id `{error_id}` • {request story: endpoint → downstream → status in ms} • <{kibana_url}|Kibana> · <{grafana_url}|Grafana> · <{jenkins_url}|Jenkins>
*Open points:* {questions only the team can answer, or "none"} · *Gaps:* {none | Kibana unavailable | repo not found | short link expired | window outside 10-day retention | code frames trimmed}
```

## Rules

- Exactly one classification, from this vocabulary: `new after deploy` · `pre-existing, grew` · `upstream dependency` · `infra` · `expected business validation` · `steady noise`.
- Every number has an aggregation behind it (Kibana agent `tools_run` shows one, or `kibana-search.js` output). No invented counts.
- Quote log lines minimally; no emails, names, full VINs or customer data beyond what identifies the signature.
- Drop a line only when its data is genuinely absent, and say so under *Gaps*.
- No Jira instructions in this phase (ticket creation is a later phase).
- Prefer the human's own Kibana link as `kibana_url` when they tagged with one; otherwise the sre bot's Discover link with the resolved window.
- Local times are Europe/Berlin (CEST/CET), UTC only inside the Kibana query text.
