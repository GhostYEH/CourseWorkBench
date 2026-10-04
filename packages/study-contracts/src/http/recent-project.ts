import { z } from 'zod';

// —— 最近项目（原生 IPC 独立 DTO）——

/**
 * 最近项目列表项。与「已打开项目」是不同对象：最近项目可能不存在磁盘目录、
 * 也没有打开代次，因此单独定义 DTO，不复用 OpenedProjectPayload 的语义。
 */
export const recentProjectSchema = z.object({
  displayPath: z.string(),
  displayName: z.string(),
  /** 上次打开时间（ISO 字符串），仅用于排序展示。 */
  lastOpenedAt: z.string(),
});
export type RecentProjectDto = z.infer<typeof recentProjectSchema>;
