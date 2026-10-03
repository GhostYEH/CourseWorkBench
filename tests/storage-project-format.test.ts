import { describe, expect, it } from 'vitest';
import { StudyError } from '@sew/study-contracts';
import { PROJECT_FORMAT_VERSION, assertManifestCompatible } from '@sew/study-storage';

/**
 * F4：项目格式版本过高时必须抛领域错误 `PROJECT_FORMAT_UNSUPPORTED`，
 * 使 HTTP 层返回 409（用户可理解）而不是 500（内部故障）。
 */
describe('项目格式兼容性', () => {
  const manifest = (formatVersion: number) => ({
    formatVersion,
    projectId: 'proj_1',
    displayName: '数学',
    createdAt: new Date().toISOString(),
  });

  it('高于当前支持的格式版本抛 PROJECT_FORMAT_UNSUPPORTED', () => {
    try {
      assertManifestCompatible(manifest(PROJECT_FORMAT_VERSION + 1));
      throw new Error('应当抛出 PROJECT_FORMAT_UNSUPPORTED');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      expect((error as StudyError).code).toBe('PROJECT_FORMAT_UNSUPPORTED');
      expect((error as StudyError).details).toMatchObject({
        formatVersion: PROJECT_FORMAT_VERSION + 1,
        supported: PROJECT_FORMAT_VERSION,
      });
    }
  });

  it('缺失 manifest 或版本不高于当前时放行', () => {
    expect(() => assertManifestCompatible(null)).not.toThrow();
    expect(() => assertManifestCompatible(manifest(PROJECT_FORMAT_VERSION))).not.toThrow();
  });
});
