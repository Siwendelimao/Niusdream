import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { openaiResponsesStream as stream } from './agentCompat.ts'
import { legacyStream } from './agentCompat.ts'
import { toTranscriptCtx } from './agentCompat.ts'
import { buildResponsesRequest, parseResponsesReply } from './responsesProtocol.ts'

const message = (text: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 60 } }
const response = (output: any[]) => ({ id: 'resp_1', object: 'response', status: 'completed', output, usage })
const frame = (type: string, extra: any) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`

test('Responses HTTP request keeps API root, budget and stateless contract', () => {
  const r = buildResponsesRequest({ base: 'https://example.invalid/v1/', model: 'fixture', apiKey: 'test-only' }, 'system', 'ping', 1)
  assert.equal(r.url, 'https://example.invalid/v1/responses')
  assert.equal(r.headers.authorization, 'Bearer test-only')
  assert.deepEqual(JSON.parse(r.body), { model: 'fixture', instructions: 'system', input: 'ping', max_output_tokens: 16, stream: false, store: false })
})

test('Responses raw JSON reads output blocks and disjoint cached input', () => {
  assert.deepEqual(parseResponsesReply(JSON.stringify(response([message('hello')]))), { text: 'hello', usage: { input: 40, output: 20, cacheRead: 60 } })
})

test('Responses forced SSE does not duplicate delta and completed snapshot', () => {
  const raw = frame('response.output_text.delta', { delta: 'hello' }) + frame('response.completed', { response: response([message('hello')]) })
  assert.equal(parseResponsesReply(raw).text, 'hello')
  assert.equal(parseResponsesReply(raw).usage?.cacheRead, 60)
})

test('Responses failures, wrong protocol and missing terminal are not success', () => {
  assert.throws(() => parseResponsesReply('{"choices":[]}'), /missing output/)
  assert.throws(() => parseResponsesReply('{"status":"failed","error":{"message":"fixture failure"}}'), /fixture failure/)
  assert.throws(() => parseResponsesReply(frame('response.failed', { response: { error: { message: 'stream failure' } } })), /stream failure/)
  assert.throws(() => parseResponsesReply(frame('response.output_text.delta', { delta: 'half' })), /terminal/)
})

test('SDK Responses tool/image/history/usage routing and legacy isolation', async t => {
  let mode = 'tool'
  const requests: any[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, body: JSON.parse(raw) })
    res.setHeader('content-type', 'text/event-stream')
    if (req.url?.endsWith('/chat/completions')) {
      res.end(`data: ${JSON.stringify({ id: 'chat1', choices: [{ index: 0, delta: { role: 'assistant', content: 'legacy' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } else if (mode === 'truncated') {
      res.end(frame('response.created', { response: { id: 'resp_1' } }))
    } else if (mode === 'tool') {
      const tool = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"value":"ok"}', status: 'completed' }
      res.end(frame('response.created', { response: { id: 'resp_1' } })
        + frame('response.output_item.added', { output_index: 0, item: { ...tool, arguments: '' } })
        + frame('response.function_call_arguments.delta', { output_index: 0, delta: tool.arguments })
        + frame('response.output_item.done', { output_index: 0, item: tool })
        + frame('response.completed', { response: response([tool]) }))
    } else {
      res.end(frame('response.created', { response: { id: 'resp_1' } })
        + frame('response.output_item.added', { output_index: 0, item: { ...message(''), content: [] } })
        + frame('response.output_text.delta', { output_index: 0, delta: 'hello' })
        + frame('response.output_item.done', { output_index: 0, item: message('hello') })
        + frame('response.completed', { response: response([message('hello')]) }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const model: any = { id: 'fixture', name: 'fixture', api: 'openai-responses', provider: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512 }
  const tools = [{ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { value: { type: 'string' } } } }]
  const user: any = { role: 'user', content: [{ type: 'text', text: 'echo' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], timestamp: 1 }
  const collect = async (m: any, messages: any[], fn: any = stream, extra: any = {}) => {
    const events: any[] = []
    for await (const ev of fn(m, toTranscriptCtx('stable-system', messages, tools), { apiKey: 'test-only', maxTokens: 512, maxRetries: 0, sessionId: 'stable-session', ...extra })) events.push(ev)
    return events
  }
  const events = await collect(model, [user])
  const assistant = events.find(e => e.type === 'done')?.message
  assert(assistant)
  assert.equal(assistant.stopReason, 'toolUse')
  assert.deepEqual(assistant.content[0].arguments, { value: 'ok' })
  assert.equal(assistant.usage.input, 40)
  assert.equal(assistant.usage.cacheRead, 60)
  assert.equal(requests.at(-1).url, '/v1/responses')
  assert.equal(requests.at(-1).body.store, false)
  assert.equal(requests.at(-1).body.prompt_cache_key, 'stable-session')
  assert(!('messages' in requests.at(-1).body))
  mode = 'text'
  const next = await collect(model, [user, assistant, { role: 'toolResult', toolCallId: assistant.content[0].id, toolName: 'echo', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 }])
  assert(next.some(e => e.type === 'done'))
  assert(requests.at(-1).body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_1'))
  assert(requests.at(-1).body.input.some((item: any) => item.role === 'user' && item.content.some((c: any) => c.type === 'input_image')))
  mode = 'truncated'
  assert((await collect(model, [user])).some(e => e.type === 'error'))
  const controller = new AbortController()
  controller.abort()
  assert((await collect(model, [user], stream, { signal: controller.signal })).some(e => e.type === 'error' && e.reason === 'aborted'))
  const old = await collect({ ...model, api: 'openai-completions', compat: { supportsDeveloperRole: false } }, [user], legacyStream)
  assert(old.some(e => e.type === 'done'))
  assert.equal(requests.at(-1).url, '/v1/chat/completions')
  assert(Array.isArray(requests.at(-1).body.messages))
})
