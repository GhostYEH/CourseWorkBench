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

import { StudyError } from '@sew/study-contracts';
import type { SqlDatabase } from './driver';
import { migrateScenePlanJson } from './migrations/scene-plan';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** 在同一个迁移事务中执行需要领域摘要/严格 JSON 校验的数据升级。 */
  migrate?: (db: SqlDatabase) => void;
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
  {
    version: 11,
    name: 'plan_payload_version_stamp',
    sql: `
-- N8：计划载荷改为版本化 schema 读取。给形状仍符合 v1 的历史载荷补标版本号与逐条确认字段，
-- 让旧数据可以继续被正确解析；根不是对象或缺少 tasks/gaps 的行保留原样，
-- 由读取层的 schema 诊断拒绝，而不是在迁移里猜测改写内容。
UPDATE plan_versions
   SET payload_json = json_insert(
         payload_json,
         '$.payloadVersion', 1,
         '$.confirmedTaskKnowledgeIds', json('[]')
       )
 WHERE json_type(payload_json) = 'object'
   AND json_extract(payload_json, '$.payloadVersion') IS NULL
   AND json_type(json_extract(payload_json, '$.tasks')) = 'array'
   AND json_type(json_extract(payload_json, '$.gaps')) = 'array';
`,
  },
  {
    version: 12,
    name: 'role_profiles',
    sql: `
-- 角色档案（《规划书》第 7 节 role_profiles）：教师与同学的表达方式配置。
-- 这里不存权限列：权限由服务端按 kind 派生，因此偏好无法把自己写成权限。
CREATE TABLE role_profiles (
  profile_id     TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('teacher', 'peer')),
  name           TEXT NOT NULL,
  persona        TEXT NOT NULL DEFAULT '',
  explanation    TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  record_scope   TEXT NOT NULL DEFAULT 'formal' CHECK (record_scope IN ('formal', 'demo')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
-- 教师档案每个记录范围最多一份；同学上限由领域层按 MAX_PEER_PROFILES 检查。
CREATE UNIQUE INDEX idx_role_profiles_teacher ON role_profiles(record_scope, kind) WHERE kind = 'teacher';
CREATE INDEX idx_role_profiles_scope_kind ON role_profiles(record_scope, kind, profile_id);
`,
  },
  {
    version: 13,
    name: 'evidence_bundles_and_lesson_versions',
    sql: `
-- 证据包（LESSON-01）：一节课允许说什么的冻结集合，按内容摘要去重。
-- 摘要一致即同一份证据包，重复冻结不会堆出第二份；来源更新只会让新冻结得到新摘要。
CREATE TABLE evidence_bundles (
  bundle_id   TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  digest      TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  frozen_at   TEXT NOT NULL,
  UNIQUE (project_id, digest)
);
CREATE INDEX idx_evidence_bundles_project ON evidence_bundles(project_id, frozen_at, bundle_id);

-- 课程版本：修改课件永远新增草案版本，已发布版本只改状态不被覆写。
CREATE TABLE lesson_versions (
  lesson_id          TEXT NOT NULL,
  version            INTEGER NOT NULL,
  project_id         TEXT NOT NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  bundle_id          TEXT NOT NULL,
  bundle_digest      TEXT NOT NULL,
  statement_ids_json TEXT NOT NULL DEFAULT '[]',
  question_ids_json  TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (lesson_id, version),
  FOREIGN KEY (bundle_id) REFERENCES evidence_bundles(bundle_id)
);
CREATE INDEX idx_lesson_versions_project ON lesson_versions(project_id, status, lesson_id, version);
`,
  },
  {
    version: 14,
    name: 'lesson_reviews_and_withdrawal',
    sql: `
-- 课程版本的人工审核结论（LESSON-02）。
-- 主键含 version：审核结论只绑定那一个草案版本，改一处表述就得重新审核。
-- reviewer 不落列：本机的权威审核人只有本地用户，客户端没有可提交的审核身份。
CREATE TABLE lesson_reviews (
  project_id       TEXT NOT NULL,
  lesson_id        TEXT NOT NULL,
  version          INTEGER NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note             TEXT NOT NULL DEFAULT '',
  admitted_json    TEXT NOT NULL DEFAULT '[]',
  blocked_json     TEXT NOT NULL DEFAULT '[]',
  reviewed_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, lesson_id, version)
);
CREATE INDEX idx_lesson_reviews_lesson ON lesson_reviews(project_id, lesson_id, version);

-- 课程↔stage 映射补记状态说明：撤回原因要留在映射上，课堂入口据此给出可读提示。
ALTER TABLE classroom_links ADD COLUMN status_note TEXT NOT NULL DEFAULT '';

-- 课程状态增加 withdrawn（主动停用），与被新版本取代含义不同，需要重建表放宽 CHECK。
CREATE TABLE lesson_versions_next (
  lesson_id          TEXT NOT NULL,
  version            INTEGER NOT NULL,
  project_id         TEXT NOT NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'withdrawn')),
  bundle_id          TEXT NOT NULL,
  bundle_digest      TEXT NOT NULL,
  statement_ids_json TEXT NOT NULL DEFAULT '[]',
  question_ids_json  TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (lesson_id, version),
  FOREIGN KEY (bundle_id) REFERENCES evidence_bundles(bundle_id)
);
INSERT INTO lesson_versions_next (
  lesson_id, version, project_id, title, status, bundle_id, bundle_digest,
  statement_ids_json, question_ids_json, created_at, updated_at
)
SELECT lesson_id, version, project_id, title, status, bundle_id, bundle_digest,
       statement_ids_json, question_ids_json, created_at, updated_at
  FROM lesson_versions;
DROP TABLE lesson_versions;
ALTER TABLE lesson_versions_next RENAME TO lesson_versions;
CREATE INDEX idx_lesson_versions_project ON lesson_versions(project_id, status, lesson_id, version);
`,
  },
  {
    version: 15,
    name: 'classroom_teaching',
    sql: `
-- 讲解卡（TEACH-01）：正式连续授课只用审核通过的卡片，卡片文本与它引用的证据包陈述一起保存。
-- origin 记录文字出自教师手写还是模型现场产生；模型产生的卡片批准后仍保留该来源标记。
CREATE TABLE lesson_explanations (
  explanation_id       TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  lesson_id            TEXT NOT NULL,
  lesson_version       INTEGER NOT NULL,
  scene_id             TEXT NOT NULL,
  position             INTEGER NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('explain', 'prompt')),
  origin               TEXT NOT NULL CHECK (origin IN ('teacher_authored', 'model_generated')),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  text                 TEXT NOT NULL,
  statement_ids_json   TEXT NOT NULL DEFAULT '[]',
  review_note          TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_lesson_explanations_play
  ON lesson_explanations(project_id, lesson_id, lesson_version, scene_id, status, position);

-- 课堂会话：一次上课的外层状态。等待本人要落库，重启后仍是等待，不能自行批准或编造作答。
CREATE TABLE classroom_sessions (
  session_id        TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  run_id            TEXT,
  lesson_id         TEXT NOT NULL,
  lesson_version    INTEGER NOT NULL,
  bundle_id         TEXT NOT NULL,
  stage_id          TEXT,
  learner_key       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('in_class', 'awaiting_learner', 'completed', 'cancelled')),
  awaiting_reason   TEXT NOT NULL DEFAULT '',
  current_scene_id  TEXT NOT NULL DEFAULT '',
  round_index       INTEGER NOT NULL DEFAULT 1,
  round_calls       INTEGER NOT NULL DEFAULT 0,
  round_peer_turns  INTEGER NOT NULL DEFAULT 0,
  lesson_calls      INTEGER NOT NULL DEFAULT 0,
  peers_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (peers_enabled IN (0, 1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_classroom_sessions_project ON classroom_sessions(project_id, status, created_at, session_id);

-- 课堂动作收据：与业务写入同一事务保存。step_key 由服务端按会话与动作意图生成，
-- 重复请求读回既有收据，不重复播报、不重复计预算。
CREATE TABLE classroom_action_receipts (
  step_key     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  scene_id     TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX idx_classroom_action_receipts_session ON classroom_action_receipts(session_id, at, step_key);
`,
  },
  {
    version: 16,
    name: 'question_assessment',
    sql: `
ALTER TABLE questions ADD COLUMN assessment_json TEXT;
ALTER TABLE attempts ADD COLUMN question_revision INTEGER;
ALTER TABLE attempts ADD COLUMN answer_version INTEGER;
ALTER TABLE attempts ADD COLUMN grading_json TEXT;
`,
  },
  {
    version: 17,
    name: 'append_only_attempt_grading',
    sql: `
CREATE TABLE attempt_grade_candidates (candidate_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), candidate_json TEXT NOT NULL);
CREATE INDEX idx_grade_candidates_attempt ON attempt_grade_candidates(project_id, attempt_id);
CREATE TABLE attempt_grade_reviews (review_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id), review_version INTEGER NOT NULL, review_json TEXT NOT NULL, UNIQUE(project_id,attempt_id,review_version));
CREATE TABLE attempt_grade_receipts (project_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL, attempt_id TEXT NOT NULL, intent_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id,request_id));
`,
  },
  {
    version: 18,
    name: 'durable_grading_generation',
    sql: `
CREATE TABLE attempt_grade_generation_calls (
  project_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  expected_review_version INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id), reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
  state TEXT NOT NULL CHECK (state IN ('started','failed','completed')),
  failure_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,request_id)
);
`,
  },
  {
    version: 19,
    name: 'local_learner_identity_binding',
    sql: `
CREATE TABLE learner_identity_bindings (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  learner_key TEXT NOT NULL,
  learner_uid TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('created_local','legacy_local')),
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 20,
    name: 'local_classroom_room_authority',
    sql: `
CREATE TABLE classroom_rooms (
  project_id TEXT NOT NULL REFERENCES projects(project_id), room_id TEXT NOT NULL,
  room_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, lease_json TEXT,
  PRIMARY KEY(project_id,room_id)
);
CREATE TABLE classroom_room_members (
  project_id TEXT NOT NULL, room_id TEXT NOT NULL, uid TEXT NOT NULL, member_json TEXT NOT NULL,
  PRIMARY KEY(project_id,room_id,uid),
  FOREIGN KEY(project_id,room_id) REFERENCES classroom_rooms(project_id,room_id)
);
CREATE TABLE classroom_room_assets (
  project_id TEXT NOT NULL, room_id TEXT NOT NULL, asset_id TEXT NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY(project_id,room_id,asset_id),
  FOREIGN KEY(project_id,room_id) REFERENCES classroom_rooms(project_id,room_id)
);
CREATE TABLE classroom_room_receipts (
  project_id TEXT NOT NULL REFERENCES projects(project_id), request_id TEXT NOT NULL,
  actor_uid TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','scene','close')),
  intent_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id,request_id)
);
CREATE TABLE classroom_room_session_bindings (
  project_id TEXT NOT NULL, room_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES classroom_sessions(session_id),
  PRIMARY KEY(project_id,room_id), UNIQUE(project_id,session_id),
  FOREIGN KEY(project_id,room_id) REFERENCES classroom_rooms(project_id,room_id)
);
`,
  },
  {
    version: 21,
    name: 'reviewed_classroom_board',
    sql: `
CREATE TABLE classroom_board_items (item_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, lesson_id TEXT NOT NULL, lesson_version INTEGER NOT NULL, item_json TEXT NOT NULL);
CREATE TABLE classroom_board_effects (project_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, item_id TEXT NOT NULL, effect_json TEXT NOT NULL, PRIMARY KEY(project_id,session_id,seq), UNIQUE(project_id,session_id,item_id));
CREATE TABLE classroom_board_receipts (project_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL, intent_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id,request_id));
`,
  },
  {
    version: 22,
    name: 'personal_feedback_and_review',
    sql: `
CREATE TABLE feedback_originals(project_id TEXT NOT NULL,uid TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,snapshot_json TEXT NOT NULL,PRIMARY KEY(project_id,uid,attempt_id));
CREATE TABLE feedback_entries(project_id TEXT NOT NULL,uid TEXT NOT NULL,attempt_id TEXT NOT NULL,version INTEGER NOT NULL,entry_id TEXT NOT NULL UNIQUE,entry_json TEXT NOT NULL,PRIMARY KEY(project_id,uid,attempt_id,version));
CREATE TABLE feedback_review_tasks(project_id TEXT NOT NULL,uid TEXT NOT NULL,task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,due_at TEXT NOT NULL,task_json TEXT NOT NULL,PRIMARY KEY(project_id,uid,task_id));
CREATE TABLE feedback_receipts(project_id TEXT NOT NULL,uid TEXT NOT NULL,request_id TEXT NOT NULL,intent_json TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,uid,request_id));
`,
  },
  {
    version: 23,
    name: 'durable_shared_model_usage',
    sql: `
CREATE TABLE model_usage_calls(project_id TEXT NOT NULL,request_id TEXT NOT NULL,run_id TEXT NOT NULL,call_json TEXT NOT NULL,PRIMARY KEY(project_id,request_id));
`,
  },
  {
    version: 24,
    name: 'classroom_peers_and_recovery',
    sql: `
-- AI 同学发言（PEER-01）。分区列由服务端写死为 simulation：同学的示范与练习
-- 不能通过与本人作答相同的读路径被当成「本人完成」。
CREATE TABLE classroom_peer_turns (
  turn_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES classroom_sessions(session_id),
  role_profile_id TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  partition TEXT NOT NULL CHECK (partition IN ('simulation')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('peer_ai')),
  turn_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, session_id, round_index, turn_index)
);
CREATE INDEX idx_classroom_peer_turns_session ON classroom_peer_turns(project_id, session_id, round_index, turn_index);
-- 同学参与度单独一张表，而不是给 classroom_sessions 加列：
-- SQLite 没有 ADD COLUMN IF NOT EXISTS，加列会让「重建旧库」这类路径无法重跑。
CREATE TABLE classroom_session_peer_settings (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES classroom_sessions(session_id),
  engagement TEXT NOT NULL CHECK (engagement IN ('quiet', 'balanced', 'active')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
);
`,
  },
  {
    version: 25,
    name: 'grading_generation_accounting',
    sql: `
-- 评分生成调用的结算计量（BUDGET-01）。
-- 没有这三列时，「已结算的评分」在共享预算报告里会整个消失，且未知用量会被
-- 静默按 0 计。加上之后评分与生成在同一份报告里可核对。
ALTER TABLE attempt_grade_generation_calls ADD COLUMN accounted_tokens INTEGER;
ALTER TABLE attempt_grade_generation_calls ADD COLUMN token_measurement TEXT;
ALTER TABLE attempt_grade_generation_calls ADD COLUMN elapsed_ms INTEGER;
`,
  },
  {
    version: 26,
    name: 'lesson_statement_revisions',
    sql: `
-- 陈述正文改写候选（LESSON-02）。模型改写只落待核区：既不写入课程版本，也不改写原陈述，
-- 人工通过后才派生新的草案版本；拒绝只留档。正文、知识点与来源的沿用由服务端复验。
CREATE TABLE lesson_statement_revisions (
  candidate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  lesson_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  statement_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')),
  candidate_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_lesson_statement_revisions_scope
  ON lesson_statement_revisions(project_id, lesson_id, base_version, statement_id);
-- 候选生成与人工处置的幂等收据：同一 requestId 与意图重试返回既有结果，不重复调用或派生。
CREATE TABLE lesson_statement_revision_receipts (
  project_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL,
  intent_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id, request_id)
);
-- 课程草案派生的幂等收据：带 requestId 的 draft 重试返回既有版本，不追加第二个草案版本。
CREATE TABLE lesson_draft_receipts (
  project_id TEXT NOT NULL, request_id TEXT NOT NULL, intent_json TEXT NOT NULL,
  lesson_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(project_id, request_id)
);
`,
  },
  {
    version: 27,
    name: 'lesson_scene_plans',
    sql: `
-- 场景计划（LESSON-02 / OMA-006、OMA-021、OMA-022）。计划是「这一版课件由哪些场景、
-- 按什么顺序、每个场景里有哪些元素」的可编辑草稿层：只挂在草案版本上，发布后不再改写。
-- 场景用稳定 sceneId（不靠序号映射），增删/排序/复制/局部重生成都不改已有场景身份。
-- revision 做乐观并发：客户端基于读到的 revision 提交，服务端已推进即拒绝。
CREATE TABLE lesson_scene_plans (
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  lesson_id      TEXT NOT NULL,
  lesson_version INTEGER NOT NULL,
  bundle_id      TEXT NOT NULL,
  plan_json      TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('deterministic','model_generated')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, lesson_id, lesson_version)
);
-- 完整课件生成候选（OMA-006）。模型产物先落待核区：不写入计划、不进入教学，
-- 人工通过才把候选场景写成该草案版本的场景计划；拒绝只留档。
CREATE TABLE lesson_courseware_candidates (
  candidate_id  TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  lesson_id     TEXT NOT NULL,
  base_version  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')),
  candidate_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_lesson_courseware_candidates_scope
  ON lesson_courseware_candidates(project_id, lesson_id, base_version);
-- 生成与处置的幂等收据：同一 requestId 与意图重试返回既有结果，不重复调用或写入。
CREATE TABLE lesson_courseware_receipts (
  project_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL,
  intent_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id, request_id)
);
`,
  },
  {
    version: 28,
    name: 'scene_plan_review_binding',
    sql: `
-- 审核绑定计划内容（LESSON-02）。审核结论必须对「这节课讲这些场景」有效：手工保存或候选
-- 应用改了计划内容后，旧审核即失效，发布必须复核当前内容。历史课程没有计划，两列为 NULL，
-- 按「证据包即内容」处理，保持兼容（不把旧审核一律判失效）。
ALTER TABLE lesson_reviews ADD COLUMN plan_revision INTEGER;
ALTER TABLE lesson_reviews ADD COLUMN plan_digest TEXT;

-- 候选记录生成时的计划基线：审批旧候选不得静默覆盖新编辑，需要明确的版本比较与覆盖确认。
-- 生成时该版本还没有计划则 revision 记 0、digest 记 NULL。
ALTER TABLE lesson_courseware_candidates ADD COLUMN base_plan_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lesson_courseware_candidates ADD COLUMN base_plan_digest TEXT;

-- 计划保存与候选处置的事务内请求回执。四种结果（completed/failed/cancelled/unknown）都要
-- 可查询、可重放：同一 requestId 与意图重试读回既有回执，不因重发而推进第二个 revision。
-- state 为 failed/cancelled/unknown 时 result_json 为 NULL（没有业务写入）。
CREATE TABLE lesson_scene_plan_receipts (
  project_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('save-scene-plan','apply-courseware')),
  intent_json TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('completed','failed','cancelled','unknown')),
  result_json TEXT,
  message     TEXT NOT NULL DEFAULT '',
  error_code  TEXT,
  error_reason TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id)
);
`,
  },
  {
    version: 29,
    name: 'scene_plan_json_and_receipt_upgrade',
    // 独立版本同时修复已经执行 v28 SQL、但仍保存 v27 JSON 的数据库。
    sql: '',
    migrate: migrateScenePlanJson,
  },
  {
    version: 30,
    name: 'collaboration_authority',
    sql: `
-- 双人共同课堂的协作权威（INVITE-01 / SYNC-01 / CHAT-01，ADR-0004）。
-- 这一组表由协作服务拥有：邀请生命周期、共享房间、成员准备状态、
-- 权威序号事件与课内消息。个人草稿/答案/判分/掌握仍在本地学习服务，
-- 不进入这里；本机链路与在线协作共用同一套合同，区别只在谁持有数据。
--
-- 说明：这里刻意**不**存「在线登记」结果。authority 只有 local_link，
-- 表示本机同进程链路；界面据此仍显示「不能联网邀请」。
CREATE TABLE collab_registrations (
  uid           TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  authority     TEXT NOT NULL CHECK (authority IN ('local_link')),
  revision      INTEGER NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE collab_rooms (
  room_id       TEXT PRIMARY KEY,
  owner_uid     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ready','active','ended')),
  revision      INTEGER NOT NULL,
  current_scene_id TEXT NOT NULL,
  lesson_id     TEXT NOT NULL,
  lesson_version INTEGER NOT NULL,
  snapshot_digest TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE collab_room_members (
  room_id    TEXT NOT NULL REFERENCES collab_rooms(room_id),
  uid        TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','participant')),
  readiness  TEXT NOT NULL CHECK (readiness IN ('pending','ready','left')),
  joined_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, uid)
);

-- 邀请：状态机 pending/accepted/rejected/revoked/expired。
-- 只存状态本身；过期由读取时按 expires_at 判定，不改写历史状态。
CREATE TABLE collab_invitations (
  invitation_id  TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL,
  inviter_uid    TEXT NOT NULL,
  invitee_uid    TEXT NOT NULL,
  lesson_id      TEXT NOT NULL,
  lesson_version INTEGER NOT NULL,
  snapshot_digest TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','revoked','expired')),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_collab_invitations_invitee ON collab_invitations(invitee_uid, status);
-- 读取侧同时按发起人与受邀人过滤（listInvitations 用 inviter_uid OR invitee_uid），两侧都要索引。
CREATE INDEX idx_collab_invitations_inviter ON collab_invitations(inviter_uid, status);

-- 房间事件：权威单调序号，重连按 (afterSeq, tailSeq] 补齐。
CREATE TABLE collab_room_events (
  room_id    TEXT NOT NULL REFERENCES collab_rooms(room_id),
  seq        INTEGER NOT NULL,
  event_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  actor_uid  TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);

-- 课内消息：权威序号与去重键并存；sender_type 由服务端写死为 human_learner。
CREATE TABLE collab_room_messages (
  room_id    TEXT NOT NULL REFERENCES collab_rooms(room_id),
  seq        INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  sender_uid TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('human_learner')),
  body       TEXT NOT NULL,
  dedup_key  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq),
  UNIQUE (room_id, dedup_key)
);

-- 命令幂等收据：同一 requestId 与意图重试读回既有结果，不重复追加。
CREATE TABLE collab_command_receipts (
  request_id  TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  actor_uid   TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`,
  },
  {
    version: 31,
    name: 'online_collaboration_service',
    sql: `
-- 独立协作服务的在线权威（UID-01 / ROOM-01 / SYNC-01 的在线部分，ADR-0005）。
-- 本机链路与在线链路共用同一组房间/邀请/消息/事件表，区别只在 authority 与数据归属：
-- 本机链路写 local_link，在线服务写 online。下面三张表只服务在线部分。

-- 放宽登记 authority：本机链路仍写 local_link，在线服务写 online。
-- SQLite 不能直接改 CHECK，用建新表/搬数据/改名的方式重建。
CREATE TABLE collab_registrations_next (
  uid           TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  authority     TEXT NOT NULL CHECK (authority IN ('local_link','online')),
  revision      INTEGER NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO collab_registrations_next (uid, display_name, authority, revision, registered_at, updated_at)
  SELECT uid, display_name, authority, revision, registered_at, updated_at FROM collab_registrations;
DROP TABLE collab_registrations;
ALTER TABLE collab_registrations_next RENAME TO collab_registrations;

-- 本人凭据：服务端只存秘密的 SHA-256 哈希，secret 本身永不落库、不进日志/快照/导出。
-- status=revoked 后一律拒绝认证；同一 credential_id 只能属于一个 uid。
CREATE TABLE collab_credentials (
  credential_id TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX idx_collab_credentials_uid ON collab_credentials(uid, status);

-- 共享房间的公共投影快照：只保存经 classroomSharedCourseSchema 校验的公开内容
-- （无测验答案、无排序正确顺序、无关系正确目标、无评分依据与私人观察）。
-- snapshot_digest 与邀请时冻结的课程摘要一致；content_digest 是服务端对投影正文
-- 复算的规范化哈希，用于拒绝「声明摘要一致、内容被换掉」的重传。
CREATE TABLE collab_room_snapshots (
  room_id         TEXT PRIMARY KEY REFERENCES collab_rooms(room_id),
  snapshot_digest TEXT NOT NULL,
  content_digest  TEXT NOT NULL,
  snapshot_json   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`,
  },
  {
    version: 32,
    name: 'collaboration_uid_enrollment',
    sql: `
CREATE TABLE collab_registration_claims (
  uid TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  consumed_credential_id TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 33,
    name: 'collaboration_teaching_state',
    sql: `
CREATE TABLE collab_teaching_states (
  room_id TEXT PRIMARY KEY REFERENCES collab_rooms(room_id),
  scene_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 34,
    name: 'collaboration_teaching_ai_state',
    sql: `
CREATE TABLE collab_teaching_ai_states (
  room_id TEXT PRIMARY KEY REFERENCES collab_rooms(room_id),
  scene_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 35,
    name: 'media_generation_tasks',
    sql: `
CREATE TABLE media_generation_tasks (
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_json TEXT NOT NULL,
  PRIMARY KEY (project_id, request_id),
  UNIQUE (project_id, task_id)
);
CREATE INDEX idx_media_tasks_run ON media_generation_tasks(project_id, run_id);
CREATE TABLE media_candidate_assets (
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),
  PRIMARY KEY (project_id, asset_id),
  FOREIGN KEY (project_id, task_id) REFERENCES media_generation_tasks(project_id, task_id)
);
`,
  },
  {
    version: 36,
    name: 'mp4_export_jobs',
    sql: `
CREATE TABLE mp4_export_jobs (
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  task_json TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id),
  UNIQUE(project_id, job_id)
);
CREATE TABLE mp4_export_segments (
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY(project_id, job_id, segment_index),
  FOREIGN KEY(project_id, job_id) REFERENCES mp4_export_jobs(project_id, job_id)
);
`,
  },
  {
    version: 37,
    name: 'material_extraction_originals',
    sql: `
CREATE TABLE material_extraction_originals (
  material_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_byte_length INTEGER NOT NULL,
  source_bytes BLOB NOT NULL,
  PRIMARY KEY(material_id, revision),
  FOREIGN KEY(material_id, revision) REFERENCES source_versions(material_id, revision)
);
`,
  },
  {
    version: 38,
    name: 'execution_lease_fencing',
    sql: `
CREATE TABLE execution_leases (
  project_id TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence > 0),
  expires_at INTEGER NOT NULL,
  released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)),
  PRIMARY KEY(project_id,execution_key)
);
`,
  },
  {
    version: 39,
    name: 'private_pro_sessions_and_skills',
    sql: `
CREATE TABLE pro_sessions (
  project_id TEXT NOT NULL, learner_uid TEXT NOT NULL, record_id TEXT NOT NULL,
  request_id TEXT NOT NULL, intent_digest TEXT NOT NULL, revision INTEGER NOT NULL,
  state_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  PRIMARY KEY(project_id,learner_uid,record_id), UNIQUE(project_id,learner_uid,request_id)
);
CREATE TABLE pro_custom_skills (
  project_id TEXT NOT NULL, learner_uid TEXT NOT NULL, record_id TEXT NOT NULL,
  request_id TEXT NOT NULL, intent_digest TEXT NOT NULL, revision INTEGER NOT NULL,
  state_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  PRIMARY KEY(project_id,learner_uid,record_id), UNIQUE(project_id,learner_uid,request_id)
);
`,
  },
  {
    version: 40,
    name: 'scene_plan_patch_candidates',
    sql: `
-- 受限 AI 场景计划补丁候选（LESSON-02 / OMA-023）。模型只能提出受限补丁操作，
-- 先落待核候选；人工逐项审核后，选中的可应用操作才按 save-scene-plan 的乐观并发写入计划。
-- 来源绑定、知识点与场景身份不在补丁合同里，因此候选也不携带这些字段。
CREATE TABLE lesson_scene_patch_candidates (
  candidate_id  TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  lesson_id     TEXT NOT NULL,
  base_version  INTEGER NOT NULL,
  base_plan_revision INTEGER NOT NULL DEFAULT 0,
  base_plan_digest TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')),
  candidate_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_lesson_scene_patch_candidates_scope
  ON lesson_scene_patch_candidates(project_id, lesson_id, base_version);
-- 生成与处置的事务内回执：同一 requestId 与意图重试读回既有结论，不重复调用或写入。
CREATE TABLE lesson_scene_patch_receipts (
  project_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('propose','apply')),
  intent_json TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('completed','failed','cancelled','unknown')),
  result_json TEXT,
  message     TEXT NOT NULL DEFAULT '',
  error_code  TEXT,
  error_reason TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id)
);
`,
  },
  {
    version: 41,
    name: 'pro_external_tokens',
    sql: `
-- Pro 外部任务 API 的 bearer token（OMA-017）。数据库只保存 SHA-256 哈希，
-- secret 明文只在创建/轮换时展示一次、永不落库/日志/导出；scopes 为最小 read/create/send。
CREATE TABLE pro_external_tokens (
  token_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  owner_uid    TEXT NOT NULL,
  label        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  scopes_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  UNIQUE(secret_hash)
);
CREATE INDEX idx_pro_external_tokens_owner
  ON pro_external_tokens(project_id, owner_uid, created_at);
`,
  },
  {
    version: 42,
    name: 'scene_plan_edit_drafts',
    sql: `
-- 场景计划的持久编辑草稿（LESSON-02 / OMA-024）。这是「正在编辑、尚未保存」的工作副本：
-- 绑定项目/课程/版本与编辑基线（base_revision/base_digest），跨端口/重启恢复；
-- 不参与教学、不驱动文档、不影响审核，只有 save-scene-plan 成功后才成为计划。
CREATE TABLE lesson_scene_plan_drafts (
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  lesson_id      TEXT NOT NULL,
  lesson_version INTEGER NOT NULL,
  base_revision  INTEGER NOT NULL,
  base_digest    TEXT,
  draft_json     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, lesson_id, lesson_version)
);
`,
  },
  {
    version: 43,
    name: 'scene_plan_receipt_draft_action',
    sql: `
-- 放宽计划命令回执的 action CHECK：新增 'save-scene-plan-draft'（OMA-024 持久编辑草稿）。
-- SQLite 不能直接改 CHECK，用建新表/搬数据/改名的方式重建。
CREATE TABLE lesson_scene_plan_receipts_next (
  project_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('save-scene-plan','apply-courseware','save-scene-plan-draft')),
  intent_json TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('completed','failed','cancelled','unknown')),
  result_json TEXT,
  message     TEXT NOT NULL DEFAULT '',
  error_code  TEXT,
  error_reason TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id)
);
INSERT INTO lesson_scene_plan_receipts_next
  (project_id, request_id, action, intent_json, state, result_json, message, error_code, error_reason, created_at)
SELECT project_id, request_id, action, intent_json, state, result_json, message, error_code, error_reason, created_at
  FROM lesson_scene_plan_receipts;
DROP TABLE lesson_scene_plan_receipts;
ALTER TABLE lesson_scene_plan_receipts_next RENAME TO lesson_scene_plan_receipts;
`,
  },
  {
    version: 44,
    name: 'pro_external_token_receipts',
    sql: `
-- 外部 token 管理命令的事务内回执（OMA-017）。凭据系统里「创建/轮换」非幂等会造成重复 token
-- 或重复轮换（旧 secret 立即失效、再换新 secret）。同 requestId 与意图重发读回既有结论：
-- 不重复创建、不重复轮换、不重复撤销。result_json 只存公开元数据（绝不含 secret 或哈希）。
CREATE TABLE pro_external_token_receipts (
  project_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create','rotate','revoke')),
  intent_json TEXT NOT NULL,
  token_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id)
);
`,
  },
  {
    version: 45,
    name: 'scene_plan_draft_revision',
    sql: `
-- 编辑草稿自身的单调版本（OMA-024）：草稿级 CAS，拒绝乱序/过期写入。
-- 与权威计划 revision 是不同约束：计划 revision 判「草稿是否基于旧计划」，草稿 revision 判
-- 「写入是否乱序/过期」。多窗口或重排的旧请求带着过期 draft_revision 提交时被拒，不覆盖新编辑。
-- 历史草稿（v42 建表）没有该列，默认 0 表示「尚无已记录的草稿版本」，首次保存会推进到 1。
ALTER TABLE lesson_scene_plan_drafts ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 46,
    name: 'deployment_access_codes',
    sql: `
-- 共享部署访问码（OMA-083）。数据库只保存 SHA-256 哈希，明文仅在签发时展示一次、永不落库/日志/导出。
-- 访问码只授予「接入部署」能力（join/guest），不代替本人凭据认证；可撤销、可设有效期。
CREATE TABLE deployment_access_codes (
  code_id     TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(project_id),
  label       TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  used_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(secret_hash)
);
CREATE INDEX idx_deployment_access_codes_project
  ON deployment_access_codes(project_id, created_at);
-- 兑换收据：同 requestId 与意图重发读回既有授权，不重复计数。
CREATE TABLE deployment_access_receipts (
  project_id  TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  code_id     TEXT NOT NULL,
  uid         TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('join','guest')),
  intent_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id)
);
`,
  },
  {
    version: 47,
    name: 'interactive_snapshots',
    sql: `
-- 互动保活快照（OMA-045）。非权威现场：按 (项目, stage, 场景, 本人) 一对一保存组件临时状态。
-- 只有组件版本一致才恢复；版本不符或无快照则明确重置。快照不影响任何本人已提交记录。
CREATE TABLE interactive_snapshots (
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  stage_id       TEXT NOT NULL,
  scene_id       TEXT NOT NULL,
  learner_uid    TEXT NOT NULL,
  widget_version TEXT NOT NULL,
  data_json      TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, stage_id, scene_id, learner_uid)
);
`,
  },
];

// Registration order is part of the upgrade protocol; reject duplicate, skipped, or reordered versions.
for (let index = 0; index < MIGRATIONS.length; index += 1) {
  if (MIGRATIONS[index]?.version !== index + 1)
    throw new Error('Database migrations must be consecutive and ordered');
}
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * 打开一个库并按 `MIGRATIONS` 迁移到当前版本。
 *
 * 本机学习服务的 `StudyStore` 与独立协作服务的 `CollabServiceStore` 共用同一份
 * 迁移清单与顺序校验，避免两处各自维护一份迁移、出现「本机升到 v31、协作服务还停在
 * v30」这类漂移。这里不做业务判断，只按版本推进事务。
 */
export const applyMigrations = (db: SqlDatabase): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number((row as { version?: unknown }).version ?? 0)),
  );
  if (
    [...applied].some(
      (version) => !Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION,
    )
  ) {
    throw new StudyError('PROJECT_FORMAT_UNSUPPORTED', {
      reason: 'unsupported_schema_version',
      supported: SCHEMA_VERSION,
    });
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      migration.migrate?.(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
};
