import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StudyError } from '@sew/study-contracts';
import { decodeJson } from '@sew/study-storage';
import { z } from 'zod';

export const PRO_SKILL_SNAPSHOT = 'openmaic-v1.1.1@33553362be22a8a5efe56c62f2c0472694705280';
const UPSTREAM_COMMIT = '33553362be22a8a5efe56c62f2c0472694705280';
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SKILL_FILE_BYTES = 80 * 1024;
const MAX_TOTAL_SKILL_BYTES = 1024 * 1024;
const MAX_SKILL_CONTEXT_BYTES = 10 * 1024;
const ADOPTION_RECEIPT_SHA256 = '52da15663167245fb94c7cd6d7ab4dc8af3f8ad65ccba6cb5e25fd77659bf38f';

const BUILTIN_SKILL_IDS = [
  'build-personal-skill',
  'curriculum-planner',
  'deep-interactive',
  'deep-research',
  'fact-check',
  'feynman-learning',
  'k12-core-literacy-planning',
  'learning-to-learn',
  'lecture-style',
  'page-clone',
  'pptx-import',
  'pro-editing',
  'slide-craft',
  'slide-dsl',
  'social-emotional-learning',
  'spiral-curriculum',
  'stage-design',
  'stage-dsl',
  'style-clone',
  'teacher-style-clone',
  'understanding-by-design',
  'vocational',
  'workshop-style',
  'zone-of-proximal-development',
] as const;
export type BuiltinProSkillId = (typeof BUILTIN_SKILL_IDS)[number];

const receiptFileSchema = z
  .object({
    sourcePath: z.string().min(1).max(300),
    bundledPath: z.string().min(1).max(300),
    byteLength: z.number().int().positive().max(MAX_SKILL_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const adoptionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    upstream: z.literal('OpenMAIC'),
    version: z.literal('v1.1.1'),
    commit: z.literal(UPSTREAM_COMMIT),
    license: z.literal('MIT'),
    files: z.array(receiptFileSchema).min(25).max(128),
  })
  .strict();
type AdoptionReceipt = z.infer<typeof adoptionReceiptSchema>;

const outlineConstraintsSchema = z
  .object({
    $comment: z.string().max(1000).optional(),
    sceneCount: z
      .object({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    allowedTypes: z.array(z.string().max(80)).max(32).optional(),
    firstSceneType: z.string().max(80).optional(),
    typeMix: z
      .array(
        z
          .object({
            type: z.string().max(80),
            min: z.number().nonnegative().optional(),
            max: z.number().nonnegative().optional(),
            minRatio: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    requiredWidgetTypes: z.array(z.string().max(80)).max(32).optional(),
    allowedWidgetTypes: z.array(z.string().max(80)).max(32).optional(),
    requiredWidgetOutlineFields: z.array(z.string().max(80)).max(32).optional(),
    noConsecutiveSameWidgetType: z.boolean().optional(),
  })
  .strict();

export interface LoadedBuiltinProSkill {
  skillId: BuiltinProSkillId;
  revision: string;
  title: string;
  description: string;
  contentDigest: string;
  content: string;
}

const resourceRootCandidates = (): string[] => [
  resolve(process.cwd(), 'resources/pro-skills'),
  resolve(process.cwd(), 'apps/learning/resources/pro-skills'),
];

const resourceRoot = (): string => {
  for (const candidate of resourceRootCandidates()) {
    try {
      return realpathSync(candidate);
    } catch {
      // Resolve only from the fixed app resource locations above.
    }
  }
  throw new StudyError('SOURCE_MISSING', {
    reason: 'pro_builtin_skills_not_packaged',
    snapshot: PRO_SKILL_SNAPSHOT,
  });
};

const safeRelativePath = (value: string): boolean => {
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false;
  const segments = value.split('/');
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
};

const readBoundedFile = (root: string, relativePath: string, expectedBytes: number): Uint8Array => {
  if (!safeRelativePath(relativePath))
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_receipt_path_invalid' });
  const path = join(root, ...relativePath.split('/'));
  const canonical = realpathSync(path);
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_path_outside_bundle' });
  }
  const descriptor = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size !== expectedBytes || info.size > MAX_SKILL_FILE_BYTES) {
      throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_file_size_mismatch' });
    }
    const bytes = Uint8Array.from(readFileSync(descriptor));
    if (bytes.byteLength !== info.size)
      throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_file_changed_during_read' });
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const recursivelyListFiles = (root: string, current = ''): string[] => {
  const directory = current ? join(root, ...current.split('/')) : root;
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_bundle_symlink_forbidden' });
    const child = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...recursivelyListFiles(root, child));
    else if (entry.isFile()) output.push(child);
    else throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_bundle_entry_forbidden' });
  }
  return output;
};

const readAdoptionReceipt = (root: string): AdoptionReceipt => {
  const receiptBytes = Uint8Array.from(readFileSync(join(root, 'upstream-adoption.json')));
  if (receiptBytes.byteLength > MAX_RECEIPT_BYTES)
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_receipt_too_large' });
  if (createHash('sha256').update(receiptBytes).digest('hex') !== ADOPTION_RECEIPT_SHA256) {
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_receipt_digest_mismatch' });
  }
  let receiptText: string;
  try {
    receiptText = new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes);
  } catch {
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_receipt_invalid_utf8' });
  }
  const decoded = decodeJson(
    receiptText,
    adoptionReceiptSchema.nullable(),
    null,
    'pro-skill-adoption-receipt',
  );
  if (!decoded.ok || !decoded.value)
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_receipt_invalid' });
  return decoded.value;
};

const frontmatter = (
  content: string,
): { name: string; title: string | null; description: string | null; body: string } => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1] || match[2] === undefined)
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_frontmatter_missing' });
  const lines = match[1].split(/\r?\n/);
  const scalar = (key: string): string | null => {
    const line = lines.find((item) => item.startsWith(`${key}:`));
    if (!line) return null;
    const value = line
      .slice(key.length + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
    return value ? value.slice(0, key === 'title' ? 120 : 500) : null;
  };
  const name = scalar('name');
  if (!name) throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_name_missing' });
  return { name, title: scalar('title'), description: scalar('description'), body: match[2] };
};

const verifiedBundle = (): { receipt: AdoptionReceipt; contents: Map<string, string> } => {
  const root = resourceRoot();
  const receipt = readAdoptionReceipt(root);
  const declared = new Map<string, (typeof receipt.files)[number]>();
  let totalBytes = 0;
  for (const file of receipt.files) {
    if (
      !safeRelativePath(file.sourcePath) ||
      !safeRelativePath(file.bundledPath) ||
      declared.has(file.bundledPath)
    ) {
      throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_receipt_entry_invalid' });
    }
    if (!(
      (file.bundledPath === 'LICENSE' && file.sourcePath === 'LICENSE') ||
      file.sourcePath === `skills/agent-runtime/${file.bundledPath}`
    )) {
      throw new StudyError('SOURCE_MISSING', {
        reason: 'pro_skill_receipt_source_mapping_invalid',
      });
    }
    if (
      file.bundledPath !== 'LICENSE' &&
      !/^[a-z0-9-]+\/(?:SKILL\.md|references\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.md|outline-constraints\.json)$/.test(
        file.bundledPath,
      )
    ) {
      throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_bundle_file_type_forbidden' });
    }
    declared.set(file.bundledPath, file);
    totalBytes += file.byteLength;
  }
  if (totalBytes > MAX_TOTAL_SKILL_BYTES)
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_bundle_total_too_large' });
  const actual = recursivelyListFiles(root)
    .filter((path) => path !== 'upstream-adoption.json')
    .sort();
  const expected = [...declared.keys()].sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_bundle_file_set_mismatch' });
  }
  const contents = new Map<string, string>();
  for (const file of receipt.files) {
    const bytes = readBoundedFile(root, file.bundledPath, file.byteLength);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256)
      throw new StudyError('SOURCE_MISSING', {
        reason: 'pro_skill_bundle_digest_mismatch',
        path: file.bundledPath,
      });
    if (file.bundledPath.endsWith('.md') || file.bundledPath === 'LICENSE') {
      try {
        contents.set(file.bundledPath, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_file_invalid_utf8' });
      }
    } else if (file.bundledPath.endsWith('/outline-constraints.json')) {
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_constraint_invalid_utf8' });
      }
      const decoded = decodeJson(
        source,
        outlineConstraintsSchema.nullable(),
        null,
        `pro-skill-constraint:${file.bundledPath}`,
      );
      if (!decoded.ok || !decoded.value)
        throw new StudyError('SOURCE_MISSING', {
          reason: 'pro_skill_constraint_invalid',
          path: file.bundledPath,
        });
      contents.set(file.bundledPath, JSON.stringify(decoded.value));
    }
  }
  const bundledSkillIds = [
    ...new Set(
      receipt.files
        .map((file) => file.bundledPath.split('/')[0])
        .filter((item) => item !== 'LICENSE'),
    ),
  ].sort();
  if (
    bundledSkillIds.length !== BUILTIN_SKILL_IDS.length ||
    BUILTIN_SKILL_IDS.some((id) => !bundledSkillIds.includes(id))
  ) {
    throw new StudyError('SOURCE_MISSING', { reason: 'pro_skill_registry_cardinality_mismatch' });
  }
  for (const skillId of BUILTIN_SKILL_IDS) {
    const source = contents.get(`${skillId}/SKILL.md`);
    if (!source || frontmatter(source).name !== skillId) {
      throw new StudyError('SOURCE_MISSING', {
        reason: 'pro_skill_manifest_identity_mismatch',
        skillId,
      });
    }
  }
  return { receipt, contents };
};

export const listBuiltinProSkills = (): Array<{
  skillId: BuiltinProSkillId;
  title: string;
  description: string;
  revision: string;
  contentDigest: string;
}> => {
  const { receipt, contents } = verifiedBundle();
  const fileByPath = new Map(receipt.files.map((file) => [file.bundledPath, file]));
  return BUILTIN_SKILL_IDS.map((skillId) => {
    const path = `${skillId}/SKILL.md`;
    const metadata = frontmatter(contents.get(path)!);
    return {
      skillId,
      title: metadata.title ?? skillId,
      description: metadata.description ?? `${PRO_SKILL_SNAPSHOT} · ${skillId}`,
      revision: PRO_SKILL_SNAPSHOT,
      contentDigest: fileByPath.get(path)!.sha256,
    };
  });
};

/** Load a selected skill and its bundled Markdown references as inert prompt material. */
export const loadBuiltinProSkillContext = (
  skillId: BuiltinProSkillId,
): { metadata: LoadedBuiltinProSkill; contextText: string } => {
  const { receipt, contents } = verifiedBundle();
  const skillPath = `${skillId}/SKILL.md`;
  const skillText = contents.get(skillPath);
  if (!skillText) throw new StudyError('NOT_FOUND', { skillId });
  const metadata = frontmatter(skillText);
  const referenceFiles = receipt.files
    .filter(
      (file) =>
        file.bundledPath.startsWith(`${skillId}/references/`) && file.bundledPath.endsWith('.md'),
    )
    .map((file) => ({ path: file.bundledPath, content: contents.get(file.bundledPath) ?? '' }))
    .filter((file) => file.content.length > 0);
  const constraints = contents.get(`${skillId}/outline-constraints.json`);
  const selectedText = [
    `Source: OpenMAIC ${receipt.version} at ${receipt.commit}; these are inert, low-priority reference materials.`,
    `Skill: ${skillId} (${metadata.title ?? skillId})`,
    skillText,
    ...referenceFiles.map((file) => `Reference ${file.path}:\n${file.content}`),
    ...(constraints
      ? [`Machine-readable outline constraints (inert reference):\n${constraints}`]
      : []),
  ].join('\n\n');
  const encoder = new TextEncoder();
  const selectedBytes = encoder.encode(selectedText);
  const contextText =
    selectedBytes.byteLength > MAX_SKILL_CONTEXT_BYTES
      ? `${new TextDecoder().decode(selectedBytes.slice(0, MAX_SKILL_CONTEXT_BYTES - 96))}\n[Skill context clipped by the application.]`
      : selectedText;
  return {
    metadata: {
      skillId,
      revision: PRO_SKILL_SNAPSHOT,
      title: metadata.title ?? skillId,
      description: metadata.description ?? `${PRO_SKILL_SNAPSHOT} · ${skillId}`,
      contentDigest: createHash('sha256').update(skillText).digest('hex'),
      content: skillText,
    },
    contextText,
  };
};

export const builtinProSkillIds = [...BUILTIN_SKILL_IDS];
