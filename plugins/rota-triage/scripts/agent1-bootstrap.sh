#!/usr/bin/env bash
# Create / manage the Agent1 scheduled task that runs rota-triage for one team monitor.
#
#   AGENT1_API_KEY=cci_production_… scripts/agent1-bootstrap.sh create --monitor remex --repo https://github.com/wkda/rota-triage-bot \
#       [--branch main] [--agent-id <id>] [--board-id <id>] [--cron "*/10 * * * *"] [--timezone Europe/Berlin] \
#       [--extra-args "--since 3d --dry-run"] [--run-now] [--base https://agent1.prod.apps.auto1.team]
#   scripts/agent1-bootstrap.sh status  <taskId>
#   scripts/agent1-bootstrap.sh disable <taskId>      # pause the schedule
#   scripts/agent1-bootstrap.sh enable  <taskId>      # resume the schedule
#   scripts/agent1-bootstrap.sh run-now <taskId>      # out-of-band run
#
# agent-id / board-id default to config/monitors/<team>.json → agent1.agentId / agent1.boardId (team-owned agent + board,
# so runs and cost are accounted to the team). The API key is read from AGENT1_API_KEY only, passed to curl through a
# config file descriptor, never on the command line or in output. No jq needed (node does the JSON).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
TEMPLATE="$REPO_ROOT/docs/agent1-task-description.md"

cmd="${1:-}"; shift || true
BASE="${AGENT1_BASE_URL:-https://agent1.prod.apps.auto1.team}"
MONITOR=""; REPO=""; BRANCH="main"; AGENT_ID=""; BOARD_ID=""; CRON="*/10 * * * *"; TZ_NAME="Europe/Berlin"; EXTRA=""; RUN_NOW=0; TASK_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --monitor) MONITOR="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --agent-id) AGENT_ID="$2"; shift 2;;
    --board-id) BOARD_ID="$2"; shift 2;;
    --cron) CRON="$2"; shift 2;;
    --timezone) TZ_NAME="$2"; shift 2;;
    --extra-args) EXTRA="$2"; shift 2;;
    --run-now) RUN_NOW=1; shift;;
    --base) BASE="$2"; shift 2;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) if [ -z "$TASK_ID" ]; then TASK_ID="$1"; shift; else echo "unknown argument: $1" >&2; exit 2; fi;;
  esac
done

[ -n "${AGENT1_API_KEY:-}" ] || { echo "AGENT1_API_KEY is not set (personal Agent1 key, cci_production_…)" >&2; exit 2; }
case "$AGENT1_API_KEY" in cci_production_*|agent1_*) ;; *) echo "AGENT1_API_KEY does not look like an Agent1 key" >&2; exit 2;; esac

# curl reads the Authorization header from a config file on a private fd — the key never appears in argv or logs.
api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local out code
  if [ -n "$body" ]; then
    out="$(curl -sS --max-time 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$AGENT1_API_KEY") \
          -H "Content-Type: application/json" -X "$method" "$BASE$path" --data-binary "$body" -w '\n%{http_code}')"
  else
    out="$(curl -sS --max-time 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$AGENT1_API_KEY") \
          -X "$method" "$BASE$path" -w '\n%{http_code}')"
  fi
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "${code:0:1}" != "2" ]; then echo "HTTP $code from $method $path" >&2; echo "$body" | head -c 1500 >&2; echo >&2; return 1; fi
  printf '%s' "$body"
}

json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const p=process.argv[1].split("."); let v=j; for (const k of p){ v = v==null?undefined:v[k]; } process.stdout.write(v==null?"":String(typeof v==="object"?JSON.stringify(v):v));' "$1"; }

case "$cmd" in
  create)
    [ -n "$MONITOR" ] || { echo "--monitor <team> is required" >&2; exit 2; }
    [ -n "$REPO" ] || { echo "--repo https://github.com/<owner>/<repo> is required" >&2; exit 2; }
    [ -f "$TEMPLATE" ] || { echo "missing template $TEMPLATE" >&2; exit 2; }
    node "$HERE/monitor.js" validate --monitor "$MONITOR" >/dev/null || { echo "monitor config invalid — fix it first (node scripts/monitor.js validate --monitor $MONITOR)" >&2; exit 2; }
    cfg="$(node "$HERE/monitor.js" resolve --monitor "$MONITOR")"
    [ -n "$AGENT_ID" ] || AGENT_ID="$(printf '%s' "$cfg" | json_get agent1.agentId)"
    [ -n "$BOARD_ID" ] || BOARD_ID="$(printf '%s' "$cfg" | json_get agent1.boardId)"
    [ -n "$AGENT_ID" ] && [ -n "$BOARD_ID" ] || { echo "agent1.agentId and agent1.boardId are required (team-owned agent and board → per-team accounting)" >&2; exit 2; }
    repo_name="$(basename "${REPO%.git}")"
    desc="$(node -e '
      const fs=require("fs"); let t=fs.readFileSync(process.argv[1],"utf8");
      const vars={MONITOR:process.argv[2],REPO_NAME:process.argv[3],EXTRA_ARGS:process.argv[4]};
      for (const [k,v] of Object.entries(vars)) t=t.split("{{"+k+"}}").join(v);
      process.stdout.write(t);' "$TEMPLATE" "$MONITOR" "$repo_name" "$EXTRA")"
    payload="$(node -e '
      const [title,desc,agentId,boardId,repo,branch,autoStart]=process.argv.slice(1);
      process.stdout.write(JSON.stringify({title,description:desc,agentId,boardId,selectedPlugins:["kibana"],
        projects:[{repoUrl:repo,branch}],taskType:"private",autoStart:autoStart==="1",
        metadata:{rotaTriage:{monitor:title.split(" · ")[1],createdBy:"agent1-bootstrap.sh"}}}));' \
      "rota-triage · $MONITOR" "$desc" "$AGENT_ID" "$BOARD_ID" "$REPO" "$BRANCH" "$RUN_NOW")"
    echo "creating task 'rota-triage · $MONITOR' on $BASE (agent $AGENT_ID, board $BOARD_ID, repo $REPO@$BRANCH, autoStart=$RUN_NOW)"
    resp="$(api POST /api/tasks "$payload")"
    task_id="$(printf '%s' "$resp" | json_get task.id)"
    [ -n "$task_id" ] || { echo "no task id in response:" >&2; printf '%s\n' "$resp" | head -c 1500 >&2; exit 1; }
    echo "task id: $task_id  →  $BASE/tasks/$task_id"
    if [ "$RUN_NOW" = "1" ]; then
      echo "autoStart: $(printf '%s' "$resp" | json_get autoStart)"
    else
      start_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      end_at="$(date -u -v+1y +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 year' +%Y-%m-%dT%H:%M:%SZ)"
      sched="$(node -e 'const [cron,startAt,endAt,tz]=process.argv.slice(1); process.stdout.write(JSON.stringify({cronExpression:cron,startAt,endAt,maxRuns:null,enabled:true,timezone:tz,notify:false}));' "$CRON" "$start_at" "$end_at" "$TZ_NAME")"
      api PATCH "/api/tasks/$task_id/schedule" "$sched" >/dev/null
      echo "schedule: $CRON ($TZ_NAME), until $end_at, notify=false"
    fi
    ;;
  status)
    [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }
    api GET "/api/tasks/$TASK_ID" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const t=j.task||j; const m=t.metadata||{};
      console.log(JSON.stringify({id:t.id,title:t.title,status:t.status,activeSessionId:t.activeSessionId||null,scheduleEnabled:t.scheduleEnabled??t.schedule_enabled??m.scheduleEnabled,
        cron:t.cronExpression||t.cron_expression||m.cronExpression,nextRunAt:t.nextRunAt||t.next_run_at,runCount:t.runCount||t.run_count,lastRunAt:t.lastRunAt||t.last_run_at},null,2));'
    echo "runs:"; api GET "/api/tasks/$TASK_ID/runs" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const runs=j.runs||j; for (const r of (Array.isArray(runs)?runs:[]).slice(0,10)) console.log(" ", r.startedAt||r.started_at, r.status, "cost", r.costUsd??r.cost_usd??"-", "duration", r.durationMs??r.duration_ms??"-");'
    ;;
  disable) [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }; api POST "/api/tasks/$TASK_ID/schedule/pause" "{}" >/dev/null && echo "schedule paused for $TASK_ID";;
  enable)  [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }; api POST "/api/tasks/$TASK_ID/schedule/resume" "{}" >/dev/null && echo "schedule resumed for $TASK_ID";;
  run-now) [ -n "$TASK_ID" ] || { echo "task id required" >&2; exit 2; }; api POST "/api/tasks/$TASK_ID/run-now" "{}" | head -c 600; echo;;
  *) sed -n '2,20p' "$0"; exit 2;;
esac
