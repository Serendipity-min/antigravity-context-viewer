'use strict';
/**
 * Headless Update-Resilient Sidecar Keeper Manager (meter-keeper.js)
 *
 * Registers an official Antigravity headless sidecar plugin under:
 *   ~/.gemini/config/plugins/antigravity-context-suite/
 *     ├── plugin.json
 *     └── sidecars/keeper/
 *         ├── sidecar.json   (restart_policy: "never", no web UI -> silent one-shot on launch)
 *         └── keeper.js      (detects if an Antigravity update wiped our ASAR patch & re-applies cleanly)
 *
 * Architectural pattern inspired by Apache-2.0 materialwebunofficial/antigravity-themes;
 * implementation written independently for this MIT suite.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getStateDir } = require('./asar-engine');

const KEEPER_PLUGIN_ID = 'antigravity-context-suite-keeper';

function getGeminiConfigDir(options = {}) {
  if (options.geminiConfigDir) return options.geminiConfigDir;
  const home = options.homeDir || os.homedir();
  return path.join(home, '.gemini', 'config');
}

function getKeeperPluginDir(options = {}) {
  return path.join(getGeminiConfigDir(options), 'plugins', KEEPER_PLUGIN_ID);
}

function getKeeperStatePath(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  return path.join(stateDir, 'keeper-status.json');
}

function buildKeeperScript(repoDir) {
  const safeRepoDir = JSON.stringify(path.resolve(repoDir));
  return `'use strict';
// Antigravity Context Suite — Headless Update-Resilient Sidecar Keeper
// Runs once on Antigravity launch (restart_policy: "never"), checks if our patch was wiped by an app update,
// and silently re-applies it so the suite survives Antigravity auto-updates.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_DIR = ${safeRepoDir};
const LOG_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AntigravityContextMeter');
const LOG_FILE = path.join(LOG_DIR, 'keeper.log');
const STATE_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'AntigravityContextMeter',
  'keeper-status.json'
);

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
      if (st && st.size > 256 * 1024) fs.writeFileSync(LOG_FILE, '', 'utf8');
    } catch {}
    fs.appendFileSync(LOG_FILE, \`[\${new Date().toISOString()}] \${msg}\\n\`, 'utf8');
  } catch {}
}

function writeStatus(patch) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    let prev = {};
    try {
      if (fs.existsSync(STATE_FILE)) prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {}
    const next = { ...prev, ...patch, checkedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {}
}

function resolveAsarFromHost() {
  try {
    const execDir = path.dirname(process.execPath || '');
    const candidate = path.join(execDir, 'resources', 'app.asar');
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  try {
    const { findAsarPath } = require(path.join(REPO_DIR, 'asar-engine.js'));
    return findAsarPath();
  } catch {
    return null;
  }
}

async function run() {
  if (!fs.existsSync(path.join(REPO_DIR, 'install.js'))) {
    log('Repo directory not found: ' + REPO_DIR);
    writeStatus({ lastResult: 'repo_missing', repoDir: REPO_DIR });
    return;
  }

  const asarPath = resolveAsarFromHost();
  if (!asarPath || !fs.existsSync(asarPath)) {
    log('Could not locate host app.asar');
    writeStatus({ lastResult: 'asar_missing' });
    return;
  }

  const { builtinAsar } = require(path.join(REPO_DIR, 'asar-engine.js'));
  const hostPkg = JSON.parse(builtinAsar.extractFile(asarPath, 'package.json').toString('utf8'));
  const utilsSrc = builtinAsar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
  const alreadyPatched = utilsSrc.includes('installContextMeter');

  if (alreadyPatched) {
    log(\`Patch intact on Antigravity v\${hostPkg.version}; exiting.\`);
    writeStatus({ lastResult: 'intact', hostVersion: hostPkg.version, asarPath });
    return;
  }

  log(\`Detected unpatched Antigravity v\${hostPkg.version} after update; auto-reapplying suite from \${REPO_DIR}...\`);
  try {
    const { install } = require(path.join(REPO_DIR, 'install.js'));
    await install({ path: asarPath, skipKeeperSync: true });
    log(\`Auto-repatch succeeded for Antigravity v\${hostPkg.version}. Restart Antigravity once if UI did not hot-mount.\`);
    writeStatus({
      lastResult: 'repatched',
      hostVersion: hostPkg.version,
      asarPath,
      lastRepatchedAt: new Date().toISOString()
    });
  } catch (err) {
    log('Auto-repatch failed: ' + (err?.message || String(err)));
    writeStatus({
      lastResult: 'failed',
      hostVersion: hostPkg.version,
      asarPath,
      lastError: err?.message || String(err)
    });
  }
}

run().catch(e => log('Unhandled keeper error: ' + (e?.stack || e))).finally(() => process.exit(0));
`;
}

function getKeeperStatus(options = {}) {
  const pluginDir = getKeeperPluginDir(options);
  const sidecarJsonPath = path.join(pluginDir, 'sidecars', 'keeper', 'sidecar.json');
  const keeperJsPath = path.join(pluginDir, 'sidecars', 'keeper', 'keeper.js');
  const installed = fs.existsSync(sidecarJsonPath) && fs.existsSync(keeperJsPath);

  let lastState = null;
  try {
    const sp = getKeeperStatePath(options);
    if (fs.existsSync(sp)) lastState = JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch {}

  let repoDir = options.repoDir || __dirname;
  if (installed) {
    try {
      const code = fs.readFileSync(keeperJsPath, 'utf8');
      const m = code.match(/const REPO_DIR = ("[^"]+");/);
      if (m) repoDir = JSON.parse(m[1]);
    } catch {}
  }

  return {
    ok: true,
    installed,
    pluginId: KEEPER_PLUGIN_ID,
    pluginDir,
    repoDir,
    lastState
  };
}

function installKeeper(options = {}) {
  const repoDir = path.resolve(options.repoDir || __dirname);
  const pluginDir = getKeeperPluginDir(options);
  const sidecarDir = path.join(pluginDir, 'sidecars', 'keeper');

  // If called from inside app.asar/dist, refuse to point REPO_DIR inside app.asar
  if (repoDir.toLowerCase().includes('.asar')) {
    return {
      ok: false,
      error: '请从本地源码仓库目录安装自愈守护进程，避免指向易被更新覆盖的 app.asar 内部路径。'
    };
  }

  fs.mkdirSync(sidecarDir, { recursive: true });

  let pkgVersion = '0.9.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    if (pkg.version) pkgVersion = pkg.version;
  } catch {}

  const pluginJson = {
    name: KEEPER_PLUGIN_ID,
    displayName: 'Antigravity Context Suite Keeper',
    version: pkgVersion,
    description: 'Headless startup keeper that automatically re-applies the Context Suite patch after an official Antigravity update.'
  };

  const sidecarJson = {
    command: 'node',
    args: ['keeper.js'],
    restart_policy: 'never',
    display_name: 'Context Suite Auto-Heal Keeper',
    description: 'Checks on Antigravity launch whether our patch was wiped by an app update and restores it silently.'
  };

  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginJson, null, 2), 'utf8');
  fs.writeFileSync(path.join(sidecarDir, 'sidecar.json'), JSON.stringify(sidecarJson, null, 2), 'utf8');
  fs.writeFileSync(path.join(sidecarDir, 'keeper.js'), buildKeeperScript(repoDir), 'utf8');

  return {
    ok: true,
    installed: true,
    pluginDir,
    repoDir,
    message: '已安装无界面自愈守护（Sidecar Keeper），Antigravity 更新后再次启动将自动检测并重新挂载补丁。'
  };
}

function uninstallKeeper(options = {}) {
  const pluginDir = getKeeperPluginDir(options);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
  return {
    ok: true,
    installed: false,
    pluginDir,
    message: '已移除自愈守护进程。'
  };
}

module.exports = {
  KEEPER_PLUGIN_ID,
  getKeeperPluginDir,
  getKeeperStatus,
  installKeeper,
  uninstallKeeper,
  buildKeeperScript
};
