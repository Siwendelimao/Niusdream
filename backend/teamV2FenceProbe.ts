/**
 * 围栏探活的**判定**（纯函数，可隔离单测；OS 查询本身在 procIdentity）。
 *
 * 为什么单独抽出来：`procStartStamp` 有三种结果，语义完全不同 ——
 *   · 非空串 = 该 pid 还在，且这是它的启动指纹；
 *   · `''`   = **确实查无此进程**（可以认为它退了）；
 *   · `null` = **查询失败 / 参数非法 / 本机查不了**（证明不了什么）。
 *
 * 旧实现 `if (!stamp) return false` 把 `''` 和 `null` 都当成"退出" ⇒
 * 一次 PowerShell 超时就能让围栏误判解除、放下一单开工（而工具进程可能还活着）。
 * 这里把三者分开：**只有 `''` 能判退出；`null` 必须继续挡住**（未知不能放行）。
 */

export type ProbeVerdict = 'exited' | 'alive' | 'unknown'

/** 拿到 OS 事实后怎么判。
 *  @param stamp     procStartStamp 的返回：非空指纹 / '' / null
 *  @param heldStamp 围栏落库时记下的启动指纹（可能没有）
 *  @param same      pid+指纹是否指同一进程（生产传 sameStamp）
 */
export function judgeFenceProbe(
  stamp: string | null,
  heldStamp: string | null,
  same: (a: string, b: string) => boolean,
): ProbeVerdict {
  if (stamp === null) return 'unknown'      /* 查询失败：证明不了它退了 ⇒ 不放行 */
  if (stamp === '') return 'exited'         /* 确实查无此 pid ⇒ 退了 */
  if (!heldStamp) return 'alive'            /* 有进程但没记指纹：可能是 pid 复用 ⇒ 按活着算 */
  return same(stamp, heldStamp) ? 'alive' : 'exited'  /* 指纹不同 = 原进程已退、pid 被别人复用 */
}

/** 只有 'exited' 才允许放行；'alive' / 'unknown' 都继续挡。 */
export function isFenceCleared(verdict: ProbeVerdict): boolean {
  return verdict === 'exited'
}
