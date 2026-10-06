/** 作者输入的行顺序只写入私有 correctOrder；条目身份不编码答案位置。 */
export const createOrderingItems = (text: string) => {
  const items = text
    .split('\n')
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => ({ id: `item_${crypto.randomUUID()}`, label }));
  return { items, correctOrder: items.map((item) => item.id) };
};

/** 同一作者输入重试必须复用条目身份，响应丢失不能变成另一份冻结定义。 */
export const createOrderingItemsCache = () => {
  let cached: { text: string; items: ReturnType<typeof createOrderingItems> } | null = null;
  return (text: string): ReturnType<typeof createOrderingItems> => {
    if (cached?.text !== text) cached = { text, items: createOrderingItems(text) };
    return cached.items;
  };
};

/** 没有本人草稿时从空排列开始，候选呈现不自动成为本人答案。 */
export const restoreOrderingOrder = (saved: readonly string[] | null): string[] =>
  saved ? [...saved] : [];
