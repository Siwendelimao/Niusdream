import type { openTeamV2Ledger } from './teamV2Ledger.ts'

type Ledger = ReturnType<typeof openTeamV2Ledger>
type Intake = Parameters<Ledger['receive']>[0]
type Job = NonNullable<ReturnType<Ledger['nextQueued']>>
export type TeamV2ExecutionResult = { kind: 'submitted'; artifact: string; report?: string; consumeNoteIds?: number[] } | { kind: 'failed'; evidence: string }

/** Internal executor port: started() must come from this exact attempt's runtime start edge.
 * No workspace side effects before that edge; resolve only after the runner has settled. */
export type TeamV2Executor = (job: Job, started: (workspace?: string) => void) => Promise<TeamV2ExecutionResult>

/** 围栏复核的对象：一次尝试的身份 + 它该在哪个成员会话里持有副作用。 */
export type TeamV2FenceTarget = { requestId: number; attemptId: number; memberId: string }

/** One owner per parent team ledger. Live backend ownership and global limits belong to the host. */
export function createTeamV2Scheduler(ledger: Ledger, ports: {
  readUserMessage(messageId: string): string | undefined
  execute: TeamV2Executor
  /** ★1124：一单交付后按需求单的可执行判据自动验收（宿主实现；不实现=不自动验收）。 */
  autoVerify?: (input: { request: { id: number; revision: number; verify?: string | null }; attempt: { id: number; memberId: string }; artifact: string }) => Promise<void>
  /** 有界槽位。当前只支持 1：2 槽必须配**每个 attempt 独立的写工作区**，
   *  否则两个成员会写同一个 workDir（相同文件/构建目录/端口），那不是并发而是互相踩。 */
  slots?: number
  /** ★第十三轮：开工门（fail-closed）。由宿主给判据：现在有没有"证明不了副作用状态"的事没结清。
   *  返回 null = 可以开工；返回字符串 = 挡住它的那条事实（原样进错误信息，给用户看）。
   *  放在 drain 入口而不是各个调用方：派工 / 重派 / 验收通过 / 围栏复核都会走 drain，
   *  只有一处判据才不会漏某条路。 */
  startBlocked?: () => string | null
  /** 结算/放槽前的**副作用围栏**：执行器交回结果（或抛错/被 abort）都不代表它拉起的工具子进程已经退出。
   *  只有这里返回 ok，才允许把这一单落成 submitted / failed / cancelled，也才允许下一个开工。
   *  参数就是 Job（`{request, attempt}`）—— 围栏复核时调度器传的是"当初挂起的那一单"，形状一致。
   *  不 ok ⇒ 进程状态无法核实 ⇒ 落 interrupted **并挂持久围栏**（`fence_hold`），
   *  之后任何一次 drain 都要先复核它，确认无残留才解除。 */
  drained?: (job: Job) => Promise<{ ok: true } | { ok: false; reason: string; pids?: Array<{ pid: number; startStamp: string | null }> }>
}) {
  const slots = ports.slots ?? 1
  if (!Number.isSafeInteger(slots) || slots < 1) throw new Error('Team V2 slot limit must be a positive integer')
  if (slots > 20) {
    /* ★1124（老板拍板）：并行度由**依赖关系和成员数**决定，不再人为卡在 2。
       团队上限 20 个成员，所以槽位上限也就是 20（每单已经有独立工作区，写隔离由 .nis-attempts/<attemptId> 保证）。
       再高没有意义：一个团队不会有比成员数更多的执行体。 */
    throw new Error('Team V2 supports at most 20 execution slots (team member limit)')
  }
  let draining = false
  /* 围栏复核：只有能证明"该 attempt 的副作用已无残留"才解除 hold；证不出来就继续挡住所有开工。
     判据来自 drained 端口（后端的进程/后台任务事实），不是调度器自己的推断。 */
  async function releaseVerifiedFences(): Promise<void> {
    if (!ports.drained) return
    for (const hold of ledger.fenceHolds()) {
      const probe = await ports.drained(hold)
      if (!probe.ok) {
        throw new Error(
          `Team V2 has an unconfirmed side effect on attempt #${hold.attempt.id}（${probe.reason}）；` +
          '在确认它停下之前，任何排队任务都不许开工')
      }
      ledger.releaseFence(hold.attempt.id, `围栏复核：成员会话已无残留进程/后台任务（原围栏：${hold.reason.slice(0, 400)}）`)
    }
  }
  /* 跑一单（并发槽里）。返回 1 = 结算了一单，0 = 这单不结算（用户取消等）。 */
  async function runOne(job: Job): Promise<number> {
    const { id, requestId } = job.attempt
    const edge = { started: false, settled: false }
    let result: TeamV2ExecutionResult | undefined
    let execFailure: unknown = null
    try {
      result = await ports.execute(job, workspace => {
        if (edge.settled || edge.started) throw new Error('Duplicate or late team start')
        /* 开工边沿 = 执行器真的开始跑的那一刻（依赖按当前版本重核 + 同成员排他都在 start 里）。 */
        ledger.start(requestId, id, workspace)
        edge.started = true
      })
      if (!edge.started) {
        /* 开工前就明确拒绝（授权失效/工作区不符）是合法结果：没有任何副作用 ⇒ 落 failed 让用户重派。 */
        const validEv = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max
        const refusedBeforeStart = result?.kind === 'failed' && validEv(result.evidence, 8_000)
        if (!refusedBeforeStart) throw new Error('Team executor returned without a start event')
      }
      const validText = (value: string, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max
      if (!(result?.kind === 'submitted' && validText(result.artifact, 500)) &&
          !(result?.kind === 'failed' && validText(result.evidence, 8_000))) {
        throw new Error('Invalid team executor receipt')
      }
    } catch (error) {
      execFailure = error
    } finally {
      edge.settled = true
    }
    /* 副作用围栏：**执行器返回 / 抛错 / 被 abort，都不等于它拉起的工具子进程已经退出**。
       先确认进程真的不在了，才允许提交、结算、放下一单开工。
       围栏不过 ⇒ 落 interrupted 并挂持久围栏（下一次 drain 仍要复核它）。 */
    if (ports.drained) {
      const fence = await ports.drained(job)
      if (!fence.ok) {
        ledger.holdFence(requestId, id,
          `工具进程未确认退出，副作用状态未知（${fence.reason}）${execFailure ? `；执行器错误：${String(execFailure).slice(0, 7_000)}` : ''}`.slice(0, 8_000), fence.pids)
        throw new Error('Team execution left live tool processes: ' + fence.reason)
      }
    }
    if (execFailure) {
      /* 阶段2：**用户取消 ≠ 执行器异常**。有取消请求就落成 cancelled；
         没有取消请求才是"执行器未交回可确认结果"= interrupted（未知副作用，等人工核对）。 */
      if (ledger.cancelRequested(id)) {
        ledger.settleCancelled(requestId, id, `用户取消，执行器已中止：${String(execFailure).slice(0, 7800)}`)
        return 0
      }
      ledger.interrupt(requestId, id, edge.started ? 'running' : 'queued', `执行器未交回可确认结果：${String(execFailure).slice(0, 7900)}`)
      throw execFailure
    }
    const receipt = result!
    /* 阶段2：取消优先于迟到结果 —— 用户已经要求取消，这一单的执行结果不再采纳，
       不许因为"恰好跑完了"就把已取消的需求复活成 submitted。 */
    if (ledger.cancelRequested(id)) {
      ledger.settleCancelled(requestId, id, `用户取消；执行器返回的结果不再采纳（${receipt.kind}）`)
      return 0
    }
    if (receipt.kind === 'submitted') {
      /* ★一次原子交付：报告落库 + attempt 结算 + 该报告处理过的收件归属，同一事务。
         原来"先 submit 再 consume"两步之间掉电，会造成**已交付的补充在重派时被再投一遍**；
         反过来先消费后提交则会让补充永久丢失。合并后只有一个事实。 */
      ledger.submitWithNotes(requestId, id, receipt.artifact, receipt.report, receipt.consumeNoteIds || [])
      /* ★1124（老板拍板：无人值守要能自己验收）：交给宿主按需求单上的**可执行判据**判一次。
         判定失败由宿主自己决定「打回重做」还是「到上限判 rejected」—— 调度器只管把这一步接上槽位收尾，
         不在这里猜业务语义。没有判据 ⇒ 宿主什么都不做（那张单继续停在待验收等人）。 */
      if (ports.autoVerify) await ports.autoVerify({ request: job.request, attempt: job.attempt, artifact: receipt.artifact })
    }
    else ledger.fail(requestId, id, receipt.evidence)
    return 1
  }

  return {
    receive(input: Intake) {
      const source = ports.readUserMessage(input.messageId)
      if (typeof source !== 'string' || typeof input.quote !== 'string' || !input.quote.trim() || !source.includes(input.quote)) {
        throw new Error('Team request must cite the original user message')
      }
      return ledger.receive(input)
    },
    /** Called by the host after dispatch, executor settlement, or startup reconciliation. */
    /** 调度一次：最多并行 `slots` 单。返回本次结算的单数。 */
    async drain(): Promise<number> {
      if (draining) return 0
      if (ledger.runningMembers().length) throw new Error('Reconcile the previous team execution before dispatch')
      draining = true
      try {
        /* 阶段4补正：**围栏是跨次调度的**。上一次 drain 因副作用未确认而停下的尝试，
           在这一次 drain 里仍然挡路 —— 除非这次复核能证明残留已经消失。
           这不依赖任何内存标记：hold 在账本里，后端重启后照样生效。
           ★第十三轮：**必须在开工门之前做**。围栏只能由这里按 OS 事实解除；
           先判门就等于"要开工门放行才能解围栏、要解围栏才能过开工门" —— 那是死锁。 */
        await releaseVerifiedFences()
        /* ★第十三轮：开工门 —— 所有 drain 入口共用的唯一判据（派工/重派/验收通过/围栏复核…）。
           围栏已按 OS 事实处理完，这里再判"还有没有证明不了的东西"，有就不挑单。 */
        const blocked = ports.startBlocked?.()
        if (blocked) throw new Error('Team V2 start blocked: ' + blocked)
        /* 并发槽位：**最多同时 slots 个**，但队列要一路推到底（单槽时就是串行把队列跑空）。 */
        type Slot = { memberId: string; done: Promise<{ n: number; attemptId: number }> }
        const active = new Map<number, Slot>()   // attemptId → slot
        let settledCount = 0
        /* 槽里抛出的异常先攒着：**别让一个槽的错误打断另一个槽的等待** —— 那会留下 running 残留，
           下一次 drain 直接被 Reconcile 挡住（双槽实测：确认/放行后队列永久不开工）。 */
        const slotErrors: unknown[] = []
        for (;;) {
          const skipAttempts = new Set(active.keys())
          const skipMembers = new Set([...active.values()].map(s => s.memberId))
          while (active.size < slots) {
            /* 已经有槽抛错 ⇒ 不再领新单（fail-fast 保住"一次 drain 一个错误"的既有语义），
               但**在飞的槽照旧等它们收尾**，绝不把孤儿 running 留给下一次 drain。 */
            if (slotErrors.length) break
            /* 领取**不改状态**（开工仍由执行器回报的 start 边沿决定）：
               用"在飞的单 + 在飞的成员"排除，保证两槽不会拿到同一单，也不会让同一成员并行。 */
            const job = ledger.nextQueued({ skipAttempts, skipMembers })
            if (!job) break
            const attemptId = job.attempt.id
            skipAttempts.add(attemptId)
            skipMembers.add(job.attempt.memberId)
            active.set(attemptId, {
              memberId: job.attempt.memberId,
              done: runOne(job)
                .then(n => ({ n, attemptId }))
                .catch((error) => { slotErrors.push(error); return { n: 0, attemptId } }),
            })
          }
          if (!active.size) break
          const first = await Promise.race([...active.values()].map(s => s.done))
          settledCount += first.n
          active.delete(first.attemptId)
        }
        /* 所有槽都收尾了才抛异常（这时没有 running 残留，下一次 drain 不会卡在 Reconcile）。 */
        if (slotErrors.length) throw slotErrors[0]
        return settledCount
      } finally { draining = false }
    },
  }
}
