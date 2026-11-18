/**
 * ★1027g：OpenCode 网关（opencode.ai）的**会话头** —— 唯一实现。
 *
 * 为什么需要：2026-10 起该网关对 chat/completions 与 responses 两个端点**强制**校验
 * `x-opencode-session`，缺了直接 400 `MissingSessionID`（实测同一 key、同一模型：
 * 不带头 400 / 带头 200，两个端点都如此）。
 *
 * 官方文档 "Where can I use it?"（https://opencode.ai/docs/go/）对第三方客户端的要求原文：
 *   "Send a stable session ID in `x-opencode-session` for each conversation
 *    so we can optimize routing and prompt caching."
 *
 * 口径：
 *   · 有会话上下文就传 `sessionId`（稳定、利于路由与 prompt 缓存）；
 *   · 纯工具性调用（连通性测试、标题生成等）给固定值 —— 仍然过闸，只是不参与按会话的缓存优化；
 *   · **只对 opencode.ai 域名生效**：别的供应商不需要这个头，乱发会被当成异常流量。
 *
 * 为什么单独一个文件：`providers.ts` 与 `responsesProtocol.ts` 互相引用（前者用后者的
 * `buildResponsesRequest`），把这个纯函数放中间，两边都能用而不产生循环依赖。
 */

export function opencodeGatewayHeaders(base: string, sid?: string): Record<string, string> {
  let host = ''
  try {
    host = new URL(String(base || '')).hostname.toLowerCase()
  } catch {
    return {}   // base 不是完整 URL（例如只填了域名没协议）→ 不敢猜，宁可不发
  }
  if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return {}
  return { 'x-opencode-session': String(sid || 'nis-utility') }
}
