import assert from 'node:assert/strict';
import path from 'node:path';
import {
  callsJsonParse,
  dependencyTargets,
  moduleSpecifiers,
  parseSource,
} from './source-files.mjs';

const LAYER_RULES = [
  {
    prefix: 'packages/study-contracts/',
    label: 'study-contracts 只保存共享类型，不得反向依赖领域/存储或框架',
    forbid: [
      '@sew/study-domain',
      '@sew/study-storage',
      'electron',
      'react',
      'react-dom',
      'next',
      'zustand',
      'fs',
      'sqlite',
    ],
  },
  {
    prefix: 'packages/study-domain/',
    label: 'study-domain 只做判断，不得依赖框架、存储或文件系统 IO',
    forbid: [
      '@sew/study-storage',
      'electron',
      'react',
      'react-dom',
      'next',
      'zustand',
      'fs',
      'sqlite',
    ],
  },
  {
    prefix: 'packages/study-storage/',
    label: 'study-storage 不得依赖 Electron/React/Next 或应用层',
    forbid: ['electron', 'react', 'react-dom', 'next', 'zustand', '/apps/'],
  },
  {
    prefix: 'apps/desktop/src/',
    label: 'Electron 主进程不得打开数据库或依赖领域/存储包',
    forbid: ['@sew/study-storage', '@sew/study-domain', 'sqlite', 'better-sqlite3', 'sqlite3'],
  },
];

const JSON_PARSE_ALLOWLIST = new Set([
  // 多选答案是跨 HTTP 的 JSON 文本，在评分入口解析后立即做严格 schema 校验。
  'packages/study-domain/src/assessment.ts',
  'packages/study-storage/src/json-codec.ts',
  'packages/study-storage/src/project-layout.ts',
  'apps/learning/lib/attempt-submission.ts',
  // 课堂多选草稿恢复：JSON 解码后校验选项值，拒绝损坏数据。
  'apps/learning/lib/quiz-answer.ts',
  // Model output is decoded at this single boundary and validated as a grading proposal.
  'apps/learning/lib/server/attempt-grading-model.ts',
  // 同一模式：错因/复习候选的模型正文只在这里解码，随后立刻用严格 schema 校验。
  'apps/learning/lib/server/feedback-model.ts',
  // 同一模式：陈述改写候选的模型正文只在这里解码，随后立刻用严格 schema 校验。
  'apps/learning/lib/server/lesson-revision-model.ts',
  // 同一模式：完整课件候选的模型正文只在这里解码，随后立刻用严格 schema 校验。
  'apps/learning/lib/server/lesson-courseware-model.ts',
  'apps/learning/lib/server/global-preferences.ts',
  // User identity files are decoded only here, then validated by the strict shared schema.
  'apps/learning/lib/server/learner-profile.ts',
  'apps/learning/lib/server/model-connection.ts',
  // 浏览器侧导入用户选中的冻结报告：本地文件只在这里解码，随后立即用严格 schema 校验，
  // 并交由服务端复算摘要与得分。服务端正文统一走 lib/server/bounded-json 的带限额解码入口，
  // 不在路由里直接 JSON.parse 或另写一份流式字节上限。
  'apps/learning/app/workbench/eval/eval-report-import-panel.tsx',
  'apps/desktop/src/service-lifecycle.cjs',
  'apps/desktop/src/settings.cjs',
]);

/** Layering and JSON-decoding checks share the same parsed source. */
export const checkSourceBoundaries = async (root, files) => {
  for (const filename of files) {
    const rel = path.relative(root, filename).split(path.sep).join('/');
    const source = await parseSource(filename);
    const rule = LAYER_RULES.find((candidate) => rel.startsWith(candidate.prefix));
    if (rule)
      for (const target of moduleSpecifiers(source)) {
        const hit = rule.forbid.find((banned) =>
          dependencyTargets(root, filename, target).some((candidate) =>
            banned.startsWith('/')
              ? candidate.includes(banned)
              : candidate === banned || candidate.startsWith(banned + '/'),
          ),
        );
        assert.ok(!hit, rel + ' 违反了分层约束（' + rule.label + '）：' + target);
      }
    assert.ok(
      !callsJsonParse(source) || JSON_PARSE_ALLOWLIST.has(rel),
      rel + ' 直接使用了 JSON.parse；请集中解码、校验并登记允许入口',
    );
  }
};
