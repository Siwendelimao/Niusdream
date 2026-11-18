/** injectMarkers.mjs 的类型声明 —— 只声明导出签名，实现全在 .mjs 里。 */

export interface InjectMarker {
  /** 注入判定的前缀（消息正文以它开头 ⇒ 是系统注入） */
  prefix: string
  /** 结构化 kind（落盘到 `_inject.kind`，前端据此决定画不画气泡） */
  kind: string
  /** 段首标签（空串 = 不画段首，如「自动续跑」） */
  label: string
}

/** 注入消息的**唯一登记处**：前缀 / kind / 标签三列对齐 */
export const INJECT_MARKERS: InjectMarker[]
/** `INJECT_MARKERS` 的前缀数组（判定用） */
export const INJECTED_USER_PREFIXES: string[]
/** 剥掉行首的注入行；`[技能:x]` 标签**不剥** */
export function stripInjectedLines(text: string): string
/** 这条消息是不是"系统注入的 user 消息"（= 不算真实轮） */
export function isInjectedUserMsg(m: any): boolean
