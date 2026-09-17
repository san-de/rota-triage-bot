# Jira ticket template — Phase 6, only when `jira.enabled` is true

One ticket per alert signature, created **after** the thread reply and team post succeeded, never in dry run.
Conventions come from `wkda/a1-platform-claude-code-plugin` → `skills/slack-alert-triage` (MX-5119): title
`[service] Issue name - actual cause`, dedupe against open tickets before creating, and the alert thread gets the key.

## Which kind, which epic

| Classification (Phase 4) | Ticket kind | Epic (`jira.epics`) | Issue type (`jira.issueTypes`) |
|---|---|---|---|
| `new after deploy`, `pre-existing, grew`, `infra` | `bug` | `epics.bug` (REMEX: "Bugs Q3-2026") | `Bug` |
| `upstream dependency` (a limit or config on our side has to change) | `tech-improvement` | `epics.tech-improvement` (REMEX: "Tech Improvement Q3-2026") | `Task` |
| `expected business validation`, `steady noise` | none | — | — |

Only classifications listed in `jira.createFor` produce a ticket. Everything else is recorded in the ledger as
`jira: "skipped (<classification>)"`.

## Dedupe (deterministic, before any create)

JQL, one query: `project = <jira.project> AND statusCategory != Done AND (labels = rota-triage) AND text ~ "<error.id or exception class>"`.
A hit whose summary starts with `[<service>]` → **link, do not create**: post `Tracked in <key>` in the alert thread and
mark the ledger `{"jira":"<key>","jiraAction":"linked"}`. Otherwise create.

## Fields

```
project        <jira.project>
issuetype      <issueTypes[kind]>
parent         <epics[kind]>                      (team-managed project: parent = the epic)
summary        [<service>] <symptom in ≤ 8 words> - <actual cause in ≤ 10 words>
labels         <jira.labels> (+ PROD_ISSUE for kind bug)
priority       High for `new after deploy` and `infra`, Medium otherwise
description    see below (Atlassian document format; plain paragraphs and one bullet list are enough)
```

### Description

```
h3. Alert
[SRE00xx] <alert title> · <service> · first tagged <t_local> · <thread_permalink> · <triage_reply_permalink>

h3. What happens
<the *What happens* paragraph of the thread reply>

h3. Where
<repo> — <path>:<line> (<Class#method>) · last touched <sha> "<subject>" (<date>) · <config key = value>

h3. Read
<classification> — <the *Read* sentence(s)>

h3. Proposal (acceptance criteria for Agent1)
* <one concrete change: config value, code fix direction, or the question for the owning team>
* Unit test covering <the boundary case>
* Integration tests run in Jenkins; do not run them in the worker

h3. Evidence
* <exception line> — <n>× in window, first <t>, trace.id <id>, error.id <id>
* <request story>
* Kibana: <resolved Discover URL> · Grafana: <url> · Jenkins: <url>

h3. Open points / Gaps
<open points> · <gaps>

_Created by rota-triage (automated). The Agent1 board sync rule "<jira.board.syncRule>" imports tickets labelled agent-one._
```

## After creation

1. `slack_send_message` in the alert thread: `:jira: <key> created under <epic key> (<epic summary>) — labelled agent-one for the REMEX Agent1 board.`
2. `ledger.js mark <ts> --json '{"jira":"<key>","jiraAction":"created","jiraKind":"<kind>"}'`.
3. The team-channel post gets ` · <key>` appended only if it has not been sent yet; never edit sent messages.

## Guardrails

- Never create a ticket in dry run, for a `team-only` post, or when the thread reply failed.
- At most one ticket per alert thread and per run; `poll.maxPerRun` bounds the rest.
- Never transition, assign or comment on existing tickets other than the one created; never touch the epics.
- The Atlassian MCP tools are resolved by name suffix (`createJiraIssue`, `searchJiraIssuesUsingJql`); if absent,
  `Gaps: Jira unavailable` and the ledger records `jira: null`.
