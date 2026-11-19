/**
 * 1035 阶段 C · 稀疏内容帧计算（纯函数，不碰 IO）
 *
 * ⚠️ 本文件**不被 server.ts import**（阶段 C 接线时才用）。零行为变化。
 *
 * 职责：给定"上一轮已下发的块"与"这一轮投影出的块"，算出该发什么：
 *   - 首次 / 轮终态 / 块顺序变了  ⇒ full（整轮 blocks）
 *   - 其余                      ⇒ sparse（只发变化块，带块级 rev）
 *   - 一点没变                  ⇒ changed:false（调用方**不要发帧**）
 *
 * 三条铁律投影到本模块：
 *   1. 禁兜底：块没有 id ⇒ 直接抛错（不许用序号当身份）。见方案 §3.13。
 *   2. 后端唯一权威：rev 由这里分配，前端不许自增。
 *   3. 红线 R3：稀疏合并要求"数组长度与顺序不变"，所以**顺序一变就必须 full**
 *      —— 否则前端按 id 原地替换会漏块/错位。
 */

export interface BlockLike {
  id: string
  kind?: string
  rev?: number
  [k: string]: unknown
}

export interface SparseEntry {
  /** 该块在整轮 blocks 里的下标（full 帧里对得上） */
  i: number
  rev: number
  block: BlockLike
}

export interface TurnRevState {
  /** id → 上次下发时的指纹与 rev */
  seen: Map<string, { fp: string; rev: number }>
  /** 上次下发的 id 序列（判顺序/插入用） */
  order: string[]
  /** 每轮单调递增的块级 rev 游标 */
  nextRev: number
  /** 轮级 rev（方案 §3.7：任一 block.rev 变化 ⇒ +1） */
  turnRev: number
}

export type DiffOutcome =
  | { changed: false }
  | { changed: true; full: true; turnRev: number; blocks: BlockLike[] }
  | { changed: true; full: false; turnRev: number; sparse: SparseEntry[] }

export interface DiffOptions {
  /** 轮终态（turn_done / 停止 / 出错收尾）⇒ 强制 full。终态是权威事实，不是"猜可能漂移" */
  forceFull?: boolean
  /** 自定义指纹（默认 = 稳定序列化整块）。用于调用方已知某些字段不该参与比较时 */
  fingerprintOf?: (b: BlockLike) => string
}

export function createTurnState(): TurnRevState {
  return { seen: new Map(), order: [], nextRev: 0, turnRev: 0 }
}

/**
 * 稳定序列化：对象键排序、跳过 `rev`（它由本模块分配）。
 * 目的 = "同样的内容必须得到同样的指纹"，否则每帧都会误判为变化。
 */
export function stableFingerprint(block: BlockLike): string {
  return JSON.stringify(sortValue(block, new Set(['rev'])))
}

function sortValue(v: unknown, skipKeys: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => sortValue(x, skipKeys))
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      if (skipKeys.has(k)) continue
      const val = obj[k]
      if (val === undefined) continue
      out[k] = sortValue(val, skipKeys)
    }
    return out
  }
  return v
}

/** 校验块身份：没有 id 就是上游违约，必须炸（禁兜底） */
function assertBlockIds(blocks: BlockLike[]): void {
  const seen = new Set<string>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b || typeof b !== 'object') throw new Error(`[sparse] blocks[${i}] 不是对象`)
    const id = typeof b.id === 'string' ? b.id : ''
    if (!id) throw new Error(`[sparse] blocks[${i}] 缺 id（块身份必须由后端投影给出，禁止用序号兜底）`)
    if (seen.has(id)) throw new Error(`[sparse] 块 id 重复: ${id}（轮内重复会让前端原地替换覆盖错块）`)
    seen.add(id)
  }
}

/**
 * 计算一帧该发什么。
 *
 * 调用约定（重要）：
 *   - 返回 changed:false ⇒ **不要发帧**（发了就是白流量）
 *   - 返回 full:true    ⇒ 发 `{ full:true, blocks }`
 *   - 返回 full:false   ⇒ 发 `{ full:false, sparse }`
 *   - 一旦发出去，state 就前移到"已下发"口径
 */
export function diffTurn(state: TurnRevState, blocks: BlockLike[], opts: DiffOptions = {}): DiffOutcome {
  assertBlockIds(blocks)
  const fpOf = opts.fingerprintOf ?? stableFingerprint
  const ids = blocks.map((b) => b.id)

  /* 顺序合法性：老序列必须仍是新序列的**前缀**。
     不成立 = 中间插入/删除/重排 ⇒ 前端"原地替换"会错位 ⇒ 必须 full（红线 R3）。 */
  const prefixOk = state.order.every((id, i) => ids[i] === id)

  /* 首次下发必须 full：空 order/空 seen 时 prefixOk 恒为 true，
     如果只靠前缀检查就会发出"全是新块的 sparse" ⇒ 前端按 applySparse 会因未知块抛错。
     这是"没有历史"这件事本身，不是兜底。 */
  const neverCommitted = state.order.length === 0 && state.seen.size === 0

  if (opts.forceFull || neverCommitted || !prefixOk) {
    return commitFull(state, blocks, fpOf)
  }

  const sparse: SparseEntry[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const fp = fpOf(b)
    const prev = state.seen.get(b.id)
    if (prev && prev.fp === fp) continue
    const rev = ++state.nextRev
    sparse.push({ i, rev, block: { ...b, rev } })
  }

  if (sparse.length === 0) {
    /* 内容零变化：不动 state（连 turnRev 都不该涨，否则前端每帧都要重渲染） */
    return { changed: false }
  }

  /* 提交：已下发块的指纹/rev 前移；顺序账本前移 */
  for (const s of sparse) state.seen.set(s.block.id, { fp: fpOf(s.block), rev: s.rev })
  state.order = ids
  state.turnRev = ++state.turnRev
  return { changed: true, full: false, turnRev: state.turnRev, sparse }
}

function commitFull(state: TurnRevState, blocks: BlockLike[], fpOf: (b: BlockLike) => string): DiffOutcome {
  const out: BlockLike[] = []
  for (const b of blocks) {
    const fp = fpOf(b)
    const prev = state.seen.get(b.id)
    /* 内容没变的块沿用旧 rev（前端幂等守卫据此判"这块没动"） */
    const rev = prev && prev.fp === fp ? prev.rev : ++state.nextRev
    state.seen.set(b.id, { fp, rev })
    out.push({ ...b, rev })
  }
  state.order = blocks.map((b) => b.id)
  state.turnRev = ++state.turnRev
  return { changed: true, full: true, turnRev: state.turnRev, blocks: out }
}

/**
 * 丢弃某轮状态（轮结束且已确认客户端收齐 / 会话切换）。
 * ⚠️ 不许"定期清"：清了之后下一次同轮帧会退化成 full —— 这是能力退化，不是正常态。
 */
export function dropTurnState(states: Map<string, TurnRevState>, turnId: string): boolean {
  return states.delete(turnId)
}

/**
 * 有界清理：只保留最近 N 轮的状态（长会话里轮数是无限的，必须封顶）。
 * 这是**资源上限**，不是兜底：被清掉的轮下次来帧就 full（正确但更费流量），不会出错。
 */
export function trimTurnStates(states: Map<string, TurnRevState>, keep: number, latestTurnIds: string[]): string[] {
  if (states.size <= keep) return []
  const keepSet = new Set(latestTurnIds.slice(0, keep))
  const removed: string[] = []
  for (const tid of [...states.keys()]) {
    if (keepSet.has(tid)) continue
    states.delete(tid)
    removed.push(tid)
    if (states.size <= keep) break
  }
  return removed
}

/* ══════════════ 前端合并的等价实现（做交叉校验用） ══════════════
   放在后端只是为了让"稀疏合并"有一套**可单测的参考实现**；
   前端 NiusDreamChat 的 applyPartialBlocks 接线时照这个语义写（按 id 原地替换、顺序不变）。 */
export function applySparse(prev: BlockLike[], sparse: SparseEntry[]): BlockLike[] {
  const idx = new Map<string, number>()
  prev.forEach((b, i) => idx.set(b.id, i))
  const out = prev.slice()
  for (const s of sparse) {
    const at = idx.get(s.block.id)
    if (at === undefined) {
      /* 未知块**只允许尾部顺序追加**（i 正好等于当前长度）：流式新增块就是这个形态。
         往中间插 = 顺序会变 ⇒ 必须由 full 帧完成（前端原地替换无法表达"插入"）。
         这里直接抛错：静默 append 会让前端顺序与后端不一致，比崩溃更难查。 */
      if (s.i !== out.length) {
        throw new Error(
          `[sparse] 稀疏帧含未知块 id=${s.block.id} 且位置 i=${s.i} ≠ 末尾 ${out.length}（中间插入必须由 full 帧完成）`,
        )
      }
      out.push(s.block)
      idx.set(s.block.id, out.length - 1)
      continue
    }
    out[at] = s.block
  }
  return out
}
