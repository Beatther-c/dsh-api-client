/**
 * tab 生命周期纯函数（P0 实施设计 §7.4 / UX §4.7，WP6）。
 *
 * 零 React、零 DSH、零视图类型 import：泛型约束只要求 `{ key: string }`，
 * ApiClientView 的 RequestTab（WP8 消费）天然满足，本文件不得反向 import 视图类型。
 *
 * 语义（§7.4 冻结）：
 * - active 未被删 → activeKey 保持；
 * - active 被删 → 原 active 位置左侧最近的存活 tab；左侧没有 → 右侧第一个存活 tab；
 *   均无 → undefined（回到空状态）；
 * - 非 active tab 被删不影响 activeKey；
 * - removedKeys 为空 → 原样返回（新数组引用亦可，内容与语义不变）。
 */

/** 最小结构约束：任何带唯一 key 的 tab 形状（RequestTab 直接可用）。 */
export interface KeyedTab {
  key: string
}

/** removeTabsAndSelectNext 的结果：存活 tabs（保持原顺序与原对象引用）+ 新 activeKey。 */
export interface TabSelection<T extends KeyedTab> {
  tabs: T[]
  activeKey: string | undefined
}

/**
 * 移除 removedKeys 指定的 tabs，并按 §7.4 规则选出下一个 active tab。
 *
 * 调用时机（§7.3）：Host 删除成功之后；本函数不做任何副作用，纯计算。
 *
 * 退化情形（文档化约定）：activeKey 在 removedKeys 中但不在 tabs 里（调用方
 * 已先行移除）时，视为「左侧无存活」，选择右侧第一个存活 tab（即幸存序列首位）。
 */
export function removeTabsAndSelectNext<T extends KeyedTab>(
  tabs: T[],
  activeKey: string | undefined,
  removedKeys: ReadonlySet<string> | string[],
): TabSelection<T> {
  const removed: ReadonlySet<string> = Array.isArray(removedKeys) ? new Set(removedKeys) : removedKeys
  if (removed.size === 0) {
    return { tabs: [...tabs], activeKey }
  }
  const survivors = tabs.filter((tab) => !removed.has(tab.key))
  if (activeKey === undefined || !removed.has(activeKey)) {
    return { tabs: survivors, activeKey }
  }
  // active 被删：先在原序列中定位，再左邻优先、右侧兜底。
  const index = tabs.findIndex((tab) => tab.key === activeKey)
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = tabs[i]
    if (candidate !== undefined && !removed.has(candidate.key)) {
      return { tabs: survivors, activeKey: candidate.key }
    }
  }
  for (let i = index + 1; i < tabs.length; i += 1) {
    const candidate = tabs[i]
    if (candidate !== undefined && !removed.has(candidate.key)) {
      return { tabs: survivors, activeKey: candidate.key }
    }
  }
  return { tabs: survivors, activeKey: undefined }
}
