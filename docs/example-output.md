# Example output

Rendered from a real case (REMEX, `[SRE0059] DLQ Received New Message | msi-service-queue-production-dlq`, nightly since
2026-09-01) using `references/thread-reply-template.md` and `references/team-channel-template.md`. Names of people are omitted.

## Thread reply (posted under the alert, 3,120 characters)

```
🤖 automated triage by rota-triage on behalf of @remex-be — a human from the team will follow up; reply here if this is wrong
*What happens:* Every night at 04:30 CEST one message arrives on `msi-service-queue`; its handler calls car-details `POST /car-details/zrt/search/filter`, which answers 200 in 5.03–5.22 s. merchant-self-inspection's read timeout for car-details is 5,000 ms, so every attempt fails, SQS redelivers every 30 s, and after the 10th receive (04:34:35) the message lands in the DLQ. 20 ERROR lines per night, identical on every night since 01 Sep.
*Where:* `wkda/merchant-self-inspection-service` — <https://github.com/wkda/merchant-self-inspection-service/blob/master/src/main/java/wkda/api/msi/service/client/CarZrtService.java#L63|CarZrtService.java:63> (`CarZrtApi.search` / `searchExtended`) · last touched 9a71249 "REMEX-2059 add request mobile evaluator endpoint" (2025-11-17) · `openfeign.client.config.car-details.read-timeout: 5000` in java-application-config `aws/merchant-self-inspection-service-sb3-production-aws.yml`
*Read:* *upstream dependency* — car-details' zrt filter for this nightly call takes ~5.1 s, just over the 5 s client timeout, so the message can never succeed; nothing changed in MSI, the car-details query crossed the limit around 01 Sep. The DLQ holds ~14 identical messages.
*Proposal:* raise `car-details.read-timeout` for MSI to 8–10 s (prod, sb3 profile) and redrive the DLQ once; ask the car-details owners about the ~5 s `car_zrt` filter query.
*Evidence:* • `SocketTimeoutException: Read timed out` → `ResponseFeignException` → `ListenerExecutionFailedException: Error processing message <uuid>` — 20× per night (10 attempts × 2 loggers), error.id `04406d1e`, trace.id `1345769712e88cbf` • SQS message 04:30:00 → car-details POST /car-details/zrt/search/filter 200 in 5,221 ms (car-details: "Slow query took 5185 ms") → timeout at 5,000 ms • <https://kibana.prod.services.auto1.team/app/discover#/?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'2026-09-14T02:25:00Z',mode:absolute,to:'2026-09-14T02:40:00Z'))&_a=(columns:!(service.name,log.level,message,trace.id,error.stack_trace),dataSource:(dataViewId:'*beat-*',type:dataView),filters:!(),query:(language:kuery,query:'service.name:%22merchant-self-inspection%22%20and%20log.level:ERROR'))|Kibana> · <https://grafana.prod.services.auto1.team/d/kQO3Xa1Mz/sqs-utilization?orgId=1&var-account=All&var-queue=msi-service-queue-production|Grafana>
*Open points:* which producer sends the 04:30 message (no tracing metadata on it)? · *Gaps:* app frames trimmed in the stack trace; producer not identifiable from logs
```

## Team channel post (#team-remex-be)

```
🔎 *[SRE0059] merchant-self-inspection* · *upstream dependency* · tagged sre bot 05:00 CEST
car-details zrt filter answers in ~5.1 s against MSI's 5 s read timeout; the nightly message dies after 10 attempts and lands in the DLQ (every night since 01 Sep) · Proposal: raise MSI's car-details read-timeout to 8–10 s and redrive the DLQ once
<https://wkda-eng.slack.com/archives/C0K4U8ZS7/p1789354801516039|alert thread> · <https://wkda-eng.slack.com/archives/C0K4U8ZS7/p1789354900123456?thread_ts=1789354801.516039&cid=C0K4U8ZS7|triage reply> · Gaps: producer of the 04:30 message not identifiable
```

## Terminal summary

```
posted    https://wkda-eng.slack.com/archives/C0K4U8ZS7/p1789354805176499?thread_ts=1789354801.516039  merchant-self-inspection  upstream dependency  reply_ts=1789354900.123456 team_ts=1789354905.654321
watermark 1789354805.176499 (2026-09-14 05:00:05 CEST) · ledger /app/task-context/rota-triage/remex/ledger.json
```
