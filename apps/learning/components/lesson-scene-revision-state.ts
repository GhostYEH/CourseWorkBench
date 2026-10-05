export const defaultRevisionTitle = (lessonTitle: string): string =>
  `${lessonTitle}（改写）`.slice(0, 120);

/** 自动生成的标题不算改动；场景以稳定 ID 的集合比较，勾选顺序不影响内容。 */
export const hasLessonRevisionChanges = (
  lessonTitle: string,
  baselineStatementIds: readonly string[],
  title: string,
  selectedStatementIds: readonly string[],
): boolean => {
  const baseline = new Set(baselineStatementIds);
  const selected = new Set(selectedStatementIds);
  const scenesChanged =
    baseline.size !== selected.size || [...baseline].some((id) => !selected.has(id));
  const normalizedTitle = title.trim();
  const titleChanged =
    normalizedTitle !== defaultRevisionTitle(lessonTitle).trim() &&
    normalizedTitle !== lessonTitle.trim();
  return scenesChanged || titleChanged;
};
