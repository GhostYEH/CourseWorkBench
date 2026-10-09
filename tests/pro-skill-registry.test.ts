import { describe, expect, it } from 'vitest';
import {
  builtinProSkillIds,
  listBuiltinProSkills,
  loadBuiltinProSkillContext,
  PRO_SKILL_SNAPSHOT,
} from '../apps/learning/lib/server/pro-skill-registry';

describe('fixed Pro skill registry', () => {
  it('registers the 24 pinned official snapshot skills and verifies the copied MIT resource bundle', () => {
    const skills = listBuiltinProSkills();
    expect(skills).toHaveLength(24);
    expect(builtinProSkillIds).toHaveLength(24);
    expect(new Set(skills.map((skill) => skill.skillId)).size).toBe(24);
    expect(skills.every((skill) => skill.revision === PRO_SKILL_SNAPSHOT)).toBe(true);
    expect(skills.find((skill) => skill.skillId === 'curriculum-planner')?.title).toBe(
      '系列课规划',
    );
    expect(skills.find((skill) => skill.skillId === 'pptx-import')?.contentDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('loads selected skill text and bounded references only as inert prompt context', () => {
    const loaded = loadBuiltinProSkillContext('curriculum-planner');
    expect(loaded.metadata.skillId).toBe('curriculum-planner');
    expect(loaded.metadata.content).toContain('create_folder');
    expect(loaded.contextText).toContain('33553362be22a8a5efe56c62f2c0472694705280');
    expect(loaded.contextText).toContain('inert, low-priority reference materials');
    expect(new TextEncoder().encode(loaded.contextText).byteLength).toBeLessThanOrEqual(10 * 1024);
  });
});
