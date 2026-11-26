/**
 * 工具唯一事实源（0904 工具系统捋顺）
 *
 * 背景：此前"仓库"(PluginsModal SYSTEM_TOOL_GROUPS)、"预设可选"(本文件旧版 39 条)、
 * "真实挂载"(server.ts 组装) 是三份各写各的清单，加新工具要人肉同步三处；且旧版
 * project_read/write/delete/run 四条名字全错（真实为 project_fs_read/project_fs_write/
 * project_fs_delete/project_run_command），list_tools 把假名喂给 AI 导致照名调用必失败。
 *
 * 现在：本文件是**唯一源**——静态定义全部内置工具（与 server.ts 真实挂载一一对应），
 * buildToolRegistry() 运行时合并 MCP/自定义工具；agentPreset.tools RPC 与 list_tools 都读它；
 * 前端仓库/预设编辑器都从 RPC 投射。加新工具只改本文件 + 真实实现，两处。
 *
 * variant 字段与前端 utils/toolClassifier.ts 的 ToolRowVariant 对齐（对话过程块同款图标），
 * 仓库卡片借此体现"这个工具的过程块长什么样"。
 */

export interface ToolRegistryEntry {
  name: string
  /** 中文名（仓库卡片标题 / 预设勾选显示） */
  label: string
  /** 简短描述（与各工具真实说明对齐） */
  description: string
  /** 仓库内分组标题 */
  group: string
  /** 过程块外观（toolClassifier variant：read/write/edit/delete/bash/search/code/ask/others） */
  variant: string
  /** 仓库 tab 归类：system=系统工具 / special=特殊工具（MCP 工具在插件 tab 按 server 展示，tab 仅作兜底归类） */
  tab: 'system' | 'special'
  /** 来源（registry 合并 MCP/自定义时写入） */
  source?: 'builtin' | 'mcp' | 'custom'
  /** 挂载门槛：不满足则勾选也不会出现在该会话（预设编辑器显示徽标，勾选仅表达"允许"） */
  gating?: 'toolset:install' | 'toolset:preset-admin' | 'toolset:custom-tools' | 'team'
  /** 高危标记（执行弹权限卡）：仓库卡片显示警示 */
  risky?: boolean
  /** MCP 专属：所属 server 名 */
  server?: string
}

/** 兼容旧命名（server.ts 启动自检等） */
export type ToolCatalogEntry = ToolRegistryEntry

/** 全部内置工具（与后端真实挂载点一一对应；server.ts getOrCreateAgent 装配） */
export const TOOL_CATALOG: ToolRegistryEntry[] = [
  // ── 文件（tools.ts buildSessionTools，cwd=会话工作区）──
  { name: 'fs_read', label: '读取文件', description: '读取工作区文件内容（可截断；支持 startLine/endLine 分段读）', group: '文件', variant: 'read', tab: 'system' },
  { name: 'list_dir', label: '列目录', description: '列出目录内容（文件/子目录+大小，毫秒级）——看结构用它，别 run_command dir', group: '文件', variant: 'read', tab: 'system' },
  { name: 'schedule', label: '定时任务', description: '定时任务：create 建（once/hourly/daily/weekly/monthly）· list 查 · update 改/停启用/绑对话/开关值守 · remove 删 · run_now 立跑', group: '定时任务', variant: 'others', tab: 'system', risky: true },
  { name: 'repo', label: '仓库地图', description: '仓库导航：map 结构概览 · search 按符号/概念找代码位置 · build 重建索引（与 fs_grep 互补）', group: '文件', variant: 'search', tab: 'system' },
  { name: 'fs_grep', label: '搜索文件内容', description: '按关键词/正则搜索工作区文件内容（返回 文件:行号 + 上下文），查代码引用/配置项时用它，别再拼 findstr', group: '文件', variant: 'search', tab: 'system' },
  { name: 'fs_write', label: '写入文件', description: '写入/新建文件（含多模态图片写入）', group: '文件', variant: 'write', tab: 'system', risky: true },
  { name: 'fs_edit', label: '精确替换', description: '按锚点精确替换文件片段（old_string 必须原样且默认唯一；改大文件比 fs_write 整文件覆盖安全，会回报命中行号）', group: '文件', variant: 'edit', tab: 'system', risky: true },
  // ── 命令（tools.ts buildCmdTool）──
  { name: 'run_command', label: '执行命令', description: '在会话工作目录执行命令', group: '命令', variant: 'bash', tab: 'system', risky: true },
  /* ★ g3：验收专用 —— 跑命令只看退出码（审批与 run_command 同级，见 server.ts assessRisk 的 check_run 分支） */
  { name: 'check_run', label: '验收命令', description: '跑一条命令并返回退出码（exitCode===0 算通过）；run_command 是干活、check_run 是验收', group: '命令', variant: 'bash', tab: 'system', risky: true },
  // ── 后台任务（tools.ts buildBgTools）—— ★ 0929 刀①：6 个 bg_* 合并成 bg(action=…) ──
  // 0921 接线补：此前只在 tools.ts 里实现，目录/预设白名单都漏登记 → 预设编辑器勾不到、AI 会话里也调不到
  //（server.ts 的严格白名单过滤会把未声明的工具全部裁掉）。本文件是「工具唯一事实源」，必须登记在这里，
  //  并同步前端 toolIcons.ts / toolClassifier.ts（跑 backend/_toolwiring_check.mjs 可一键核对）。
  { name: 'bg', label: '后台任务', description: '后台任务工具箱：action=start 挂后台执行（command 或 url 下载）/ list 列任务 / read 读输出 / stop 停止 / note 报进度 / watch 约回访', group: '后台任务', variant: 'bash', tab: 'system', risky: true },

  // ── 交互 ──
  { name: 'ask_user', label: '询问用户', description: '向用户提问并等待回答（确认/澄清）', group: '交互', variant: 'ask', tab: 'system' },
  { name: 'load_tools', label: '加载能力包', description: '低频能力包按需加载（浏览器等）：说明书不常驻省上下文，要用时展开后照调', group: '交互', variant: 'others', tab: 'system' },
  { name: 'plan_write', label: '任务计划', description: '写/更新任务计划（输入框上方计划卡展示，完成划勾）', group: '交互', variant: 'write', tab: 'system' },
  { name: 'settings_update', label: '更新设置', description: '更新全局设置（名字/性格提示词等）', group: '交互', variant: 'edit', tab: 'system', risky: true },
  // ── 记忆 + 知识库 + 便签（★ 0929 刀①：memory_*/knowledge_* 7 个 → memory+knowledge 两个家族；notebook_* 4 个 → notebook ──
  { name: 'memory', label: '记忆', description: '记忆工具箱：action=search 检索 / store 写入（归 category）/ delete 删除 / distill 蒸馏整理', group: '记忆', variant: 'search', tab: 'special' },
  { name: 'knowledge', label: '知识库', description: '知识库工具箱：action=query 查询（附现有分类）/ add 添加（先判断 entry_type 与分类）/ delete 删除', group: '知识库', variant: 'search', tab: 'special' },
  { name: 'notebook', label: '便签', description: '便签工具箱：action=list 读（接活前先看）/ add 记一条（先查重）/ update 改状态详情 / delete 删条目', group: '便签', variant: 'write', tab: 'special' },
  /* ★1126：生成图片。**工具唯一事实源必须登记**（漏了会怎样：预设编辑器勾不到、工具页看不到、
     AI 会话里被严格白名单裁掉 —— 三条全中，老板实测"工具面板里找不到"就是这个原因）。
     group 单开「生成」：将来 video / audio 也归这里，不跟"特殊工具"混。
     risky=true：按张计费，执行弹审批卡（server.ts assessRisk 的 image 分支）。 */
  { name: 'image', label: '生成图片', description: '生成一张图片（文生图）。模型在「设置 → 供应商 → 生成模型」里配一次，全员共用；只在用户明确要求出图时调用', group: '生成', variant: 'others', tab: 'special', risky: true },
  /* ★1126：生成视频 —— **异步**：提交即返回，跑在后台任务里（进度/完成通知走 bg 那套） */
  { name: 'video', label: '生成视频', description: '生成一段视频（文生视频）。**提交后立刻返回**，实际生成跑在后台任务里（约 2~3 分钟，带真实进度），完成后自动通知', group: '生成', variant: 'others', tab: 'special', risky: true },
  // ── 联网（webTools.ts）──
  { name: 'web_search', label: '网页搜索', description: '联网搜索', group: '联网', variant: 'search', tab: 'system' },
  { name: 'web_fetch', label: '网页抓取', description: '抓取网页内容', group: '联网', variant: 'read', tab: 'system' },
  { name: 'github_search', label: 'GitHub 搜索', description: 'GitHub 代码/仓库搜索', group: '联网', variant: 'search', tab: 'system' },
  // ── 技能 ──
  { name: 'use_skill', label: '使用技能', description: '加载已安装技能（SKILL.md）的完整指令', group: '技能', variant: 'others', tab: 'system' },
  // ── 团队 V2（★1124：V1 的 team_dispatch / bb_* / member_* / sub_read / team_info / sub_plan 已随 V1 运行链拆除，
  //    目录必须同步换成 V2 九件 —— 否则工具面板显示的是**运行时已经不存在的工具**，用户会以为没接线）──
  { name: 'team_v2_dispatch', label: '团队收单并派发', description: '把用户明确要求的活收成需求单并派给成员，可随单声明 after / dependsOn 依赖', group: '团队', variant: 'others', tab: 'system', gating: 'team' },
  { name: 'team_v2_status', label: '查看团队进度', description: '只读账本里的阶段，不派工、不复验', group: '团队', variant: 'read', tab: 'system', gating: 'team' },
  { name: 'team_v2_review', label: '复验需求单', description: '独立复验（C）只产出意见，**不改变需求单状态**', group: '团队', variant: 'read', tab: 'system', gating: 'team' },
  { name: 'team_v2_revise', label: '修改需求要求', description: '追加或修改需求的要求与验收（排队/执行中的先结算再改）', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'team_v2_rework', label: '返工重派', description: '同一需求单开新尝试，不新增顶层需求', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'team_v2_retry', label: '重试中断的执行', description: '先按 OS 事实确认旧进程已退出，再把中断项判失败并放行队列', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'team_v2_cancel', label: '取消需求', description: '排队中的立即取消；运行中的先真停执行器再标已取消', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'team_v2_note', label: '给需求补充信息', description: '给正在执行的需求按顺序插话（不改验收/范围）', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'team_v2_depend', label: '设置需求依赖', description: '前置验收通过后后置才开工；自依赖/成环会被拒', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  { name: 'team_v2_accept', label: '按用户原话验收', description: '用户口头表态（通过/打回）后落成需求单状态；quote 必须逐字引用用户那句话', group: '团队', variant: 'write', tab: 'system', gating: 'team' },
  /* ★ 0925v（"分身"功能）：非团队模式派 1~3 个只读分身并行查证（分身工具是硬白名单：不能跑命令、不能改文件） */
  { name: 'spawn_clone', label: '派出分身', description: '派出 1~3 个只读分身并行查证子任务（同步等待完成后返回摘要）', group: '团队', variant: 'others', tab: 'system', risky: true },
  { name: 'project_note', label: '写项目档案', description: '维护工作区根的项目档案（NIS-notes.md）：项目约定/当前进度/决策记录/产物清单——让同项目的其他窗口了解项目背景与进度', group: '交互', variant: 'write', tab: 'system' },  // ★1010-E（已定案）：从「记忆」组挪到「交互」——"记忆"留给记忆库（memory），消除系统/特殊两个 tab 都出现"记忆"分组的疑惑
  // ── 安装助手（toolsets: install 会话才有）──
  { name: 'install_skill', label: '安装技能', description: '安装技能包（git URL/本地目录 → backend/skills，含查重）', group: '特殊工具', variant: 'bash', tab: 'special', gating: 'toolset:install' },
  { name: 'uninstall_skill', label: '卸载技能', description: '卸载已安装的技能', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:install' },
  { name: 'scan_skill', label: '扫描技能', description: '对技能目录做安全扫描（PASS/WARN/FAIL）', group: '特殊工具', variant: 'search', tab: 'special', gating: 'toolset:install' },
  { name: 'list_installed', label: '已安装清单', description: '列出已安装技能与安装记录', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:install' },
  { name: 'install_mcp', label: '安装 MCP', description: '安装并连接 MCP 服务（写配置+启动，工具即刻对 agent 生效）', group: '特殊工具', variant: 'bash', tab: 'special', gating: 'toolset:install' },
  { name: 'uninstall_mcp', label: '卸载 MCP', description: '卸载 MCP 服务（断开连接并删除配置）', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:install' },
  // ── 预设管理（toolsets: preset-admin，创造模式专属）──
  { name: 'list_tools', label: '列出工具', description: '列出系统全部可用工具（预设创作用）', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:preset-admin' },
  { name: 'read_preset', label: '读预设', description: '读取 Agent 预设完整内容', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:preset-admin' },
  { name: 'save_preset', label: '保存预设', description: '保存 Agent 预设（校验+运行时自检+落盘）', group: '特殊工具', variant: 'write', tab: 'special', gating: 'toolset:preset-admin' },
  { name: 'delete_preset', label: '删除预设', description: '删除自定义 Agent 预设', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:preset-admin' },
  // ── 自定义工具管理（toolsets: custom-tools，创造模式专属）──
  { name: 'list_custom_tools', label: '列自定义工具', description: '列出全部自定义工具（高风险工具清单）', group: '特殊工具', variant: 'read', tab: 'special', gating: 'toolset:custom-tools' },
  { name: 'save_custom_tool', label: '建自定义工具', description: '创建/更新自定义工具（高风险：执行必弹权限卡）', group: '特殊工具', variant: 'write', tab: 'special', gating: 'toolset:custom-tools' },
  { name: 'delete_custom_tool', label: '删自定义工具', description: '删除自定义工具', group: '特殊工具', variant: 'delete', tab: 'special', gating: 'toolset:custom-tools' },
]

/**
 * 唯一源出口：静态内置 + MCP 实时 + 自定义工具实时。
 * mcp/custom 条目由 server.ts 传入（本文件不 import mcpRuntime/customTools，避免依赖环）。
 */
export function buildToolRegistry(opts: {
  mcpTools: Array<{ name: string; label: string; description: string; server: string }>
  customTools: Array<{ name: string; label: string; description: string }>
}): ToolRegistryEntry[] {
  const builtin: ToolRegistryEntry[] = TOOL_CATALOG.map(t => ({ ...t, source: 'builtin' as const }))
  const mcp: ToolRegistryEntry[] = opts.mcpTools.map(t => ({
    name: t.name,
    label: t.label || t.name,
    description: t.description,
    // 0904 反馈②：MCP 工具归组「MCP 工具」，前端仓库从 MCP tab 投射分组，不进系统/特殊清单
    group: 'MCP 工具',
    // variant 与前端 classifyTool(mcp__) 对齐=线性搜索图标同款族
    variant: 'search',
    tab: 'system' as const,
    source: 'mcp' as const,
    server: t.server,
  }))
  const custom: ToolRegistryEntry[] = opts.customTools.map(t => ({
    name: t.name,
    label: t.label || t.name,
    description: t.description,
    group: '自定义工具',
    variant: 'others',
    tab: 'special' as const,
    source: 'custom' as const,
    risky: true, // 自定义工具每次执行必弹权限卡（既有行为）
  }))
  return [...builtin, ...mcp, ...custom]
}


