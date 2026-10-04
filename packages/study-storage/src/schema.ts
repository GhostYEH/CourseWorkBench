/**
 * 数据库 schema 与迁移。
 *
 * 依据《规划书》第 7 节的数据模型。首版只落地第一阶段必需的表；
 * 课程/课堂相关表在 M2 接入 OpenMAIC 时按同一迁移机制追加。
 *
 * 约定：
 * - 主键统一使用字符串 ID，不用自增，避免暴露写入顺序。
 * - JSON 列统一 `_json` 后缀，读取时集中解析，禁止在 SQL 里做业务判断。
 * - 权威事实只在 `knowledge_points`；派生 Markdown 不是第二套权威。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    sql: `
CREATE TABLE IF NOT EXISTS projects (
  project_id      TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  goal            TEXT NOT NULL DEFAULT '',
  exam_date       TEXT,
  daily_minutes   INTEGER NOT NULL DEFAULT 0,
  learning_mode   TEXT NOT NULL DEFAULT 'beginner',
  format_version  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 材料身份与不可变版本：重新导入产生新 revision，旧版本保留。
CREATE TABLE IF NOT EXISTS source_versions (
  material_id          TEXT NOT NULL,
  revision             INTEGER NOT NULL,
  display_name         TEXT NOT NULL,
  material_type        TEXT NOT NULL,
  readable_location    TEXT,
  imported_at          TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  fingerprint          TEXT NOT NULL,
  normalized_text      TEXT NOT NULL,
  segment_count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (material_id, revision)
);

CREATE TABLE IF NOT EXISTS source_segments (
  material_id   TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  segment_id    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  PRIMARY KEY (material_id, revision, segment_id),
  FOREIGN KEY (material_id, revision) REFERENCES source_versions(material_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_segments_text ON source_segments(material_id, revision, ordinal);

-- AI 候选：只写候选，不能写权威表。
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id        TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  concept            TEXT NOT NULL,
  conditions         TEXT NOT NULL DEFAULT '',
  scope_status       TEXT NOT NULL,
  prerequisites_json TEXT NOT NULL DEFAULT '[]',
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  acceptance         TEXT NOT NULL DEFAULT '',
  priority           TEXT NOT NULL DEFAULT 'medium',
  proposed_by        TEXT NOT NULL DEFAULT 'ai',
  status             TEXT NOT NULL DEFAULT 'pending',
  mechanical_json    TEXT NOT NULL DEFAULT '{}',
  review_note        TEXT,
  created_at         TEXT NOT NULL,
  reviewed_at        TEXT,
  revision           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

-- 唯一权威知识点表。
CREATE TABLE IF NOT EXISTS knowledge_points (
  knowledge_id       TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  concept            TEXT NOT NULL,
  conditions         TEXT NOT NULL DEFAULT '',
  source_status      TEXT NOT NULL DEFAULT 'pending',
  scope_status       TEXT NOT NULL,
  mastery_status     TEXT NOT NULL DEFAULT 'untested',
  prerequisites_json TEXT NOT NULL DEFAULT '[]',
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  acceptance         TEXT NOT NULL DEFAULT '',
  priority           TEXT NOT NULL DEFAULT 'medium',
  origin_proposal_id TEXT,
  revision           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kp_source_status ON knowledge_points(source_status);

CREATE TABLE IF NOT EXISTS questions (
  question_id        TEXT PRIMARY KEY,
  stem               TEXT NOT NULL,
  answer             TEXT NOT NULL DEFAULT '',
  solution           TEXT NOT NULL DEFAULT '',
  knowledge_ids_json TEXT NOT NULL DEFAULT '[]',
  origin             TEXT NOT NULL,
  origin_label       TEXT NOT NULL,
  origin_detail      TEXT,
  origin_record_json TEXT,
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);

-- 作答：真实与模拟分区存储，通过 kind 区分；唯一键保证重复请求读取既有结果。
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id         TEXT PRIMARY KEY,
  question_id        TEXT NOT NULL,
  kind               TEXT NOT NULL,
  actor_type         TEXT NOT NULL,
  answer_text        TEXT NOT NULL DEFAULT '',
  process_text       TEXT NOT NULL DEFAULT '',
  mastery_after      TEXT,
  attribution_status TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  submitted_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_id, kind);

-- 步骤收据：业务提交与检查点在同一事务保存，重复请求按唯一键读取既有结果。
CREATE TABLE IF NOT EXISTS step_receipts (
  step_key     TEXT PRIMARY KEY,
  run_id       TEXT,
  step_id      TEXT,
  result_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  state             TEXT NOT NULL,
  frozen_json       TEXT NOT NULL DEFAULT '{}',
  terminated_reason TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- 全局偏好（外观与阅读）。项目级教学表达另表保存，运行期间冻结版本。
CREATE TABLE IF NOT EXISTS preferences (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teaching_preferences (
  project_id  TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

-- 备考计划：只有 confirmed 版本可以进入课程生成。
CREATE TABLE IF NOT EXISTS plan_versions (
  project_id   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);

-- 课程 ↔ 课堂 stage 映射（M2 接入 OpenMAIC 时使用）。
CREATE TABLE IF NOT EXISTS classroom_links (
  lesson_id            TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  lesson_version       INTEGER NOT NULL,
  stage_id             TEXT,
  stage_document_version INTEGER,
  document_digest      TEXT,
  evidence_bundle_id   TEXT,
  status               TEXT NOT NULL DEFAULT 'draft',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'material_exam_verifications',
    sql: `
-- 真题来源权威事实：某材料版本是否已由授权审核核实为考试真题。
-- 题目身份只能据此派生，请求方不能自报「materialVerifiedAsExam」。
CREATE TABLE IF NOT EXISTS material_exam_verifications (
  material_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  verified_by  TEXT NOT NULL,
  verified_at  TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (material_id, revision),
  FOREIGN KEY (material_id, revision) REFERENCES source_versions(material_id, revision) ON DELETE CASCADE
);
`,
  },
  {
    version: 3,
    name: 'question_origin_audit_and_attempt_requested_kind',
    sql: `
-- 题目身份审计：落库请求声明的身份与被阻止的伪装真题标记，供评测页区分
-- 「合法新编题」与「自称真题被降级」。
ALTER TABLE questions ADD COLUMN requested_origin TEXT NOT NULL DEFAULT 'ai_new';
ALTER TABLE questions ADD COLUMN forged_exam_claim INTEGER NOT NULL DEFAULT 0;

-- 作答幂等：记录请求声明的 kind（可能因主体非本人被强制为 simulation），
-- 命中幂等键时据此拒绝「同一键、不同声明」的重试。
ALTER TABLE attempts ADD COLUMN requested_kind TEXT NOT NULL DEFAULT 'real';
UPDATE attempts SET requested_kind = kind;
`,
  },
  {
    version: 4,
    name: 'classroom_documents',
    sql: `
-- 课堂文档：沿用 OpenMAIC DSL 的 stage+scenes 形状，按项目分区保存。
-- digest 用于确认写入的确实是登记过的审核课件；来源绑定不进 DSL 文档，见下方侧表。
CREATE TABLE IF NOT EXISTS classroom_documents (
  stage_id       TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  lesson_id      TEXT NOT NULL,
  dsl_version    TEXT NOT NULL DEFAULT '',
  document_json  TEXT NOT NULL,
  digest         TEXT NOT NULL,
  scene_count    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_id)
);
CREATE INDEX IF NOT EXISTS idx_classroom_documents_lesson ON classroom_documents(project_id, lesson_id);

-- 场景来源侧表：每个场景绑定的知识点/题目与审核记录；无绑定的场景不能进入教学。
CREATE TABLE IF NOT EXISTS classroom_scene_sources (
  project_id         TEXT NOT NULL,
  stage_id           TEXT NOT NULL,
  scene_id           TEXT NOT NULL,
  knowledge_ids_json TEXT NOT NULL DEFAULT '[]',
  question_id        TEXT,
  reviewed_by        TEXT NOT NULL,
  review_note        TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_id, scene_id)
);

-- 课堂状态：播放位置等受控状态。SQLite 是唯一权威，浏览器缓存不作为恢复来源。
CREATE TABLE IF NOT EXISTS classroom_state (
  project_id       TEXT NOT NULL,
  stage_id         TEXT NOT NULL,
  current_scene_id TEXT NOT NULL DEFAULT '',
  revision         INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_id)
);
`,
  },
  {
    version: 5,
    name: 'classroom_assets_and_bindings',
    sql: `
-- 二进制课堂资源及审核课件引用，均按项目隔离；digest 在服务端从原始字节计算。
CREATE TABLE IF NOT EXISTS classroom_assets (
  project_id  TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  sha256      TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
CREATE TABLE IF NOT EXISTS classroom_asset_bindings (
  project_id  TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  scene_id    TEXT NOT NULL,
  slot        TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_id, scene_id, slot),
  FOREIGN KEY (project_id, asset_id) REFERENCES classroom_assets(project_id, asset_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_classroom_asset_bindings_asset ON classroom_asset_bindings(project_id, asset_id);
`,
  },
  {
    version: 6,
    name: 'classroom_runtime_and_kv',
    sql: `
-- RuntimeStore data is project-local; learner_key is server-assigned and keeps
--本人与模拟会话 in distinct partitions. Records are append-only and ordered by seq.
CREATE TABLE IF NOT EXISTS classroom_runtime_sessions (
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  learner_key         TEXT NOT NULL,
  stage_id            TEXT NOT NULL,
  kind                TEXT NOT NULL,
  runtime_dsl_version TEXT NOT NULL,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_partition
  ON classroom_runtime_sessions(project_id, stage_id, learner_key, created_at, session_id);

CREATE TABLE IF NOT EXISTS classroom_runtime_records (
  project_id  TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  record_id   TEXT NOT NULL,
  scene_id    TEXT,
  action_index INTEGER,
  sub_anchor  TEXT,
  created_at  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, seq),
  UNIQUE (project_id, session_id, record_id),
  FOREIGN KEY (project_id, session_id)
    REFERENCES classroom_runtime_sessions(project_id, session_id) ON DELETE CASCADE
);

-- Only account-scope values are persisted by this service. Device scope remains local.
CREATE TABLE IF NOT EXISTS classroom_kv (
  project_id  TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kv_key      TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, learner_key, kv_key)
);
CREATE INDEX IF NOT EXISTS idx_classroom_kv_keys
  ON classroom_kv(project_id, learner_key, kv_key);

-- Links an idempotent assessed attempt to the exact runtime session it closed.
CREATE TABLE IF NOT EXISTS classroom_quiz_receipts (
  project_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  question_id     TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key),
  FOREIGN KEY (project_id, session_id)
    REFERENCES classroom_runtime_sessions(project_id, session_id) ON DELETE CASCADE
);
`,
  },
  {
    version: 7,
    name: 'formal_demo_record_scope_and_review_provenance',
    sql: `
-- Machine partition for authority-bearing sources and derived records. Existing
-- rows default to formal, except the exact registered demo lesson bundle below.
ALTER TABLE source_versions ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE proposals ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE proposals ADD COLUMN review_provenance TEXT
  CHECK (review_provenance IS NULL OR review_provenance IN ('user_semantic', 'demo_author'));
ALTER TABLE knowledge_points ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE knowledge_points ADD COLUMN review_provenance TEXT
  CHECK (review_provenance IS NULL OR review_provenance IN ('user_semantic', 'demo_author'));
ALTER TABLE questions ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE classroom_documents ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE classroom_scene_sources ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE classroom_assets ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));
ALTER TABLE classroom_asset_bindings ADD COLUMN record_scope TEXT NOT NULL DEFAULT 'formal'
  CHECK (record_scope IN ('formal', 'demo'));

-- Identify only the repository-registered fixed demo: exact fixed stage/lesson,
-- compiler-reviewed author identity and note, source location, and evidence link.
-- User records sharing only a title or scope_status remain formal.
UPDATE knowledge_points
SET record_scope = 'demo', review_provenance = 'demo_author'
WHERE knowledge_id IN (
  SELECT DISTINCT CAST(knowledge_id.value AS TEXT)
  FROM classroom_documents AS document
  JOIN classroom_scene_sources AS binding
    ON binding.project_id = document.project_id AND binding.stage_id = document.stage_id
  JOIN json_each(binding.knowledge_ids_json) AS knowledge_id
  WHERE document.stage_id = 'stage-demo-monotonicity-1'
    AND document.lesson_id = 'lesson-demo-monotonicity-1'
    AND binding.reviewed_by = '内置演示课件（编者按公开定义撰写并在仓库内登记，非正式考纲）'
    AND binding.review_note = '演示材料：仅用于验证真实课堂链路（文档、渲染、来源绑定、作答持久化）。内容不是考试真题，也不作为正式教学单元；M1 前替换为真实科目材料。'
    AND document.digest = '0ae3baa37c31bf04ff166a27ac6502600bfd5991445e54586c876c853797e563'
    AND knowledge_points.name = '函数单调性（增函数）的定义'
    AND knowledge_points.concept = '在区间 D 内任取 x1 < x2，若都有 f(x1) < f(x2)，则 f(x) 在 D 上是增函数'
    AND knowledge_points.conditions = '自变量必须取自同一个区间 D 内的任意两个值'
    AND json_array_length(knowledge_points.evidence_json) = 2
    AND EXISTS (
      SELECT 1 FROM json_each(knowledge_points.evidence_json) AS evidence
      JOIN source_versions AS source
        ON source.material_id = json_extract(evidence.value, '$.materialId')
       AND source.revision = json_extract(evidence.value, '$.revision')
      WHERE json_extract(evidence.value, '$.materialId') = source.material_id
        AND source.display_name = '演示材料：函数单调性（必修一片段）.md'
        AND source.material_type = 'md'
        AND source.readable_location = 'apps/learning/lib/classroom/reviewed-lesson.ts:FIXED_MATERIAL'
        AND source.fingerprint = '930a44aedfa0e4f45179a2ed22cf532b0ef30c4db651cb049e96312855e8cad4'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(knowledge_points.evidence_json) AS evidence
      JOIN source_versions AS source ON source.material_id = json_extract(evidence.value, '$.materialId')
        AND source.revision = json_extract(evidence.value, '$.revision')
      WHERE source.display_name = '演示材料：函数单调性（必修一片段）.md'
        AND source.readable_location = 'apps/learning/lib/classroom/reviewed-lesson.ts:FIXED_MATERIAL'
        AND source.fingerprint = '930a44aedfa0e4f45179a2ed22cf532b0ef30c4db651cb049e96312855e8cad4'
        AND json_extract(evidence.value, '$.segmentId') = 'S003'
        AND json_extract(evidence.value, '$.use') = 'concept_basis'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(knowledge_points.evidence_json) AS evidence
      JOIN source_versions AS source ON source.material_id = json_extract(evidence.value, '$.materialId')
        AND source.revision = json_extract(evidence.value, '$.revision')
      WHERE source.display_name = '演示材料：函数单调性（必修一片段）.md'
        AND source.readable_location = 'apps/learning/lib/classroom/reviewed-lesson.ts:FIXED_MATERIAL'
        AND source.fingerprint = '930a44aedfa0e4f45179a2ed22cf532b0ef30c4db651cb049e96312855e8cad4'
        AND json_extract(evidence.value, '$.segmentId') = 'S004'
        AND json_extract(evidence.value, '$.use') = 'method_basis'
    )
);

UPDATE proposals SET record_scope = 'demo', review_provenance = 'demo_author'
WHERE proposal_id IN (
  SELECT origin_proposal_id FROM knowledge_points
  WHERE record_scope = 'demo' AND origin_proposal_id IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1 FROM knowledge_points AS formal_knowledge
  WHERE formal_knowledge.origin_proposal_id = proposals.proposal_id
    AND formal_knowledge.record_scope = 'formal'
);

UPDATE source_versions SET record_scope = 'demo'
WHERE EXISTS (
  SELECT 1
  FROM knowledge_points AS knowledge, json_each(knowledge.evidence_json) AS evidence
  WHERE knowledge.record_scope = 'demo'
    AND json_extract(evidence.value, '$.materialId') = source_versions.material_id
    AND json_extract(evidence.value, '$.revision') = source_versions.revision
);

UPDATE questions SET record_scope = 'demo'
WHERE EXISTS (
  SELECT 1 FROM json_each(questions.knowledge_ids_json) AS knowledge_id
  JOIN knowledge_points AS knowledge ON knowledge.knowledge_id = knowledge_id.value
  WHERE knowledge.record_scope = 'demo'
);

UPDATE classroom_documents SET record_scope = 'demo'
WHERE stage_id = 'stage-demo-monotonicity-1' AND lesson_id = 'lesson-demo-monotonicity-1'
  AND EXISTS (
    SELECT 1 FROM classroom_scene_sources AS binding
    JOIN json_each(binding.knowledge_ids_json) AS knowledge_id
    JOIN knowledge_points AS knowledge ON knowledge.knowledge_id = knowledge_id.value
    WHERE binding.project_id = classroom_documents.project_id
      AND binding.stage_id = classroom_documents.stage_id
      AND binding.reviewed_by = '内置演示课件（编者按公开定义撰写并在仓库内登记，非正式考纲）'
      AND binding.review_note = '演示材料：仅用于验证真实课堂链路（文档、渲染、来源绑定、作答持久化）。内容不是考试真题，也不作为正式教学单元；M1 前替换为真实科目材料。'
      AND classroom_documents.digest = '0ae3baa37c31bf04ff166a27ac6502600bfd5991445e54586c876c853797e563'
      AND knowledge.record_scope = 'demo'
  );
UPDATE classroom_scene_sources SET record_scope = 'demo'
WHERE stage_id = 'stage-demo-monotonicity-1'
  AND reviewed_by = '内置演示课件（编者按公开定义撰写并在仓库内登记，非正式考纲）'
  AND review_note = '演示材料：仅用于验证真实课堂链路（文档、渲染、来源绑定、作答持久化）。内容不是考试真题，也不作为正式教学单元；M1 前替换为真实科目材料。'
  AND EXISTS (SELECT 1 FROM classroom_documents AS document
    WHERE document.project_id = classroom_scene_sources.project_id
      AND document.stage_id = classroom_scene_sources.stage_id
      AND document.lesson_id = 'lesson-demo-monotonicity-1'
      AND document.digest = '0ae3baa37c31bf04ff166a27ac6502600bfd5991445e54586c876c853797e563')
  AND EXISTS (
    SELECT 1 FROM json_each(classroom_scene_sources.knowledge_ids_json) AS knowledge_id
    JOIN knowledge_points AS knowledge ON knowledge.knowledge_id = knowledge_id.value
    WHERE knowledge.record_scope = 'demo'
  );
UPDATE classroom_assets SET record_scope = 'demo'
WHERE ((sha256 = '3d6615700b057fc08b6287f57c2561f698711b8c8bd6241cc5526bf16da89efb'
       AND json_extract(metadata_json, '$.symbolicRef') = 'demo-image-monotonicity-v1')
   OR (sha256 = 'c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866'
       AND json_extract(metadata_json, '$.symbolicRef') = 'demo-font-katex-main-regular-v1'))
  AND EXISTS (SELECT 1 FROM classroom_asset_bindings AS binding
    JOIN classroom_documents AS document ON document.project_id = binding.project_id AND document.stage_id = binding.stage_id
    WHERE binding.project_id = classroom_assets.project_id AND binding.asset_id = classroom_assets.asset_id
      AND binding.stage_id = 'stage-demo-monotonicity-1' AND binding.scene_id = 'scene-slide-intro'
      AND ((binding.slot = 'hero-image' AND json_extract(classroom_assets.metadata_json, '$.symbolicRef') = 'demo-image-monotonicity-v1')
        OR (binding.slot = 'formula-font' AND json_extract(classroom_assets.metadata_json, '$.symbolicRef') = 'demo-font-katex-main-regular-v1'))
      AND document.lesson_id = 'lesson-demo-monotonicity-1'
      AND document.digest = '0ae3baa37c31bf04ff166a27ac6502600bfd5991445e54586c876c853797e563');
UPDATE classroom_asset_bindings SET record_scope = 'demo'
WHERE stage_id = 'stage-demo-monotonicity-1' AND scene_id = 'scene-slide-intro'
  AND ((slot = 'hero-image' AND asset_id IN (
          SELECT asset_id FROM classroom_assets
          WHERE record_scope = 'demo' AND sha256 = '3d6615700b057fc08b6287f57c2561f698711b8c8bd6241cc5526bf16da89efb'))
    OR (slot = 'formula-font' AND asset_id IN (
          SELECT asset_id FROM classroom_assets
          WHERE record_scope = 'demo' AND sha256 = 'c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866')));

CREATE INDEX idx_sources_record_scope ON source_versions(record_scope, material_id, revision);
CREATE INDEX idx_proposals_record_scope_status ON proposals(record_scope, status, created_at);
CREATE INDEX idx_knowledge_record_scope ON knowledge_points(record_scope, source_status);
CREATE INDEX idx_questions_record_scope ON questions(record_scope, created_at);
`,
  },
  {
    version: 8,
    name: 'classroom_document_organization',
    sql: `
-- Folders organize documents within a project. They never alter document JSON,
-- source bindings, review digests, or classroom state.
CREATE TABLE classroom_folders (
  project_id      TEXT NOT NULL,
  id              TEXT NOT NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  folder_order    REAL NOT NULL,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, normalized_name)
);

CREATE INDEX idx_classroom_folders_project_order
  ON classroom_folders(project_id, folder_order, id);

CREATE TABLE classroom_document_folders (
  project_id TEXT NOT NULL,
  stage_id   TEXT NOT NULL,
  folder_id  TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_id),
  FOREIGN KEY (project_id, stage_id)
    REFERENCES classroom_documents(project_id, stage_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, folder_id)
    REFERENCES classroom_folders(project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_classroom_document_folders_folder
  ON classroom_document_folders(project_id, folder_id, stage_id);
`,
  },
  {
    version: 9,
    name: 'material_raw_archive_and_segment_spans',
    sql: `
-- 原始文件归档：文件导入按材料版本保存原样字节与其 SHA-256（含 BOM 与原换行风格）。
-- 粘贴导入与升级前的历史版本没有原文件可归档，明确记为 absent，界面不得宣称可打开原文。
CREATE TABLE source_raw_archives (
  material_id   TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  storage_mode  TEXT NOT NULL CHECK (storage_mode IN ('archived', 'absent')),
  absent_reason TEXT CHECK (absent_reason IS NULL OR absent_reason IN ('text_import', 'legacy_import')),
  original_name TEXT,
  media_type    TEXT CHECK (media_type IS NULL OR media_type IN ('text/plain', 'text/markdown')),
  raw_sha256    TEXT,
  byte_length   INTEGER,
  raw_bytes     BLOB,
  archived_at   TEXT NOT NULL,
  PRIMARY KEY (material_id, revision),
  FOREIGN KEY (material_id, revision)
    REFERENCES source_versions(material_id, revision) ON DELETE CASCADE,
  CHECK (
    (storage_mode = 'archived' AND raw_bytes IS NOT NULL AND raw_sha256 IS NOT NULL AND byte_length IS NOT NULL)
    OR (storage_mode = 'absent' AND raw_bytes IS NULL AND raw_sha256 IS NULL AND byte_length IS NULL)
  )
);

-- 既有版本在此迁移前只保存了规范化文本，原始字节已经丢弃：如实标为历史未归档。
INSERT INTO source_raw_archives (material_id, revision, storage_mode, absent_reason, archived_at)
SELECT material_id, revision, 'absent', 'legacy_import', imported_at FROM source_versions;

-- 段落在归档原文中的 UTF-8 字节区间与行号（1 起始）；原文未归档时为 NULL。
ALTER TABLE source_segments ADD COLUMN raw_start_byte INTEGER;
ALTER TABLE source_segments ADD COLUMN raw_end_byte INTEGER;
ALTER TABLE source_segments ADD COLUMN raw_line_start INTEGER;
ALTER TABLE source_segments ADD COLUMN raw_line_end INTEGER;
`,
  },
  {
    version: 10,
    name: 'syllabus_items_and_knowledge_mapping',
    sql: `
-- 考纲原子项：人工登记的可考核条目及其必要要素（《规划书》8.1 的覆盖分母）。
-- 同一记录范围内考纲编号唯一且不区分大小写：重复登记被拒绝，避免同一条目虚增分母。
CREATE TABLE syllabus_items (
  item_id            TEXT PRIMARY KEY,
  code               TEXT NOT NULL,
  label              TEXT NOT NULL,
  requirements_json  TEXT NOT NULL,
  source_material_id TEXT NOT NULL,
  source_revision    INTEGER NOT NULL,
  source_segment_id  TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_excerpt     TEXT NOT NULL,
  record_scope       TEXT NOT NULL DEFAULT 'formal' CHECK (record_scope IN ('formal', 'demo')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (source_material_id, source_revision)
    REFERENCES source_versions(material_id, revision) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_syllabus_scope_code ON syllabus_items(record_scope, code COLLATE NOCASE);
CREATE INDEX idx_syllabus_scope_order ON syllabus_items(record_scope, created_at, item_id);

-- 知识点到「某条目内某个必要要素」的映射；未映射为 NULL，覆盖统计按缺口单列。
ALTER TABLE knowledge_points ADD COLUMN syllabus_item_id TEXT;
ALTER TABLE knowledge_points ADD COLUMN syllabus_requirement_key TEXT;
CREATE INDEX idx_knowledge_syllabus_item ON knowledge_points(syllabus_item_id, syllabus_requirement_key);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
