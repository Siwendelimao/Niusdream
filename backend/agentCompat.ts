/**
 * 底座适配层 —— 全仓**唯一**允许出现第三方底座包名（`@earendil-works/*`）的文件。
 *
 * 为什么要有这一层：
 *   产品自己的代码不应该到处挂着别人的包名。底座换了、升级了、甚至换了别家，
 *   要改的也只有这一个文件。业务代码一律从本文件 import，不再直接写 `@earendil-works/...`。
 *
 * 为什么包名本身改不了（技术事实，不是偷懒）：
 *   `@earendil-works/pi-ai` / `pi-agent-core` 是 npm 上**别人发布的真实依赖包**（`backend/package.json`
 *   的 dependencies），改名意味着改 `node_modules` ⇒ 构建与安装都无法完成。它和 Vue / Electron 同级，
 *   是"用了谁的库"这个事实，不是我们的产品命名。所以我们做的是**把它收进一层**，
 *   让我们自己的代码里一个字母都不出现。
 *
 * 本文件同时收口两处上游破坏性升级（★1011 0.84.2 → 1.1.0）：
 *   ① 收工钩子改名 + 返回语义反转（0.87 删 `shouldStopAfterTurn`，新增 `finishTurn`）
 *      旧：`(ctx) => boolean`，true = 停
 *      新：`(ctx) => { action: 'end' } | { action: 'continue' } | undefined`，end = 停
 *      ⇒ 用 toFinishTurn() 把"旧式 boolean 判据"包成新钩子（判据代码一行不动）。
 *      上游 d.ts 注明 "Error and aborted responses remain hard exits"（出错/中断仍是硬退出），
 *      与部分二手资料的说法相反 —— 这里不加守卫（保持行为等价），若实测发现出错轮被判错再补。
 *   ② 流函数入参从 `Context` 收紧为 `TranscriptContext`（0.86 起）
 *      官方原文："Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 *      provider code" ⇒ 直传 `{ systemPrompt, messages, tools }` 字面量会被类型系统拒绝（实测 14 条 TS2345）。
 *      ⇒ 统一用 toTranscriptCtx()。
 *      ⚠️ 语义影响：normalizeContext 会把 systemPrompt / tools **折进首条 system 消息**，
 *         请求字节前缀可能变化 ⇒ 改完需实测 prompt 缓存命中率（token 面板）。
 */

/* ── 底座对外导出（业务代码只从这里拿，不要直接 import 第三方）────────────── */

/* 值（运行时需要的类/函数） */
export { Agent } from '@earendil-works/pi-agent-core'
/* ⚠️ normalizeContext 在本文件内部还要用（见 toTranscriptCtx），所以必须**先 import 再 re-export**：
   只写 `export { x } from '...'` 不会在本地作用域引入 x，直接用会报 TS2304（实测踩过）。 */
import { AssistantMessageEventStream, normalizeContext } from '@earendil-works/pi-ai'
export { AssistantMessageEventStream, normalizeContext }

/* 各协议的流函数：上游按子路径分发，这里统一成带协议名的明确别名 */
export { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions'
export { stream as openaiResponsesStream } from '@earendil-works/pi-ai/api/openai-responses'
export { stream as anthropicMessagesStream } from '@earendil-works/pi-ai/api/anthropic-messages'
export { stream as googleGeminiStream } from '@earendil-works/pi-ai/api/google-generative-ai'

/* 类型（编译期消失，零运行时成本） */
export type { AgentMessage, AgentEvent, BeforeToolCallContext, AgentTool } from '@earendil-works/pi-agent-core'
export type { ImageContent, Model } from '@earendil-works/pi-ai'

/* ── 适配函数（上游语义变化收口在这里）──────────────────────────────── */

/** 旧式"返回 true 就停"的判据 → 新钩子 finishTurn 要的 TurnDecision */
export function toFinishTurn(legacy: (ctx: any) => boolean) {
  return (ctx: any) => (legacy(ctx) ? { action: 'end' as const } : undefined)
}

/** 直调适配器时的请求上下文（官方要求 normalizeContext() 产出的 TranscriptContext） */
export function toTranscriptCtx(systemPrompt: string, messages: any, tools: any[] = []) {
  return normalizeContext({ systemPrompt, messages, tools } as any)
}
