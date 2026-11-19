# Antigravity Desktop 个性化增强套件 (`v0.9.0 Personal`)

> 本项目基于 MIT 协议派生自 [elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)，面向 **Google Antigravity Desktop 2.3x+** 做深度精简与个性化增强（保留完整 MIT 许可证与第三方署名，详见 [LICENSE](LICENSE) 与 [i18n/THIRD_PARTY_LICENSES.md](i18n/THIRD_PARTY_LICENSES.md)）。

## 核心特性

1. **底部对话框工具栏停靠 + 面板向上展开**
   - 直接停靠在 `.agy-composer-footer`（`极速 / Turbo` 按钮左侧），保持极简 5 单元对称布局：
     `[ 〇 额度(5h/周) ]  [ 〇 上下文% ]  [ ⚡ tok/s ]  [ 📊 总用量 ]  [ / 指令 ]`
   - 所有弹出面板自适应向**上方**展开，不遮挡输入框与左侧栏。
2. **`/` 指令与本地技能中心（`#panel-commands`）**
   - 整合四大来源：
     - **官方内置 `/` 指令中文百科**：`/compact`、`/plan`、`/grill-me`、`/boost`、`/goal`、`/teamwork`、`/browser`、`/schedule`、`/automation`、`/learn`、`/plugin`、`/btw`，逐条标注适用场景、不建议场景、用法示例与消耗提示。
     - **已装插件与全局技能动态扫描**：自动识别 `~/.gemini/config/plugins/`（如 `context7-mcp`、`science`、`android-cli-plugin`）、`~/.gemini/config/skills/`（如 `easyeda-api`）及官方内置技能。
     - **`E:\agent_skills` 全量技能库接入（113+ 技能）**：自动合并 `registry/skills-catalog.json` 分类与中文简介，大小写不敏感扫描 `SKILL.md` / `skill.md`（包含 `archify`、`graphify` 等）。
     - **双层调用机制（省 Token 预算）**：支持为高频技能点亮「⚡ 原生挂载」写入 `~/.gemini/config/skills.json`（原生 `/` 补全）；其余未挂载技能常驻 **0 Token** 占用，点击「填入」自动生成按需读取提示并填入输入框（**只填入，不自动发送**）。
3. **重构客户端界面汉化（`v2.33.0+` · 免重启实时开关）**
   - 修复原版在 Electron `sandbox` 沙箱中 `preload.js` 门禁失效的 Bug，迁移至主进程 IPC（`meter-i18n-host.js`）+ 分层外置字典。
   - 接入 MIT 开源 [Antigravity-Chinese-Localization](https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization) 的 `v2.33.0+` 全量词典（4,264+ 词条）与补丁层（`i18n/zh-CN.supplement.json`），完整覆盖 `Interface Layout`、`Voice mode`、`This Computer / Remote` 等新版界面。
   - 基于 `WeakMap` 非破坏性叶节点翻译 + 聊天正文防误译保护 + 打字防抖（Anti-Thrashing），支持在面板「配置」页内**一键实时切换中/英文，无需重启客户端**。
4. **上下文精细拆解 + KV 缓存命中率 + 5h/周配额环切换**
   - 纯 Node.js（`node:sqlite` + 零依赖 Protobuf 解码）直读本机会话 `gen_metadata`，将当前上下文按系统提示词 / 内置工具 / Rules / Skills / MCP / 对话 / 工具输出及已读文件精细拆解。
   - 展示实时 **KV 缓存命中率**（`cacheWrite` 正确计入未命中输入）及命中率骤降提醒，中性归类 `context canceled` 中断状态。
   - 额度看板支持在底栏圆环自由切换优先显示 **自动 / 5h 额度 / 周额度**。
5. **503 限流瞬时错误自动重试开关**
   - 在「配置」页提供独立开关与最大重试次数（1–3 次），遇到 `503 No capacity available` 等瞬时过载错误时自动退避重试。
6. **更新后无界面自愈守护（Headless Sidecar Keeper）**
   - 通过官方 `~/.gemini/config/plugins/antigravity-context-suite-keeper/` 注册无 UI 一次性 Sidecar（`restart_policy: "never"`），每次 Antigravity 官方自动更新重启后自动检测并静默重装补丁。
7. **纯 Desktop 极致瘦身**
   - 彻底剥离：上下文加长（256K 二进制修补）、系统提示词二进制修补、免 TUN 代理拦截、Antigravity CLI 启动器与 CLI 扫描、多账号自动切换与上游在线检查更新按钮。

---

## 快速安装与日常管理

> 零第三方 npm 依赖，需 Node.js `>= 22.4.0`（支持 `node:sqlite`）。

```powershell
# 1. 构建渲染层产物并运行全部单元测试
npm run build:renderer
npm test

# 2. 持久化安装至本机 Antigravity app.asar 并自动部署自愈守护
node cli.js install

# 3. 查看模块与自愈守护状态
node cli.js modules
node cli.js keeper status

# 4. 一键无损还原原版 app.asar（加 --with-keeper 可同步移除守护进程）
node cli.js restore
```

> **提示**：Antigravity `v2.33.0` 起默认关闭了远程调试端口（CDP），因此 `node cli.js install` 完成持久化注入后，**完全退出并重新打开一次 Antigravity 客户端**即可加载全部新版主进程与渲染层模块。

---

## 许可与致谢

- 本项目沿用 **MIT License**，详见 [LICENSE](LICENSE)。
- 第三方开源致谢与许可证全文见 [i18n/THIRD_PARTY_LICENSES.md](i18n/THIRD_PARTY_LICENSES.md)。
