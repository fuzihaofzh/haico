#!/bin/bash
# End-to-end test: create project, trigger controller, wait, check results
# Must run WITHOUT proxychains: env -u LD_PRELOAD bash test/run-e2e.sh

set -e
unset LD_PRELOAD PROXYCHAINS_CONF_FILE PROXYCHAINS_QUIET_MODE

HOST="http://127.0.0.1:4567"
COOKIE="/tmp/argus-e2e-cookie.txt"
GREEN='\033[32m'
CYAN='\033[36m'
NC='\033[0m'

info() { echo -e "${CYAN}► $1${NC}"; }
ok() { echo -e "${GREEN}✓ $1${NC}"; }

# Auth
info "Setting up auth..."
curl -s -X POST "$HOST/api/auth/setup" -H "Content-Type: application/json" -d '{"password":"test1234"}' -c "$COOKIE" > /dev/null 2>&1 || true
curl -s -X POST "$HOST/api/auth" -H "Content-Type: application/json" -d '{"password":"test1234"}' -c "$COOKIE" > /dev/null
ok "Authenticated"

# Clean old projects
for id in $(curl -s -b "$COOKIE" "$HOST/api/projects" | python3 -c "import sys,json;[print(p['id']) for p in json.load(sys.stdin)]" 2>/dev/null); do
  curl -s -b "$COOKIE" -X DELETE "$HOST/api/projects/$id" > /dev/null
done
ok "Cleaned old projects"

# Create project
info "Creating project..."
cat > /tmp/argus-proj.json << 'EOF'
{
  "name": "argus-self-review",
  "description": "Agents review the Argus codebase",
  "task_description": "You are managing a code review of the Argus project at /misc/projdata11/info_fil/zhfu/lin/argus. Create 2 workers: one to count files and lines of code, one to find TODO/FIXME and code quality issues. Assign each worker an issue describing their task. Start them, wait for results in issue comments, then compile a summary issue for the user."
}
EOF

PID=$(curl -s -b "$COOKIE" -X POST "$HOST/api/projects" -H "Content-Type: application/json" -d @/tmp/argus-proj.json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
ok "Project: $PID"

CTRL=$(curl -s -b "$COOKIE" "$HOST/api/projects/$PID/agents" | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin) if a['is_controller']][0])")
ok "Controller: $CTRL"

# Trigger
info "Triggering controller..."
curl -s -b "$COOKIE" -X POST "$HOST/api/agents/$CTRL/start" -H "Content-Type: application/json" -d '{}' > /dev/null
ok "Controller started"

# Wait for controller to finish
info "Waiting for controller (max 3 min)..."
for i in $(seq 1 36); do
  sleep 5
  STATUS=$(curl -s -b "$COOKIE" "$HOST/api/agents/$CTRL/status" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])" 2>/dev/null)
  printf "  [%2d] %s\n" "$i" "$STATUS"
  if [ "$STATUS" = "idle" ] || [ "$STATUS" = "error" ]; then break; fi
done
ok "Controller finished: $STATUS"

# Wait a bit for workers that controller may have started
info "Waiting for workers to finish (max 3 min)..."
for i in $(seq 1 36); do
  RUNNING=$(curl -s -b "$COOKIE" "$HOST/api/projects/$PID/agents" | python3 -c "import sys,json;print(sum(1 for a in json.load(sys.stdin) if a['status']=='running'))" 2>/dev/null)
  printf "  [%2d] %s running\n" "$i" "$RUNNING"
  if [ "$RUNNING" = "0" ]; then break; fi
  sleep 5
done
ok "All agents idle"

echo ""
echo "============================================"
echo " RESULTS"
echo "============================================"

echo ""
info "AGENTS:"
curl -s -b "$COOKIE" "$HOST/api/projects/$PID/agents" | python3 -c "
import sys,json
for a in json.load(sys.stdin):
    ctrl = ' [controller]' if a['is_controller'] else ''
    print(f'  {a[\"name\"]:40} [{a[\"status\"]:8}]{ctrl}')
"

echo ""
info "ISSUES:"
curl -s -b "$COOKIE" "$HOST/api/projects/$PID/issues" | python3 -c "
import sys,json
issues = json.load(sys.stdin)
for i in issues:
    assigned = i.get('assigned_to','unassigned') or 'unassigned'
    print(f'  #{i[\"number\"]:2} [{i[\"status\"]:12}] {i[\"title\"]}')
"

echo ""
info "ISSUE DETAILS + COMMENTS:"
ALL_ISSUES=$(curl -s -b "$COOKIE" "$HOST/api/projects/$PID/issues")
for IID in $(echo "$ALL_ISSUES" | python3 -c "import sys,json;[print(i['id']) for i in json.load(sys.stdin)]" 2>/dev/null); do
  curl -s -b "$COOKIE" "$HOST/api/issues/$IID" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n = d.get('comments',[])
print(f'  === #{d[\"number\"]} [{d[\"status\"]}] {d[\"title\"]} ({len(n)} comments) ===')
if d.get('body'):
    for line in d['body'][:300].split('\n')[:5]: print(f'    {line}')
for c in n:
    author = c['author_id'][:20]
    body_preview = c['body'][:200].replace('\n',' ')
    print(f'    💬 [{author}] {body_preview}')
print()
" 2>/dev/null
done

echo ""
info "CONTROLLER OUTPUT (stdout, latest run):"
curl -s -b "$COOKIE" "$HOST/api/agents/$CTRL/logs?limit=20" | python3 -c "
import sys,json
logs=json.load(sys.stdin)
if not logs: print('  (no logs)'); exit()
latest_run = logs[0]['run_id']
for l in reversed(logs):
    if l['run_id'] == latest_run and l['stream'] == 'stdout':
        text = l['content'][:1500]
        # Skip proxychains noise and system prompt echo
        if 'proxychains' in text.lower() or 'Argus Multi-Agent' in text[:50]: continue
        print(text)
" 2>/dev/null

echo ""
echo "============================================"
echo " URL: http://seis10:4567/projects/$PID"
echo "============================================"
