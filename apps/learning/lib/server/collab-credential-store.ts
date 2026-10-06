/**
 * 在线协作凭据的受控存储（ADR-0005）。
 *
 * 凭据（`credentialId` + `secret`）只留在**本地服务的受控边界**：写入用户级目录
 * （`resolveUserDataDir()`），文件权限 0600，原子替换。它**不进**浏览器存储、
 * 日志、项目快照或导出——渲染层只拿到 `credentialId` 这个公开句柄，永远拿不到 secret。
 *
 * 磁盘文件是不可信输入：读取时用严格 schema 校验，损坏即视为未配置（不静默使用）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decodeJson } from '@sew/study-storage';
import { resolveUserDataDir } from './global-preferences';

export const COLLAB_CREDENTIAL_FILE_NAME = 'collab-online-credential.json';

export const collabCredentialFileSchema = z
  .object({
    fileVersion: z.literal(1),
    credentialId: z.string().min(1).max(200),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    pendingRegistration: z
      .object({
        uid: z.string().min(1),
        displayName: z.string().min(1),
        requestId: z.string().min(1).max(200),
        baseUrl: z.string().url(),
        activationToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CollabCredentialRecord = z.infer<typeof collabCredentialFileSchema>;

const filePath = (): string => join(resolveUserDataDir(), COLLAB_CREDENTIAL_FILE_NAME);

/** 读取本人凭据；未配置或损坏时返回 null（调用方据此显示「不能联网邀请」）。 */
export const readCollabCredential = (): CollabCredentialRecord | null => {
  let raw: string;
  try {
    raw = readFileSync(filePath(), 'utf8');
  } catch {
    return null;
  }
  const decoded = decodeJson(raw, collabCredentialFileSchema, null, 'collab-online-credential');
  return decoded.ok ? decoded.value : null;
};

/** 写入本人凭据：0600 权限，临时文件 + rename 原子替换。 */
export const writeCollabCredential = (record: CollabCredentialRecord): void => {
  const validated = collabCredentialFileSchema.parse(record);
  const dir = resolveUserDataDir();
  mkdirSync(dir, { recursive: true });
  const target = filePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* 保留原始失败 */
    }
    throw error;
  }
};

/** 清除本人凭据（吊销后或用户主动解绑）。文件不存在视为已清除。 */
export const clearCollabCredential = (): void => {
  try {
    rmSync(filePath(), { force: true });
  } catch {
    /* 已不存在 */
  }
};
