import { opencodeGatewayHeaders } from './opencodeGateway.ts'

/** OpenAI Responses 小型 HTTP 调用的协议边界；聊天流/工具/图片由 pi-ai 适配器处理。 */
export function buildResponsesRequest(
  cfg: { base: string; model: string; apiKey?: string },
  system: string, input: string, maxTokens: number,
): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: `${cfg.base.replace(/\/+$/, '')}/responses`,
    headers: { 'content-type': 'application/json', authorization: cfg.apiKey ? `Bearer ${cfg.apiKey}` : '', ...opencodeGatewayHeaders(cfg.base) },
    // Responses 最小输出预算为 16；不发送 Chat Completions 的 messages/max_tokens。
    body: JSON.stringify({ model: cfg.model, ...(system ? { instructions: system } : {}), input,
      max_output_tokens: Math.max(16, maxTokens), stream: false, store: false }),
  }
}

export function parseResponsesReply(raw: string): {
  text: string; usage?: { input: number; output: number; cacheRead: number }
} {
  let text = ''
  let sawResponse = false
  let sawTerminal = false
  let snapshot = ''
  let usage: { input: number; output: number; cacheRead: number } | undefined
  const accept = (data: any) => {
    if (data?.error || data?.status === 'failed' || data?.status === 'cancelled') {
      throw new Error(String(data?.error?.message || `Responses ${data.status || 'error'}`))
    }
    sawResponse = Array.isArray(data?.output) || typeof data?.output_text === 'string'
    // output_text 是 SDK 便利字段；原始 HTTP 响应须遍历 output[].content[]。
    const parts = (Array.isArray(data?.output) ? data.output : [])
      .filter((item: any) => item?.type === 'message' && item?.role === 'assistant')
      .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
      .filter((block: any) => block?.type === 'output_text' && typeof block.text === 'string')
      .map((block: any) => block.text).join('')
    if (parts || typeof data?.output_text === 'string') snapshot = parts || data.output_text
    if (data?.usage) {
      const cached = Number(data.usage.input_tokens_details?.cached_tokens) || 0
      usage = { input: Math.max(0, (Number(data.usage.input_tokens) || 0) - cached),
        output: Number(data.usage.output_tokens) || 0, cacheRead: cached }
    }
  }
  if (/^\s*(?:data:|event:)/m.test(raw)) {
    // 有些网关强制 SSE；terminal snapshot 与 delta 二选一，不能重复拼接。
    for (const frame of raw.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
      const payload = frame.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n')
      if (!payload || payload === '[DONE]') continue
      let event: any
      try { event = JSON.parse(payload) } catch { continue }
      if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error(String(event.error?.message || event.response?.error?.message || event.message || 'Responses stream failed'))
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta
      if (event.response) accept(event.response)
      if (event.type === 'response.completed' || event.type === 'response.incomplete') sawTerminal = true
    }
    if (!sawTerminal) throw new Error('Responses stream ended before a terminal response event')
  } else {
    accept(JSON.parse(raw))
    if (!sawResponse) throw new Error('Invalid Responses reply: missing output')
  }
  return { text: snapshot || text, ...(usage ? { usage } : {}) }
}
