'use strict';
/**
 * Slash Command & Local Skills Hub Backend (meter-commands.js)
 *
 * Unifies 4 sources into a searchable, Chinese-annotated Command Hub:
 *   1. Antigravity Desktop Built-in Slash Commands (/compact, /plan, /goal, ...)
 *   2. Installed Plugins, Global Skills & Workspace Skills (~/.gemini/config/plugins, ~/.gemini/config/skills, .agents/)
 *   3. Personal E:\agent_skills Library (113+ skills, case-insensitive SKILL.md / skill.md, merged with skills-catalog.json)
 *      with Dual-Layer Native Pinning into ~/.gemini/config/skills.json ("~/.agents/skills" + include_only)
 *   4. User Favorites, Recent History & Custom Prompt Snippets (%LOCALAPPDATA%/AntigravityContextMeter/commands-hub.json)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStateDir } = require('./asar-engine');

const DEFAULT_AGENT_SKILLS_ROOT = 'E:\\agent_skills';
const EXCLUDED_SKILL_DIRS = new Set(['_shared', 'nature-shared', '.git', 'node_modules']);
const INTERNAL_BUILTIN_SKILLS = new Set(['swarm_monitor', 'swarm_narrator', 'swarm_pane']);

const BUILTIN_SLASH_COMMANDS = [
  {
    id: 'builtin:/compact',
    command: '/compact',
    insertText: '/compact',
    title: '压缩当前会话上下文',
    source: 'builtin',
    category: '会话控制',
    costTag: '节省上下文',
    costTone: 'good',
    summary: '将当前过长的历史对话压缩为结构化摘要，释放大量上下文窗口空间，同时保留任务关键上下文。',
    whenToUse: '上下文占用超过 70%–85%、准备切换下一阶段子任务，或感觉模型开始遗忘早期细节时使用。',
    whenNotToUse: '刚刚开启的新会话，或需要逐字核对前几轮长文本原话时不必压缩。',
    example: '/compact'
  },
  {
    id: 'builtin:/plan',
    command: '/plan',
    insertText: '/plan ',
    title: '先规划后执行',
    source: 'builtin',
    category: '规划与思考',
    costTag: '中等消耗',
    costTone: 'info',
    summary: '要求智能体在动手改代码或执行复杂任务前，先产出清晰的步骤计划与边界确认。',
    whenToUse: '涉及多文件重构、架构调整、高风险配置修改或需求边界尚未完全锁定时。',
    whenNotToUse: '单行 typo 修复、简单问答或查文件状态等琐碎小事。',
    example: '/plan 重构认证模块并补充单元测试'
  },
  {
    id: 'builtin:/grill-me',
    command: '/grill-me',
    insertText: '/grill-me ',
    title: '交互式追问对齐设计',
    source: 'builtin',
    category: '规划与思考',
    costTag: '轻量对话',
    costTone: 'info',
    summary: '让智能体以面试/追问的方式逐项核对你的需求细节与设计取舍，帮你把模糊想法打磨清晰。',
    whenToUse: '想法还比较粗、希望 AI 帮你挑出架构盲区或边界条件时。',
    whenNotToUse: '需求已经非常明确、只想快速落地的场景。',
    example: '/grill-me 我想做一个面向实验室的仪器数据管理后台'
  },
  {
    id: 'builtin:/boost',
    command: '/boost',
    insertText: '/boost ',
    title: '深度推理与多视角严谨验证',
    source: 'builtin',
    category: '规划与思考',
    costTag: '消耗较高',
    costTone: 'warn',
    summary: '触发更深度的思考、战略规划、多角度审视与严格自证，适合攻坚复杂工程或科研问题。',
    whenToUse: '疑难 Bug 排查、核心算法推导、关键架构评审或高质量论文/方案打磨。',
    whenNotToUse: '日常简单修改（会显著增加思考时间与 Token 消耗）。',
    example: '/boost 定位并发竞争导致的偶发死锁并证明修复正确性'
  },
  {
    id: 'builtin:/goal',
    command: '/goal',
    insertText: '/goal ',
    title: '长程自治目标模式',
    source: 'builtin',
    category: '自动化与协作',
    costTag: '高消耗 / 长耗时',
    costTone: 'warn',
    summary: '让智能体持续迭代直至目标完全达成，期间主动拆解、验证与修复，不轻易中途停下。',
    whenToUse: '大型重构、批量测试修复、通宵跑实验脚本或需要端到端彻底收尾的任务。',
    whenNotToUse: '需要每一步人工审查或只想先看看方案的探索性任务。',
    example: '/goal 修复所有集成测试失败项并确保 npm test 100% 通过'
  },
  {
    id: 'builtin:/teamwork',
    command: '/teamwork',
    insertText: '/teamwork ',
    title: '多智能体并行协同',
    source: 'builtin',
    category: '自动化与协作',
    costTag: '高配额消耗',
    costTone: 'warn',
    summary: '把大型项目拆给多个并行的自治智能体协同推进（独立分工 + 交叉审查）。',
    whenToUse: '前后端联调、多模块并行开发、大规模文献/代码并行调研与复核。',
    whenNotToUse: '高度串行的小任务（启动多智能体会有额外协调与配额开销）。',
    example: '/teamwork 并行完成 API 重构、前端适配与端到端回归测试'
  },
  {
    id: 'builtin:/browser',
    command: '/browser',
    insertText: '/browser ',
    title: '内置浏览器交互与检索',
    source: 'builtin',
    category: '自动化与协作',
    costTag: '中等消耗',
    costTone: 'info',
    summary: '调用内置浏览器子智能体打开网页、点击表单、查看实时渲染页面或调试本地 Web 应用。',
    whenToUse: '需要查看前端页面实际渲染效果、排查动态 JS 网页或进行多步网页操作。',
    whenNotToUse: '仅需查静态文档或本地文件时（普通检索更快更省）。',
    example: '/browser 打开 http://localhost:3000 检查登录表单样式与控制台报错'
  },
  {
    id: 'builtin:/schedule',
    command: '/schedule',
    insertText: '/schedule ',
    title: '定时任务 / 周期 Cron',
    source: 'builtin',
    category: '自动化与协作',
    costTag: '低消耗',
    costTone: 'good',
    summary: '为指令设置一次性倒计时提醒或按 Cron 表达式周期性自动执行。',
    whenToUse: '需要每隔一段时间轮询构建状态、定时汇总日报或延时触发某个检查。',
    whenNotToUse: '只需立刻执行一次的普通任务。',
    example: '/schedule 每天早上 9 点检查 GitHub 仓库的新 Issue 并汇总'
  },
  {
    id: 'builtin:/automation',
    command: '/automation',
    insertText: '/automation ',
    title: '设计常驻后台自动化',
    source: 'builtin',
    category: '自动化与协作',
    costTag: '低消耗',
    costTone: 'good',
    summary: '以向导方式设计并创建一个脱离当前会话的长期后台定时自动化流程。',
    whenToUse: '希望建立每天/每周自动运行的独立任务（如邮件摘要、依赖安全巡检）。',
    whenNotToUse: '仅在当前对话周期内临时用一次的定时检查（用 /schedule 更轻）。',
    example: '/automation 每周一早上整理上周 Git 提交并生成周报草稿'
  },
  {
    id: 'builtin:/learn',
    command: '/learn',
    insertText: '/learn ',
    title: '将本次经验固化为长期规则',
    source: 'builtin',
    category: '扩展与记忆',
    costTag: '极低消耗',
    costTone: 'good',
    summary: '把你刚纠正过的习惯、项目规范或踩坑环境配置持久化写入规则/记忆，后续任务自动遵守。',
    whenToUse: '刚纠正完 AI 的输出风格、踩过一次复杂的环境配置坑，希望以后永远记住。',
    whenNotToUse: '仅适用于当前这一次临时需求的一次性约束。',
    example: '/learn 以后所有 Markdown 文档都不使用非必要 LaTeX 符号'
  },
  {
    id: 'builtin:/plugin',
    command: '/plugin',
    insertText: '/plugin ',
    title: '管理 / 打包插件',
    source: 'builtin',
    category: '扩展与记忆',
    costTag: '低消耗',
    costTone: 'good',
    summary: '启用、禁用、安装、卸载 Antigravity 插件，或把技能/规则/MCP 打包成独立插件。',
    whenToUse: '需要查看和管理已装插件、排查插件状态，或把一组自定义能力封装复用。',
    whenNotToUse: '仅想调整单个项目的轻量规则文件时。',
    example: '/plugin 查看当前已安装的插件列表与启用状态'
  },
  {
    id: 'builtin:/btw',
    command: '/btw',
    insertText: '/btw ',
    title: '顺手旁白提问（不打断主线）',
    source: 'builtin',
    category: '会话控制',
    costTag: '低消耗',
    costTone: 'good',
    summary: '在不干扰当前主任务上下文和执行节奏的前提下，快速插入一个独立的小问题。',
    whenToUse: '主线任务推进到一半，突然想顺手确认某个概念、命令参数或语法细节。',
    whenNotToUse: '需要修改当前主线任务目标或修改代码文件的正式指令。',
    example: '/btw PowerShell 里怎么查看占用 8080 端口的进程？'
  }
];

// Friendly Chinese glosses for well-known installed plugins & builtin skills
const KNOWN_SKILL_ZH_GLOSSES = {
  'context7-mcp': {
    title: 'Context7 实时框架与库文档检索',
    summary: '通过 Context7 MCP 实时拉取 React、Next.js、Vue、Prisma、Supabase、PyTorch 等最新版本的官方文档与代码示例，避免过时 API 幻觉。',
    whenToUse: '编写或升级第三方框架/库代码、查询最新 API 签名或配置写法时。',
    example: '/context7-mcp 查询 Next.js 最新版 App Router 中间件配置方式'
  },
  'android-cli': {
    title: 'Android CLI 开发与设备控制',
    summary: '调用 android CLI 创建项目、管理 SDK/模拟器（AVD）、截取屏幕与检查 UI 布局树。',
    whenToUse: 'Android 应用开发、真机/模拟器调试或查看官方 Android 文档时。'
  },
  'android-device-hub': {
    title: 'Android 设备镜像与实时操控',
    summary: '通过 Device Hub 侧边栏管理虚拟/物理 Android 设备并进行触控与屏幕布局分析。',
    whenToUse: '需要连接并实时操作 Android 模拟器或真机界面时。'
  },
  'compose-preview': {
    title: 'Jetpack Compose 预览渲染',
    summary: '渲染 Jetpack Compose @Preview 函数并在侧边栏即时检查 UI 改动效果。',
    whenToUse: '调整 Jetpack Compose 界面样式并需要即时视觉验收时。'
  },
  'google-antigravity-sdk': {
    title: 'Antigravity Python SDK 开发指南',
    summary: '使用 Google Antigravity SDK 设计、编写和调试自治智能体与多智能体编排系统。',
    whenToUse: '需要以编程方式接入 Antigravity SDK 时。'
  },
  'easyeda-api': {
    title: '嘉立创 EDA (EasyEDA) API 自动化',
    summary: '辅助调用嘉立创 EDA / JLCEDA 接口进行原理图与 PCB 自动化检查、器件布局与工程操作。',
    whenToUse: '结合 jlceda MCP 进行原理图分析、DRC 检查或 PCB 设计辅助时。'
  },
  'easyeda-enhanced-schematic': {
    title: '嘉立创 EDA 增强原理图设计',
    summary: '提供增强型原理图绘制、网络核对与电路规范检查工作流。',
    whenToUse: '设计或审校嘉立创 EDA 原理图工程时。'
  },
  'antigravity-guide': {
    title: 'Antigravity 官方功能速查指南',
    summary: '查询 Antigravity Desktop、IDE、CLI、快捷键、自定义扩展与官方配置说明。',
    whenToUse: '不确定 Antigravity 某项内置功能如何设置时。'
  },
  'agy-customizations': {
    title: 'Antigravity 扩展系统规范',
    summary: '指导创建与排查 Rules、Skills、Plugins、Hooks 与 MCP Server 配置及其加载优先级。',
    whenToUse: '编写自定义技能、规则、插件或调试加载顺序时。'
  },
  'generative_ui': {
    title: '内联交互式可视化组件渲染',
    summary: '在对话或 Artifact 中直接渲染交互式 HTML 图表、流程图、控件或教学演示。',
    whenToUse: '希望直观可视化数据、原理演示或做交互原型时。'
  },
  'run-workflow': {
    title: '动态 Python 多智能体编排脚本',
    summary: '用 Python 编排 parallel/pipeline 多智能体并发处理大量文件、模块或审查视角。',
    whenToUse: '需要将大任务代码化扇出给多个智能体分阶段聚合处理时。'
  },
  'swarm': {
    title: 'Swarm 蜂群多智能体协作',
    summary: '在共享消息板上启动多个独立对话的工作智能体并行攻关与交叉复核。',
    whenToUse: '任务可清晰拆分为多个独立并行子任务或需要双人复核时。'
  },
  'archify': {
    title: '交互式架构/流程/时序图生成',
    summary: '把想法、方案、Mermaid 或代码库转为可交互的架构图、流程图、时序图、数据流与状态图，支持导出 HTML/PNG/SVG。',
    whenToUse: '做系统设计文档、代码库架构梳理或论文/汇报配图时。',
    example: '/archify 梳理当前仓库核心模块依赖并生成交互式架构图'
  },
  'graphify': {
    title: '代码库与知识图谱深度解析',
    summary: '将代码库、文档、论文或音视频构建为可查询的知识图谱（含 AST 提取、社区聚类与 HTML 交互图谱），大幅减少重复读文件 Token。',
    whenToUse: '快速吃透陌生大型代码库、梳理模块调用关系或建立项目知识图谱时。',
    example: '/graphify 分析当前项目目录并生成模块关系图谱'
  }
};

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lightweight zero-dependency YAML frontmatter parser for SKILL.md
 * Handles single-line strings, quoted strings, and YAML block scalars (|, |-, >, >-)
 */
function parseSkillFrontmatter(markdownText) {
  if (typeof markdownText !== 'string') return {};
  const text = markdownText.replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  const result = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1];
    let val = keyMatch[2].trim();

    if (val === '|' || val === '|-' || val === '>' || val === '>-' || val === '') {
      const isFolded = val.startsWith('>');
      const blockLines = [];
      i++;
      let baseIndent = null;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (/^[A-Za-z0-9_-]+:/.test(nextLine)) break;
        if (nextLine.trim() === '') {
          blockLines.push('');
          i++;
          continue;
        }
        const indentMatch = nextLine.match(/^(\s+)/);
        if (!indentMatch) break;
        if (baseIndent === null) baseIndent = indentMatch[1].length;
        blockLines.push(nextLine.slice(Math.min(baseIndent, indentMatch[1].length)));
        i++;
      }
      // Only capture simple scalar blocks (skip nested yaml maps unless key is name/description/trigger)
      if (val !== '' || key === 'description' || key === 'name' || key === 'trigger') {
        const joined = isFolded
          ? blockLines.map(s => s.trim()).filter(Boolean).join(' ')
          : blockLines.join('\n').trim();
        if (joined) result[key] = joined;
      }
      continue;
    }

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
    i++;
  }
  return result;
}

function findSkillMdFile(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const match = entries.find(e => e.isFile() && /^skill\.md$/i.test(e.name));
    return match ? path.join(dirPath, match.name) : null;
  } catch {
    return null;
  }
}

function estimateFrontmatterTokens(name, description) {
  const chars = String(name || '').length + String(description || '').length + 14;
  return Math.max(8, Math.ceil(chars / 3.5));
}

function getPrefsPath(options = {}) {
  if (options.prefsPath) return options.prefsPath;
  const stateDir = options.stateDir || getStateDir();
  return path.join(stateDir, 'commands-hub.json');
}

function getGeminiConfigDir(options = {}) {
  if (options.geminiConfigDir) return options.geminiConfigDir;
  return path.join(options.homeDir || os.homedir(), '.gemini', 'config');
}

function getNativeSkillsJsonPath(options = {}) {
  return path.join(getGeminiConfigDir(options), 'skills.json');
}

function loadNativePinnedAgentSkills(options = {}) {
  const skillsJsonPath = getNativeSkillsJsonPath(options);
  const data = safeReadJson(skillsJsonPath);
  const pinned = new Set();
  if (!data || !Array.isArray(data.entries)) {
    return { skillsJsonPath, pinned, raw: data };
  }
  for (const entry of data.entries) {
    if (!entry || typeof entry.path !== 'string') continue;
    const norm = entry.path.replace(/\\/g, '/').toLowerCase();
    if (norm === '~/.agents/skills' || norm.endsWith('/agent_skills/skills')) {
      if (Array.isArray(entry.include_only)) {
        for (const name of entry.include_only) {
          if (typeof name === 'string' && name.trim()) pinned.add(name.trim());
        }
      }
    }
  }
  return { skillsJsonPath, pinned, raw: data };
}

function saveNativePinnedAgentSkills(pinnedList, options = {}) {
  const skillsJsonPath = getNativeSkillsJsonPath(options);
  const cleanPinned = Array.from(new Set(
    (Array.isArray(pinnedList) ? pinnedList : [])
      .map(s => String(s || '').trim())
      .filter(s => s && !EXCLUDED_SKILL_DIRS.has(s))
  )).sort();

  const existing = safeReadJson(skillsJsonPath) || {};
  const entries = Array.isArray(existing.entries) ? existing.entries.slice() : [];
  const targetIdx = entries.findIndex(e => {
    if (!e || typeof e.path !== 'string') return false;
    const norm = e.path.replace(/\\/g, '/').toLowerCase();
    return norm === '~/.agents/skills' || norm.endsWith('/agent_skills/skills');
  });

  if (cleanPinned.length === 0) {
    if (targetIdx >= 0) entries.splice(targetIdx, 1);
  } else {
    // Prefer ~/.agents/skills if NTFS junction/folder exists (documented Antigravity syntax)
    const homeAgentsSkills = path.join(options.homeDir || os.homedir(), '.agents', 'skills');
    const mountPath = fs.existsSync(homeAgentsSkills)
      ? '~/.agents/skills'
      : path.join(options.agentSkillsRoot || DEFAULT_AGENT_SKILLS_ROOT, 'skills').replace(/\\/g, '/');

    const newEntry = {
      path: mountPath,
      include_only: cleanPinned,
      exclude: ['_shared', 'nature-shared']
    };
    if (targetIdx >= 0) entries[targetIdx] = newEntry;
    else entries.push(newEntry);
  }

  const nextDoc = { ...existing, entries };
  fs.mkdirSync(path.dirname(skillsJsonPath), { recursive: true });
  const tmpPath = `${skillsJsonPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextDoc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, skillsJsonPath);

  return {
    ok: true,
    skillsJsonPath,
    pinned: cleanPinned
  };
}

function loadCommandPrefs(options = {}) {
  const prefsPath = getPrefsPath(options);
  const existing = safeReadJson(prefsPath);
  if (existing && typeof existing === 'object') {
    return {
      favorites: Array.isArray(existing.favorites) ? existing.favorites : [],
      recent: Array.isArray(existing.recent) ? existing.recent : [],
      customCommands: Array.isArray(existing.customCommands) ? existing.customCommands : [],
      agentSkillsRoot: typeof existing.agentSkillsRoot === 'string' && existing.agentSkillsRoot.trim()
        ? existing.agentSkillsRoot.trim()
        : (options.agentSkillsRoot || DEFAULT_AGENT_SKILLS_ROOT)
    };
  }
  return {
    favorites: [
      'builtin:/compact',
      'builtin:/plan',
      'plugin:context7:context7-mcp',
      'agentskills:archify',
      'agentskills:graphify'
    ],
    recent: [],
    customCommands: [],
    agentSkillsRoot: options.agentSkillsRoot || DEFAULT_AGENT_SKILLS_ROOT
  };
}

function saveCommandPrefs(patch = {}, options = {}) {
  const current = loadCommandPrefs(options);
  const next = {
    favorites: Array.isArray(patch.favorites)
      ? Array.from(new Set(patch.favorites.map(String).filter(Boolean))).slice(0, 120)
      : current.favorites,
    recent: Array.isArray(patch.recent)
      ? Array.from(new Set(patch.recent.map(String).filter(Boolean))).slice(0, 20)
      : current.recent,
    customCommands: Array.isArray(patch.customCommands)
      ? patch.customCommands
        .filter(c => c && typeof c.command === 'string' && c.command.trim())
        .slice(0, 60)
        .map(c => ({
          id: String(c.id || `custom:${c.command.trim()}`),
          command: c.command.trim(),
          insertText: String(c.insertText || c.command.trim()),
          title: String(c.title || c.command.trim()),
          summary: String(c.summary || ''),
          category: String(c.category || '自定义快捷指令')
        }))
      : current.customCommands,
    agentSkillsRoot: typeof patch.agentSkillsRoot === 'string' && patch.agentSkillsRoot.trim()
      ? patch.agentSkillsRoot.trim()
      : current.agentSkillsRoot
  };

  const prefsPath = getPrefsPath(options);
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(next, null, 2), 'utf8');
  return { ok: true, prefs: next };
}

function scanInstalledPluginsAndSkills(options = {}) {
  const items = [];
  const geminiConfigDir = getGeminiConfigDir(options);
  const configJson = safeReadJson(path.join(geminiConfigDir, 'config.json')) || {};
  const pluginsCfg = (configJson && typeof configJson.plugins === 'object') ? configJson.plugins : {};

  // 1. Installed plugins (~/.gemini/config/plugins/<plugin>/skills/<skill>/SKILL.md)
  const pluginsRoot = path.join(geminiConfigDir, 'plugins');
  if (fs.existsSync(pluginsRoot)) {
    let pluginDirs = [];
    try { pluginDirs = fs.readdirSync(pluginsRoot, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
    for (const pDir of pluginDirs) {
      const pluginId = pDir.name;
      if (pluginId === 'antigravity-context-suite-keeper') continue;
      const pluginPath = path.join(pluginsRoot, pluginId);
      const pluginManifest = safeReadJson(path.join(pluginPath, 'plugin.json')) || {};
      const pluginEnabled = pluginsCfg[pluginId]?.enabled !== false && pluginManifest.disabled !== true;
      const pluginDisplay = pluginManifest.displayName || pluginManifest.name || pluginId;

      const skillsDir = path.join(pluginPath, 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      let skillDirs = [];
      try { skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
      for (const sDir of skillDirs) {
        const skillMdPath = findSkillMdFile(path.join(skillsDir, sDir.name));
        if (!skillMdPath) continue;
        let fm = {};
        try { fm = parseSkillFrontmatter(fs.readFileSync(skillMdPath, 'utf8')); } catch {}
        const slashName = (fm.name || sDir.name).trim();
        const gloss = KNOWN_SKILL_ZH_GLOSSES[slashName] || KNOWN_SKILL_ZH_GLOSSES[sDir.name] || null;
        const enDesc = (fm.description || pluginManifest.description || '').trim();
        items.push({
          id: `plugin:${pluginId}:${slashName}`,
          command: `/${slashName}`,
          aliases: pluginId !== slashName ? [`/${pluginId}`] : [],
          insertText: `/${slashName} `,
          title: gloss?.title || `${pluginDisplay} · ${slashName}`,
          source: 'plugin',
          sourceLabel: `插件: ${pluginDisplay}`,
          pluginId,
          enabled: pluginEnabled,
          category: pluginId === 'science' ? '科研插件 (Science)' : '已装插件与技能',
          costTag: pluginEnabled ? '原生已启用' : '已禁用',
          costTone: pluginEnabled ? 'good' : 'muted',
          summary: gloss?.summary || enDesc || `${pluginDisplay} 插件提供的技能指令。`,
          enDescription: enDesc,
          whenToUse: gloss?.whenToUse || '',
          example: gloss?.example || `/${slashName} `,
          skillPath: skillMdPath,
          nativeMounted: pluginEnabled,
          estimatedTokens: estimateFrontmatterTokens(slashName, enDesc)
        });
      }
    }
  }

  // 2. Global user skills (~/.gemini/config/skills/<skill>/SKILL.md)
  const globalSkillsRoot = path.join(geminiConfigDir, 'skills');
  if (fs.existsSync(globalSkillsRoot)) {
    let skillDirs = [];
    try { skillDirs = fs.readdirSync(globalSkillsRoot, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
    for (const sDir of skillDirs) {
      const skillMdPath = findSkillMdFile(path.join(globalSkillsRoot, sDir.name));
      if (!skillMdPath) continue;
      let fm = {};
      try { fm = parseSkillFrontmatter(fs.readFileSync(skillMdPath, 'utf8')); } catch {}
      const slashName = (fm.name || sDir.name).trim();
      const gloss = KNOWN_SKILL_ZH_GLOSSES[slashName] || KNOWN_SKILL_ZH_GLOSSES[sDir.name] || null;
      const enDesc = (fm.description || '').trim();
      items.push({
        id: `global:${slashName}`,
        command: `/${slashName}`,
        insertText: `/${slashName} `,
        title: gloss?.title || slashName,
        source: 'global_skill',
        sourceLabel: '全局技能',
        enabled: true,
        category: '已装插件与技能',
        costTag: '全局已挂载',
        costTone: 'good',
        summary: gloss?.summary || enDesc || '本机全局自定义技能。',
        enDescription: enDesc,
        whenToUse: gloss?.whenToUse || '',
        example: `/${slashName} `,
        skillPath: skillMdPath,
        nativeMounted: true,
        estimatedTokens: estimateFrontmatterTokens(slashName, enDesc)
      });
    }
  }

  // 3. Built-in Antigravity skills (~/.gemini/antigravity/builtin/skills)
  const builtinSkillsRoot = path.join(options.homeDir || os.homedir(), '.gemini', 'antigravity', 'builtin', 'skills');
  if (fs.existsSync(builtinSkillsRoot)) {
    let skillDirs = [];
    try { skillDirs = fs.readdirSync(builtinSkillsRoot, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
    for (const sDir of skillDirs) {
      if (INTERNAL_BUILTIN_SKILLS.has(sDir.name)) continue;
      const skillMdPath = findSkillMdFile(path.join(builtinSkillsRoot, sDir.name));
      if (!skillMdPath) continue;
      let fm = {};
      try { fm = parseSkillFrontmatter(fs.readFileSync(skillMdPath, 'utf8')); } catch {}
      const slashName = (fm.name || sDir.name).trim();
      // Skip skills already represented as top-level built-in slash commands
      if (BUILTIN_SLASH_COMMANDS.some(c => c.command === `/${slashName}`)) continue;
      const gloss = KNOWN_SKILL_ZH_GLOSSES[slashName] || KNOWN_SKILL_ZH_GLOSSES[sDir.name] || null;
      const enDesc = (fm.description || '').trim();
      items.push({
        id: `builtin-skill:${slashName}`,
        command: `/${slashName}`,
        insertText: `/${slashName} `,
        title: gloss?.title || slashName,
        source: 'builtin_skill',
        sourceLabel: '官方内置技能',
        enabled: true,
        category: '官方内置技能',
        costTag: '按需渐进加载',
        costTone: 'info',
        summary: gloss?.summary || enDesc || 'Antigravity 官方内置技能。',
        enDescription: enDesc,
        whenToUse: gloss?.whenToUse || '',
        example: `/${slashName} `,
        skillPath: skillMdPath,
        nativeMounted: true,
        estimatedTokens: estimateFrontmatterTokens(slashName, enDesc)
      });
    }
  }

  return items;
}

function scanAgentSkillsLibrary(agentSkillsRoot, pinnedSet) {
  const items = [];
  const categoriesSet = new Set();
  if (!agentSkillsRoot || !fs.existsSync(agentSkillsRoot)) {
    return { items, categories: [], totalDiskSkills: 0, rootExists: false };
  }

  const skillsDir = path.join(agentSkillsRoot, 'skills');
  if (!fs.existsSync(skillsDir)) {
    return { items, categories: [], totalDiskSkills: 0, rootExists: false };
  }

  // Load skills-catalog.json if present for Chinese category + purpose
  const catalogPath = path.join(agentSkillsRoot, 'registry', 'skills-catalog.json');
  const catalogRaw = safeReadJson(catalogPath);
  const catalogByDir = new Map();
  if (Array.isArray(catalogRaw)) {
    for (const row of catalogRaw) {
      if (row && typeof row.directory === 'string') {
        catalogByDir.set(row.directory.trim(), row);
      }
    }
  }

  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !EXCLUDED_SKILL_DIRS.has(d.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {}

  for (const dirEntry of entries) {
    const dirName = dirEntry.name;
    const fullDir = path.join(skillsDir, dirName);
    const skillMdPath = findSkillMdFile(fullDir);
    if (!skillMdPath) continue;

    let fm = {};
    try { fm = parseSkillFrontmatter(fs.readFileSync(skillMdPath, 'utf8')); } catch {}
    const slashName = (fm.name || dirName).trim();
    const triggerCmd = (typeof fm.trigger === 'string' && fm.trigger.trim().startsWith('/'))
      ? fm.trigger.trim()
      : `/${slashName}`;
    const catalogEntry = catalogByDir.get(dirName) || null;
    const gloss = KNOWN_SKILL_ZH_GLOSSES[slashName] || KNOWN_SKILL_ZH_GLOSSES[dirName] || null;
    const category = catalogEntry?.category || '未分类';
    categoriesSet.add(category);

    const enDesc = (fm.description || '').trim();
    const zhPurpose = gloss?.summary || catalogEntry?.purpose || enDesc || `本地技能 ${dirName}`;
    const isPinned = pinnedSet.has(dirName) || pinnedSet.has(slashName);
    const estimatedTokens = estimateFrontmatterTokens(slashName, enDesc);

    // Dual-layer insertion:
    //  - If natively pinned in ~/.gemini/config/skills.json -> direct native /<name> invocation
    //  - If unpinned -> zero-overhead explicit on-demand file-read prompt
    const insertText = isPinned
      ? `${triggerCmd} `
      : `请先读取并严格遵循技能文件 ${skillMdPath} 执行以下任务：\n`;

    const aliases = [];
    if (dirName !== slashName) aliases.push(`/${dirName}`);
    if (dirName === 'graphify') aliases.push('/codegraph', 'codegraph');

    items.push({
      id: `agentskills:${dirName}`,
      directory: dirName,
      slashName,
      command: triggerCmd,
      aliases,
      insertText,
      nativeInsertText: `${triggerCmd} `,
      onDemandInsertText: `请先读取并严格遵循技能文件 ${skillMdPath} 执行以下任务：\n`,
      title: gloss?.title || `${slashName}${dirName !== slashName ? ` (${dirName})` : ''}`,
      source: 'agent_skills',
      sourceLabel: 'E:\\agent_skills',
      category,
      costTag: isPinned ? `原生挂载 (~${estimatedTokens} tok)` : '按需触发 (0 常驻)',
      costTone: isPinned ? 'good' : 'muted',
      summary: zhPurpose,
      enDescription: enDesc,
      whenToUse: gloss?.whenToUse || '',
      example: gloss?.example || `${triggerCmd} `,
      skillPath: skillMdPath,
      nativeMounted: isPinned,
      canPinNative: true,
      estimatedTokens
    });
  }

  return {
    items,
    categories: Array.from(categoriesSet),
    totalDiskSkills: items.length,
    rootExists: true
  };
}

function listAllCommands(options = {}) {
  const prefs = loadCommandPrefs(options);
  const agentSkillsRoot = options.agentSkillsRoot || prefs.agentSkillsRoot || DEFAULT_AGENT_SKILLS_ROOT;
  const nativeState = loadNativePinnedAgentSkills(options);

  const builtinItems = BUILTIN_SLASH_COMMANDS.map(item => ({
    ...item,
    sourceLabel: 'Antigravity 官方内置',
    nativeMounted: true,
    canPinNative: false,
    estimatedTokens: 0
  }));

  const installedItems = scanInstalledPluginsAndSkills(options);
  const agentSkillsScan = scanAgentSkillsLibrary(agentSkillsRoot, nativeState.pinned);

  const customItems = (prefs.customCommands || []).map(c => ({
    ...c,
    source: 'custom',
    sourceLabel: '个人自定义',
    costTag: '快捷模板',
    costTone: 'info',
    nativeMounted: false,
    canPinNative: false,
    estimatedTokens: 0
  }));

  const allItems = [...builtinItems, ...installedItems, ...agentSkillsScan.items, ...customItems];

  const favSet = new Set(prefs.favorites || []);
  const recentOrder = new Map((prefs.recent || []).map((id, idx) => [id, idx]));

  for (const item of allItems) {
    item.isFavorite = favSet.has(item.id);
    item.recentRank = recentOrder.has(item.id) ? recentOrder.get(item.id) : -1;
  }

  const pinnedItems = agentSkillsScan.items.filter(i => i.nativeMounted);
  const pinnedTokens = pinnedItems.reduce((acc, i) => acc + (i.estimatedTokens || 0), 0);

  return {
    ok: true,
    items: allItems,
    stats: {
      total: allItems.length,
      builtinCount: builtinItems.length,
      installedCount: installedItems.length,
      agentSkillsCount: agentSkillsScan.totalDiskSkills,
      customCount: customItems.length,
      agentSkillsRoot,
      agentSkillsRootExists: agentSkillsScan.rootExists,
      agentSkillsCategories: agentSkillsScan.categories,
      nativePinnedCount: pinnedItems.length,
      nativePinnedTokens: pinnedTokens,
      skillsJsonPath: nativeState.skillsJsonPath
    },
    prefs
  };
}

function toggleNativeSkillPin(directoryOrId, shouldPin, options = {}) {
  const cleanDir = String(directoryOrId || '').replace(/^agentskills:/, '').trim();
  if (!cleanDir || EXCLUDED_SKILL_DIRS.has(cleanDir)) {
    return { ok: false, error: '无效的技能目录名' };
  }
  const current = loadNativePinnedAgentSkills(options);
  const nextSet = new Set(current.pinned);
  if (shouldPin) nextSet.add(cleanDir);
  else nextSet.delete(cleanDir);

  const saved = saveNativePinnedAgentSkills(Array.from(nextSet), options);
  const refreshed = listAllCommands(options);
  return {
    ok: true,
    directory: cleanDir,
    pinned: Boolean(shouldPin),
    skillsJsonPath: saved.skillsJsonPath,
    pinnedList: saved.pinned,
    data: refreshed
  };
}

module.exports = {
  BUILTIN_SLASH_COMMANDS,
  DEFAULT_AGENT_SKILLS_ROOT,
  parseSkillFrontmatter,
  loadCommandPrefs,
  saveCommandPrefs,
  loadNativePinnedAgentSkills,
  saveNativePinnedAgentSkills,
  toggleNativeSkillPin,
  listAllCommands
};
