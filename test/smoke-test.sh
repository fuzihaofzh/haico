#!/bin/bash
# Argus Smoke Test - 端到端测试
# 用 echo/sleep 模拟 agent，验证完整工作流

set -e

BASE="http://localhost:3099"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}► $1${NC}"; }

# ── 清理旧数据 ──
info "Cleaning up old test data..."
rm -f "$(dirname "$0")/../data/argus.db"

# ── 启动服务器 ──
info "Starting Argus server on port 3099..."
cd "$(dirname "$0")/.."
ARGUS_PORT=3099 node dist/index.js &
SERVER_PID=$!
sleep 2

# 确保退出时清理
cleanup() {
  info "Cleaning up..."
  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# 检查服务器是否启动
curl -sf "$BASE/login" > /dev/null 2>&1 || curl -sf "$BASE/setup" > /dev/null 2>&1
pass "Server started"

# ── 1. 设置密码 ──
info "1. Setting up password..."
RES=$(curl -sf -X POST "$BASE/api/auth/setup" \
  -H "Content-Type: application/json" \
  -d '{"password":"test1234"}')
echo "$RES" | grep -q '"ok":true' && pass "Password setup" || fail "Password setup: $RES"

# ── 2. 登录 ──
info "2. Logging in..."
RES=$(curl -sf -X POST "$BASE/api/auth" \
  -H "Content-Type: application/json" \
  -d '{"password":"test1234"}' \
  -c /tmp/argus-test-cookies)
echo "$RES" | grep -q '"ok":true' && pass "Login" || fail "Login: $RES"

# ── 3. 创建项目 ──
info "3. Creating project..."
PROJECT=$(curl -sf -X POST "$BASE/api/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-project",
    "description": "Smoke test project",
    "task_description": "This is a test task for verifying the system works.",
    "command_template": "echo \"Agent running: {prompt}\" && sleep 2 && echo \"Agent done.\""
  }')
PROJECT_ID=$(echo "$PROJECT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$PROJECT_ID" ] && pass "Project created: $PROJECT_ID" || fail "Project creation: $PROJECT"

# ── 4. 列出项目 ──
info "4. Listing projects..."
PROJECTS=$(curl -sf "$BASE/api/projects")
echo "$PROJECTS" | grep -q "$PROJECT_ID" && pass "Project listed" || fail "Project not in list"

# ── 5. 获取项目详情 ──
info "5. Getting project details..."
DETAIL=$(curl -sf "$BASE/api/projects/$PROJECT_ID")
echo "$DETAIL" | grep -q "test-project" && pass "Project detail" || fail "Project detail: $DETAIL"

# ── 6. 检查自动创建的 controller agent ──
info "6. Checking auto-created controller agent..."
AGENTS=$(curl -sf "$BASE/api/projects/$PROJECT_ID/agents")
CONTROLLER_ID=$(echo "$AGENTS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$AGENTS" | grep -q '"is_controller":1' && pass "Controller agent created: $CONTROLLER_ID" || fail "No controller: $AGENTS"

# ── 7. 创建 worker agent ──
info "7. Creating worker agent..."
WORKER=$(curl -sf -X POST "$BASE/api/projects/$PROJECT_ID/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"worker-1","role":"Test worker agent","working_directory":"/tmp"}')
WORKER_ID=$(echo "$WORKER" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$WORKER_ID" ] && pass "Worker created: $WORKER_ID" || fail "Worker creation: $WORKER"

# ── 8. 获取 agent 详情 ──
info "8. Getting agent details..."
AGENT_DETAIL=$(curl -sf "$BASE/api/agents/$WORKER_ID")
echo "$AGENT_DETAIL" | grep -q "worker-1" && pass "Agent detail" || fail "Agent detail: $AGENT_DETAIL"

# ── 9. 启动 worker agent ──
info "9. Starting worker agent..."
START=$(curl -sf -X POST "$BASE/api/agents/$WORKER_ID/start" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello from smoke test!"}')
echo "$START" | grep -q '"success":true' && pass "Agent started" || fail "Agent start: $START"

# ── 10. 检查 agent 状态（应该是 running）──
info "10. Checking agent status (should be running)..."
sleep 0.5
STATUS=$(curl -sf "$BASE/api/agents/$WORKER_ID/status")
echo "$STATUS" | grep -q '"status":"running"' && pass "Agent is running" || {
  # 如果 echo 太快已经结束了
  echo "$STATUS" | grep -q '"status":"idle"' && pass "Agent already finished (fast)" || fail "Unexpected status: $STATUS"
}

# ── 11. 等待 agent 完成 ──
info "11. Waiting for agent to finish..."
sleep 3
STATUS=$(curl -sf "$BASE/api/agents/$WORKER_ID/status")
echo "$STATUS" | grep -q '"status":"idle"\|"status":"error"' && pass "Agent finished" || fail "Agent still running: $STATUS"

# ── 12. 检查日志 ──
info "12. Checking conversation logs..."
LOGS=$(curl -sf "$BASE/api/agents/$WORKER_ID/logs")
echo "$LOGS" | grep -q "Hello from smoke test" && pass "Logs contain prompt output" || fail "Logs missing output: $LOGS"
echo "$LOGS" | grep -q "Agent done" && pass "Logs contain completion" || fail "Logs missing completion: $LOGS"

# ── 13. 发送消息 ──
info "13. Sending message..."
MSG=$(curl -sf -X POST "$BASE/api/projects/$PROJECT_ID/messages" \
  -H "Content-Type: application/json" \
  -d "{\"from_id\":\"user\",\"to_id\":\"$CONTROLLER_ID\",\"subject\":\"Test message\",\"body\":\"Hello controller!\"}")
MSG_ID=$(echo "$MSG" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$MSG_ID" ] && pass "Message sent: $MSG_ID" || fail "Message send: $MSG"

# ── 14. 获取消息列表 ──
info "14. Listing messages..."
MSGS=$(curl -sf "$BASE/api/projects/$PROJECT_ID/messages")
echo "$MSGS" | grep -q "Test message" && pass "Message listed" || fail "Message not found: $MSGS"

# ── 15. 过滤未读消息 ──
info "15. Filtering unread messages..."
UNREAD=$(curl -sf "$BASE/api/projects/$PROJECT_ID/messages?to=$CONTROLLER_ID&unread=true")
echo "$UNREAD" | grep -q "Hello controller" && pass "Unread message filtered" || fail "Unread filter: $UNREAD"

# ── 16. 标记已读 ──
info "16. Marking message as read..."
READ_RES=$(curl -sf -X PUT "$BASE/api/messages/$MSG_ID/read")
echo "$READ_RES" | grep -q '"success":true' && pass "Message marked read" || fail "Mark read: $READ_RES"

# 验证已读后过滤不到
UNREAD2=$(curl -sf "$BASE/api/projects/$PROJECT_ID/messages?to=$CONTROLLER_ID&unread=true")
echo "$UNREAD2" | grep -q "Hello controller" && fail "Message still shows as unread" || pass "Unread filter correct after marking read"

# ── 17. 更新项目 ──
info "17. Updating project..."
UPDATE=$(curl -sf -X PUT "$BASE/api/projects/$PROJECT_ID" \
  -H "Content-Type: application/json" \
  -d '{"description":"Updated description","command_template":"echo Updated: {prompt}"}')
echo "$UPDATE" | grep -q "Updated description" && pass "Project updated" || fail "Project update: $UPDATE"

# ── 18. 启动 agent 并停止 ──
info "18. Testing agent stop..."
# 用 sleep 30 模拟长时间运行
curl -sf -X PUT "$BASE/api/projects/$PROJECT_ID" \
  -H "Content-Type: application/json" \
  -d '{"command_template":"sleep 30"}' > /dev/null
START2=$(curl -sf -X POST "$BASE/api/agents/$WORKER_ID/start" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"long running task"}')
echo "$START2" | grep -q '"success":true' && pass "Long agent started" || fail "Start long agent: $START2"
sleep 1
STOP=$(curl -sf -X POST "$BASE/api/agents/$WORKER_ID/stop")
echo "$STOP" | grep -q '"success":true' && pass "Agent stop requested" || fail "Agent stop: $STOP"
sleep 2
STATUS2=$(curl -sf "$BASE/api/agents/$WORKER_ID/status")
echo "$STATUS2" | grep -qv '"status":"running"' && pass "Agent stopped" || fail "Agent still running after stop: $STATUS2"

# ── 19. 测试重复启动防护 ──
info "19. Testing duplicate start protection..."
# 恢复命令模板
curl -sf -X PUT "$BASE/api/projects/$PROJECT_ID" \
  -H "Content-Type: application/json" \
  -d '{"command_template":"sleep 10"}' > /dev/null
curl -sf -X POST "$BASE/api/agents/$WORKER_ID/start" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"first"}' > /dev/null
sleep 0.5
DUP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/agents/$WORKER_ID/start" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"second"}')
[ "$DUP" = "409" ] && pass "Duplicate start rejected (409)" || fail "Duplicate start not rejected: HTTP $DUP"
curl -sf -X POST "$BASE/api/agents/$WORKER_ID/stop" > /dev/null
sleep 1

# ── 20. 删除 agent ──
info "20. Deleting agent..."
DEL=$(curl -sf -X DELETE "$BASE/api/agents/$WORKER_ID")
echo "$DEL" | grep -q '"success":true' && pass "Agent deleted" || fail "Agent delete: $DEL"

# 验证已删除
DEL_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/agents/$WORKER_ID")
[ "$DEL_CHECK" = "404" ] && pass "Agent confirmed deleted (404)" || fail "Agent still exists: $DEL_CHECK"

# ── 21. 删除项目（级联删除）──
info "21. Deleting project (cascade)..."
DEL_P=$(curl -sf -X DELETE "$BASE/api/projects/$PROJECT_ID")
echo "$DEL_P" | grep -q '"success":true' && pass "Project deleted" || fail "Project delete: $DEL_P"

# 验证 controller agent 也被级联删除
CTRL_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/agents/$CONTROLLER_ID")
[ "$CTRL_CHECK" = "404" ] && pass "Controller agent cascade deleted" || fail "Controller still exists: $CTRL_CHECK"

# ── 22. 测试远程访问需要认证 ──
info "22. Testing auth enforcement..."
# 不带 cookie 从"非 localhost"视角测试（这里只能验证 API 结构正确）
AUTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects")
# localhost 免认证，所以这里应该返回 200
[ "$AUTH_CHECK" = "200" ] && pass "Localhost bypasses auth" || fail "Localhost auth: HTTP $AUTH_CHECK"

echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  All tests passed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
