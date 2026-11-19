'use strict';
// 本地开发与实时会话桥接服务。常规启动时由 Electron IPC 接管。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect, normalizeLoopbackOrigin, getAppDataDir } = require('./local-api');
const {
  collect,
  collectTokenHistoryAsync,
  collectSessionTimelineAsync,
  fetchQuotaSnapshotFromHost,
  recordModelCalls,
  getPluginSettings,
  savePluginSettings
} = require('./meter-collector');
const { getStateDir } = require('./asar-engine');
const { PROJECT_VERSION, getHostCoreBuildId } = require('./modules-config');
const { loadHostI18nPack } = require('./meter-i18n-host');
const { listAllCommands, saveCommandPrefs, toggleNativeSkillPin } = require('./meter-commands');
const { readConversationContextBreakdown } = require('./meter-context-breakdown');
const { getKeeperStatus, installKeeper, uninstallKeeper } = require('./meter-keeper');

function buildLiveRuntimeModulesMeta(cfg) {
  const diskCh = cfg?.modules?.chinese || {};
  const diskZhActive = Boolean(diskCh.enabled && String(diskCh.language || '').toLowerCase() !== 'en');
  return {
    chineseActive: diskZhActive,
    chineseBootLanguage: diskZhActive ? 'zh-CN' : 'en',
    chineseLiveToggle: true,
    chineseNeedsRestart: false
  };
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 传输体积上限
const MAX_RECORD_CALLS = 500; // 单批次最大记录数
const ALLOWED_ROUTES = [
  '/runtime-info',
  '/scan',
  '/context-breakdown',
  '/token-history',
  '/session-timeline',
  '/quota',
  '/record-calls',
  '/get-settings',
  '/save-settings',
  '/modules-status',
  '/toggle-module',
  '/get-host-i18n-pack',
  '/list-commands',
  '/save-command-prefs',
  '/toggle-native-skill-pin',
  '/keeper-status',
  '/toggle-keeper',
  '/shutdown',
  '/restart-host'
];

const LIVE_HOST_STARTED_AT = Date.now();
const LIVE_HOST_BUILD_ID = getHostCoreBuildId(__dirname);
const LIVE_CAPABILITIES = {
  scan: true,
  contextBreakdown: true,
  tokenHistory: true,
  sessionTimeline: true,
  quota: true,
  recordCalls: true,
  settings: true,
  modules: true,
  hostI18nLive: true,
  commandsHub: true,
  keeper: true,
  restartHost: false,
  hotReload: true
};

function timingSafeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createLiveRequestHandler({ api, secret, getAllowedOrigins = null, onShutdown = null, startedAt = LIVE_HOST_STARTED_AT }) {
  const resolveAllowedSet = () => {
    const set = new Set();
    const addAllowed = (raw) => {
      if (!raw || typeof raw !== 'string') return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      const norm = normalizeLoopbackOrigin(trimmed);
      set.add(norm || trimmed);
    };
    if (typeof getAllowedOrigins === 'function') {
      const list = getAllowedOrigins() || [];
      for (const o of list) addAllowed(o);
    }
    if (Array.isArray(api?.origins)) {
      for (const o of api.origins) addAllowed(o);
    }
    if (api?.origin) addAllowed(api.origin);
    return set;
  };

  return async (req, res) => {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const reqOrigin = normalizeLoopbackOrigin(rawOrigin) || rawOrigin;
    const allowedSet = resolveAllowedSet();
    if (!reqOrigin || !allowedSet.has(reqOrigin)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-Context-Token');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST' || !ALLOWED_ROUTES.includes(req.url) || !timingSafeTokenEqual(req.headers['x-ag-context-token'], secret)) { res.writeHead(403); res.end(); return; }
    let body = '';
    let bodyLength = 0;
    let exceeded = false;
    req.on('data', chunk => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求体积超出限制（最大 1MB）' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (exceeded) return;
      try {
        const request = JSON.parse(body || '{}');
        if (req.url === '/record-calls') {
          const calls = Array.isArray(request.calls) ? request.calls : [];
          if (calls.length > MAX_RECORD_CALLS) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `单次入账记录数超出上限（最多 ${MAX_RECORD_CALLS} 条）` }));
            return;
          }
          const resCall = recordModelCalls(calls, {});
          if (resCall && typeof resCall === 'object' && resCall.ok === false) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              changed: false,
              error: resCall.error || '入账落盘失败',
              ...(resCall.phase ? { phase: resCall.phase } : {}),
              ...(resCall.code ? { code: resCall.code } : {})
            }));
            return;
          }
          const changed = (resCall && typeof resCall === 'object') ? !!resCall.changed : !!resCall;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, changed }));
          return;
        }
        if (req.url === '/context-breakdown') {
          const data = readConversationContextBreakdown(request?.id, { force: request?.force === true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        if (req.url === '/get-settings') {
          const result = getPluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/save-settings') {
          const result = savePluginSettings(request);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/get-host-i18n-pack') {
          const result = loadHostI18nPack(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/list-commands') {
          const result = listAllCommands(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/save-command-prefs') {
          const result = saveCommandPrefs(request || {});
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/toggle-native-skill-pin') {
          const result = toggleNativeSkillPin(request?.dir, Boolean(request?.pin));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/keeper-status') {
          const result = getKeeperStatus();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/toggle-keeper') {
          const result = request?.enable ? installKeeper({ repoDir: __dirname }) : uninstallKeeper();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        if (req.url === '/modules-status') {
          const { loadModulesConfig, inspectDiskModules } = require('./modules-config');
          const cfg = loadModulesConfig();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            data: cfg,
            disk: inspectDiskModules(request?.asarPath || null),
            runtime: buildLiveRuntimeModulesMeta(cfg),
            configCorrupted: Boolean(cfg.__configCorrupted),
            configError: cfg.__configError || null,
            corruptedConfigPath: cfg.__corruptedConfigPath || null
          }));
          return;
        }
        if (req.url === '/toggle-module') {
          const { loadModulesConfig, saveModulesConfig, inspectDiskModules, normalizeBrandTitle, normalizeClientLanguage } = require('./modules-config');
          const cfg = loadModulesConfig();
          const mod = request?.name;
          if (!cfg.modules[mod]) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `未知模块: ${mod}` }));
            return;
          }
          const extra = request?.opts || {};
          const targetEnable = Boolean(request?.enable);
          const disk = inspectDiskModules(extra.asarPath || null);
          const hasDiskCapability = mod === 'chinese'
            ? Boolean(disk.chineseReady)
            : (mod === 'proxy' ? Boolean(disk.proxyReady) : Boolean(disk.meterReady));

          // 在热挂载模式或未持久化注入下尝试开启未注入模块时，给出可执行的外部补装指引，不假报切换成功
          if (targetEnable && !hasDiskCapability) {
            const modLabel = mod === 'chinese' ? '汉化' : (mod === 'proxy' ? '免 TUN 代理' : '核心监控');
            const subCmd = mod === 'proxy' ? 'proxy:enable' : (mod === 'chinese' ? 'chinese:enable' : 'install');
            const cmdHint = process.platform === 'win32'
              ? `在插件目录打开终端运行 install.bat 或 node cli.js ${subCmd}`
              : `在插件目录打开终端运行 node cli.js ${subCmd}`;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ok: false,
              status: 'install_failed',
              data: cfg,
              disk,
              runtime: buildLiveRuntimeModulesMeta(cfg),
              error: `当前客户端磁盘 ASAR 未注入${modLabel}组件（或组件不完整）。请先彻底退出 Antigravity（包含系统托盘），再${cmdHint} 完成持久化注入。`,
              restartRequired: false
            }));
            return;
          }

          if (mod === 'chinese') {
            const nextLang = normalizeClientLanguage(extra.language, targetEnable);
            cfg.modules.chinese.language = nextLang;
            cfg.modules.chinese.enabled = nextLang === 'zh-CN';
            if (extra.brandTitle !== undefined) cfg.modules.chinese.brandTitle = normalizeBrandTitle(extra.brandTitle);
            cfg.modules.chinese.lastUpdated = new Date().toISOString();
          } else {
            cfg.modules[mod].enabled = targetEnable;
          }
          saveModulesConfig(cfg);
          const runtime = buildLiveRuntimeModulesMeta(cfg);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            status: 'config_toggled',
            data: cfg,
            disk,
            runtime,
            restartRequired: false
          }));
          return;
        }
        if (req.url === '/runtime-info') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            backendVersion: PROJECT_VERSION,
            hostBuildId: LIVE_HOST_BUILD_ID,
            backendSource: 'live-host',
            pid: process.pid,
            startedAt,
            capabilities: { ...LIVE_CAPABILITIES },
            origins: Array.from(resolveAllowedSet())
          }));
          return;
        }
        if (req.url === '/shutdown') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, shuttingDown: true, pid: process.pid, version: PROJECT_VERSION }));
          if (typeof onShutdown === 'function') {
            setImmediate(() => {
              try { onShutdown(); } catch {}
            });
          }
          return;
        }
        if (req.url === '/restart-host') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, supported: false }));
          return;
        }
        if (req.url === '/token-history') {
          const data = await collectTokenHistoryAsync({ force: request.force === true });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        if (req.url === '/session-timeline') {
          const tlOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
          const targetOrigin = allowedSet.has(tlOrigin) ? tlOrigin : reqOrigin;
          const opts = request?.options && typeof request.options === 'object' ? request.options : request;
          const safeOpts = {
            origin: targetOrigin,
            force: opts?.force === true,
            ...(Array.isArray(opts?.liveSteps) ? { liveSteps: opts.liveSteps } : {}),
            ...(Array.isArray(opts?.liveCalls) ? { liveCalls: opts.liveCalls } : {}),
            ...(Array.isArray(opts?.cascadeModelConfigs) ? { cascadeModelConfigs: opts.cascadeModelConfigs } : {}),
            ...(opts?.userStatus && typeof opts.userStatus === 'object' ? { userStatus: opts.userStatus } : {})
          };
          const data = await collectSessionTimelineAsync(request?.id || '', safeOpts);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            ok: true,
            data: {
              ...(data || {}),
              backendVersion: PROJECT_VERSION,
              backendSource: 'live-host'
            }
          }));
          return;
        }
        if (req.url === '/quota') {
          const reqTargetOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
          const targetOrigin = allowedSet.has(reqTargetOrigin) ? reqTargetOrigin : reqOrigin;
          const resData = await fetchQuotaSnapshotFromHost({
            force: request.force === true,
            origin: targetOrigin,
            backendSource: 'live-host',
            currentModel: request.currentModel || null,
            browsePoolKey: request.browsePoolKey || null
          });
          const { _raw, ...safeData } = resData || {};
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: safeData }));
          return;
        }
        const scanOrigin = normalizeLoopbackOrigin(request?.origin) || reqOrigin;
        const effectiveOrigin = allowedSet.has(scanOrigin) ? scanOrigin : reqOrigin;
        const data = await collect(effectiveOrigin, request.id, { force: request.force === true });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          data: {
            ...(data || {}),
            backendVersion: PROJECT_VERSION,
            backendSource: 'live-host'
          }
        }));
      }
      catch (e) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  };
}

function getCliArgValue(flagName) {
  const idx = process.argv.indexOf(flagName);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return String(process.argv[idx + 1] || '').trim();
  }
  return '';
}

function parseInitialOriginsEnv() {
  const cliOriginsB64 = getCliArgValue('--origins-b64');
  let raw = String(process.env.AG_LIVE_ORIGINS || '').trim();
  if (!raw && cliOriginsB64) {
    try { raw = Buffer.from(cliOriginsB64, 'base64').toString('utf8').trim(); } catch {}
  }
  if (!raw) return [];
  try {
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? Array.from(new Set(parsed.map(normalizeLoopbackOrigin).filter(Boolean)))
        : [];
    }
  } catch {}
  return Array.from(new Set(raw.split(/[,;\s]+/).map(normalizeLoopbackOrigin).filter(Boolean)));
}

function discoverCdpPageOrigins() {
  return new Promise((resolve) => {
    try {
      const portFile = path.join(getAppDataDir(), 'Antigravity', 'DevToolsActivePort');
      if (!fs.existsSync(portFile)) return resolve([]);
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      if (!Number.isFinite(port) || port <= 0) return resolve([]);
      const req = http.get(`http://127.0.0.1:${port}/json/list`, { agent: false }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const pages = JSON.parse(d);
            const list = Array.from(new Set(
              (Array.isArray(pages) ? pages : [])
                .filter(item => item && item.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(item.url))
                .map(item => normalizeLoopbackOrigin(item.url))
                .filter(Boolean)
            ));
            resolve(list);
          } catch { resolve([]); }
        });
      });
      req.setTimeout(2000, () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

function probeOriginAlive(origin) {
  return new Promise((resolve) => {
    try {
      const safeOrigin = normalizeLoopbackOrigin(origin);
      if (!safeOrigin) return resolve(false);
      const transport = safeOrigin.startsWith('https:') ? require('https') : http;
      const req = transport.request(safeOrigin + '/', { agent: false, rejectUnauthorized: false, method: 'GET' }, res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function startLiveHost() {
  const envOrigins = parseInitialOriginsEnv();
  let currentOrigins = envOrigins;
  let api = null;
  if (currentOrigins.length > 0) {
    api = await connect({ origin: currentOrigins[0] });
    api.origins = currentOrigins;
  } else {
    api = await connect();
    currentOrigins = Array.isArray(api.origins) && api.origins.length ? api.origins : [api.origin];
  }
  const secret = crypto.randomBytes(32).toString('hex');
  const cliStamp = getCliArgValue('--stamp');
  const stampRaw = process.env.AG_LIVE_STAMP_PATH || cliStamp;
  const stamp = stampRaw
    ? path.resolve(stampRaw)
    : path.join(getStateDir(), '.live-session.json');
  const hostPidRaw = Number(process.env.AG_LIVE_HOST_PID || getCliArgValue('--host-pid') || 0);
  const watchHostPid = Number.isInteger(hostPidRaw) && hostPidRaw > 0 ? hostPidRaw : null;

  let checkTimer = null;
  let server = null;
  let shuttingDown = false;
  const shutdownGracefully = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    const primaryStamp = path.join(getStateDir(), '.live-session.json');
    for (const candidateStamp of Array.from(new Set([stamp, primaryStamp]))) {
      try {
        if (fs.existsSync(candidateStamp)) {
          const cur = JSON.parse(fs.readFileSync(candidateStamp, 'utf8'));
          if (cur && cur.pid === process.pid) fs.unlinkSync(candidateStamp);
        }
      } catch {}
    }
    if (server) {
      try {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      } catch {
        process.exit(0);
      }
    } else {
      process.exit(0);
    }
  };

  server = http.createServer(createLiveRequestHandler({
    api,
    secret,
    getAllowedOrigins: () => currentOrigins,
    onShutdown: shutdownGracefully,
    startedAt: LIVE_HOST_STARTED_AT
  }));

  server.listen(0, '127.0.0.1', () => {
    const info = {
      port: server.address().port,
      token: secret,
      pid: process.pid,
      origin: api.origin,
      origins: currentOrigins,
      version: PROJECT_VERSION,
      hostBuildId: LIVE_HOST_BUILD_ID,
      backendSource: 'live-host',
      hasQuota: true,
      hasRuntimeInfo: true,
      capabilities: Object.keys(LIVE_CAPABILITIES).filter(k => LIVE_CAPABILITIES[k]),
      startedAt: LIVE_HOST_STARTED_AT
    };
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    const tmpStamp = `${stamp}.tmp-${process.pid}`;
    fs.writeFileSync(tmpStamp, JSON.stringify(info, null, 2));
    fs.renameSync(tmpStamp, stamp);
    console.log('Context Meter local bridge ready on loopback port ' + info.port);
  });

  let misses = 0;
  checkTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      if (watchHostPid) {
        try { process.kill(watchHostPid, 0); } catch {
          shutdownGracefully();
          return;
        }
      }
      const cdpOrigins = await discoverCdpPageOrigins();
      if (cdpOrigins.length > 0) {
        currentOrigins = Array.from(new Set([...cdpOrigins, ...envOrigins]));
        misses = 0;
        return;
      }
      if (envOrigins.length > 0) {
        const aliveResults = await Promise.all(envOrigins.map(o => probeOriginAlive(o)));
        if (aliveResults.some(Boolean)) {
          misses = 0;
          return;
        }
      }
      throw new Error('No live Antigravity origins available');
    } catch {
      if (++misses >= 3) {
        shutdownGracefully();
      }
    }
  }, 10000);
}

if (require.main === module) {
  startLiveHost().catch(e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = {
  ALLOWED_ROUTES,
  LIVE_CAPABILITIES,
  LIVE_HOST_BUILD_ID,
  buildLiveRuntimeModulesMeta,
  createLiveRequestHandler,
  parseInitialOriginsEnv,
  startLiveHost
};
