/* lazyTools.ts —— 刀②：低频能力包「工具照常挂载、说明书按需发」（0929）
 * 思路（能力零损失版懒加载）：
 *   · 工具**始终挂在 agent 上**（模型随时调得到=能力不减）；
 *   · 但发给模型的「工具表」里，低频包只保留一行目录（系统提示里告知），
 *     真实说明书在 load_tools('包名') 之后才进请求 —— 这一步由 createStreamFn
 *     在【每次请求组装工具表时】过滤（工具循环每跳都过这里 ⇒ 当轮加载当轮生效）。
 *   · 缓存友好：低频包工具在工具表末尾（MCP 本就排尾），隐藏=截尾巴、加载=尾巴回来，
 *     前缀逐字节稳定，只在"加载那一跳"付一次缓存未命中。
 * 0928 真机验证过的取舍：pi-ai 原生 defer_loading 只有 Anthropic 系支持工具引用，
 * 主力模型（mimo/deepseek/agnes）走 openai-completions 协议 —— 故自实现这层通用机制。
 *
 * ★ 阶段 E-1（懒包推广，1014）：从"只有 browser 一个包"推广到内置低频能力（admin/member/knowledge）。
 *   约定：MCP 本来就是"能力包 + 懒加载"，按包算；把这套模式推广到内置低频工具。
 *   ⚠️ 两条硬约束（别踩）：
 *     ① **`fs_*` 绝不能进懒包**（占调用 42.9%，高频；藏了必付加载往返）；
 *     ② **`bb_*`（黑板）不能进懒包** —— 团队协作要常驻，藏了等于让成员喊不到黑板。
 *   ⚠️ 顺序：见 splitToolsForRequest 的「稳定分区」——不再依赖"工具表里本来就在尾部"这个前提：
 *      输出一律 = 常驻工具（原相对序）+ 已加载懒包工具（原相对序）⇒ 隐藏=截尾、加载=续尾，
 *      任何家族的挂载位置（MCP 在尾、team 工具在 finalTools 之后、knowledge 在中间）都不影响缓存前缀。
 */

/** 低频能力包定义：包名 → 归属判定 + 一句话索引（系统提示/目录用）
 *  ⚠️ **定义顺序有意义**：`lazyFamilyOf` 用 `Object.entries` 按定义顺序遍历、**第一个匹配胜出**。
 *     所以更具体的 `match` 必须写在更宽泛的前面（见下面 screenshot 与 browser 的先后）。 */
export const LAZY_FAMILIES: Record<string, { label: string; match: (name: string) => boolean; hint: string }> = {
  /* ★k1（需求）：**截图单独成包** —— 必须定义在 `browser` **之前**。
     ⚠️ 这个位置不是随便放的：`browser` 的 match 是 `/^mcp__nis-browser__wb_/`（前缀很宽），
        而 `lazyFamilyOf` 是"第一个匹配胜出" ⇒ 若 screenshot 写在 browser 后面，
        它永远匹配不到，两个截图工具会被 browser 吞掉（本包的改动等于没写）。
        后来人挪位置前先看 lazyFamilyOf 的遍历语义。
     为什么值得拆：截图是高频小事（"截个图给我看"），而 browser 包有 20 件；
     为了 1 件拖 20 件说明书进请求不划算。拆出来后目录行也直说"能截整块桌面"，
     模型才不会以为只有浏览器截图。 */
  screenshot: {
    label: '截图能力包',
    match: (n) => /^mcp__nis-browser__wb_(send_screenshot|screen_capture)$/.test(n),
    hint: '截浏览器页面 / 截【整块桌面或指定窗口】（任何应用）/ 发本地图片文件 到对话流 —— 2 件',
  },
  browser: {
    label: '浏览器能力包',
    /* ★k1：截图两件已独立成 screenshot 包（定义在上面，先匹配 ⇒ 这里不会再命中它们）。
       保留这条前缀匹配覆盖 browser 包其余工具（打开/点击/填表/读页面等）。 */
    match: (n) => /^mcp__nis-browser__wb_/.test(n),
    hint: '打开网页/点击/填表单/读页面 等浏览器操作（真实浏览器，用户可见）。截图见 screenshot 包',
  },
  /* 系统管理（13 件，三处来源：安装助手 6 + 预设管理 4 + 自定义工具 3）：改的是 NiusDream 自身配置，
     只在"装东西 / 造预设 / 造工具"场景用，普通干活轮次里 100% 不会被调。 */
  admin: {
    label: '系统管理能力包',
    match: (n) => /^(list_installed|install_skill|uninstall_skill|scan_skill|install_mcp|uninstall_mcp|list_tools|read_preset|save_preset|delete_preset|list_custom_tools|save_custom_tool|delete_custom_tool)$/.test(n),
    hint: '装/卸技能与 MCP、扫描已装、预设增删改查、自定义工具增删查 等 13 件系统管理操作',
  },
  /* 团队成员管理（5 件；⚠️ bb_* 黑板工具**不在包内**，团队协作要常驻）。 */
  member: {
    label: '团队成员管理包',
    match: (n) => /^(member_tell|member_new_session|team_info|sub_read|sub_plan)$/.test(n),
    hint: '给成员插话补充/给成员开新对话/查成员详情/读执行详情与单聊/成员自列计划 等 5 件团队管理操作（黑板 bb_* 常驻，不在包内）',
  },
  /* 知识库（1 件：0929 刀① 已把 knowledge_query/add/delete 合成家族工具 knowledge，action 切换）。 */
  knowledge: {
    label: '知识库能力包',
    match: (n) => /^knowledge(_query|_add|_delete)?$/.test(n),
    hint: '资料收藏（与"记忆=长期偏好/教训"分开）：query 查 / add 添 / delete 删 —— 1 件家族工具，action 切换',
  },
}

/** 工具名属于哪个懒加载包（不属于=常驻工具，null） */
function lazyFamilyOf(name: string): string | null {
  for (const [fam, def] of Object.entries(LAZY_FAMILIES)) if (def.match(name)) return fam
  return null
}

/** 这批工具里有多少件属于懒包（给挂载点判断"值不值得挂加载器"用） */
export function countLazyTools(tools: any[]): number {
  return (tools || []).filter(t => !!lazyFamilyOf(String(t?.name || ''))).length
}

/** 该不该挂 load_tools（加载器）：只有**能藏 ≥2 件**时才值得（藏 1 件多挂 1 件加载器 = 白换）。 */
export function shouldMountLoader(tools: any[]): boolean {
  return countLazyTools(tools) >= 2
}

/** 请求级工具表过滤：常驻全发；懒包只有「已加载」才发（loaded 为空=只发常驻）。
 *  ★ 底线保险：工具表里**没有 load_tools**（加载器）时一律不藏 —— 藏了又没处喊 = 能力损失，绝不允许。
 *  ★ 稳定分区（阶段 E-1）：输出 = 常驻（原序）++ 已加载懒包件（按家族首次出现序、家族内原序）。
 *    这样"藏/加载"永远只动**尾部**，前缀逐字节稳定 —— 与各家族挂在哪里无关（MCP 在原尾部、
 *    team 工具在 finalTools 之后、knowledge 在中间，全都安全）。 */
export function splitToolsForRequest(tools: any[], loaded: Set<string> | undefined | null): any[] {
  const hasLoader = tools.some(t => String(t?.name || '') === 'load_tools')
  if (!hasLoader) return tools
  const residents: any[] = []
  const byFam = new Map<string, any[]>()
  for (const t of tools) {
    const f = lazyFamilyOf(String(t?.name || ''))
    if (!f) { residents.push(t); continue }
    if (!loaded || loaded.size === 0 || !loaded.has(f)) continue
    const arr = byFam.get(f)
    if (arr) arr.push(t)
    else byFam.set(f, [t])
  }
  const out = residents
  for (const arr of byFam.values()) for (const t of arr) out.push(t)
  return out
}

/** 该包还没加载时，模型只该看到的「目录行」（系统提示/工具表注记用） */
export function familyIndexLine(family: string): string {
  const def = LAZY_FAMILIES[family]
  return def ? `${def.label}（${def.hint}）—— 用 load_tools('${family}') 展开说明书后使用` : ''
}

/** 把一个包的真实说明书拼成文本（load_tools 的返回体：模型当轮即可照着调用） */
export function familyToolDocs(family: string, tools: any[]): string {
  const def = LAZY_FAMILIES[family]
  const mine = tools.filter(t => def?.match(String(t?.name || '')))
  if (!mine.length) return `【${family}】没有找到该能力包的工具（可能未挂载：检查预设的工具勾选）`
  const lines = mine.map((t: any) => {
    const props = t?.parameters?.properties || {}
    const params = Object.entries(props).map(([k, v]: any) => `${k}${v?.type ? `:${v.type}` : ''}`).join(', ')
    return `· ${t.name}（${t.label || ''}）：${String(t.description || '').slice(0, 160)}${params ? `｜参数：${params}` : ''}`
  })
  return `已加载【${def.label}】${mine.length} 件，本轮及后续都可直接调用（说明书如下，参数细节以工具 schema 为准）：\n${lines.join('\n')}`
}
