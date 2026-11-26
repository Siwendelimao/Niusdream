import { DatabaseSync } from 'node:sqlite'
import type { TeamFileCheck } from './teamV2FileCheck.ts'
import type { ReviewReceipt } from './teamV2ReviewInput.ts'
import type { ReviewExecution } from './teamV2Reviewer.ts'
import { MEMBER_REPORT_FORMAT, matchesMemberReport } from './teamV2Report.ts'
import { deriveStageStanding, stageAttemptKey, type StagePhase } from './teamV2Stage.ts'

/** One ledger file per parent team session. This module owns facts, not agent execution. */
export function openTeamV2Ledger(file: string, onCommittedChange?: (stoppedBatches: number[]) => void) {
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS request (
        id INTEGER PRIMARY KEY,
        messageId TEXT NOT NULL,
        partKey TEXT NOT NULL,
        title TEXT NOT NULL,
        quote TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(messageId, partKey)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attempt (
        id INTEGER PRIMARY KEY,
        requestId INTEGER NOT NULL REFERENCES request(id),
        revision INTEGER NOT NULL,
        memberId TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('queued','running','submitted','accepted','rejected','failed','interrupted')),
        artifact TEXT,
        evidence TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS report_receipt (
        attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
        report TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS recovery_review (
        attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
        reviewer TEXT NOT NULL,
        evidence TEXT NOT NULL,
        reviewedAt INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attempt_workspace (
        attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
        root TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS file_check (
        id INTEGER PRIMARY KEY,
        attemptId INTEGER NOT NULL REFERENCES attempt(id),
        workspace TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        expected TEXT NOT NULL,
        actual TEXT,
        bytes INTEGER,
        checkedAt INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('matched','mismatch','missing'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS review_execution (
        id INTEGER PRIMARY KEY,
        attemptId INTEGER NOT NULL REFERENCES attempt(id),
        artifact TEXT NOT NULL,
        fileCheckId INTEGER REFERENCES file_check(id),
        recordedAt INTEGER NOT NULL,
        result TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS review_execution_by_attempt ON review_execution(attemptId, id);
      CREATE INDEX IF NOT EXISTS file_check_by_attempt ON file_check(attemptId, id DESC);
      CREATE INDEX IF NOT EXISTS attempts_by_request ON attempt(requestId, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON attempt(requestId)
        WHERE phase IN ('queued','running','submitted');
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_member ON attempt(memberId)
        WHERE phase = 'running';
      /* One row per dispatch call that actually created work. Identities are the authorizing
         user message plus the dispatch moment — never the front end, a shared quote, or idleness. */
      CREATE TABLE IF NOT EXISTS dispatch_batch (
        id INTEGER PRIMARY KEY,
        authorizingMessageId TEXT NOT NULL,
        dispatchedAt INTEGER NOT NULL
      ) STRICT;
      /* A settlement is an event: "this exact attempt set had stopped executing at this moment".
         It stores identity and time only; the batch's standing is derived from attempt rows. */
      CREATE TABLE IF NOT EXISTS stage_settlement (
        id INTEGER PRIMARY KEY,
        batchId INTEGER NOT NULL REFERENCES dispatch_batch(id),
        attemptKey TEXT NOT NULL,
        settledAt INTEGER NOT NULL,
        UNIQUE(batchId, attemptKey)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS stage_item (
        settlementId INTEGER NOT NULL REFERENCES stage_settlement(id),
        requestId INTEGER NOT NULL REFERENCES request(id),
        revision INTEGER NOT NULL,
        attemptId INTEGER NOT NULL REFERENCES attempt(id),
        PRIMARY KEY (settlementId, requestId)
      ) STRICT;
      /* Exactly one report record per settlement. 'pending' means "settled, not delivered";
         only a real delivered message id may flip it, never a dedupe shortcut. */
      CREATE TABLE IF NOT EXISTS stage_report (
        id INTEGER PRIMARY KEY,
        settlementId INTEGER NOT NULL UNIQUE REFERENCES stage_settlement(id),
        state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
        deliveredMessageId TEXT,
        createdAt INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS stage_item_by_settlement ON stage_item(settlementId, requestId);
      /* 要求版本来源（阶段1·追加）：每次版本变更记一条，保存真实用户消息 id + 逐字来源 + 该版本要求文本。
         初始版本在收单时写一行（kind='initial'）；追加/改验收写 kind='revise'。
         原话（request.quote）不被覆盖，历史版本只增不改。 */
      CREATE TABLE IF NOT EXISTS request_revision (
        id INTEGER PRIMARY KEY,
        requestId INTEGER NOT NULL REFERENCES request(id),
        revision INTEGER NOT NULL,
        messageId TEXT NOT NULL,
        quote TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('initial','revise','legacy')),
        at INTEGER NOT NULL,
        UNIQUE(requestId, revision)
      ) STRICT;
      /* 阶段2·运行中取消请求：先落"用户要求取消"这件事（attemptId 唯一，重复请求幂等），
         真正停下执行器之后由 settleCancelled 把 attempt 落成 cancelled。
         —— 这样"取消"与"执行器异常中断(interrupted=未知副作用待核)"不会混成一格。 */
      CREATE TABLE IF NOT EXISTS attempt_cancel (
        attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
        requestId INTEGER NOT NULL REFERENCES request(id),
        reason TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
      /* 阶段2·普通补充（不改授权/验收）：绑定**当前有效 attempt**，按到达顺序交给执行者；
         同一 (requestId, messageId) 只收一次（工具重放/网络重试幂等）。
         消费后 consumed=1，执行者处理过就不会重复投递。 */
      CREATE TABLE IF NOT EXISTS request_note (
        id INTEGER PRIMARY KEY,
        requestId INTEGER NOT NULL REFERENCES request(id),
        attemptId INTEGER NOT NULL REFERENCES attempt(id),
        messageId TEXT NOT NULL,
        quote TEXT NOT NULL,
        text TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL,
        UNIQUE(requestId, messageId)
      ) STRICT;
      /* 阶段3·需求依赖：同一父团队会话内，后置需求要等前置需求**按当前版本验收通过**才允许开工。
         自依赖由 CHECK 拦住；跨会话引用在写入时校验；成环在写入时 DFS 拒绝。 */
      CREATE TABLE IF NOT EXISTS request_dependency (
        requestId INTEGER NOT NULL REFERENCES request(id),
        dependsOn INTEGER NOT NULL REFERENCES request(id),
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (requestId, dependsOn),
        CHECK(requestId <> dependsOn)
      ) STRICT;
      /* 阶段4·可归属用量：成员执行这一轮真实的 token 记账，绑定 requestId/revision/attemptId。
         它**另计**，不并入团队公共总量（公共 = 总量 - 可归属），避免双算。
         缺回执时照样写一行（known=0），由上层标"不完整"，不按比例补。 */
      CREATE TABLE IF NOT EXISTS attempt_usage (
        attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
        requestId INTEGER NOT NULL REFERENCES request(id),
        revision INTEGER NOT NULL,
        memberId TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cacheRead INTEGER NOT NULL,
        cacheWrite INTEGER NOT NULL,
        hitRate REAL,
        receiptKnown INTEGER NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
      /* 阶段4补正·副作用围栏（跨次调度）：围栏拒绝不是"本次 drain 的一次性判断"，
         而是「这个 attempt 的副作用还没被确认停下」这件事本身 —— 必须落库。
         有 hold 时任何后续开工都要先复核；复核确认无残留才删行，并记一条 recovery_review 当结清证据。 */
      CREATE TABLE IF NOT EXISTS fence_hold (
        attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
        reason TEXT NOT NULL,
        at INTEGER NOT NULL
      ) STRICT;
        /* ★围栏的 OS 事实：后端**拉起过的进程**（pid + 启动戳）跟着围栏一起落库。
           为什么必须落库：后端被 SIGKILL 后内存登记表是空的，但外部工具进程可能还活着；
           "登记表为空"不等于"进程退出"，只有 OS 层探活（pid + 启动戳）才是事实。 */
        CREATE TABLE IF NOT EXISTS fence_pid (
          attemptId INTEGER NOT NULL REFERENCES attempt(id),
          pid INTEGER NOT NULL,
          startStamp TEXT,
          PRIMARY KEY (attemptId, pid)
        ) STRICT;
        /* ★第十三轮补正（R4）：**副作用已按 OS 事实清理**这件事本身，要能单独留证。
           它和"人工核对过产物/执行"是两件事：前者只解围栏，后者才解"待对账"。
           以前把两者塞进 recovery_review，结果"OS 退出"就把人工对账一起抹掉了。 */
        CREATE TABLE IF NOT EXISTS fence_release (
          attemptId INTEGER PRIMARY KEY REFERENCES attempt(id),
          evidence TEXT NOT NULL,
          at INTEGER NOT NULL
        ) STRICT;
        /* ★1124（老板批准的结构性修法）：**工具启动意图** —— 在 spawn() **之前**先落这一行。
           为什么：noteAttemptPid 只能在拿到 pid 之后落库，而"进程已经起来、pid 还没进账本"
           这段同步代码里如果后端被 SIGKILL，账本里就没有任何痕迹 ⇒ 重启后 drained 看到
           "没有 pid" 会当成"没有残留"（真实盲区）。
           有了 intent：pid 未知也是一条**账本事实**，重启后按"未知副作用"挡住，必须人工核对。
           pid 为空 ＝ 还没拿到 pid（崩溃窗口）；拿到后 bindProcIntent 补上。
           生命周期：spawn 前 begin → 拿到 pid 后 bind → 进程结束/启动失败 end（删行）。 */
        CREATE TABLE IF NOT EXISTS proc_intent (
          id INTEGER PRIMARY KEY,
          attemptId INTEGER NOT NULL REFERENCES attempt(id),
          token TEXT NOT NULL UNIQUE,
          tool TEXT NOT NULL,
          at INTEGER NOT NULL,
          pid INTEGER
        ) STRICT;
    `)
    /* 阶段1补正②：表重建与唯一索引放进**同一个事务**，任一失败整体回滚（迁移是原子的）。
       旧库若已存在同源重复的 revise 行，先明确报出冲突来源，而不是建索引失败后留下半迁移。 */
    db.exec('BEGIN')
    try {
      const revisionDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='request_revision'").get() as { sql?: string } | undefined
      if (revisionDdl?.sql && !revisionDdl.sql.includes("'legacy'")) {
        const before = Number((db.prepare('SELECT COUNT(*) AS n FROM request_revision').get() as { n: number }).n)
        db.exec('ALTER TABLE request_revision RENAME TO request_revision_stage1a')
        db.exec(`CREATE TABLE request_revision (
          id INTEGER PRIMARY KEY,
          requestId INTEGER NOT NULL REFERENCES request(id),
          revision INTEGER NOT NULL,
          messageId TEXT NOT NULL,
          quote TEXT NOT NULL,
          acceptance TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('initial','revise','legacy')),
          at INTEGER NOT NULL,
          UNIQUE(requestId, revision)
        ) STRICT`)
        db.exec(`INSERT INTO request_revision (id, requestId, revision, messageId, quote, acceptance, kind, at)
          SELECT id, requestId, revision, messageId, quote, acceptance, kind, at FROM request_revision_stage1a`)
        const after = Number((db.prepare('SELECT COUNT(*) AS n FROM request_revision').get() as { n: number }).n)
        if (after !== before) throw new Error('V2 ledger revision table migration lost rows')
        db.exec('DROP TABLE request_revision_stage1a')
      }
      const dup = db.prepare("SELECT requestId, messageId FROM request_revision WHERE kind='revise' GROUP BY requestId, messageId HAVING COUNT(*) > 1 LIMIT 1").get() as { requestId: number; messageId: string } | undefined
      if (dup) {
        throw new Error(`V2 ledger has more than one revise for the same user message (request ${dup.requestId}); resolve it before reopening`)
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS request_revision_by_source ON request_revision(requestId, messageId) WHERE kind = 'revise'")
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    /* 阶段2：attempt.phase 是硬 CHECK，加 'cancelled' 必须重建表；6 张子表以 attempt(id) 为 FK。
       顺序：关 FK（必须事务外）→ 事务内建新表/拷数据/重建两个部分索引/行数校验/foreign_key_check → 开 FK。
       任一校验不过就整事务回滚，并把 FK 开关拨回去。 */
    const attemptDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attempt'").get() as { sql?: string } | undefined
    if (attemptDdl?.sql && !attemptDdl.sql.includes("'cancelled'")) {
      const before = Number((db.prepare('SELECT COUNT(*) AS n FROM attempt').get() as { n: number }).n)
      db.exec('PRAGMA foreign_keys = OFF')
      try {
        db.exec('BEGIN')
        try {
          db.exec(`CREATE TABLE attempt_stage2 (
            id INTEGER PRIMARY KEY,
            requestId INTEGER NOT NULL REFERENCES request(id),
            revision INTEGER NOT NULL,
            memberId TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('queued','running','submitted','accepted','rejected','failed','interrupted','cancelled')),
            artifact TEXT,
            evidence TEXT
          ) STRICT`)
          db.exec('INSERT INTO attempt_stage2 (id, requestId, revision, memberId, phase, artifact, evidence) SELECT id, requestId, revision, memberId, phase, artifact, evidence FROM attempt')
          db.exec('DROP TABLE attempt')
          db.exec('ALTER TABLE attempt_stage2 RENAME TO attempt')
          db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON attempt(requestId) WHERE phase IN ('queued','running','submitted')")
          db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_member ON attempt(memberId) WHERE phase = 'running'")
          const after = Number((db.prepare('SELECT COUNT(*) AS n FROM attempt').get() as { n: number }).n)
          if (after !== before) throw new Error('V2 ledger attempt table migration lost rows')
          const broken = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
          if (broken.length) throw new Error('V2 ledger attempt migration broke foreign keys: ' + JSON.stringify(broken.slice(0, 3)))
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      } finally {
        db.exec('PRAGMA foreign_keys = ON')
      }
    }
    /* Old ledgers keep their rows untouched: the new column stays NULL and no historic work item
       is retroactively assigned to a batch it was never dispatched under. */
    const requestColumns = db.prepare('PRAGMA table_info(request)').all() as Array<{ name: string }>
    if (!requestColumns.some(column => column.name === 'batchId')) {
      db.exec('ALTER TABLE request ADD COLUMN batchId INTEGER REFERENCES dispatch_batch(id)')
    }
    db.exec('CREATE INDEX IF NOT EXISTS request_by_batch ON request(batchId)')
    /* ★1124（老板拍板：验收要能在无人值守时自己跑）：需求单可以带一份**可执行判据**。
       老库不迁移数据 —— 新列留 NULL，表示"这张单没有自动判据"，验收仍需人（绝不补 0 冒充可核）。 */
    if (!requestColumns.some(column => column.name === 'verify')) {
      db.exec('ALTER TABLE request ADD COLUMN verify TEXT')
    }
    /* ★1124（老板要"验收记录一条条看，带几点几分"）：attempt 记下**终结时刻**。
       NULL = 还没终结（queued/running/submitted）；老库同样不迁移数据，历史行留 NULL、不伪造时间。 */
    const attemptColumns = db.prepare('PRAGMA table_info(attempt)').all() as Array<{ name: string }>
    if (!attemptColumns.some(column => column.name === 'settledAt')) {
      db.exec('ALTER TABLE attempt ADD COLUMN settledAt INTEGER')
    }
    /* "Has this attempt already been settled?" is the only question the restart sweep asks per
       work item, so it needs an index of its own on the existing stage_item rows. */
    db.exec('CREATE INDEX IF NOT EXISTS stage_item_by_attempt ON stage_item(attemptId)')
  } catch (error) {
    db.close()
    throw error
  }
  type Request = { id: number; messageId: string; partKey: string; title: string; quote: string; acceptance: string; revision: number; verify?: string | null }
  type Phase = 'queued' | 'running' | 'submitted' | 'accepted' | 'rejected' | 'failed' | 'interrupted'
  type Attempt = { id: number; requestId: number; revision: number; memberId: string; phase: Phase; artifact: string | null; evidence: string | null; settledAt?: number | null }
  type StageBatchRow = { requestId: number; requestRevision: number; attemptId: number | null; attemptRevision: number | null; phase: StagePhase | null }
  type StageSettlementRow = { id: number; batchId: number; settledAt: number; authorizingMessageId: string; dispatchedAt: number; reportState: 'pending' | 'delivered'; deliveredMessageId: string | null; reportCreatedAt: number }
  type StageItemRow = { requestId: number; revision: number; attemptId: number; phase: StagePhase; memberId: string; artifact: string | null; title: string; recoveryChecked: number }
  type StageReportRecord = { settlementId: number; state: 'pending' | 'delivered'; deliveredMessageId: string | null; createdAt: number }
  const get = db.prepare('SELECT * FROM request WHERE id = ?')
  const bySource = db.prepare('SELECT * FROM request WHERE messageId = ? AND partKey = ?')
  const priorIntake = db.prepare('SELECT * FROM request WHERE messageId = ? AND title = ? AND quote = ? ORDER BY id LIMIT 1')
  const last = db.prepare('SELECT * FROM attempt WHERE requestId = ? ORDER BY id DESC LIMIT 1')
  const list = db.prepare('SELECT * FROM request ORDER BY id')
  const page = db.prepare('SELECT * FROM request WHERE id > ? ORDER BY id LIMIT ?')
  const pageForSource = db.prepare('SELECT * FROM request WHERE messageId = ? AND id > ? ORDER BY id LIMIT ?')
  /* ★1124b（老板：「倒序加载却从最老的一头开始」）：工单面板是**最新优先**的列表 ——
     分页也得从新往旧走，否则第一页拿到的是最老的 N 条，最新的反而要翻到底才出现。
     只给 `page()` 用；`stageReport` / `stageSettlements`（自动汇报按时间先后播报）继续用上面那两条升序的。 */
  const pageDesc = db.prepare('SELECT * FROM request WHERE id < ? ORDER BY id DESC LIMIT ?')
  const pageForSourceDesc = db.prepare('SELECT * FROM request WHERE messageId = ? AND id < ? ORDER BY id DESC LIMIT ?')
  const sources = db.prepare('SELECT DISTINCT messageId FROM request')
  const attempts = db.prepare('SELECT * FROM attempt WHERE requestId = ? ORDER BY id')
  /* ★1124（老板拍板）：主 agent 判断"新任务跟这个成员上次做的有没有关联"要有依据 ——
     每个成员最近一单（requestId/attemptId/phase/title + 这张单累计跑过几轮）。
     `rounds` 就是它失败的次数依据：上一单 3 轮还没过 ⇒ 下次派单前该换段。 */
  const recentAttemptByMember = db.prepare(`
    SELECT a.memberId AS memberId, a.requestId AS requestId, a.id AS attemptId, a.phase AS phase,
           r.title AS title,
           (SELECT COUNT(*) FROM attempt x WHERE x.requestId = a.requestId) AS rounds
    FROM attempt a JOIN request r ON r.id = a.requestId
    WHERE a.id = (SELECT MAX(y.id) FROM attempt y WHERE y.memberId = a.memberId)
    ORDER BY a.memberId`)
  const insert = db.prepare('INSERT INTO request (messageId, partKey, title, quote, acceptance, verify) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
  const enqueue = db.prepare("INSERT INTO attempt (requestId, revision, memberId, phase) VALUES (?, ?, ?, 'queued') RETURNING *")
  const revise = db.prepare('UPDATE request SET revision = revision + 1, acceptance = ? WHERE id = ? RETURNING *')
  const insertRevision = db.prepare('INSERT INTO request_revision (requestId, revision, messageId, quote, acceptance, kind, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const revisionsOf = db.prepare('SELECT revision, messageId, quote, acceptance, kind, at FROM request_revision WHERE requestId = ? ORDER BY revision')
  const revisionBySource = db.prepare("SELECT revision, messageId, quote, acceptance, kind, at FROM request_revision WHERE requestId = ? AND messageId = ? AND kind = 'revise'")
  /* ★1124：多一个 settledAt（终结时刻）—— 由调用方算好传进来，不用 SQL 里的 `CASE WHEN ? IN(...)`：
     node:sqlite 对那种表达式的参数绑定会报 `column index out of range`（实测踩过）。 */
  const transition = db.prepare(`UPDATE attempt SET phase = ?, artifact = ?, evidence = ?, settledAt = COALESCE(?, settledAt)
    WHERE id = ? AND requestId = ? AND revision = ? AND phase = ? RETURNING *`)
  /* ★1124：简报里要带「C 只出意见」的那一句 —— 取每条 attempt 最近一次复验结果。 */
  const latestReviewByAttempt = db.prepare('SELECT result FROM review_execution WHERE attemptId = ? ORDER BY id DESC LIMIT 1')
  const queued = db.prepare("SELECT * FROM attempt WHERE phase = 'queued' ORDER BY id LIMIT 1")
  const attemptById = db.prepare('SELECT * FROM attempt WHERE id = ?')
  const insertCancel = db.prepare('INSERT OR REPLACE INTO attempt_cancel (attemptId, requestId, reason, at) VALUES (?, ?, ?, ?)')
  const cancelRow = db.prepare('SELECT reason, at FROM attempt_cancel WHERE attemptId = ?')
  const insertNote = db.prepare('INSERT INTO request_note (requestId, attemptId, messageId, quote, text, consumed, at) VALUES (?, ?, ?, ?, ?, 0, ?) RETURNING id')
  const noteBySource = db.prepare('SELECT id, attemptId, text FROM request_note WHERE requestId = ? AND messageId = ?')
  /* 阶段2·补充收件：按 **request + 版本** 取未消费补充，不按单个 attempt 硬绑。
     语义：补充是"用户给这版需求的上下文"，与哪个 attempt 无关 —— 所以
       · 执行中：本次 attempt 取到它并投递；
       · 失败后重派（同版本新 attempt）：**接续**投给新 attempt，不静默丢（原记录仍在，consumed 未变）；
       · 改了验收（revision 变了）：**不接续**，不跨版本重放旧版本的补充。 */
  const pendingNotesStmt = db.prepare(`SELECT n.id, n.messageId, n.text FROM request_note n
    WHERE n.requestId = ? AND n.consumed = 0
      AND n.attemptId IN (SELECT a.id FROM attempt a WHERE a.requestId = ?
        AND a.revision = (SELECT revision FROM attempt WHERE id = ?))
    ORDER BY n.id`)
  const consumeNote = db.prepare('UPDATE request_note SET consumed = 1 WHERE id = ?')
  /* 交付时校验"这条补充确实属于这一单、这一 attempt"（防止调用方传错 id 把别的单吃掉）。 */
  const noteById = db.prepare('SELECT id, requestId, attemptId, consumed FROM request_note WHERE id = ?')
  const depsOf = db.prepare('SELECT dependsOn FROM request_dependency WHERE requestId = ? ORDER BY dependsOn')
  const dependentsOfStmt = db.prepare('SELECT requestId FROM request_dependency WHERE dependsOn = ? ORDER BY requestId')
  const insertDep = db.prepare('INSERT INTO request_dependency (requestId, dependsOn, createdAt) VALUES (?, ?, ?)')
  const allQueued = db.prepare("SELECT * FROM attempt WHERE phase = 'queued' ORDER BY id")
  const insertAttemptUsage = db.prepare(`INSERT INTO attempt_usage (attemptId, requestId, revision, memberId, input, output, cacheRead, cacheWrite, hitRate, receiptKnown, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attemptId) DO UPDATE SET input=excluded.input, output=excluded.output, cacheRead=excluded.cacheRead, cacheWrite=excluded.cacheWrite, hitRate=excluded.hitRate, receiptKnown=excluded.receiptKnown, at=excluded.at`)
  const attemptUsageRows = db.prepare('SELECT requestId, revision, memberId, input, output, cacheRead, cacheWrite, hitRate, receiptKnown FROM attempt_usage ORDER BY requestId, revision')
  const interrupted = db.prepare("UPDATE attempt SET phase = 'interrupted', evidence = ? WHERE phase = 'running'")
  const runningBatches = db.prepare(`SELECT DISTINCT r.batchId AS batchId FROM attempt a
    JOIN request r ON r.id = a.requestId WHERE a.phase = 'running' AND r.batchId IS NOT NULL`)
  const restartHold = db.prepare("SELECT 1 FROM attempt a LEFT JOIN recovery_review r ON r.attemptId = a.id WHERE a.phase = 'queued' OR (a.phase = 'interrupted' AND r.attemptId IS NULL) LIMIT 1")
  const unresolvedInterrupts = db.prepare("SELECT a.id FROM attempt a LEFT JOIN recovery_review r ON r.attemptId = a.id WHERE a.phase = 'interrupted' AND r.attemptId IS NULL ORDER BY a.id")
    /* 一个 attempt 只留一条核对记录：两阶段（人工核对 / 围栏探针）都要留证据 ⇒ 后写的**追加**而不是覆盖。
     否则"先人工确认、后围栏解除"会撞 UNIQUE 约束（真流程就会走到）。 */
  const saveRecoveryReview = db.prepare(`INSERT INTO recovery_review(attemptId, reviewer, evidence, reviewedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(attemptId) DO UPDATE SET reviewer = excluded.reviewer,
      evidence = recovery_review.evidence || ' ｜ ' || excluded.evidence,
      reviewedAt = excluded.reviewedAt`)
  /* 副作用围栏的持久事实（见建表注释）：hold 期间任何开工都要先复核 */
  const insertFenceHold = db.prepare('INSERT OR REPLACE INTO fence_hold(attemptId, reason, at) VALUES (?, ?, ?)')
  const fenceHoldRows = db.prepare(`SELECT f.attemptId, f.reason, a.requestId, a.memberId FROM fence_hold f
    JOIN attempt a ON a.id = f.attemptId ORDER BY f.attemptId`)
  const fenceHoldFor = db.prepare('SELECT reason FROM fence_hold WHERE attemptId = ?')
  const deleteFenceHold = db.prepare('DELETE FROM fence_hold WHERE attemptId = ?')
  const insertFencePid = db.prepare('INSERT OR REPLACE INTO fence_pid(attemptId, pid, startStamp) VALUES (?, ?, ?)')
  const deleteFencePids = db.prepare('DELETE FROM fence_pid WHERE attemptId = ?')
  const fencePidRows = db.prepare('SELECT attemptId, pid, startStamp FROM fence_pid')
  /* ★1124：启动意图（`spawn()` 之前落库） */
  const insertProcIntent = db.prepare('INSERT INTO proc_intent(attemptId, token, tool, at, pid) VALUES (?, ?, ?, ?, NULL)')
  const bindProcIntentPid = db.prepare('UPDATE proc_intent SET pid = ? WHERE token = ? AND attemptId = ? AND pid IS NULL')
  const deleteProcIntentByToken = db.prepare('DELETE FROM proc_intent WHERE token = ?')
  const deleteProcIntentsByAttempt = db.prepare('DELETE FROM proc_intent WHERE attemptId = ?')
  const unboundProcIntentRows = db.prepare('SELECT id, attemptId, token, tool, at FROM proc_intent WHERE attemptId = ? AND pid IS NULL')
  const procIntentRows = db.prepare('SELECT id, attemptId, token, tool, at, pid FROM proc_intent WHERE attemptId = ?')
  const insertFenceRelease = db.prepare('INSERT OR REPLACE INTO fence_release(attemptId, evidence, at) VALUES (?, ?, ?)')
  const fenceReleaseRows = db.prepare('SELECT attemptId, evidence, at FROM fence_release ORDER BY attemptId')
  const activeMembers = db.prepare("SELECT memberId, requestId, id AS attemptId FROM attempt WHERE phase = 'running' ORDER BY requestId")
  const workspaceInsert = db.prepare('INSERT INTO attempt_workspace (attemptId, root) VALUES (?, ?)')
  const workspaceFor = db.prepare('SELECT root FROM attempt_workspace WHERE attemptId = ?')
  const attemptByIdStmt = db.prepare('SELECT * FROM attempt WHERE id = ?')
  const insertReport = db.prepare('INSERT INTO report_receipt (attemptId, report) VALUES (?, ?)')
  const getReport = db.prepare('SELECT r.report FROM report_receipt r JOIN attempt a ON a.id = r.attemptId WHERE r.attemptId = ? AND a.artifact = ?')
  const recordCheck = db.prepare('INSERT INTO file_check (attemptId, workspace, relativePath, expected, actual, bytes, checkedAt, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, attemptId, relativePath, expected, actual, bytes, checkedAt, outcome')
  const lastCheck = db.prepare('SELECT id, attemptId, relativePath, expected, actual, bytes, checkedAt, outcome FROM file_check WHERE attemptId = ? ORDER BY id DESC LIMIT 1')
  const recordReview = db.prepare('INSERT INTO review_execution (attemptId, artifact, fileCheckId, recordedAt, result) VALUES (?, ?, ?, ?, ?)')
  const reviewExecutions = db.prepare('SELECT id, artifact, fileCheckId, recordedAt, result FROM review_execution WHERE attemptId = ? ORDER BY id')
  const verificationRows = db.prepare(`SELECT a.requestId AS requestId, e.result AS result
    FROM review_execution e JOIN attempt a ON a.id = e.attemptId ORDER BY e.id`)
  const pendingReviews = db.prepare(`SELECT r.id, r.title FROM request r JOIN attempt a
    ON a.id = (SELECT id FROM attempt WHERE requestId = r.id ORDER BY id DESC LIMIT 1)
    WHERE a.phase = 'submitted' AND a.revision = r.revision ORDER BY r.id LIMIT 2`)
  const insertBatch = db.prepare('INSERT INTO dispatch_batch (authorizingMessageId, dispatchedAt) VALUES (?, ?) RETURNING id')
  const bindBatch = db.prepare('UPDATE request SET batchId = ? WHERE id = ? AND batchId IS NULL RETURNING id')
  const batchOfRequest = db.prepare('SELECT batchId FROM request WHERE id = ?')
  /* Batches worth a look, in one indexed statement: some work item stopped executing and its
   attempt has never been covered by a settlement. Whether the whole batch stopped is decided by
   settleBatch; already-settled batches never reach it, so a restart sweep pays an index probe per
   work item instead of re-deriving every attempt key. */
  const candidateBatches = db.prepare(`SELECT DISTINCT r.batchId AS batchId FROM request r
    JOIN attempt a ON a.id = (SELECT MAX(id) FROM attempt WHERE requestId = r.id)
    WHERE r.batchId IS NOT NULL AND a.revision = r.revision AND a.phase NOT IN ('queued','running')
      AND NOT EXISTS (SELECT 1 FROM stage_item i WHERE i.attemptId = a.id)`)
  const batchRequests = db.prepare(`SELECT r.id AS requestId, r.revision AS requestRevision,
      a.id AS attemptId, a.revision AS attemptRevision, a.phase
    FROM request r LEFT JOIN attempt a ON a.id = (SELECT id FROM attempt WHERE requestId = r.id ORDER BY id DESC LIMIT 1)
    WHERE r.batchId = ? ORDER BY r.id`)
  const insertSettlement = db.prepare(`INSERT INTO stage_settlement (batchId, attemptKey, settledAt) VALUES (?, ?, ?)
    ON CONFLICT(batchId, attemptKey) DO NOTHING RETURNING id`)
  const insertStageItem = db.prepare('INSERT INTO stage_item (settlementId, requestId, revision, attemptId) VALUES (?, ?, ?, ?)')
  const insertStageReport = db.prepare("INSERT INTO stage_report (settlementId, state, createdAt) VALUES (?, 'pending', ?) RETURNING id")
  const settlementPage = db.prepare(`SELECT s.id, s.batchId, s.settledAt, b.authorizingMessageId, b.dispatchedAt,
      r.state AS reportState, r.deliveredMessageId, r.createdAt AS reportCreatedAt
    FROM stage_settlement s
    JOIN dispatch_batch b ON b.id = s.batchId
    JOIN stage_report r ON r.settlementId = s.id
    WHERE s.id > ? ORDER BY s.id LIMIT ?`)
  const settlementItems = db.prepare(`SELECT i.requestId, i.revision, i.attemptId, a.phase, a.memberId, a.artifact, rq.title,
      CASE WHEN rr.attemptId IS NULL THEN 0 ELSE 1 END AS recoveryChecked
    FROM stage_item i JOIN attempt a ON a.id = i.attemptId
    JOIN request rq ON rq.id = i.requestId
    LEFT JOIN recovery_review rr ON rr.attemptId = i.attemptId
    WHERE i.settlementId = ? ORDER BY i.requestId`)
  const deliverStageReport = db.prepare(`UPDATE stage_report SET state = 'delivered', deliveredMessageId = ?
    WHERE settlementId = ? AND state = 'pending' RETURNING settlementId, state, deliveredMessageId, createdAt`)
  const stageReportFor = db.prepare('SELECT settlementId, state, deliveredMessageId, createdAt FROM stage_report WHERE settlementId = ?')
  /* Undelivered stages after a settlement watermark, oldest first. Ordering (not timestamps)
     decides eligibility, so same-millisecond settle-then-enable can never leak a backlog item. */
  const pendingReportPage = db.prepare(`SELECT s.id, s.batchId, s.settledAt, b.authorizingMessageId, b.dispatchedAt,
      r.state AS reportState, r.deliveredMessageId, r.createdAt AS reportCreatedAt
    FROM stage_report r
    JOIN stage_settlement s ON s.id = r.settlementId
    JOIN dispatch_batch b ON b.id = s.batchId
    WHERE r.state = 'pending' AND s.id > ?
    ORDER BY s.id LIMIT ?`)
  const latestSettlement = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM stage_settlement')
  const stageTotalsRow = db.prepare(`SELECT (SELECT COUNT(*) FROM stage_settlement) AS settlements,
      (SELECT COUNT(*) FROM stage_report WHERE state = 'pending') AS pendingReports,
      (SELECT COUNT(*) FROM stage_report WHERE state = 'delivered') AS deliveredReports`)
  const currentPhaseCounts = db.prepare(`SELECT COALESCE(a.phase, 'received') AS phase, COUNT(*) AS count
    FROM request r LEFT JOIN attempt a ON a.revision = r.revision AND a.id =
      (SELECT id FROM attempt WHERE requestId = r.id ORDER BY id DESC LIMIT 1)
    GROUP BY COALESCE(a.phase, 'received') ORDER BY phase`)
  const latestBoundReview = db.prepare(`SELECT result FROM review_execution WHERE attemptId = ? AND artifact = ?
    AND fileCheckId IS ? ORDER BY id DESC LIMIT 1`)
  const working = db.prepare("SELECT id FROM attempt WHERE memberId = ? AND phase = 'running'")
  function required(text: string, max: number) {
    if (typeof text !== 'string' || !text.trim() || text.length > max) throw new Error('Invalid team ledger input')
    return text
  }
  function req(id: number): Request {
    const row = get.get(id) as Request | undefined
    if (!row) throw new Error('Team request not found')
    return row
  }
  function latest(id: number): Attempt | undefined { return last.get(id) as Attempt | undefined }
  const changes = onCommittedChange && db.prepare('SELECT total_changes() AS n')
  /* Batches whose attempt set changed *into* a stopped state inside the current transaction.
     Settlement is triggered by that transition, not by "something was committed". */
  const stoppedBatches = new Set<number>()
  function atomic<T>(op: () => T): T {
    const before = changes?.get()?.n
    db.exec('BEGIN IMMEDIATE')
    let value: T
    try {
      value = op()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      stoppedBatches.clear()
      throw error
    }
    const affected = [...stoppedBatches]
    stoppedBatches.clear()
    if (onCommittedChange && changes?.get()?.n !== before) queueMicrotask(() => onCommittedChange(affected))
    return value
  }
  function current(requestId: number, id: number, phase: Phase): Attempt {
    const a = latest(requestId)
    if (!a || a.id !== id || a.phase !== phase || a.revision !== req(requestId).revision) {
      throw new Error('Stale or invalid team attempt')
    }
    return a
  }
  function advance(a: Attempt, phase: Phase, artifact = a.artifact, evidence = a.evidence) {
    const settledAt = (['accepted', 'rejected', 'failed', 'interrupted', 'cancelled'] as Phase[]).includes(phase) ? Date.now() : null
    const row = transition.get(phase, artifact, evidence, settledAt, a.id, a.requestId, a.revision, a.phase) as Attempt | undefined
    if (!row) throw new Error('Team attempt did not transition')
    /* Only "stopped executing" moves a settlement condition. submitted→accepted, file checks and
       reviewer bookkeeping all leave the attempt set's identity and stopping state untouched. */
    if ((a.phase === 'queued' || a.phase === 'running') && phase !== 'queued' && phase !== 'running') {
      const batchId = (batchOfRequest.get(a.requestId) as { batchId: number | null } | undefined)?.batchId
      if (typeof batchId === 'number') stoppedBatches.add(batchId)
    }
    return row
  }
  /** One settlement rendered for readers: stored identity + standing derived from attempt rows. */
  function settlementView(row: StageSettlementRow) {
    const attempts = settlementItems.all(row.id) as StageItemRow[]
    return {
      settlementId: row.id,
      batchId: row.batchId,
      authorizingMessageId: row.authorizingMessageId,
      dispatchedAt: row.dispatchedAt,
      settledAt: row.settledAt,
      standing: deriveStageStanding(attempts.map(attempt => attempt.phase)),
      report: { state: row.reportState, deliveredMessageId: row.deliveredMessageId, createdAt: row.reportCreatedAt },
      items: attempts.map(attempt => ({
        requestId: attempt.requestId, revision: attempt.revision, attemptId: attempt.attemptId, title: attempt.title,
        phase: attempt.phase, memberId: attempt.memberId, artifact: attempt.artifact,
        recoveryChecked: attempt.recoveryChecked === 1,
        /* ★1124：这条是**自动验收（硬判据）**过的吗（证据前缀由 autoVerifySubmission 写入）——
           简报要靠它区分"真读过产物"和"仅报告层面验收"，别把两种说成一回事。 */
        autoVerified: typeof attempt.evidence === 'string' && attempt.evidence.startsWith('自动验收（硬判据）'),
        /* ★1124（老板选 A）：C 只出意见，附在简报里帮人判断 —— 解析失败按"没有意见"处理，不猜。 */
        review: (() => {
          const row = latestReviewByAttempt.get(attempt.attemptId) as { result?: string } | undefined
          if (!row?.result) return null
          try {
            const parsed = JSON.parse(row.result)
            if (parsed?.status !== 'opinion' || !parsed?.opinion) return null
            const status = parsed.opinion.status
            if (!['supported', 'concerns', 'insufficient'].includes(status)) return null
            return { status, summary: String(parsed.opinion.summary || '').slice(0, 400) }
          } catch { return null }
        })(),
      })),
    }
  }
  /** Caller owns the transaction: this runs either inside the commit that stopped the batch, or
   * inside the single restart sweep. Returns true when a new stage was actually recorded. */
  function settleBatch(batchId: number, settledAt: number): boolean {
    const rows = batchRequests.all(batchId) as StageBatchRow[]
    if (!rows.length) throw new Error('Team stage batch has no work item')
    const stopped = rows.every(row => row.attemptId !== null && row.attemptRevision === row.requestRevision &&
      row.phase !== 'queued' && row.phase !== 'running')
    if (!stopped) return false
    const items = rows.map(row => ({ requestId: row.requestId, revision: row.requestRevision, attemptId: Number(row.attemptId) }))
    const settlement = insertSettlement.get(batchId, stageAttemptKey(items), settledAt) as { id: number } | undefined
    if (!settlement) return false
    for (const item of items) insertStageItem.run(settlement.id, item.requestId, item.revision, item.attemptId)
    insertStageReport.run(settlement.id, settledAt)
    return true
  }
  function project(request: Request) {
    const a = latest(request.id)
    const attempt = a?.revision === request.revision ? a : null
    const fileCheck = attempt ? lastCheck.get(attempt.id) ?? null : null
    /* 阶段1：版本来源随投影一起下发（只读），让"我的需求"能回跳每一版的原话。 */
    /* 阶段3：阻塞原因也随投影下发 —— 页面/工具看到的是同一个后端口径，不在前端推断。 */
    /* ★1124：判据随投影下发。解析失败按"没有可执行判据"处理（宁可让人验收，也不瞎猜一份判据出来）。 */
    let verify: unknown = null
    if (request.verify) { try { verify = JSON.parse(request.verify) } catch { verify = null } }
    /* ★1124：验收流水 = 这一单每一次尝试的相位/时间/依据（上限 20 条，够看历史又不拖垮面板）。 */
    const attemptRows = (attempts.all(request.id) as Attempt[]).slice(-20)
    return { request, phase: attempt?.phase ?? 'received', attempt, fileCheck, verify, attempts: attemptRows, revisions: revisionsOf.all(request.id), blockedReason: dependencyBlocked(request.id) }
  }
  function receive(input: Omit<Request, 'id' | 'revision'>, dispatch = false): { request: Request; created: boolean } {
    const fields = [required(input.messageId, 200), required(input.partKey, 120), required(input.title, 240), required(input.quote, 20_000), required(input.acceptance, 8_000), input.verify ? JSON.stringify(input.verify) : null] as const
    const existing = (bySource.get(fields[0], fields[1]) ??
      (dispatch ? priorIntake.get(fields[0], fields[2], fields[3]) : undefined)) as Request | undefined
    if (!existing) {
      const created = insert.get(...fields) as Request
      /* 初始版本同样留来源（阶段1）：首版要求也能回跳到授权用户消息的逐字引用。 */
      insertRevision.run(created.id, created.revision, created.messageId, created.quote, created.acceptance, 'initial', Date.now())
      return { request: created, created: true }
    }
    if (existing.title !== input.title || existing.quote !== input.quote) throw new Error('Conflicting team intake identity')
    /* 老账本（阶段1之前）没有版本行：按可证事实补基线，不猜内容、不改 request 行。 */
    ensureBaseline(existing)
    return { request: existing, created: false }
  }
  /** 阶段1补正：写前先把"已知的旧版本事实"保住。
   *  · revision 还是 1 ⇒ 用 request 自身（真实收单消息 id + 原话 + 当时要求）写 initial —— 这是可证的 v1；
   *  · 已经改过版却没有任何历史行 ⇒ 只能登记 kind='legacy' 的**当前快照**（quote 留空表示来源不可核），
   *    绝不把当前要求伪标成 initial，也不编造中间版本。 */
  function ensureBaseline(request: Request) {
    if (revisionsOf.all(request.id).length) return
    if (request.revision === 1) {
      insertRevision.run(request.id, 1, request.messageId, request.quote, request.acceptance, 'initial', Date.now())
      return
    }
    insertRevision.run(request.id, request.revision, request.messageId, '', request.acceptance, 'legacy', Date.now())
  }
  /** 阶段3：这条需求的依赖是否还没满足（返回第一条原因；无阻塞返回 null）。
   *  口径：前置必须**当前 revision 的最新 attempt 是 accepted**；submitted/failed/cancelled/interrupted 都不算。 */
  function dependencyBlocked(requestId: number): string | null {
    for (const row of depsOf.all(requestId) as Array<{ dependsOn: number }>) {
      const dep = req(row.dependsOn)
      const a = latest(dep.id)
      if (!a || a.revision !== dep.revision || a.phase !== 'accepted') {
        return `前置需求 #${dep.id} 未按当前版本验收通过（当前 ${a ? a.phase : 'received'}）`
      }
    }
    return null
  }
  /** 依赖边的唯一写法（不含事务）：同账本内、不自依赖、不成环、重复幂等。
   *  抽出来是为了能在 `receiveAndAssign` 的**同一个事务里**落边 —— `atomic` 用的是裸
   *  BEGIN IMMEDIATE/COMMIT，**不能嵌套**，所以内部调用方必须走这个无事务版本。 */
  function linkDependency(requestId: number, dependsOn: number): { requestId: number; dependsOn: number; created: boolean } {
    req(requestId); req(dependsOn)
    if (requestId === dependsOn) throw new Error('V2 request cannot depend on itself')
    const already = (depsOf.all(requestId) as Array<{ dependsOn: number }>).some(row => row.dependsOn === dependsOn)
    if (already) return { requestId, dependsOn, created: false }
    /* 成环检测：从 dependsOn 出发能否走回 requestId */
    const seen = new Set<number>()
    const stack = [dependsOn]
    while (stack.length) {
      const id = stack.pop()!
      if (id === requestId) throw new Error('V2 dependency would create a cycle')
      if (seen.has(id)) continue
      seen.add(id)
      for (const row of depsOf.all(id) as Array<{ dependsOn: number }>) stack.push(row.dependsOn)
    }
    insertDep.run(requestId, dependsOn, Date.now())
    return { requestId, dependsOn, created: true }
  }
  return {
    receive(input: Omit<Request, 'id' | 'revision'>): Request { return atomic(() => receive(input).request) },
    /** Includes the authorizing message because a batch is identified by the dispatch it came from,
     * not by the front end or by which user text the tasks happen to quote.
     *  阶段3补正：依赖可以在**同一次派工**里声明，并与派工在同一个事务里落库：
     *   · `after`      = 本批第 N 项（1 起）—— 同批引用，不需要事先知道单号；
     *   · `dependsOn`  = 已存在的需求单编号。
     *  任何一项引用无效（越界 / 单号不存在 / 自依赖 / 成环）⇒ 整个 atomic 回滚：需求、attempt、边全不落。
     *  边在 enqueue 之前写好，所以这批需求**从提交那一刻起**就不可能被 nextQueued 抢跑；
     *  `start()` 还会按前置的**当前版本**再核一次（改版后重新阻塞）。 */
    receiveAndAssign(authorizingMessageId: string, input: Array<Omit<Request, 'id' | 'revision'> & { memberId: string; after?: number; dependsOn?: number }>) {
      const authorization = required(authorizingMessageId, 200)
      return atomic(() => {
        const resolved = input.map(item => ({ item, ...receive(item, true) }))
        for (const { item, request } of resolved) {
          if (item.after !== undefined) {
            const target = Number.isInteger(item.after) ? resolved[item.after - 1] : undefined
            if (!target) throw new Error(`V2 dependency after=${item.after} does not name a task in this dispatch`)
            linkDependency(request.id, target.request.id)
          }
          if (item.dependsOn !== undefined) linkDependency(request.id, item.dependsOn)
        }
        const fresh = resolved.filter(row => row.created)
        /* No batch row for a replay: a repeat dispatch that creates nothing must not leave a
           batch behind that would later settle with no work of its own. */
        const batch = fresh.length ? insertBatch.get(authorization, Date.now()) as { id: number } : undefined
        for (const row of fresh) {
          if (!batch || !bindBatch.get(batch.id, row.request.id)) throw new Error('Team dispatch batch did not bind its new request')
        }
        return resolved.map(({ item, request }) => {
          const existing = latest(request.id)
          if (existing) return { request, attempt: existing, created: false }
          const attempt = enqueue.get(request.id, request.revision, required(item.memberId, 200)) as Attempt
          return { request, attempt, created: true }
        })
      })
    },
    /** 追加/改验收（阶段1补正）：**生产唯一写入口**，来源必填（真实用户消息 id + 逐字引用）。
     *  · 同源重复：同一 (requestId, messageId) 已有 revise 版本 ⇒ 内容相同返回当前状态（幂等、不再升版），
     *    内容不同抛冲突（同一操作不许被静默改成另一个成功）；
     *  · 旧库兼容：写前先按**可证事实**补基线——revision 还是 1 用 request 自身的 messageId/quote/acceptance 写 initial
     *    （这就是 v1 的授权来源）；已改过版但缺历史则写 kind='legacy'（来源不可核，只登记当前快照，绝不伪造中间版本）；
     *  · 版本行与 request.revision 在同一个 atomic 事务里提交，任一失败整体回滚。 */
    reviseAcceptance(requestId: number, revision: number, acceptance: string, source: { messageId: string; quote: string }): Request {
      return atomic(() => {
        const current = req(requestId)
        if (current.revision !== revision) throw new Error('Stale team request revision')
        const old = latest(requestId)
        if (old && ['queued', 'running', 'submitted'].includes(old.phase)) throw new Error('Settle the current attempt before revising')
        const text = required(acceptance, 8_000)
        const src = { messageId: required(source.messageId, 200), quote: required(source.quote, 20_000) }
        const prior = revisionBySource.get(requestId, src.messageId) as { revision: number; acceptance: string } | undefined
        if (prior) {
          if (prior.acceptance === text) return current
          throw new Error('This user message already revised the request with different content')
        }
        ensureBaseline(current)
        const updated = revise.get(text, requestId) as Request
        insertRevision.run(requestId, updated.revision, src.messageId, src.quote, text, 'revise', Date.now())
        return updated
      })
    },
    /** 要求版本历史（阶段1补正）：只读、按版本升序。`kind='legacy'` 表示"阶段1之前的历史、来源不可核"，不是伪造版本。 */
    revisionHistory(requestId: number) {
      return revisionsOf.all(req(requestId).id) as Array<{ revision: number; messageId: string; quote: string; acceptance: string; kind: 'initial' | 'revise' | 'legacy'; at: number }>
    },
    assign(requestId: number, revision: number, memberId: string): Attempt {
      return atomic(() => {
        if (req(requestId).revision !== revision) throw new Error('Stale team request revision')
        const old = latest(requestId)
        if (old?.revision === revision && !['failed', 'rejected', 'cancelled'].includes(old.phase)) throw new Error('Team request already assigned or accepted')
        return enqueue.get(requestId, revision, required(memberId, 200)) as Attempt
      })
    },
    /** 阶段2·排队取消：只处理**尚未开工**的 queued attempt（还没有任何执行副作用）。
     *  取消后 `nextQueued()` 取不到它，同一版本可以重新派工；重复取消幂等；
     *  运行中/待验收的取消必须连执行器真停一起做，这里明确拒绝而不是假装成功。 */
    cancelQueuedAttempt(requestId: number, attemptId: number, reason: string): Attempt {
      return atomic(() => {
        const row = attemptById.get(attemptId) as Attempt | undefined
        if (!row || row.requestId !== requestId) throw new Error('Unknown team attempt')
        if (row.phase === 'cancelled') return row
        if (row.phase !== 'queued') throw new Error('Only a queued attempt can be cancelled before it starts')
        /* 走 advance 而不是直接 UPDATE：取消也是"停止执行"，必须登记批次结算，
           否则该阶段永远不会产生结算记录（Nis 反例：events=[[]]，手动全量结算才返回 1）。 */
        return advance(row, 'cancelled', row.artifact, required(reason, 8_000))
      })
    },
    /** 下一个可开工的排队项。`skipAttempts` / `skipMembers` 供并发槽位做"本批已领"排除（不改状态）。 */
    nextQueued(opts?: { skipAttempts?: Set<number>; skipMembers?: Set<string> }) {
      /* 阶段3：跳过依赖未满足的排队项 —— 前置必须**按当前版本 accepted**，取第一个可开工的。 */
      for (const a of allQueued.all() as Attempt[]) {
        if (opts?.skipAttempts?.has(a.id)) continue
        if (opts?.skipMembers?.has(a.memberId)) continue
        if (dependencyBlocked(a.requestId)) continue
        if (working.get(a.memberId)) continue
        return { request: req(a.requestId), attempt: a }
      }
      return undefined
    },
    /** 阶段3·依赖写入（单独调用别名）：同账本(=同父会话)内、不自依赖、不成环；重复添加幂等。 */
    addDependency(requestId: number, dependsOn: number): { requestId: number; dependsOn: number; created: boolean } {
      return atomic(() => linkDependency(requestId, dependsOn))
    },
    /** 依赖里未满足的第一条原因（无阻塞返回 null）—— 页面/工具都用这一个口径。 */
    dependencyBlocked(requestId: number): string | null {
      return dependencyBlocked(requestId)
    },
    dependencies(requestId: number) {
      return depsOf.all(requestId) as Array<{ dependsOn: number }>
    },
    dependents(requestId: number) {
      return dependentsOfStmt.all(requestId) as Array<{ requestId: number }>
    },
    /** 阶段4·记一次成员执行的可归属用量（同一 attempt 重写覆盖，不累加 —— 一轮一次）。
     *  `receiptKnown=false` 表示这次没有可核回执：照样落行，让上层标"不完整"，绝不按比例补。 */
    recordAttemptUsage(input: { attemptId: number; requestId: number; revision: number; memberId: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; hitRate?: number } | null }): void {
      atomic(() => {
        /* 阶段4补正：写入口**不信任输入的四个身份字段** —— 必须与账本里该 attempt 的真实身份一致，
           否则"同库真实 attempt ID + 另一 request/revision/member"就能把用量错归到别的需求。 */
        const actual = attemptById.get(input.attemptId) as Attempt | undefined
        if (!actual || actual.requestId !== input.requestId || actual.revision !== input.revision || actual.memberId !== input.memberId) {
          throw new Error('V2 usage attribution does not match the attempt')
        }
        const u = input.usage || {}
        const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0)
        const known = !!input.usage
        insertAttemptUsage.run(
          input.attemptId, input.requestId, input.revision, input.memberId,
          num(u.input), num(u.output), num(u.cacheRead), num(u.cacheWrite),
          typeof u.hitRate === 'number' && Number.isFinite(u.hitRate) ? u.hitRate : null,
          known ? 1 : 0, Date.now(),
        )
      })
    },
    /** 可归属用量的只读投影：按需求聚合 + 标出缺回执的条数（不与公共总量相加）。 */
    attributableUsage() {
      const rows = attemptUsageRows.all() as Array<{ requestId: number; revision: number; memberId: string; input: number; output: number; cacheRead: number; cacheWrite: number; hitRate: number | null; receiptKnown: number }>
      const byRequest: Record<string, { calls: number; withReceipt: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
      let calls = 0, withReceipt = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0
      for (const row of rows) {
        const key = String(row.requestId)
        const bucket = byRequest[key] || (byRequest[key] = { calls: 0, withReceipt: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
        bucket.calls += 1
        calls += 1
        if (row.receiptKnown) {
          bucket.withReceipt += 1; withReceipt += 1
          bucket.input += row.input; bucket.output += row.output
          bucket.cacheRead += row.cacheRead; bucket.cacheWrite += row.cacheWrite
          input += row.input; output += row.output; cacheRead += row.cacheRead; cacheWrite += row.cacheWrite
        }
      }
      return { calls, withReceipt, unknown: calls - withReceipt, totals: { input, output, cacheRead, cacheWrite }, byRequest }
    },
    /** 阶段2·取消入口（统一）：queued 直接落 cancelled；running 先登记取消请求（不假装已停），
     *  等执行器真的中止后由 settleCancelled 落定；其它阶段明确拒绝。重复请求幂等。 */
    requestCancel(requestId: number, attemptId: number, reason: string): Attempt {
      return atomic(() => {
        const row = attemptById.get(attemptId) as Attempt | undefined
        if (!row || row.requestId !== requestId) throw new Error('Unknown team attempt')
        const text = required(reason, 8_000)
        if (row.phase === 'cancelled') return row
        if (row.phase === 'queued') return advance(row, 'cancelled', row.artifact, text)
        if (row.phase !== 'running') throw new Error('Only a queued or running attempt can be cancelled')
        insertCancel.run(attemptId, requestId, text, Date.now())
        return row
      })
    },
    /** 执行器确认停下之后落定取消（幂等）：running/queued/submitted → cancelled，并留下"确实已停"的证据。
     *  没有取消请求时返回 undefined —— 让调用方继续走 interrupted（未知副作用）那条路。 */
    settleCancelled(requestId: number, attemptId: number, evidence: string): Attempt | undefined {
      return atomic(() => {
        if (!cancelRow.get(attemptId)) return undefined
        const row = attemptById.get(attemptId) as Attempt | undefined
        if (!row || row.requestId !== requestId) return undefined
        if (row.phase === 'cancelled') return row
        if (!['queued', 'running', 'submitted'].includes(row.phase)) return row
        /* 同样走 advance：取消落地要登记批次结算，才能产生带 cancelled standing 的阶段记录。 */
        return advance(row, 'cancelled', row.artifact, required(evidence, 8_000))
      })
    },
    /** 这个 attempt 是否处在"用户已要求取消"状态（调度器据此区分 cancelled 与 interrupted）。 */
    cancelRequested(attemptId: number): boolean {
      return !!cancelRow.get(attemptId)
    },
    /** 阶段2·普通补充：不改授权/验收的本单补充，绑定**当前有效 attempt**（同 revision 且 queued/running）。
     *  同一 (requestId, messageId) 只收一次 —— 工具重放/网络重试幂等；不同消息按到达顺序排队。
     *  改范围/验收不走这里（那是 reviseAcceptance 的版本变更）。 */
    addNote(input: { requestId: number; messageId: string; quote: string; text: string }): { id: number; attemptId: number; replayed: boolean } {
      return atomic(() => {
        const current = req(input.requestId)
        const a = latest(input.requestId)
        if (!a || a.revision !== current.revision || !['queued', 'running'].includes(a.phase)) {
          throw new Error('V2 note requires a queued or running attempt on the current revision')
        }
        const existing = noteBySource.get(input.requestId, input.messageId) as { id: number; attemptId: number; text: string } | undefined
        const text = required(input.text, 8_000)
        if (existing) {
          /* 同源重放只在**内容一致**时幂等；同一条消息换内容必须冲突，不能静默当成"另一个成功"。 */
          if (existing.text === text) return { id: existing.id, attemptId: existing.attemptId, replayed: true }
          throw new Error('This user message already added a different note to the request')
        }
        const row = insertNote.get(input.requestId, a.id, required(input.messageId, 200), required(input.quote, 20_000), text, Date.now()) as { id: number }
        return { id: row.id, attemptId: a.id, replayed: false }
      })
    },
    /** 执行者取这一单**该版本**还没消费的补充（按 id 升序 = 到达顺序）。
     *  同版本重派的新 attempt 也能取到同一批（接续）；换了版本则不取（不跨版本重放）。 */
    pendingNotes(requestId: number, attemptId: number) {
      return pendingNotesStmt.all(requestId, requestId, attemptId) as Array<{ id: number; messageId: string; text: string }>
    },
    /** 标记已投递（执行者处理过），避免重复投递给后续轮次。 */
    consumeNotes(ids: number[]): number {
      return atomic(() => {
        let n = 0
        for (const id of ids) { consumeNote.run(id); n++ }
        return n
      })
    },
    interrupt(requestId: number, attemptId: number, phase: 'queued' | 'running', evidence: string): Attempt {
      return atomic(() => advance(current(requestId, attemptId, phase), 'interrupted', null, required(evidence, 8_000)))
    },
    /** A new backend must not claim the old execution finished or blindly resume its queue. */
    recoverAfterOwnerExit(): number {
      return atomic(() => {
        /* Restart is the one place that legitimately touches many batches: every attempt this
           process left running is about to stop, so those batches become settlement candidates. */
        for (const row of runningBatches.all() as Array<{ batchId: number }>) stoppedBatches.add(row.batchId)
        return Number(interrupted.run('上一个后端已退出；执行和产物未确认，需核对后再处理。').changes)
      })
    },
    needsRestartReview(): boolean { return !!restartHold.get() },
    pendingRecoveryAttempts(): number[] { return unresolvedInterrupts.all().map(row => Number(row.id)) },
    /** 围栏拒绝：把「副作用未确认停下」落成**持久事实**（表里一行），并把这次尝试落成 interrupted。
     *  它跨 drain、跨重启都还在 —— 只有 `releaseFence`（带退出证据的复核）才能解除。 */
    holdFence(requestId: number, attemptId: number, evidence: string, pids?: Array<{ pid: number; startStamp?: string | null }>): Attempt {
      return atomic(() => {
        /* 围栏可能在开工前就拒绝（queued，无副作用）或开工后（running）——
           两阶段都要能落 hold，校验强度不变：最新尝试 + 版本没变 + 未进终态。 */
        const a = latest(requestId)
        if (!a || a.id !== attemptId || a.requestId !== requestId || a.revision !== req(requestId).revision || !['queued', 'running'].includes(a.phase)) {
          throw new Error('Stale or invalid team attempt')
        }
        const text = required(evidence, 8_000)
        insertFenceHold.run(attemptId, text, Date.now())
        /* 残留进程跟着围栏一起落库（OS 事实），后端重启后仍可据此探活。 */
        deleteFencePids.run(attemptId)
        for (const p of pids || []) {
          const pid = Number(p?.pid)
          if (!Number.isSafeInteger(pid) || pid <= 0) continue
          insertFencePid.run(attemptId, pid, p?.startStamp ? String(p.startStamp) : null)
        }
        return advance(a, 'interrupted', null, text)
      })
    },
    /** ★工具**一启动**就把 pid+启动戳记到这条 attempt 名下（不等围栏才记）。
     *  为什么：围栏只在"结算时发现还有残留"才登记；如果后端在那一刻之前被 SIGKILL，
     *  重启后内存登记表是空的、账本里也没有 pid ⇒ 没人知道它拉起过哪些进程（真实盲区）。
     *  提前落库后，`drained` 直接用 OS 事实复核这些 pid。
     *  返回 `true` = 已落行；`false` = 这一单已不在 queued/running（**没记**，调用方必须如实留痕，
     *  不许当"没有残留"）。指纹未知就存 null —— 未知不能伪造。 */
    noteAttemptPid(attemptId: number, pid: number, startStamp: string | null): boolean {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false
      return atomic(() => {
        const a = attemptById.get(attemptId) as Attempt | undefined
        if (!a || !['queued', 'running'].includes(a.phase)) return false   /* 只记在跑的这单 */
        insertFencePid.run(attemptId, pid, startStamp ? String(startStamp) : null)
        return true
      })
    },
    /** ★1124：**工具启动意图** —— 在 `spawn()` 之前落一行（pid 未知）。
     *  这是"崩溃窗口"的结构性答案：pid 还没拿到就已经有账本事实，重启后不会被当成"没有残留"。
     *  只对**在跑的这单**记；已结算/已终态返回 null（调用方照常起进程，但会缺一条审计事实 ——
     *  与 `noteAttemptPid` 同一条口径：没记就是没记，不许假装记过）。 */
    beginProcIntent(attemptId: number, token: string, tool: string): number | null {
      if (!Number.isSafeInteger(attemptId) || attemptId <= 0) return null
      const text = String(tool || '').trim()
      if (!text) throw new Error('Proc intent needs a tool name')
      const key = String(token || '').trim()
      if (!key) throw new Error('Proc intent needs a token')
      return atomic(() => {
        const a = attemptById.get(attemptId) as Attempt | undefined
        if (!a || !['queued', 'running'].includes(a.phase)) return null
        const info = insertProcIntent.run(attemptId, key, text.slice(0, 200), Date.now())
        return Number(info.lastInsertRowid)
      })
    },
    /** 拿到 pid 就补上（只补还没补过的行）。返回 false = 没这行/已经补过，调用方如实留痕。 */
    bindProcIntent(attemptId: number, token: string, pid: number): boolean {
      if (!Number.isSafeInteger(attemptId) || attemptId <= 0) return false
      if (!Number.isSafeInteger(pid) || pid <= 0) return false
      const key = String(token || '').trim()
      if (!key) return false
      return atomic(() => Number(bindProcIntentPid.run(pid, key, attemptId).changes) > 0)
    },
    /** 进程结束 / 启动失败 → 这条意图作废（删行）。 */
    endProcIntent(token: string): boolean {
      const key = String(token || '').trim()
      if (!key) return false
      return atomic(() => Number(deleteProcIntentByToken.run(key).changes) > 0)
    },
    /** 这单名下**还没拿到 pid** 的意图（= 崩溃窗口留下的"未知副作用"）。 */
    unboundProcIntents(attemptId: number): Array<{ id: number; token: string; tool: string; at: number }> {
      return (unboundProcIntentRows.all(attemptId) as Array<{ id: number; attemptId: number; token: string; tool: string; at: number }>)
        .map(row => ({ id: Number(row.id), token: String(row.token), tool: String(row.tool), at: Number(row.at) }))
    },
    /** 这单名下全部意图（取证/诊断用）。 */
    procIntents(attemptId: number): Array<{ id: number; tool: string; at: number; pid: number | null }> {
      return (procIntentRows.all(attemptId) as Array<{ id: number; attemptId: number; token: string; tool: string; at: number; pid: number | null }>)
        .map(row => ({ id: Number(row.id), tool: String(row.tool), at: Number(row.at), pid: row.pid === null ? null : Number(row.pid) }))
    },
    /** 人工确认过"副作用清干净了" ⇒ 这些未知意图也随之结清（否则这一单永远放不出去）。 */
    clearProcIntents(attemptId: number): number {
      return atomic(() => Number(deleteProcIntentsByAttempt.run(attemptId).changes))
    },
    /** ★重启复核：对**已经 interrupted** 的 attempt 补登记围栏（不改 phase）。
     *  用途：进程被 SIGKILL 后重启，running 一律变 interrupted；但如果**预登记的 pid 里还有活的**，
     *  那就不只是"待人工对账"，而是"副作用确实可能还在" —— 必须挡住队列，等清理后再放。
     *  与 `holdFence` 的区别：那个要求 queued/running（首次发现残留），这个针对重启后的 interrupted。 */
    holdFenceOnInterrupted(attemptId: number, evidence: string, pids: Array<{ pid: number; startStamp?: string | null }>): boolean {
      return atomic(() => {
        const a = attemptById.get(attemptId) as Attempt | undefined
        if (!a || a.phase !== 'interrupted') return false
        insertFenceHold.run(attemptId, required(evidence, 8_000), Date.now())
        /* 只留**还活着**的那些（死掉的不该继续挂在围栏上） */
        deleteFencePids.run(attemptId)
        for (const p of pids) {
          const pid = Number(p?.pid)
          if (!Number.isSafeInteger(pid) || pid <= 0) continue
          insertFencePid.run(attemptId, pid, p?.startStamp ? String(p.startStamp) : null)
        }
        return true
      })
    },
    /** 这条 attempt 名下记过的所有 pid（含工具启动时预登记的）。 */
    attemptPids(attemptId: number): Array<{ pid: number; startStamp: string | null }> {
      return (fencePidRows.all() as Array<{ attemptId: number; pid: number; startStamp: string | null }>)
        .filter(row => Number(row.attemptId) === attemptId)
        .map(row => ({ pid: Number(row.pid), startStamp: row.startStamp }))
    },
    /** ★已按 OS 事实确认"副作用清理干净"的执行（证据，**不等于**人工核对过）。 */
    fenceReleases(): Array<{ attemptId: number; evidence: string; at: number }> {
      return (fenceReleaseRows.all() as Array<{ attemptId: number; evidence: string; at: number }>)
        .map(row => ({ attemptId: Number(row.attemptId), evidence: String(row.evidence), at: Number(row.at) }))
    },
    /** 当前所有未解除的围栏（以**Job 形状**返回：调度器的围栏端口与执行端口吃同一个对象）。 */
    fenceHolds(): Array<{ request: Request; attempt: Attempt; reason: string; pids: Array<{ pid: number; startStamp: string | null }> }> {
      const rows = fenceHoldRows.all() as Array<{ attemptId: number; requestId: number; reason: string }>
      const pidsByAttempt = new Map<number, Array<{ pid: number; startStamp: string | null }>>()
      for (const row of fencePidRows.all() as Array<{ attemptId: number; pid: number; startStamp: string | null }>) {
        const list = pidsByAttempt.get(row.attemptId) || []
        list.push({ pid: Number(row.pid), startStamp: row.startStamp })
        pidsByAttempt.set(row.attemptId, list)
      }
      const out: Array<{ request: Request; attempt: Attempt; reason: string; pids: Array<{ pid: number; startStamp: string | null }> }> = []
      for (const row of rows) {
        const attempt = attemptById.get(row.attemptId) as Attempt | undefined
        if (!attempt) continue
        out.push({ request: req(row.requestId), attempt, reason: row.reason, pids: pidsByAttempt.get(row.attemptId) || [] })
      }
      return out
    },
    /** ★围栏解除 = **只**证明"副作用已按 OS 事实清理干净"（两件事里的第一件）。
     *
     *  第十三轮补正（独立验收 R4）：这里以前同时写 recovery_review 并把 attempt 打成 failed ——
     *  那等于"OS 退出就替代了人工对账"，后单会在没人核对过旧执行的情况下开工。
     *  现在拆开：
     *    · 副作用已清理 → 删围栏 + 落 `fence_release`（证据），attempt **仍是 interrupted、仍待人工核对**；
     *    · 人工核对（`acknowledgeRecovery`）→ 才把 attempt 落成 failed 并解除"待对账"。
     *  两件事都成立，排队后单才允许开工（放行判据在 scheduler 的统一门里）。 */
    releaseFence(attemptId: number, evidence: string) {
      return atomic(() => {
        const held = fenceHoldFor.get(attemptId) as { reason: string } | undefined
        if (!held) throw new Error('No fence hold for this attempt')
        const a = attemptById.get(attemptId) as Attempt | undefined
        if (!a || a.phase !== 'interrupted') throw new Error('Fence hold must belong to an interrupted attempt')
        deleteFenceHold.run(attemptId)
        deleteFencePids.run(attemptId)
        insertFenceRelease.run(attemptId, required(evidence, 8_000), Date.now())
        return a
      })
    },
    acknowledgeRecovery(ids: number[], reviewer: string, evidence: string) {
      const actor = required(reviewer, 200)
      const note = required(evidence, 8_000)
      return atomic(() => {
        const pending = unresolvedInterrupts.all().map(row => Number(row.id))
        if (!Array.isArray(ids) || ids.length !== pending.length || [...ids].sort((a, b) => a - b).some((id, i) => id !== pending[i])) {
          throw new Error('V2 recovery set changed; refresh before confirming')
        }
        if (activeMembers.get()) throw new Error('V2 cannot acknowledge recovery with a running attempt')
        const now = Date.now()
        /* ★第十三轮补正：返回**真正核对过**的条数（原来返回的是"待核总数"，
           有围栏被跳过时会对用户谎报"已核对 N 条"—— 本轮 R2 取证时实测到 reviewed=1 而其实一条都没核）。 */
        let reviewed = 0
        for (const id of pending) {
          /* ★有未解除围栏 ⇒ 这条**不进人工核对阶段**（独立验收拍板：分阶段结算）。
             围栏是"副作用仍不确定"的另一条事实，不能被人工恢复确认覆盖；
             它必须继续留在待核列表里，直到围栏探针按 OS 事实证明进程已退
             （`releaseFence` 写 fence-probe 那条核对记录）。 */
          const a = attemptById.get(id) as Attempt | undefined
          if (fenceHoldFor.get(id)) continue
          saveRecoveryReview.run(id, actor, note, now)
          reviewed++
          /* 无围栏的普通崩溃：核对完就转 failed（可重派），否则它既不能 rework 也不能重派，
             会永远挂在待核里 —— 用户只能看着一条永远不能动的单。 */
          if (a && a.phase === 'interrupted') {
            advance(a, 'failed', null, `崩溃核对：产物未交付（已人工确认，可重派）· ${note}`.slice(0, 8_000))
          }
        }
        return reviewed
      })
    },
    start(requestId: number, attemptId: number, workspace?: string): Attempt {
      return atomic(() => {
        const a = current(requestId, attemptId, 'queued')
        /* 阶段3：开工时**重核依赖** —— 挑单过滤之后前置可能已改版/被取消，不能拿挑单那一刻的判断当准。 */
        const blocked = dependencyBlocked(requestId)
        if (blocked) throw new Error(`V2 request is blocked by dependency: ${blocked}`)
        if (working.get(a.memberId)) throw new Error('Member already running a team attempt')
        if (workspace !== undefined) workspaceInsert.run(a.id, required(workspace, 4096))
        return advance(a, 'running')
      })
    },
    submit(requestId: number, attemptId: number, artifact: string, report?: string): Attempt {
      return atomic(() => {
        const attempt = current(requestId, attemptId, 'running')
        const ref = required(artifact, 500)
        if (report !== undefined || ref.startsWith(MEMBER_REPORT_FORMAT + ':')) {
          if (typeof report !== 'string' || !matchesMemberReport(ref, report)) throw new Error('Invalid durable member report')
          insertReport.run(attemptId, report)
        }
        return advance(attempt, 'submitted', ref)
      })
    },
    /** ★正式交付的**唯一原子入口**：报告落库 + attempt 结算 + 该报告已处理的收件归属，
     *  在**同一个事务**里要么一起成立、要么一起不成立。
     *
     *  为什么必须合并（独立验收的账本反例）：原来先 `submit()` 再单独 `consumeNotes()`，
     *  两步之间掉电 ⇒ 报告已交付、收件却还挂着 pending ⇒ 重派会**把已经交付过的补充再投一遍**。
     *  反过来（先消费后提交）更糟：收件被吃掉、报告没交付 ⇒ 补充永久丢失。
     *  合并事务之后只有一个事实：**这份报告 + 它处理过的补充**一起生效。
     *
     *  边界：只消费 `noteIds` 里明确列出的（同一需求、同一版本、这次尝试确实处理过的），
     *  不跨版本消费、不从历史正文捞结果、不缺省清空收件箱。 */
    submitWithNotes(requestId: number, attemptId: number, artifact: string, report: string | undefined, noteIds: number[]): Attempt {
      return atomic(() => {
        const attempt = current(requestId, attemptId, 'running')
        const ref = required(artifact, 500)
        if (report !== undefined || ref.startsWith(MEMBER_REPORT_FORMAT + ':')) {
          if (typeof report !== 'string' || !matchesMemberReport(ref, report)) throw new Error('Invalid durable member report')
          insertReport.run(attemptId, report)
        }
        const sent = advance(attempt, 'submitted', ref)
        /* 只消费调用方明确列出、且**属于这一单、这一版**的收件。
           ★注意：收件的 `attemptId` 是**原始来源**（当初投递它的那次尝试），不是这次交付的身份 ——
           同版本重派（attempt 1 的补充接续到 attempt 2）是合法且必须支持的，所以这里校验的是
           「同一需求 + 同一版本」，不是「同一 attempt」。保留原始来源不改写。 */
        const currentRevision = req(requestId).revision
        for (const id of noteIds) {
          const row = noteById.get(id) as { requestId?: number; attemptId?: number } | undefined
          if (!row || Number(row.requestId) !== requestId) {
            throw new Error(`Refusing to consume note ${id} that does not belong to request #${requestId}`)
          }
          const origin = attemptById.get(Number(row.attemptId)) as Attempt | undefined
          if (!origin || origin.revision !== currentRevision) {
            throw new Error(`Refusing to consume note ${id} from another revision (note @rev ${origin?.revision}, request @rev ${currentRevision})`)
          }
          consumeNote.run(id)
        }
        return sent
      })
    },
    readDurableReport(attemptId: number, artifact: string): string | null {
      const report = getReport.get(attemptId, artifact)?.report
      return typeof report === 'string' && matchesMemberReport(artifact, report) ? report : null
    },
    fail(requestId: number, attemptId: number, evidence: string): Attempt {
      return atomic(() => {
        /* 失败可以发生在**开工前**（授权已失效 / 工作区变了 —— 没有任何副作用）：
           queued→failed 与 running→failed 是同一件事（这次尝试结束、用户可重派），
           校验强度不变：必须是这一单的最新尝试、版本没变、且还没进终态。 */
        const a = latest(requestId)
        if (!a || a.id !== attemptId || a.requestId !== requestId || a.revision !== req(requestId).revision || !['queued', 'running'].includes(a.phase)) {
          throw new Error('Stale or invalid team attempt')
        }
        return advance(a, 'failed', null, required(evidence, 8_000))
      })
    },
    /** Only the future validator bridge should call this, never a model-set completion checkbox. */
    verify(requestId: number, attemptId: number, artifact: string, passed: boolean, evidence: string): Attempt {
      return atomic(() => {
        const a = current(requestId, attemptId, 'submitted')
        if (a.artifact !== artifact || typeof passed !== 'boolean') throw new Error('Invalid team verification receipt')
        return advance(a, passed ? 'accepted' : 'rejected', a.artifact, required(evidence, 8_000))
      })
    },
    checkFile(requestId: number, attemptId: number, artifact: string, read: (workspace: string) => TeamFileCheck) {
      return atomic(() => {
        const attempt = latest(requestId)
        if (!attempt || attempt.id !== attemptId || attempt.revision !== req(requestId).revision || attempt.artifact !== artifact || !['submitted', 'accepted', 'rejected'].includes(attempt.phase)) {
          throw new Error('V2 file check requires the current report receipt')
        }
        const workspace = workspaceFor.get(attemptId)?.root
        if (typeof workspace !== 'string') throw new Error('This execution did not record a workspace; it cannot be verified')
        const result = read(workspace)
        return recordCheck.get(attemptId, workspace, result.relativePath, result.expected, result.actual, result.bytes, Date.now(), result.outcome)
      })
    },
    /** ★1124：每个成员最近一单（换段判据 / status 投影共用同一份账本事实）。 */
    recentByMember() { return recentAttemptByMember.all() },
    stageReport(afterId = 0) {
      if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('Invalid team stage report cursor')
      const limit = 6
      const requests = page.all(afterId, limit + 1) as Request[]
      const items = requests.slice(0, limit).map(r => {
        const { phase, attempt, fileCheck } = project(r)
        const review = attempt?.artifact ? latestBoundReview.get(attempt.id, attempt.artifact, fileCheck?.id ?? null) : undefined
        const result = review ? JSON.parse(String(review.result)) as ReviewExecution : undefined
        return {
          requestId: r.id, revision: r.revision, title: r.title, phase, memberId: attempt?.memberId,
          lastFileCheck: fileCheck ? { outcome: fileCheck.outcome, checkedAt: fileCheck.checkedAt } : null,
          independentReview: result?.status === 'opinion' ? result.opinion.status : null,
        }
      })
      return {
        counts: currentPhaseCounts.all(), items, members: recentAttemptByMember.all(),
        nextAfterId: requests.length > limit ? requests[limit - 1].id : null,
      }
    },
    /** Settles the given batches, or — with no argument — every batch a restart may have missed.
     * One BEGIN IMMEDIATE covers settlement + its attempt list + the report record, so a crash
     * leaves either nothing (the next settlement recomputes from attempt rows) or the whole set.
     * A repeat call hits UNIQUE(batchId, attemptKey) and adds nothing — never a second report. */
    settleStages(batchIds?: number[]): number {
      if (batchIds !== undefined && (!Array.isArray(batchIds) || batchIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
        throw new Error('Invalid team stage batch selection')
      }
      return atomic(() => {
        const settledAt = Date.now()
        const targets = batchIds ?? (candidateBatches.all() as Array<{ batchId: number }>).map(row => row.batchId)
        let created = 0
        for (const batchId of targets) if (settleBatch(batchId, settledAt)) created++
        return created
      })
    },
    /** Read port: settlement facts are stored, standing comes from attempt rows right now. */
    stageSettlements(afterId = 0, limit = 20) {
      if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('Invalid team stage cursor or limit')
      }
      const rows = settlementPage.all(afterId, limit + 1) as StageSettlementRow[]
      const items = rows.slice(0, limit).map(settlementView)
      return { items, nextAfterId: rows.length > limit ? rows[limit - 1].id : null }
    },
    /** Stages settled after `afterSettlementId` that were never delivered, oldest first.
     * `afterSettlementId` is the watermark captured when auto reporting was switched on — an
     * ordering fact, so a stage settled in the same millisecond *before* the switch still counts
     * as backlog and is never delivered. */
    pendingStageReports(afterSettlementId: number, limit = 20) {
      if (!Number.isSafeInteger(afterSettlementId) || afterSettlementId < 0) throw new Error('Invalid team stage report watermark')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid team stage report limit')
      const rows = pendingReportPage.all(afterSettlementId, limit) as StageSettlementRow[]
      return rows.map(settlementView)
    },
    /** Current settlement watermark: switching auto reporting on starts after this id. */
    latestSettlementId(): number { return Number((latestSettlement.get() as { id: number }).id) },
    stageTotals() { return stageTotalsRow.get() as { settlements: number; pendingReports: number; deliveredReports: number } },
    /** Whether this settlement still needs its delivery record written (reconciliation reads it). */
    stageReportPending(settlementId: number): boolean {
      const row = stageReportFor.get(settlementId) as StageReportRecord | undefined
      if (!row) throw new Error('Team stage report not found')
      return row.state === 'pending'
    },
    /** Only a message that really landed may close a report record; there is no "assume sent". */
    markStageReportDelivered(settlementId: number, deliveredMessageId: string) {
      const messageId = required(deliveredMessageId, 200)
      return atomic(() => {
        const delivered = deliverStageReport.get(messageId, settlementId) as StageReportRecord | undefined
        if (delivered) return delivered
        const current = stageReportFor.get(settlementId) as StageReportRecord | undefined
        if (!current) throw new Error('Team stage report not found')
        // Replay of the same real message (reconnect) is the same delivery; a different one is not.
        if (current.deliveredMessageId === messageId) return current
        throw new Error('Team stage report was already delivered by a different message')
      })
    },
    pendingReviewChoices() { return pendingReviews.all() as Array<{ id: number; title: string }> },
    reviewCandidate(requestId: number) { return project(req(requestId)) },
    recordReview(receipt: ReviewReceipt, fileCheckId: number | null, result: ReviewExecution) {
      return atomic(() => recordReview.run(receipt.attemptId, receipt.artifact, fileCheckId, Date.now(), JSON.stringify(result)))
    },
    reviewExecutions(attemptId: number) {
      return reviewExecutions.all(attemptId).map(row => ({ ...row, result: JSON.parse(String(row.result)) as ReviewExecution }))
    },
    /** C 的账本（`review_execution`）按工单切开：一次实际调用一行，含该次真实模型身份与用量回执。
     * 只读投影，不重算、不补 0；归属走 attempt → requestId。 */
    verificationRecords() {
      return (verificationRows.all() as Array<{ requestId: number; result: string }>).map(row => {
        const result = JSON.parse(String(row.result)) as ReviewExecution
        return {
          requestId: Number(row.requestId),
          providerId: result.providerId,
          model: result.model,
          status: result.status,
          usage: result.usage,
        }
      })
    },
    list() { return (list.all() as Request[]).map(project) },
    sourceMessageIds() { return sources.all().map(row => String(row.messageId)) },
    /* ★1124b（老板：「倒序加载却从最老的一头开始」）：**列表最新优先，排序只在这里定**。
       `beforeId` = 上一页返回的 `nextBeforeId`（本页最小 id）；首次传 null 表示从最新一条开始往回。
       前端不再自己 sort —— 工单顺序跟轮序一样，只认后端。 */
    page(beforeId: number | null, limit: number, messageId?: string) {
      if ((beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId < 1)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('Invalid team work page cursor or limit')
      }
      const cursorId = beforeId ?? Number.MAX_SAFE_INTEGER
      const rows = (messageId === undefined ? pageDesc.all(cursorId, limit + 1) : pageForSourceDesc.all(required(messageId, 200), cursorId, limit + 1)) as Request[]
      return { items: rows.slice(0, limit).map(project), nextBeforeId: rows.length > limit ? rows[limit - 1].id : null }
    },
    attempts(requestId: number) { req(requestId); return attempts.all(requestId) as Attempt[] },
    /** ★1124：按 attemptId 单查（中断单合并沙箱产物时要看它有没有 artifact）。 */
    attemptById(attemptId: number) { return attemptByIdStmt.get(attemptId) as Attempt | undefined },
    /** ★1124：这一单的执行工作区（双槽下是 <父工作区>/.nis-attempts/<id>）。 */
    workspaceOf(attemptId: number) { const row = workspaceFor.get(attemptId) as { root?: string } | undefined; return row?.root },
    /** Execution facts only. Not the UI's combined roster (which also includes member DMs). */
    runningMembers() { return activeMembers.all() as Array<{ memberId: string; requestId: number; attemptId: number }> },
    close() { db.close() },
  }
}
