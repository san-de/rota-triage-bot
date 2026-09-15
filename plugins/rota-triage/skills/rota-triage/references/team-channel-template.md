# Team channel post — one short message per tagged alert, posted in `output.teamChannelId`

Under 600 characters. Links: the alert thread (`{workspaceUrl}/archives/{channelId}/p{threadTs without the dot}`) and the
triage reply (`{workspaceUrl}/archives/{channelId}/p{replyTs without the dot}?thread_ts={threadTs}&cid={channelId}`).

```
🔎 *[{SRE_CODE}] {service}* · *{classification}* · tagged {tagger} {t_local}
{one-line read} · Proposal: {one line}
<{thread_permalink}|alert thread> · <{reply_permalink}|triage reply>{ · Gaps: {gaps}}
```

## Fallback when the thread reply failed

If `slack_send_message` into the alert thread was refused twice (for example a channel the runner cannot post into),
post the **full thread-reply body** to the team channel instead, prefixed with one line:

```
⚠ could not reply in <{thread_permalink}|the alert thread> ({reason}) — analysis below
```

and record the entry with `status: "team-only"`. Never post drafts and never post into any other channel.

## Health line (once per run, only when needed)

When `ledger.js run-note` reports `lastSuccessfulRunAt` older than 2 hours (or null with a ledger that has runs), post one line:

```
⏱ rota-triage for @{team}: no successful run since {lastSuccessfulRunAt local} — check the Agent1 task "rota-triage · {team}"
```
