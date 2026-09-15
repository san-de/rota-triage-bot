# DM template — optional, only when `output.dmUserIds` is non-empty

One Slack DM per tagged message and recipient (`slack_send_message` with the user id as `channel_id`, `unfurl_app_links=false`).
Body = the thread-reply body (see `thread-reply-template.md`) under this header; under 3,500 characters. When more than
`poll.maxPerRunBeforeNumbering` alerts are handled in one run, prefix the first line with `(k/n) `.

```
🔎 *rota-triage · [{SRE_CODE}] {service} · {alert_time_local}* — <{thread_permalink}|alert thread> · <{reply_permalink}|triage reply>
*Tagged by:* {tagger_name} — <{tagged_message_permalink}|message>  ·  *Incident:* {SI-… link or none}  ·  *Last deploy:* {release_tag}, {deploy_age} ago by {deployer}
*Ask:* "{what the tagger asked, ≤ 140 chars}"

{thread-reply body without its signature line}
```

## Terminal echo (dry-run and after posting)

```
posted    <permalink>  <service>  <classification>  reply_ts=<ts> team_ts=<ts>
team-only <permalink>  <service>  <classification>  reason=<…>
dry-run   <permalink>  <service>  <classification>
skipped   <permalink>  <reason>
failed    <permalink>  <reason>
watermark <ts> (<local time>) · ledger <path>
```
