/**
 * 团队存储 —— 文件夹制落盘（可拆装 + 隔离），与 Agent 预设同心智。
 *
 * 目录：backend/data/teams/<id>/team.json
 * 结构：{ id, name, description, mainPreset, mode, blackboard, members[], createdAt, schemaVersion }
 * 校验：成员 1-20（`MAX_MEMBERS`）；成员 preset 必须引用"自定义预设"（builtin 拒绝入队）；modelMode=independent 时 modelId 必填。
 * 首次启动：teams 目录为空时写入示例团队 software-dev-team（前端/后端/测试三人组）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from './paths.ts'
import { readAgentPreset } from './agentPresetsStore.ts'
import { loadJsonOrBackup, writeJsonAtomic } from './jsonStore.ts'

export const TEAMS_DIR = path.join(DATA_ROOT, 'teams')

// Commit-side read model: status frames never invoke the migrating team-file reader.
const memberRosters = new Map<string, ReadonlyMap<string, object>>()
export function readTeamMemberRoster(id: string): ReadonlyMap<string, object> | undefined {
  return memberRosters.get(id)
}
function recordMemberRoster(team: { id: string; members: ReadonlyArray<{ id: string }> }): void {
  const ids = Array.isArray(team.members) ? team.members.map(member => member?.id) : undefined
  if (!ids || ids.some(id => typeof id !== 'string' || !id.trim() || /^clone\d+$/i.test(id)) || new Set(ids).size !== ids.length) {
    memberRosters.delete(team.id)
    return
  }
  const previous = memberRosters.get(team.id)
  memberRosters.set(team.id, new Map(ids.map(id => [id, previous?.get(id) ?? {}])))
}

export interface TeamMember {
  id: string
  type: 'preset'
  preset: string
  role?: string
  modelMode: 'shared' | 'independent'
  modelId?: string
  /** 0910：成员独立模型的推理挡位（缺省 deep=原行为；后端 createStreamFn 按模型能力钳位） */
  effort?: string
  /** ★1032（P71）：成员模式 —— default(默认) / plan(只出计划) / execute(直接执行) / readonly(只读)。缺省 default。 */
  mode?: 'default' | 'plan' | 'execute' | 'readonly'
  /** ★1036：**显示名**（「前端工程师#1」这类）——由 `assignMemberNames` 统一生成。
   *  分身场景早就在用这个字段（cloneRuntime 造的成员带 name），这里只是正式建档。
   *  ★1032-TM（P101）：**这个字段不允许为空** —— 名字是成员的一等属性（面板、段首头像、派活回执都用它），
   *  以前"只有同预设 ≥2 个才补名"，单个成员永远是空、全靠显示层猜预设名（老大："不要兜底"）。
   *  现在写侧保证：新增成员即生成，见 `assignMemberNames`。 */
  name?: string
  /** ★1032-TM（P101）：这个名字是**系统按预设自动生成的**（true）还是**用户手填的**（false/缺省）。
   *  规则只有一条：自动名会跟着预设/同名数量重算（换预设、加人自动改号）；手填名一辈子不动。
   *  以前没有这个标记 ⇒ 只能靠"名字是否为空"判，用户一旦填过名就再也不会自动更新（换预设名不跟着变）。 */
  nameAuto?: boolean
  /** @deprecated ★1036：同一成员同时派几次 —— **机制已取消**（成员就是一个人）。
   *  存量 JSON 里可能还有这个字段，读取时会被 `normalizeMembers` 展开成多条成员并丢弃它。 */
  maxInstances?: number
  skills?: string[]
}

export interface TeamDef {
  id: string
  name: string
  description: string
  mainPreset: string
  mode: 'auto' | 'serial' | 'parallel'
  blackboard: boolean
  /** @deprecated ★tw8：`maxParallel` **已删除**（teamRuntime 一次都没读过它 —— 1104-H 后
   *  每名成员一条串行车道，"并行上限"就是成员数）。存量 team.json 里残留的这个字段由
   *  `migrateTeam` 静默剥掉：**忽略、不报错、不动成员**（老板已存的团队不能被读坏）。 */
  members: TeamMember[]
  createdAt?: number
  /** ★1036：数据模型版本（见 `TEAM_SCHEMA`）。缺省=旧结构，读盘时会被 `migrateTeam` 一次性迁移并落盘。 */
  schemaVersion?: number
}

const MODES = ['auto', 'serial', 'parallel']
/** 成员推理挡位白名单（与前端 ReasoningModeBtn/EffortSlider 的挡位值一致） */
const EFFORTS = ['fast', 'deep', 'heavy', 'burning']
/** ★t2（1104）：effort 的**空值语义归一** —— undefined / null / '' / 纯空白 一律 = 「未指定挡位」(undefined)。
 *  **只归一空值**：非空值原样返回（trim 后），合不合法交给调用方按白名单判 —— 绝不在这里补默认值/兜底。 */
function normalizeEffort(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}
/** 0910 三批②：成员模型能力档位（供主 agent 按任务难度匹配派活；auto=由系统按模型能力自动识别） */
/** 成员数量上限（★1036：8 → 20，需求——「成员就是人」，同预设可以有多个人） */
const MAX_MEMBERS = 20
/* ★1036（需求）：`maxInstances`（同一成员同时派几次）**这个机制取消** ——
   成员就是一个人，想要三个人就在成员列表里配 #1/#2/#3（各自独立上下文）。
   存量配置里 maxInstances>1 的，读取时按数量**展开成多条成员**（见 `normalizeMembers`），
   不丢原来配的并行意图。 */

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/

function teamPath(id: string): string {
  return path.join(TEAMS_DIR, id, 'team.json')
}

function sanitizeId(name: string): string {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return slug || 'team-' + Date.now().toString(36)
}

/** 校验（含成员预设白名单：必须引用自定义预设）。返回错误信息，null=合法 */
function validateTeam(t: any): string | null {
  if (!t || typeof t !== 'object') return 'team 必须是对象'
  if (typeof t.name !== 'string' || !t.name.trim()) return 'name 不能为空'
  if (t.mode !== undefined && !MODES.includes(t.mode)) return `mode 只能是 ${MODES.join('/')}`
  if (t.mainPreset !== undefined) {
    const mp = readAgentPreset(String(t.mainPreset))
    if (!mp) return `主 agent 预设不存在：${t.mainPreset}`
    if (!mp.builtin) return `主 agent 预设必须是内置预设（当前团队指挥官为内置 team-lead）`
  }
  if (!Array.isArray(t.members)) return 'members 必须是数组'
  if (t.members.length < 1) return '至少需要 1 名成员'
  if (t.members.length > MAX_MEMBERS) return `成员最多 ${MAX_MEMBERS} 名（防 token 爆炸）`
  const memberIds = new Set<string>()
  for (const m of t.members) {
    if (!m || typeof m !== 'object') return '成员必须是对象'
    if (m.id) {
      if (memberIds.has(m.id)) return '成员 id 重复'
      memberIds.add(m.id)
    }
    const preset = readAgentPreset(String(m.preset || ''))
    if (!preset) return `成员引用的预设不存在：${m.preset}`
    if (preset.builtin) return `内置预设「${preset.name}」不能作为团队成员——只能用自定义预设组队（可从内置复制）`
    if (m.modelMode === 'independent' && !String(m.modelId || '').trim()) {
      return `成员「${preset.name}」选择了独立模型，必须指定 modelId`
    }
    /* ★t2（1104）：effort 空值语义归一 —— undefined / null / '' / 纯空白 都表示「未指定挡位」，
       **不进入白名单校验**。这是语义归一，不是放宽：空串本来就不代表任何挡位
       （前端历史行为是把 undefined 兜成 ''，才让"编辑过的团队第二次保存必被拒"）。
       只归一空值 —— 非空值照样必须是合法挡位，**不叠默认值、不把非法值静默改成 deep**。 */
    const memberEffort = normalizeEffort(m.effort)
    if (memberEffort !== undefined && !EFFORTS.includes(memberEffort)) {
      return `成员「${preset.name}」的推理挡位不合法：${m.effort}（可用 ${EFFORTS.join('/')}）`
    }
    /* ★1036：`maxInstances` 校验已删 —— 机制取消（成员就是人，想要多个人就配多条成员）。
       存量字段由 `expandLegacyInstances` 在迁移时展开并丢弃。 */
  }
  /* ★tw8：`maxParallel` 的校验已删 —— 字段本身取消（1104-H 后每人一条车道，并行上限 = 成员数）。
     **「最多 20 名成员」的上限仍然在**（见上面 `MAX_MEMBERS` 对 `members.length` 的校验，别误删）；
     老 team.json 里残留的 maxParallel 不再校验、不再报错，读盘时由 `migrateTeam` 静默剥离。 */
  return null
}

export function listTeams(): TeamDef[] {
  const out: TeamDef[] = []
  try {
    if (!fs.existsSync(TEAMS_DIR)) return out
    for (const d of fs.readdirSync(TEAMS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      try {
        const r = loadJsonOrBackup<any>(teamPath(d.name), () => null)
        if (r.degraded) console.error(`[teams] ${d.name}/team.json 坏档已备份为 .corrupt-*，已跳过（原档可捞）`)
        const t = r.data
        /* ★1036：列表也必须走同一个迁移（否则 `listTeams` 拿到旧结构、`readTeam` 拿到新结构 = 双轨） */
        if (t && t.id === d.name) out.push(migrateTeam(t))
      } catch { /* skip */ }
    }
  } catch (e) {
    console.error('[teams] list failed:', e)
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

/**
 * ★1036 数据模型版本。**迁移只发生一次、且落盘**（不在读取路径上反复翻译 —— 那等于双轨）。
 *   1 → 2：`maxInstances`（同一成员同时派几份）取消，改为「成员就是人」；
 *          存量按数量展开成多条成员；同预设多名自动编号 #1/#2/…
 *   2 → 3（P101）：`name` 从"可以空"变成**必须由系统生成**（空 ⇒ 预设名；同名多个 ⇒ #1/#2），
 *          并打 `nameAuto:true` 标记。理由：单个成员的 name 一直是空、全靠显示层猜预设名
 *          （老大："不要兜底"）。这一版把老数据补齐并落盘，之后读侧不再需要猜。
 */
const TEAM_SCHEMA = 3

/** 把旧模型展开成新模型（**只在迁移时**调用一次）：
 *  `maxInstances > 1` ⇒ 复制成多条成员（各自独立 id），并丢掉该字段。
 *  ⚠️ 非法值（负数/小数/非数字）**不静默夹取**：按 1 处理并打日志 —— 静默夹取会让配置错误永远看不见。 */
function expandLegacyInstances(members: any[]): TeamMember[] {
  const out: TeamMember[] = []
  for (const raw of (Array.isArray(members) ? members : [])) {
    if (!raw || typeof raw !== 'object') continue
    const base: any = { ...raw }
    const rawN = base.maxInstances
    delete base.maxInstances
    let count = 1
    if (rawN !== undefined) {
      const n = Number(rawN)
      if (Number.isInteger(n) && n >= 1) count = Math.min(n, MAX_MEMBERS)
      else console.warn(`[teams] 成员 ${String(base.id || '?')} 的 maxInstances 非法（${String(rawN)}），迁移时按 1 处理`)
    }
    for (let k = 1; k <= count; k++) {
      const m: any = { ...base }
      if (k > 1) {
        /* 展开出来的第 2、3 份必须有**独立 id**（否则派活 / 黑板 owner 全撞在一起） */
        const root = String(base.id || 'm')
        let candidate = `${root}-${k}`
        let dup = 2
        while (out.some(x => x.id === candidate)) candidate = `${root}-${k}-${dup++}`
        m.id = candidate
      }
      out.push(m)
    }
  }
  return out
}

/** 成员的**显示名**分配（★1032-TM P101 重写）。
 *  规则只有两条：
 *   ① **用户手填的名字（`nameAuto !== true` 且非空）一律不动** —— 用户命名优先；
 *   ② 其余全部由系统生成：同预设 ≥2 个 ⇒ `预设名#1/#2/…`，只有 1 个 ⇒ `预设名`，并打上 `nameAuto:true`。
 *  为什么要改（原来的实现）：只有"同预设 ≥2 个"才补名 ⇒ 单个成员的 `name` 永远是空，
 *  面板/段首头像/派活回执全靠"显示时回退到预设名"——老大原话："不要兜底"。
 *  现在**写侧保证 name 不空**，读侧不再需要猜；加第 6、第 7 个成员（m6/m7）也一样自动有名字。
 *  ⚠️ 纯展示名，不参与任何判据 —— 派活 / 黑板一律按 `id`，绝不按名字匹配。 */
function assignMemberNames(members: TeamMember[]): void {
  const byPreset = new Map<string, TeamMember[]>()
  for (const m of members) {
    const p = String(m.preset || '')
    const arr = byPreset.get(p) || []
    arr.push(m)
    byPreset.set(p, arr)
  }
  for (const [presetId, list] of byPreset) {
    const presetName = readAgentPreset(presetId)?.name || presetId
    list.forEach((m, i) => {
      /* ① 用户手填的名字：跳过（不覆盖、也不打 nameAuto） */
      if (String(m.name || '').trim() && m.nameAuto !== true) return
      m.name = list.length > 1 ? `${presetName}#${i + 1}` : presetName
      m.nameAuto = true
    })
  }
}

/** 给一批成员补齐 id —— **唯一实现**（`saveTeam` 落盘前与 `teams.assignMemberIds` RPC 共用）。
 *
 *  规则（★1032-TM P100 定案，别改）：**最小空闲编号** m1/m2/m3…，不看数组下标。
 *   · 已带 id 的成员**原样保留**（id 是身份，永不重排、永不改写）；
 *   · 无 id 的按**数组顺序**依次拿"下一个没人用的 mN"。
 *  为什么不用 `${'m'+(i+1)}`：删掉中间一个再新增会跳号（看着像少了个人）；存量还有 `m1-2` 这类遗留 id。
 *
 *  ⚠️ **纯函数**：不读磁盘、不写磁盘、不改全局状态、不碰 name/effort 归一化（那些是 saveTeam 的活）。
 *  ⚠️ 为什么要抽出来：前端新增成员时要在**保存之前**就把序号显示出来，且必须与落盘后的编号一字不差；
 *     若前端自己按数组长度 +1 猜，删过成员就会猜错。分配权只能在后端（老板铁律：后端是唯一源）。 */
export function assignMemberIds<T extends { id?: string }>(members: T[]): T[] {
  const used = new Set<string>()
  for (const m of members) { const id = String((m as any)?.id || ''); if (id) used.add(id) }
  let next = 1
  return members.map((m) => {
    if (String((m as any)?.id || '')) return m
    while (used.has(`m${next}`)) next++
    const id = `m${next}`
    used.add(id)
    next++
    return { ...m, id }
  })
}

/** 读盘后的**一次性迁移**：旧 schema ⇒ 展开 + 编号 ⇒ 打版本 ⇒ 写回磁盘。
 *  写回失败不回滚内存结果（下次读会重试迁移），但必须留痕暴露。 */
function migrateTeam(t: any): any {
  if (!t) return t
  /* ★1032（P71）：**「模型档位」功能已删除** —— 存量 team.json 里的 capability 在这里清掉，
     并写回磁盘（幂等：没有该字段就不写）。不做这件事的话，界面上没有了、数据里还在，下次谁读都以为它还有用。 */
  let _stripped = false
  for (const m of (Array.isArray(t.members) ? t.members : [])) {
    if (m && Object.prototype.hasOwnProperty.call(m, 'capability')) { delete m.capability; _stripped = true }
  }
  /* ★tw8：**「最大并行」字段已删除** —— 存量 team.json 里还有的话在这里剥掉（与 capability 同一套
     幂等机制：没有该字段就不写盘）。只删这一个字段、成员与其它字段原样保留；**不报错**。 */
  if (Object.prototype.hasOwnProperty.call(t, 'maxParallel')) { delete t.maxParallel; _stripped = true }
  if (Number(t.schemaVersion) >= TEAM_SCHEMA) {
    if (_stripped) {
      try { writeJsonAtomic(teamPath(String(t.id)), t) } catch (e: any) {
        console.error(`[teams] ${String(t.id)} 清理废弃字段写盘失败（内存已清，下次读重试）：${e?.message || e}`)
      }
    }
    return t
  }
  const beforeCount = (Array.isArray(t.members) ? t.members : []).length
  t.members = expandLegacyInstances(t.members)
  /* v2 → v3：把**空的 name 全部补上**（预设名 / 预设名#N）并打 nameAuto。
     这一步只跑一次，之后写侧保证不空；读侧那条"空 → 预设名"的降级从此只会出现在坏数据上。 */
  assignMemberNames(t.members)
  t.schemaVersion = TEAM_SCHEMA
  console.log(`[teams] ${String(t.id)} 迁移到 schema ${TEAM_SCHEMA}：成员 ${beforeCount} → ${t.members.length}，名字已补齐`)
  try {
    writeJsonAtomic(teamPath(String(t.id)), t)
  } catch (e: any) {
    console.error(`[teams] ${String(t.id)} 迁移结果写盘失败（内存已用新结构，下次读重试）：${e?.message || e}`)
  }
  return t
}

export function readTeam(id: string): TeamDef | null {
  if (!ID_RE.test(id)) return null
  try {
    const r = loadJsonOrBackup<any>(teamPath(id), () => null)
    const t = r.data
    if (!t || t.id !== id) return null
    /* ★1036：旧 schema 在这里**一次性迁移并落盘**，之后全系统只认新结构 */
    return migrateTeam(t)
  } catch {
    return null
  }
}

/** 保存（创建/更新）。id 为空时从 name 生成（保证唯一） */
export function saveTeam(input: any): { ok: true; team: TeamDef } | { ok: false; error: string } {
  let id = String(input?.id || '').trim()
  if (!id) {
    const base = sanitizeId(input?.name)
    let n = 1
    id = base
    while (readTeam(id)) id = `${base}-${++n}`
  }
  if (!ID_RE.test(id)) return { ok: false, error: 'id 不合法（2-48 位小写字母/数字/连字符）' }
  const existing = readTeam(id)
  const team: TeamDef = {
    id,
    name: String(input?.name || '未命名团队').trim().slice(0, 40),
    description: String(input?.description || '').trim().slice(0, 200),
    mainPreset: String(input?.mainPreset || 'team-lead'),
    mode: MODES.includes(input?.mode) ? input.mode : 'auto',
    blackboard: input?.blackboard !== false,
    members: Array.isArray(input?.members) ? input.members : [],
    createdAt: existing?.createdAt || Date.now(),
    /* ★1036：落盘即新模型 —— 前端不再发 maxInstances，这里也不接受"半旧"结构 */
    schemaVersion: TEAM_SCHEMA,
  }
  /* 成员补 id —— ★1032-TM（P100）：**用最小空闲编号**（m1/m2/m3…），不再按数组下标补。
     原来的 `${m.id || 'm' + (i+1)}` 有两个问题：
       · 删掉中间一个成员再新增，下标会把新人补成 m5（跳号），看着像"少了一个人"；
       · 存量还有 `m1-2` 这种"同预设展开"的遗留 id（schema 1→2 时生成），与"一人一个 id"的新模型不符。
     现在：id 是成员的身份（派活/黑板/成员状态都按它），生成规则必须是"下一个没人用的 mN"。 */
  {
    /* ★t2（1104 返工）：effort 的**整表替换语义** —— 来件没带 effort 就是没带，不代猜旧值。
       上面的 `members` 直接取来件整表，**不做**"按 id / 数组位置去旧档捞 effort 回填"：
       删成员/换序时那样会把 B 的挡位张冠李戴给 A，那是猜测不是事实（老板铁律：不猜、禁兜底）。三件事分开：
         · 键不存在 = 这次没提供 ⇒ 就是没有（不继承、不兜底）；
         · 键存在但值为空（undefined/null/''/纯空白）⇒ 删键，不落盘空串；
         · 键存在且非空 ⇒ trim 后原值落盘（合法性由 validateTeam 白名单判，这里不叠默认值、不改写）。 */
    /* id 分配走**唯一实现** `assignMemberIds`（与 teams.assignMemberIds RPC 同一份代码）。
       顺序仍是「先分 id、再处理 effort」，与抽函数前逐字节一致。 */
    const _rawMembers = team.members          // 原始来件快照（下面要按位置回查 effort）
    const _withIds = assignMemberIds(_rawMembers)
    team.members = _withIds.map((m, i) => {
      const copy: any = { ...m }
      delete copy.maxInstances   // 机制已取消：存量字段一律不带进新结构
      if (Object.prototype.hasOwnProperty.call(_rawMembers[i], 'effort')) {
        const eff = normalizeEffort(copy.effort)
        if (eff === undefined) delete copy.effort   // 显式未指定 = 没有这个键，不写 ''
        else copy.effort = eff                      // 非空原值落盘
      } else {
        delete copy.effort                          // 来件没带这个键 = 没提供，不继承旧档、不猜
      }
      return copy
    })
  }
  assignMemberNames(team.members)
  const err = validateTeam(team)
  if (err) return { ok: false, error: err }
  try {
    fs.mkdirSync(path.dirname(teamPath(id)), { recursive: true })
    writeJsonAtomic(teamPath(id), team)
    recordMemberRoster(team)
    return { ok: true, team }
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || e}` }
  }
}

export function deleteTeam(id: string): string | null {
  if (!ID_RE.test(id)) return 'id 不合法'
  const dir = path.join(TEAMS_DIR, id)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    memberRosters.delete(id)
    return null
  } catch (e: any) {
    return `删除失败：${e?.message || e}`
  }
}

/** 首次启动：teams 目录为空时写入示例团队（前端/后端/测试三人组，可编辑或删除） */
export function initTeams(): void {
  try {
    fs.mkdirSync(TEAMS_DIR, { recursive: true })
    const teams = listTeams()
    for (const team of teams) recordMemberRoster(team)
    if (teams.length > 0) return
    const sample = {
      id: 'software-dev-team',
      name: '软件开发小组',
      description: '示例团队：前端/后端/测试三人组，适合网站与软件产品开发。主指挥官拆解需求，前端与后端并行实现，测试工程师最后验收。',
      mainPreset: 'team-lead',
      mode: 'auto',
      blackboard: true,
      members: [
        { id: 'm1', type: 'preset', preset: 'frontend-dev', role: '', modelMode: 'shared', modelId: '', skills: [] },
        { id: 'm2', type: 'preset', preset: 'backend-dev', role: '', modelMode: 'shared', modelId: '', skills: [] },
        { id: 'm3', type: 'preset', preset: 'qa-tester', role: '', modelMode: 'shared', modelId: '', skills: [] },
      ],
      createdAt: Date.now(),
    }
    fs.mkdirSync(path.dirname(teamPath(sample.id)), { recursive: true })
    fs.writeFileSync(teamPath(sample.id), JSON.stringify(sample, null, 2) + '\n', 'utf-8')
    recordMemberRoster(sample)
    console.log(`[teams] seeded sample team: ${sample.id}`)
  } catch (e) {
    console.error('[teams] init failed:', e)
  }
}
