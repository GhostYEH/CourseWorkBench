import { describe, expect, it } from 'vitest';
import {
  decodeJson,
  encodeJson,
  prerequisitesSchema,
  mechanicalSchema,
} from '../packages/study-storage/src/json-codec';

/**
 * N8：JSON 持久化校验。损坏数据不得静默当作合法数据。
 */
describe('JSON codec', () => {
  it('合法 JSON 通过校验并返回解析值', () => {
    const decoded = decodeJson('["kp_1","kp_2"]', prerequisitesSchema, [], 'test.prerequisites');
    expect(decoded.ok).toBe(true);
    expect(decoded.error).toBeNull();
    expect(decoded.value).toEqual(['kp_1', 'kp_2']);

    const mechanical = decodeJson(
      '{"passed":true,"checks":[{"code":"SOURCE_LOCATED","ok":true,"detail":"ok"}]}',
      mechanicalSchema,
      { passed: false, checks: [] },
      'test.mechanical',
    );
    expect(mechanical.ok).toBe(true);
    expect(mechanical.value.passed).toBe(true);
  });

  it('损坏 JSON 返回 ok:false、可诊断错误与显式 fallback', () => {
    const decoded = decodeJson('["kp_1",', prerequisitesSchema, [], 'proposals.prerequisites_json');
    expect(decoded.ok).toBe(false);
    expect(decoded.value).toEqual([]);
    expect(decoded.error).toContain('proposals.prerequisites_json');
    expect(decoded.error).toContain('JSON 解析失败');
  });

  it('根形状错误被拒绝（期望数组却给对象）', () => {
    const decoded = decodeJson('{"a":1}', prerequisitesSchema, [], 'test.root_shape');
    expect(decoded.ok).toBe(false);
    expect(decoded.error).toContain('test.root_shape');
    expect(decoded.error).toContain('形状校验失败');
    expect(decoded.value).toEqual([]);
  });

  it('null 与空串视为未写入，回退但不报错', () => {
    expect(decodeJson(null, prerequisitesSchema, [], 'test.null')).toEqual({
      value: [],
      ok: true,
      error: null,
    });
    expect(decodeJson('   ', prerequisitesSchema, [], 'test.empty')).toEqual({
      value: [],
      ok: true,
      error: null,
    });
  });

  it('encodeJson 序列化 undefined 为显式 null', () => {
    expect(encodeJson({ a: 1 })).toBe('{"a":1}');
    expect(encodeJson(undefined)).toBe('null');
  });
});
