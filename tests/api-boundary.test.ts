import { describe, expect, it } from 'vitest';
import {
  materialImportSchema,
  questionDetailQuerySchema,
  questionCreateSchema,
  preferencesWriteSchema,
} from '@sew/study-contracts';
import { toQuestionDetailDto, toQuestionListItemDto } from '../apps/learning/lib/server/dto';
import type { QuestionRow } from '@sew/study-storage';

/**
 * API 边界回归（N1/N7 + 缺陷「题目列表暴露答案/解析」）。
 *
 * 这些用例锁定「存储记录与 API DTO 分离」「答案按入口最小化」「导入模式用判别联合」
 * 三条边界，避免日后有人把 row 直接透传或退回字符串推断。
 */

const questionRow = (): QuestionRow => ({
  questionId: 'q1',
  stem: '判断 f(x)=x^2 在 (0,+∞) 上的单调性',
  answer: '增函数',
  solution: '取值、作差、变形、定号、下结论',
  knowledgeIds: ['kp1'],
  origin: 'material_original',
  originLabel: '材料原题',
  originDetail: '材料 mat1 r1 第 3 题',
  originRecord: {
    materialId: 'mat1',
    revision: 1,
    questionNumber: '3',
    rewrittenFrom: null,
    rewriteNote: '',
  },
  revision: 1,
  requestedOrigin: 'material_original',
  forgedExamClaim: false,
  recordScope: 'formal',
  createdAt: new Date().toISOString(),
});

describe('题目 DTO 边界', () => {
  it('列表项不含标准答案与解析，且不带内部字段', () => {
    const dto = toQuestionListItemDto(questionRow());
    expect(dto).not.toHaveProperty('answer');
    expect(dto).not.toHaveProperty('solution');
    expect(dto).not.toHaveProperty('originRecord');
    expect(Object.keys(dto).sort()).toEqual(
      ['knowledgeIds', 'origin', 'originDetail', 'originLabel', 'questionId', 'recordScope', 'revision', 'stem'].sort(),
    );
  });

  it('详情 DTO 才携带答案与解析', () => {
    const dto = toQuestionDetailDto(questionRow());
    expect(dto.answer).toBe('增函数');
    expect(dto.solution).toContain('作差');
  });
});

describe('题目详情查询参数', () => {
  it('缺省与显式 false 都不返回答案', () => {
    expect(questionDetailQuerySchema.parse({}).includeAnswer).toBe(false);
    expect(questionDetailQuerySchema.parse({ includeAnswer: 'false' }).includeAnswer).toBe(false);
  });

  it('只有显式 true 才返回答案', () => {
    expect(questionDetailQuerySchema.parse({ includeAnswer: 'true' }).includeAnswer).toBe(true);
  });

  it('拒绝非布尔字面量，避免歧义输入', () => {
    expect(questionDetailQuerySchema.safeParse({ includeAnswer: '1' }).success).toBe(false);
    expect(questionDetailQuerySchema.safeParse({ includeAnswer: 'yes' }).success).toBe(false);
  });
});

describe('材料导入判别联合（N7）', () => {
  const scope = { projectId: 'proj1', generation: 1 };
  const base = { displayName: '必修一.md', type: 'md' as const };

  it('file 模式必须带 sourcePath，且不接受 rawText 混淆', () => {
    const parsed = materialImportSchema.parse({ ...base, scope, mode: 'file', sourcePath: 'C:/x.md' });
    expect(parsed.mode).toBe('file');
    expect(materialImportSchema.safeParse({ ...base, scope, mode: 'file' }).success).toBe(false);
  });

  it('text 模式必须带 rawText', () => {
    const parsed = materialImportSchema.parse({ ...base, scope, mode: 'text', rawText: '正文' });
    expect(parsed.mode).toBe('text');
    expect(materialImportSchema.safeParse({ ...base, scope, mode: 'text' }).success).toBe(false);
  });

  it('缺少 mode 的旧式请求被拒绝，不再靠字段推断', () => {
    expect(
      materialImportSchema.safeParse({ ...base, scope, sourcePath: 'C:/x.md' }).success,
    ).toBe(false);
  });
});

describe('题目创建请求不接受自报真题字段（缺陷「真题可信事实可由请求自报」）', () => {
  it('originRecord 不接受 materialVerifiedAsExam', () => {
    const parsed = questionCreateSchema.safeParse({
      scope: { projectId: 'proj1', generation: 1 },
      stem: '题目',
      knowledgeIds: ['kp1'],
      requestedOrigin: 'exam_original',
      originRecord: {
        materialId: 'mat1',
        revision: 1,
        questionNumber: '3',
        materialVerifiedAsExam: true,
      },
    });
    // zod 默认剥离未知字段：即便请求塞入该字段也不会进入解析结果。
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.originRecord).not.toHaveProperty('materialVerifiedAsExam');
    }
  });
});

describe('偏好写入作用域（缺陷「偏好作用域不一致」+ N2）', () => {
  const appearance = {
    theme: 'paper',
    accentPreset: 'cinnabar',
    uiFont: 'system-sans',
    readingFont: 'system-serif',
    readingFontSizePx: 18,
    readingLineHeight: 1.7,
    readingMaxWidthPx: 760,
    zoom: 1,
    density: 'standard',
    reduceMotion: 'system',
    panelTreeWidth: 240,
    panelRightWidth: 320,
    bottomPanelHeight: 28,
  };
  const teaching = {
    learningMode: 'beginner',
    explanation: 'intuitive',
    hintDepth: 'stepwise',
    exerciseBalance: 'balanced',
    selfExplanation: true,
    everydayExamples: 'moderate',
    extraPreference: '',
  };

  it('外观是全局偏好，不需要 scope', () => {
    expect(preferencesWriteSchema.safeParse({ appearance }).success).toBe(true);
  });

  it('教学表达是项目级，缺少 scope 必须拒绝', () => {
    expect(preferencesWriteSchema.safeParse({ teaching }).success).toBe(false);
  });

  it('教学表达携带 scope 才接受', () => {
    const parsed = preferencesWriteSchema.safeParse({
      scope: { projectId: 'proj1', generation: 3 },
      teaching,
    });
    expect(parsed.success).toBe(true);
  });

  it('空请求（既无 appearance 也无 teaching）被拒绝', () => {
    expect(preferencesWriteSchema.safeParse({}).success).toBe(false);
  });
});
