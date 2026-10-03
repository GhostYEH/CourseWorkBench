/**
 * 用户级全局偏好（外观与阅读）。
 *
 * 外观属于用户而不是某个项目：它存在用户级目录里，切换项目不应改变主题。
 * 文件用版本化 schema 校验，写入走临时文件 + rename 的原子替换；
 * 文件缺失或损坏时回退默认值并告警，不抛出异常拖垮请求。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { preferencesSchema, type PreferencesDto } from '@sew/study-contracts';
import { DEFAULT_PREFERENCES } from '../preferences';

/** 全局偏好文件格式版本。升级格式时递增并在此处理迁移。 */
export const GLOBAL_PREFERENCES_FILE_VERSION = 1;

const globalPreferencesFileSchema = z.object({
  fileVersion: z.literal(GLOBAL_PREFERENCES_FILE_VERSION),
  preferences: preferencesSchema,
});

const PREFERENCES_FILE_NAME = 'global-preferences.json';

/**
 * 用户级目录：优先使用环境变量 `SEW_USER_DATA_DIR`，否则回退到服务工作目录下的
 * 稳定路径（apps/learning/.sew-user-data），不使用易被清理的系统临时目录。
 */
export const resolveUserDataDir = (): string => {
  const configured = process.env.SEW_USER_DATA_DIR;
  if (configured && configured.trim().length > 0) return configured;
  return join(process.cwd(), '.sew-user-data');
};

const preferencesFilePath = (): string => join(resolveUserDataDir(), PREFERENCES_FILE_NAME);

export const readGlobalPreferences = (): PreferencesDto => {
  const file = preferencesFilePath();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // 尚未写入过属于正常情况，不告警。
    return { ...DEFAULT_PREFERENCES };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[preferences] 全局偏好文件不是合法 JSON，已回退默认值：${file}`);
    return { ...DEFAULT_PREFERENCES };
  }

  const result = globalPreferencesFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[preferences] 全局偏好文件校验失败，已回退默认值：${file}`);
    return { ...DEFAULT_PREFERENCES };
  }
  return { ...DEFAULT_PREFERENCES, ...result.data.preferences };
};

export const writeGlobalPreferences = (value: PreferencesDto): PreferencesDto => {
  const validated = preferencesSchema.parse(value);
  const dir = resolveUserDataDir();
  const file = preferencesFilePath();
  mkdirSync(dir, { recursive: true });

  const payload = JSON.stringify({
    fileVersion: GLOBAL_PREFERENCES_FILE_VERSION,
    preferences: validated,
  });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempFile, payload, 'utf8');
  renameSync(tempFile, file);
  return validated;
};
