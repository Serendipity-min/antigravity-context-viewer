'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadHostI18nPack, clearHostI18nCache } = require('./meter-i18n-host');
const {
  parseSkillFrontmatter,
  listAllCommands,
  saveCommandPrefs,
  toggleNativeSkillPin
} = require('./meter-commands');
const {
  calculateCacheHitStats,
  isCanceledStreamMessage,
  readConversationContextBreakdown
} = require('./meter-context-breakdown');
const {
  getKeeperStatus,
  installKeeper,
  uninstallKeeper
} = require('./meter-keeper');

describe('Personal Suite Backend Modules', () => {
  describe('meter-i18n-host (Layered v2.33.0+ Dictionary)', () => {
    it('loads bundled MIT v2.33.0+ dictionary + supplement and resolves all v2.33.0 screenshot strings', () => {
      clearHostI18nCache();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-test-'));
      try {
        const pack = loadHostI18nPack({ stateDir: tmpDir, noCache: true });
        assert.equal(pack.ok, true);
        assert.ok(pack.meta.exactCount >= 4250, `Expected >= 4250 exact entries, got ${pack.meta.exactCount}`);
        assert.ok(pack.meta.coreWordsCount >= 100);
        // Check previously missing v2.33.0 UI strings
        assert.equal(pack.exact['Interface Layout'], '界面布局');
        assert.equal(pack.exact['Knowledge Work'], '知识工作');
        assert.equal(pack.exact['Software Engineering'], '软件工程');
        assert.equal(pack.exact['Voice mode'], '语音模式');
        assert.equal(pack.exact['This Computer'], '本机');
        assert.equal(pack.exact['Remote'], '远程');
        assert.equal(pack.exact['Powered by Gemini Live'], '由 Gemini Live 提供支持');
        assert.equal(pack.exact['System default'], '系统默认');
        assert.equal(pack.exact['Not set'], '未设置');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('supports user custom overrides and null tombstones', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-i18n-custom-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'i18n-custom.json'), JSON.stringify({
          exact: {
            'Remote': '远程主机',
            'Voice mode': null
          }
        }), 'utf8');
        const pack = loadHostI18nPack({ stateDir: tmpDir, noCache: true });
        assert.equal(pack.exact['Remote'], '远程主机');
        assert.equal(pack.exact['Voice mode'], undefined);
        assert.equal(pack.meta.hasCustomLayer, true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('meter-commands (Slash Commands & E:\\agent_skills Dual-Layer Hub)', () => {
    it('parses single-line, quoted, and folded YAML frontmatter', () => {
      const md = `---\nname: demo-skill\ndescription: >-\n  Line one\n  line two.\ntrigger: /demo\n---\n# Body\n`;
      const fm = parseSkillFrontmatter(md);
      assert.equal(fm.name, 'demo-skill');
      assert.equal(fm.description, 'Line one line two.');
      assert.equal(fm.trigger, '/demo');
    });

    it('scans synthetic plugins, skills, and handles dual-layer native pinning cleanly', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cmd-test-'));
      const fakeHome = path.join(tmpRoot, 'home');
      const fakeState = path.join(tmpRoot, 'state');
      const fakeAgentSkills = path.join(tmpRoot, 'agent_skills');
      try {
        // Fake plugin: context7
        const c7Dir = path.join(fakeHome, '.gemini', 'config', 'plugins', 'context7', 'skills', 'context7-mcp');
        fs.mkdirSync(c7Dir, { recursive: true });
        fs.writeFileSync(path.join(fakeHome, '.gemini', 'config', 'plugins', 'context7', 'plugin.json'), JSON.stringify({ name: 'context7', displayName: 'Context7' }));
        fs.writeFileSync(path.join(c7Dir, 'SKILL.md'), '---\nname: context7-mcp\ndescription: Fetch live docs.\n---\n');

        // Fake E:\agent_skills with archify (SKILL.md), graphify (lowercase skill.md), and _shared (excluded)
        fs.mkdirSync(path.join(fakeAgentSkills, 'skills', 'archify'), { recursive: true });
        fs.mkdirSync(path.join(fakeAgentSkills, 'skills', 'graphify'), { recursive: true });
        fs.mkdirSync(path.join(fakeAgentSkills, 'skills', '_shared'), { recursive: true });
        fs.mkdirSync(path.join(fakeAgentSkills, 'registry'), { recursive: true });
        fs.writeFileSync(path.join(fakeAgentSkills, 'skills', 'archify', 'SKILL.md'), '---\nname: archify\ndescription: Architecture diagram skill.\n---\n');
        fs.writeFileSync(path.join(fakeAgentSkills, 'skills', 'graphify', 'skill.md'), '---\nname: graphify\ntrigger: /graphify\ndescription: Knowledge graph builder.\n---\n');
        fs.writeFileSync(path.join(fakeAgentSkills, 'registry', 'skills-catalog.json'), JSON.stringify([
          { directory: 'archify', category: '设计与前端', purpose: '交互式架构图生成' },
          { directory: 'graphify', category: '浏览器、开发与技能工具', purpose: '代码知识图谱构建' }
        ]));

        const opts = { homeDir: fakeHome, stateDir: fakeState, agentSkillsRoot: fakeAgentSkills };
        const initial = listAllCommands(opts);
        assert.equal(initial.ok, true);
        assert.ok(initial.items.some(i => i.command === '/compact'));
        assert.ok(initial.items.some(i => i.id === 'plugin:context7:context7-mcp'));
        const arch = initial.items.find(i => i.id === 'agentskills:archify');
        const graph = initial.items.find(i => i.id === 'agentskills:graphify');
        assert.ok(arch && graph);
        assert.equal(arch.nativeMounted, false);
        assert.ok(arch.insertText.includes('请先读取并严格遵循技能文件'));
        assert.ok(graph.aliases.includes('/codegraph'));

        // Pin archify natively
        const pinnedRes = toggleNativeSkillPin('archify', true, opts);
        assert.equal(pinnedRes.ok, true);
        assert.deepEqual(pinnedRes.pinnedList, ['archify']);
        const skillsJson = JSON.parse(fs.readFileSync(path.join(fakeHome, '.gemini', 'config', 'skills.json'), 'utf8'));
        assert.equal(skillsJson.entries.length, 1);
        assert.deepEqual(skillsJson.entries[0].include_only, ['archify']);
        const archAfter = pinnedRes.data.items.find(i => i.id === 'agentskills:archify');
        assert.equal(archAfter.nativeMounted, true);
        assert.equal(archAfter.insertText, '/archify ');

        // Save favorites & custom command
        const savedPrefs = saveCommandPrefs({
          favorites: ['builtin:/compact', 'agentskills:graphify'],
          customCommands: [{ command: '/my-review', title: '自用代码审查', insertText: '请按严格工程标准审查改动：' }]
        }, opts);
        assert.equal(savedPrefs.ok, true);
        const afterPrefs = listAllCommands(opts);
        assert.ok(afterPrefs.items.some(i => i.command === '/my-review'));

        // Unpin archify
        const unpinRes = toggleNativeSkillPin('archify', false, opts);
        assert.deepEqual(unpinRes.pinnedList, []);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('meter-context-breakdown (KV Cache Hit Rate, PR #38 Cancel, Breakdown)', () => {
    it('computes KV cache hit rate with cacheWrite counted as uncached prompt input', () => {
      const s1 = calculateCacheHitStats(1000, 9000, 0);
      assert.equal(s1.hitRate, 90.0);
      assert.equal(s1.tier, 'high');

      // cacheWrite=2000 must count into uncached (1000+2000=3000), total=10000, hitRate=70%
      const s2 = calculateCacheHitStats(1000, 7000, 2000);
      assert.equal(s2.uncachedInput, 3000);
      assert.equal(s2.totalPromptTokens, 10000);
      assert.equal(s2.hitRate, 70.0);
      assert.equal(s2.tier, 'mid');

      // Cold start: 0 cached, positive fresh -> 0.0% (not null)
      const s3 = calculateCacheHitStats(500, 0, 0);
      assert.equal(s3.hitRate, 0);
      assert.equal(s3.tier, 'low');

      const s4 = calculateCacheHitStats(0, 0, 0);
      assert.equal(s4.hitRate, null);
    });

    it('classifies Go context canceled streams as neutral interruptions', () => {
      assert.equal(isCanceledStreamMessage('stream reading error: context canceled'), true);
      assert.equal(isCanceledStreamMessage('Post "https://...": context canceled'), true);
      assert.equal(isCanceledStreamMessage('AbortError: user cancelled request'), true);
      assert.equal(isCanceledStreamMessage('503 Service Unavailable'), false);
    });

    it('gracefully handles missing conversation db without throwing', () => {
      const res = readConversationContextBreakdown('00000000-0000-0000-0000-000000000000', { agDir: os.tmpdir() });
      assert.equal(res.available, false);
    });
  });

  describe('meter-keeper (Headless Update-Resilient Sidecar Keeper)', () => {
    it('installs, reports status, and uninstalls headless sidecar plugin cleanly', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-keeper-test-'));
      const fakeHome = path.join(tmpRoot, 'home');
      const fakeState = path.join(tmpRoot, 'state');
      try {
        const opts = { homeDir: fakeHome, stateDir: fakeState, repoDir: __dirname };
        assert.equal(getKeeperStatus(opts).installed, false);

        const ins = installKeeper(opts);
        assert.equal(ins.ok, true);
        assert.equal(ins.installed, true);
        const sidecarManifest = JSON.parse(fs.readFileSync(path.join(ins.pluginDir, 'sidecars', 'keeper', 'sidecar.json'), 'utf8'));
        assert.equal(sidecarManifest.restart_policy, 'never');
        assert.equal(sidecarManifest.has_web_ui, undefined);

        assert.equal(getKeeperStatus(opts).installed, true);

        const rm = uninstallKeeper(opts);
        assert.equal(rm.ok, true);
        assert.equal(getKeeperStatus(opts).installed, false);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('Desktop-Only Renderer Bundle & Slimming Assertions', () => {
    it('compiled meter-renderer.js includes all personal suite modules and excludes stripped bloat', () => {
      const bundle = fs.readFileSync(path.join(__dirname, 'meter-renderer.js'), 'utf8');
      // Present: new personal suite features
      for (const marker of [
        'HostI18nController',
        'CommandsHubController',
        'AutoRetryController',
        'findComposerFooterRightGroup',
        'id="badge-commands"',
        'id="panel-commands"',
        'id="kv-cache-card"',
        'id="ctx-breakdown-card"',
        'id="quota-ring-mode-bar"',
        'id="keeper-card"',
        'id="auto-retry-card"',
        'Serendipity-min/antigravity-context-viewer'
      ]) {
        assert.ok(bundle.includes(marker), `Expected renderer bundle to include ${marker}`);
      }
      // Absent: removed bloat UI
      for (const removed of [
        'id="badge-cli"',
        'id="btn-check-update-ctx"',
        'id="btn-check-update"',
        'id="proxy-notun-drawer"',
        'id="enhance-preset-card"',
        'id="quota-accounts-section"',
        'id="tab-ctx-models"'
      ]) {
        assert.ok(!bundle.includes(removed), `Expected renderer bundle NOT to include removed UI ${removed}`);
      }

      // Regression: .cmd-card must never shrink to 0px inside flex .cmd-hub-list,
      // and .cmd-subcat-bar[hidden] must override display:flex.
      assert.match(bundle, /\.cmd-card\s*\{[^}]*flex-shrink:\s*0/, 'Expected .cmd-card to include flex-shrink: 0');
      assert.match(bundle, /\.cmd-subcat-bar\[hidden\][\s\S]*?display:\s*none\s*!important/, 'Expected .cmd-subcat-bar[hidden] to force display: none !important');
      assert.ok(bundle.includes('measureComposerLeftIntrinsicWidth'), 'Expected flex-grow-safe composer width measurement');
    });
  });
});
