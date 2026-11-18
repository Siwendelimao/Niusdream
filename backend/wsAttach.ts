/**
 * 1035 阶段 B · /api/ws 挂载（接线层）
 *
 * ⚠️ 本文件**当前不被 server.ts import** —— 阶段 B 接线时才引入。
 *
 * 设计要点（方案 §3.2）：
 *   **门禁不复制，一律注入**。四道门禁（远程访问开关 / Origin 白名单 / token / 版本）
 *   已经存在于 server.ts（isLocalRequest / originTrusted / 读 token），这里只负责"在 upgrade 阶段调用它"。
 *   复制一份门禁 = 两条实现必然漂移 = 安全回退，正是本方案要消灭的东西。
 *
 * 用法（明天在 server.ts 里加 3 行）：
 *   const hub = new WsHub()
 *   const ws = attachWs({ server, hub, gate: (req) => nisWsGate(req) })
 *   // 广播处： broadcastMux(...) 之后加一行  if (ws.enabled) hub.broadcast(toWsFrame(frame))
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { WsHub, type WsLike } from './wsHub.ts'

export type GateResult = { ok: true } | { ok: false; status: number; message: string }

export interface AttachOptions {
  server: Server
  hub: WsHub
  /** upgrade 阶段的准入判定（**必须**是 server.ts 里那套现门禁，不许另写一份） */
  gate: (req: IncomingMessage) => GateResult
  /** 挂载路径；默认 /api/ws */
  path?: string
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void
}

export interface Attached {
  /** 已挂载（upgrade 事件已注册）。false 表示 server 不接受 upgrade */
  readonly enabled: boolean
  readonly hub: WsHub
  /** 当前 TCP 级连接数（可观测性用） */
  clientCount(): number
  close(): Promise<void>
}

/**
 * 把 hub 挂到已有 http.Server 的 upgrade 事件上（**不新开端口** —— 手机只需放行一个端口）。
 *
 * 失败即抛：挂不上就让启动失败（而不是"静默降级成只有 SSE"——
 * 那会让"WS 没生效"变成看不见的状态）。
 */
export function attachWs(opts: AttachOptions): Attached {
  const { server, hub, gate } = opts
  const path = opts.path ?? '/api/ws'
  const log = opts.log ?? ((level, msg, extra) => {
    if (level === 'error') console.error('[wsAttach]', msg, extra ?? '')
    else if (level === 'warn') console.warn('[wsAttach]', msg, extra ?? '')
    else console.log('[wsAttach]', msg, extra ?? '')
  })

  const wss = new WebSocketServer({ noServer: true, clientTracking: true })

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = ''
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname
    } catch (e) {
      log('warn', 'upgrade 的 url 解析失败', { url: req.url, err: String((e as Error)?.message || e) })
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }

    /* 别的 upgrade 路径不归我们管：直接放行给其它监听者（不要 destroy，避免打断既有功能） */
    if (pathname !== path) return

    const g = gate(req)
    if (!g.ok) {
      log('warn', `upgrade 被门禁拒绝 ${g.status}`, { path: pathname, message: g.message })
      rejectUpgrade(socket, g.status, g.message)
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = hub.addConnection(ws as unknown as WsLike)
      log('info', `连接建立 ${conn.id}`)
    })
  }

  server.on('upgrade', onUpgrade)

  return {
    enabled: true,
    hub,
    clientCount: () => wss.clients.size,
    close: async () => {
      server.off('upgrade', onUpgrade)
      for (const c of wss.clients) {
        try {
          c.terminate()
        } catch {
          /* 关闭路径上 terminate 抛错无补救动作；只留痕 */
          log('error', 'terminate 抛错（关闭时）')
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

/** 未完成握手的 upgrade 请求：回一个最小 HTTP 响应再断开（比直接 destroy 更容易排查） */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'
  const body = `${message}\n`
  const head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  try {
    socket.write(head)
  } catch (e) {
    /* 对端已断：这里写不进去是常态，留痕即可，不需要补救 */
    console.warn('[wsAttach] 拒绝响应写入失败（对端可能已断开）:', String((e as Error)?.message || e))
  } finally {
    socket.destroy()
  }
}
