#!/usr/bin/env bash
# 第一阶段闭环的端到端验收脚本。
#
# 前置：本地服务已启动（apps/learning/server.mjs），并已知端口与会话凭据。
#   TOKEN=$(grep -o '"sessionToken":"[a-f0-9]*"' <日志> | head -1 | cut -d'"' -f4)
#   BASE=http://127.0.0.1:4381 TOKEN=... bash scripts/smoke-first-phase.sh
#
# 检查项对应 README「第一阶段的完成标志」与《规划书》第 10 节的攻击用例。

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:4381}"
TOKEN="${TOKEN:?需要提供 SEW 会话凭据}"
PROJECT_ID="${PROJECT_ID:-}"
GENERATION="${GENERATION:-}"

pass=0
fail=0

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -m 60 -X "$method" "$BASE$path" \
      -H "content-type: application/json" -H "origin: $BASE" -H "x-sew-session: $TOKEN" -d "$body"
  else
    curl -s -m 60 -X "$method" "$BASE$path" -H "origin: $BASE" -H "x-sew-session: $TOKEN"
  fi
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS  $label"
    pass=$((pass + 1))
  else
    echo "  FAIL  $label（期望 $expected，实际 $actual）"
    fail=$((fail + 1))
  fi
}

jq_get() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=$1;console.log(v===undefined?'':String(v))}catch(e){console.log('')}})"; }

echo "== 0. 项目身份 =="
if [ -z "$PROJECT_ID" ]; then
  state=$(api GET /api/study/state)
  PROJECT_ID=$(echo "$state" | jq_get "o.data.project.projectId")
  GENERATION=$(echo "$state" | jq_get "o.data.project.generation")
fi
echo "  project=$PROJECT_ID generation=$GENERATION"
check "未带会话凭据的请求被拒绝" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/study/state")"

SCOPE="{\"projectId\":\"$PROJECT_ID\",\"generation\":$GENERATION}"

echo "== 1. 导入材料 =="
imported=$(api POST /api/study/materials "{\"scope\":$SCOPE,\"displayName\":\"第三章.md\",\"type\":\"md\",\"readableLocation\":\"人教版必修一 第三章\",\"rawText\":\"# 函数的基本性质\\n\\n函数的单调性：设函数 f(x) 的定义域为 I，如果对于定义域 I 内某个区间 D 上的任意两个自变量的值 x1、x2，当 x1 < x2 时，都有 f(x1) < f(x2)，那么就说函数 f(x) 在区间 D 上是增函数。\\n\\n判断单调性的基本步骤是取值、作差、变形、定号、下结论。\"}")
MATERIAL_ID=$(echo "$imported" | jq_get "o.data.material.materialId")
MATERIAL_REV=$(echo "$imported" | jq_get "o.data.material.revision")
SEGMENTS=$(echo "$imported" | jq_get "o.data.segments.length")
check "材料导入并切分段落" "3" "$SEGMENTS"

echo "== 2. 无来源候选被拦在待核实 =="
forged=$(api POST /api/study/knowledge/propose "{\"scope\":$SCOPE,\"name\":\"神奇定律\",\"concept\":\"材料未记载的神奇定律\",\"conditions\":\"\",\"scopeStatus\":\"in_syllabus\",\"prerequisites\":[],\"evidence\":[],\"acceptance\":\"\",\"priority\":\"high\",\"proposedBy\":\"ai\"}")
FORGED_ID=$(echo "$forged" | jq_get "o.data.proposal.proposalId")
FORGED_PASSED=$(echo "$forged" | jq_get "o.data.proposal.mechanical.passed")
FORGED_REV=$(echo "$forged" | jq_get "o.data.proposal.revision")
check "无来源候选机械检查未通过" "false" "$FORGED_PASSED"

echo "== 3. 人工点击通过也不能绕过来源 =="
review=$(api POST /api/study/knowledge/review "{\"scope\":$SCOPE,\"proposalId\":\"$FORGED_ID\",\"decision\":\"approved\",\"expectedRevision\":$FORGED_REV,\"semanticReviewed\":true,\"note\":\"\"}")
check "无来源候选审核被拒" "SOURCE_MISSING" "$(echo "$review" | jq_get "o.error.code")"

echo "== 4. 有来源候选 + 人工语义审核 =="
valid=$(api POST /api/study/knowledge/propose "{\"scope\":$SCOPE,\"name\":\"增函数的定义\",\"concept\":\"区间内 x1<x2 时 f(x1)<f(x2)\",\"conditions\":\"在同一区间 D 内取值\",\"scopeStatus\":\"in_syllabus\",\"prerequisites\":[],\"evidence\":[{\"materialId\":\"$MATERIAL_ID\",\"revision\":$MATERIAL_REV,\"segmentId\":\"S002\",\"use\":\"concept_basis\"}],\"acceptance\":\"能判断给定函数在区间上的单调性\",\"priority\":\"high\",\"proposedBy\":\"ai\"}")
VALID_ID=$(echo "$valid" | jq_get "o.data.proposal.proposalId")
VALID_REV=$(echo "$valid" | jq_get "o.data.proposal.revision")
check "有来源候选机械检查通过" "true" "$(echo "$valid" | jq_get "o.data.proposal.mechanical.passed")"

noSemantic=$(api POST /api/study/knowledge/review "{\"scope\":$SCOPE,\"proposalId\":\"$VALID_ID\",\"decision\":\"approved\",\"expectedRevision\":$VALID_REV,\"semanticReviewed\":false,\"note\":\"\"}")
check "未做语义确认时不能通过" "KNOWLEDGE_NOT_VERIFIED" "$(echo "$noSemantic" | jq_get "o.error.code")"

approved=$(api POST /api/study/knowledge/review "{\"scope\":$SCOPE,\"proposalId\":\"$VALID_ID\",\"decision\":\"approved\",\"expectedRevision\":$VALID_REV,\"semanticReviewed\":true,\"note\":\"已对照原文\"}")
KNOWLEDGE_ID=$(echo "$approved" | jq_get "o.data.knowledgePoint.knowledgeId")
check "审核通过写入权威知识点" "verified" "$(echo "$approved" | jq_get "o.data.knowledgePoint.sourceStatus")"

echo "== 5. 生成准入 =="
admission=$(api POST /api/study/admission "{\"scope\":$SCOPE,\"knowledgeIds\":[\"$KNOWLEDGE_ID\"]}")
check "已核实知识点准入通过" "true" "$(echo "$admission" | jq_get "o.data.allowed")"
blockedAdmission=$(api POST /api/study/admission "{\"scope\":$SCOPE,\"knowledgeIds\":[\"kp_不存在\"]}")
check "未核实知识点被阻断" "KNOWLEDGE_NOT_VERIFIED" "$(echo "$blockedAdmission" | jq_get "o.data.blocked[0].code")"

echo "== 6. 题目身份由程序裁定 =="
question=$(api POST /api/study/questions "{\"scope\":$SCOPE,\"stem\":\"判断 f(x)=x 在 R 上的单调性\",\"answer\":\"增函数\",\"solution\":\"取 x1<x2\",\"knowledgeIds\":[\"$KNOWLEDGE_ID\"],\"requestedOrigin\":\"exam_original\",\"originRecord\":null}")
QUESTION_ID=$(echo "$question" | jq_get "o.data.question.questionId")
check "AI 新编题自称真题被降级" "ai_new" "$(echo "$question" | jq_get "o.data.question.origin")"
check "伪装真题被记为攻击尝试" "true" "$(echo "$question" | jq_get "o.data.forgedExamClaim")"

echo "== 7. 本人作答与提交去重 =="
# 每次运行使用新的幂等键：同一键重复提交才应命中既有收据。
KEY="smoke-key-$(date +%s)-$$"
first=$(api POST /api/study/attempts "{\"scope\":$SCOPE,\"questionId\":\"$QUESTION_ID\",\"idempotencyKey\":\"$KEY\",\"actorType\":\"human_learner\",\"answerText\":\"增函数\",\"processText\":\"取值作差\",\"kind\":\"real\"}")
check "首次提交写入真实作答" "false" "$(echo "$first" | jq_get "o.data.deduplicated")"
check "答对后掌握状态更新" "passed" "$(echo "$first" | jq_get "o.data.attempt.masteryAfter")"
retry=$(api POST /api/study/attempts "{\"scope\":$SCOPE,\"questionId\":\"$QUESTION_ID\",\"idempotencyKey\":\"$KEY\",\"actorType\":\"human_learner\",\"answerText\":\"增函数\",\"processText\":\"取值作差\",\"kind\":\"real\"}")
check "重复提交读取既有收据" "true" "$(echo "$retry" | jq_get "o.data.deduplicated")"

echo "== 8. AI 同学作答写入 simulation =="
peer=$(api POST /api/study/attempts "{\"scope\":$SCOPE,\"questionId\":\"$QUESTION_ID\",\"idempotencyKey\":\"smoke-peer-$(date +%s)-$$\",\"actorType\":\"peer_ai\",\"answerText\":\"增函数\",\"processText\":\"我认为\",\"kind\":\"real\"}")
check "同学提交被强制写入 simulation" "simulation" "$(echo "$peer" | jq_get "o.data.attempt.kind")"

echo "== 9. 旧项目代次失效 =="
stale=$(api POST /api/study/admission "{\"scope\":{\"projectId\":\"$PROJECT_ID\",\"generation\":99999},\"knowledgeIds\":[\"$KNOWLEDGE_ID\"]}")
check "过期打开代次的请求被拒绝" "PROJECT_GENERATION_STALE" "$(echo "$stale" | jq_get "o.error.code")"

echo
echo "结果：$pass 项通过，$fail 项失败"
[ "$fail" -eq 0 ]
