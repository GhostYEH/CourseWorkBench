/** IPC errors can contain filesystem details. Only fixed identity guidance is displayed. */
export const describeProjectActionError = (caught: unknown): string => {
  const message = caught instanceof Error ? caught.message : '';
  if (message.includes('PROJECT_NOT_AUTHORIZED') && (message.includes('项目已关联其他本地 UID') || message.includes('个人档案与项目身份不一致'))) {
    return '项目身份不匹配，请使用原个人档案打开。复制科目项目不会迁移个人 UID。';
  }
  if (message.includes('INTERNAL') && message.includes('本地学习者身份')) {
    return '个人档案读取或保存失败，请检查原个人档案数据。当前项目不会改为另一个 UID。';
  }
  return '项目操作失败，请确认所选目录可访问后重试。';
};
