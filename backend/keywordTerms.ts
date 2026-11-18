/** ★b1x（B 阶段：关键词检索三层加强）—— 中文技术术语表 + 三层抽词（**纯函数，无依赖，单测直接 import**）
 *
 *  老板 1104 原话："扩大抽取范围就不用了，就抽当前这一轮用户消息，从里面筛选关键词；还有我觉得你现在给的
 *  这个关键词筛选有点太片面了，有的可能是做文聊这种，如果抽取不能抽中文还有就是抽全都是术语化的东西，会不好命中。"
 *
 *  旧实现（server.ts extractEntityKeywords）只抽 5 类标识符，且 `if (/^[\u4e00-\u9fa5]+$/.test(h)) continue`
 *  ⇒ **纯中文词一律丢掉**：用户说「手柄」「压缩」「记忆」全抽不到，只能靠语义；而语义对「飞书」「钢琴陪练」
 *  这类专有名词不敏感（向量空间里它和常见词贴得很近）。
 *
 *  现在三层叠加（不是替代），按优先级拼装后截断到 max：
 *    ① 标识符层（原 5 类，优先级最高）：文件名/路径、错误码、HTTP 状态码 → snake_case/camelCase → 大写缩写
 *    ② 中文专有名词层：《》「」“”‘’ 以及直引号（直引号要求内含中文，防代码里的 "path" 混进来）
 *    ③ 中文技术术语层：本文件 TECH_TERMS 白名单（**约 230 词**，跟 NiusDream 项目实际词汇对齐；**单字词一律不收**）
 *
 *  ⚠️ 为什么不"扩大抽取范围"（老板已否决）：把整轮历史/全部用户消息都拿去分词抽词 ⇒ 噪音词成倍上涨
 *  （每句闲聊都能贡献一串词），且抽词结果要拼进语义 query，query 一长，真正那个文件名就被稀释了。
 *  代价（更快更准）与收益（多几条噪音）不成正比 —— 所以**限定当前这一轮用户消息**，只做"更狠的中文筛选"。
 */

/** 单字/无区分度的英文停用词（旧表原样保留） */
const EN_STOP = new Set(['api', 'ok', 'id', 'ui', 'npm', 'the', 'and', 'for', 'not', 'yes', 'no', 'json', 'html', 'http', 'https', 'www', 'com'])

/** 中文技术术语白名单（NiusDream 语境高频概念）。
 *  收录口径：①≥2 字（单字无区分度一律不收）；②在 NiusDream 的对话/代码/文档里真会反复出现；
 *  ③**故意不收**超通用词（问题 / 东西 / 现在 / 可以 / 一下 / 时候 / 感觉 / 觉得）——那种词抽出来只会污染 query。
 *  匹配时按**长度降序**先占位（"强化记忆" 先于 "强化"/"记忆"），避免长词被短词切碎。 */
export const TECH_TERMS: string[] = [
  // ── 记忆 / 知识库 / 检索（本阶段主战场）
  '强化记忆', '强化知识', '常驻记忆', '记忆召回', '记忆注入', '记忆库', '记忆检索', '语义检索', '关键词检索', '混合检索',
  '知识库', '知识条目', '知识注入', '召回', '检索', '注入', '常驻', '强化', '钉住', '取消钉住', '蒸馏', '待确认',
  '命中', '命中率', '语义', '关键词', '分词', '词表', '白名单', '黑名单', '阈值', '权重', '打分', '排序', '去重',
  '过滤', '截断', '摘要', '压缩', '折叠', '展开', '索引', '向量', '嵌入', '相似度', '精确匹配', '模糊匹配',
  // ── 上下文 / 提示词 / Agent 骨架
  '提示词', '系统提示', '系统提示词', '上下文', '上下文窗口', '工具链', '工具描述', '工具集', '工具池', '调用参数',
  '懒加载', '闸门', '锚点', '缓存前缀', '前缀缓存', '会话', '轮次', '本轮', '消息', '预设', '人格', '人设',
  '团队', '成员', '分身', '黑板', '计划', '验收', '任务单', '派发', '回归', '交付', '产物', '里程碑', '进度',
  '汇报', '打回', '重派', '确认', '探针', '体检', '自检', '回归测试',
  // ── 界面 / 交互
  '前端', '后端', '界面', '组件', '页面', '按钮', '弹窗', '输入框', '侧栏', '面板', '主题', '深色', '浅色',
  '微标', '样式', '布局', '拖拽', '手柄', '滚动条', '悬停', '动画', '图标', '字体', '行高', '圆角', '阴影',
  '遮罩', '分页', '富文本', '编辑器', '预览', '弹层', '标签', '字段', '表单', '列表', '表格', '图表', '圆环',
  '像素', '定位', '偏移', '宽高', '自适应', '响应式', '折叠区', '顶栏', '底栏', '对话框', '菜单', '快捷键',
  // ── 模型 / 推理 / 计费
  '模型', '推理', '流式', '缓存', '计费', '重试', '变体', '芯片', '并发', '超时', '令牌', '预算', '温度',
  '采样', '上下文压缩', '总结', '润色', '降级', '回退', '备用', '失败重试', '限流', '配额',
  // ── 运行时 / 进程 / 环境
  '定时任务', '任务队列', '取消队列', '排队', '中断', '恢复', '回滚', '快照', '备份', '导出', '导入', '迁移',
  '插件', '扩展', '技能', '脚本', '沙箱', '权限', '审批', '审计', '日志', '报错', '崩溃', '内存泄漏', '死循环',
  '卡死', '白屏', '闪烁', '抖动', '延迟', '首屏', '端口', '进程', '重启', '启动', '调试', '单测', '测试',
  '复现', '环境变量', '依赖', '安装', '部署', '打包', '编译', '构建', '版本', '分支', '合并', '冲突', '提交',
  // ── 数据 / 存储 / 协议
  '数据库', '数据表', '表结构', '主键', '事务', '序列化', '反序列化', '文件', '目录', '路径', '仓库', '地图',
  '代码', '源码', '注释', '变量', '函数', '类型', '接口', '协议', '微服务', '请求', '响应', '报文体', '桥接',
  // ── NiusDream 项目自有词
  '目标模式', '改造模式', '自动续跑', '工作区', '档案', '便签', '待办', '提醒', '通知', '指挥官',
  '项目档案', '代码索引', '仓库地图', '记忆面板', '设置页', '软件环境', '常驻块', '注入块', '块序', '字数占用',
]

/** 技语匹配顺序：长词优先（"强化记忆" 不会被 "强化" 先吃掉） */
const TERMS_BY_LEN = [...TECH_TERMS].filter((t) => t.length >= 2).sort((a, b) => b.length - a.length)

/** 文件名/带扩展名路径（中文名也算） */
const RE_FILE = /[\u4e00-\u9fa5A-Za-z0-9_\-./\\]*[\u4e00-\u9fa5A-Za-z0-9_\-]*\.(?:tsx?|jsx?|cjs|mjs|json|vue|md|py|css|scss|html|sql|ya?ml|sh|bat|ps1|toml|ini|db)\b/g
/** 错误码 ERR_xxx / ENOENT / EADDRINUSE */
const RE_ERRCODE = /\b(?:ERR_[A-Z0-9_]+|E[A-Z][A-Z0-9]{2,})\b/g
/** 4xx / 5xx（OCR 状态码，可能是 HTTP 也可能是别的错误码） */
const RE_HTTP = /\b(?:HTTP\s*)?[45]\d\d\b/g
/** snake_case 标识符（memory_graph / fs_read） */
const RE_SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,3}\b/g
/** camelCase 标识符（buildMemoryRecall） */
const RE_CAMEL = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g
/** 大写缩写/项目名（NiusDream / MCP / DSH） */
const RE_UPPER = /\b[A-Z][A-Z0-9_]{1,9}\b/g
/** 中文专有名词：成对标点包裹（每个分支捕获组不同，取第一个非空组） */
const RE_PROPER = /《([^《》\n]{2,30})》|「([^「」\n]{2,30})」|“([^“”\n]{2,30})”|‘([^‘’\n]{2,30})’|"([^"\n]{2,30})"|'([^'\n]{2,30})'/g
/** 直引号/无书名号场景里，专有名词必须含中文（否则 `"path"`、`'use strict'` 这类代码字面量全会混进来） */
const RE_CJK = /[\u4e00-\u9fa5]/

/** 收词前统一清洗：剥首尾的点/斜杠/引号/标点与空白 */
function cleanHit(raw: string): string {
  return String(raw || '')
    .replace(/^[\s.,;/\\'"`《「“‘’'"，。、；：！？·…—\-（）()]+/, '')
    .replace(/[\s.,;/\\'"`《「“‘’'"，。、；：！？·…—\-（）()]+$/, '')
    .trim()
}

/** 合法词判定（三层共用）：长度/纯数字/停用词 */
function acceptAscii(h: string): boolean {
  if (h.length < 3 || h.length > 80) return false
  if (/^\d+$/.test(h)) return false
  if (/^[\u4e00-\u9fa5]+$/.test(h)) return false      // 标识符层不收纯中文（那是层 ②③ 的活）
  return !EN_STOP.has(h.toLowerCase())
}

/**
 * 三层抽词（替换原 server.ts 的 extractEntityKeywords）。
 * @param text 当前这一轮的用户消息（**不扩到历史**）
 * @param max  总预算（默认 8；中文词占名额，从原来的 6 提到 8）
 * @returns 去重后的关键词，**按优先级排好序**（截断从尾部丢，先丢缩写）
 */
export function extractEntityKeywords(text: string, max = 8): string[] {
  const src = String(text || '')
  if (!src.trim()) return []
  const groups: string[][] = [[], [], [], [], []]   // 0 文件名/错误码/HTTP · 1 专有名词 · 2 技术术语 · 3 标识符 · 4 缩写

  const take = (re: RegExp, bucket: string[], pick: (m: RegExpExecArray) => string = (m) => m[0]) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const v = cleanHit(pick(m))
      if (v) bucket.push(v)
      if (m.index === re.lastIndex) re.lastIndex++      // 空匹配保护（防死循环）
    }
  }

  // ── 层 ①（最高优先）：文件名/路径、错误码、HTTP 状态
  take(RE_FILE, groups[0])
  take(RE_ERRCODE, groups[0])
  take(RE_HTTP, groups[0])

  // ── 层 ②：中文专有名词（《》「」“”‘’；直引号要求含中文，防代码字面量）
  take(RE_PROPER, groups[1], (m) => {
    const groups6 = [m[1], m[2], m[3], m[4], m[5], m[6]]
    const idx = groups6.findIndex((x) => typeof x === 'string' && x.length > 0)
    if (idx < 0) return ''
    const body = String(groups6[idx])
    if (idx >= 4 && !RE_CJK.test(body)) return ''        // 直引号 "path" / 'use strict' → 丢
    return body
  })

  // ── 层 ③：中文技术术语白名单（长词优先 + 占位遮盖，避免「记忆」把「强化记忆」切碎）
  try {
    let work = src
    const found: { t: string; i: number }[] = []
    for (const t of TERMS_BY_LEN) {
      let idx = work.indexOf(t)
      if (idx < 0) continue
      const first = idx
      while (idx >= 0) {
        work = work.slice(0, idx) + '\u0000'.repeat(t.length) + work.slice(idx + t.length)
        idx = work.indexOf(t, idx + t.length)
      }
      found.push({ t, i: first })
    }
    found.sort((a, b) => a.i - b.i || b.t.length - a.t.length)
    for (const f of found) groups[2].push(f.t)
  } catch { /* 术语层失败不影响标识符层 */ }

  // ── 层 ④⑤：标识符 / 大写缩写（原 5 类里的后三类，优先级最低）
  take(RE_SNAKE, groups[3])
  take(RE_CAMEL, groups[3])
  take(RE_UPPER, groups[4])

  const out: string[] = []
  const seen = new Set<string>()
  for (const bucket of groups) {
    for (const h0 of bucket) {
      const h = cleanHit(h0)
      if (!h) continue
      const isCjkPure = /^[\u4e00-\u9fa5]+$/.test(h)
      if (isCjkPure) {
        if (h.length < 2 || h.length > 30) continue        // 中文：2~30 字（单字一律不收）
        if (!groups[1].includes(h) && !groups[2].includes(h)) continue   // 中文只认专有名词/术语层
      } else if (/^[45]\d\d$/.test(h)) {
        /* 4xx/5xx 状态码：**纯数字照样收**（acceptAscii 会把纯数字全丢掉） */
      } else if (!acceptAscii(h)) continue
      const k = h.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(h)
      if (out.length >= max) return out
    }
  }
  return out
}

/** 术语表自检用：给单测/体检脚本读规模与样例 */
export function keywordTermsInfo(): { count: number; sample: string[] } {
  const uniq = Array.from(new Set(TECH_TERMS))
  return { count: uniq.length, sample: uniq.slice(0, 12) }
}
