'use strict';
/**
 * Main-Process Layered Host Localization Provider (meter-i18n-host.js)
 *
 * Replaces legacy preload.js 390KB inline injection (which failed Electron sandbox fs gating)
 * with a clean, sandbox-safe main-process IPC loader supporting:
 *   1. Bundled MIT v2.33.0+ base dictionary (i18n/zh-CN.v233.json)
 *   2. Bundled supplementary overrides (i18n/zh-CN.supplement.json)
 *   3. Optional user custom overrides (%LOCALAPPDATA%/AntigravityContextMeter/i18n-custom.json)
 *   4. Null tombstones in supplement/user layers to suppress unwanted translations
 */

const fs = require('fs');
const path = require('path');
const { getStateDir } = require('./asar-engine');

let cachedPack = null;
let cachedPackSig = '';

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

function resolveBundledFile(fileName, options = {}) {
  const candidates = [];
  if (options.i18nDir) {
    candidates.push(path.join(options.i18nDir, fileName));
  }
  candidates.push(
    path.join(__dirname, 'i18n', fileName),
    path.join(__dirname, 'dist', 'i18n', fileName),
    path.join(__dirname, '..', 'i18n', fileName)
  );
  return candidates.find(p => fs.existsSync(p)) || null;
}

function getUserCustomDictPath(options = {}) {
  if (options.customPath) return options.customPath;
  const stateDir = options.stateDir || getStateDir();
  return path.join(stateDir, 'i18n-custom.json');
}

function getFileMtimeSig(p) {
  try {
    if (!p || !fs.existsSync(p)) return '0';
    const st = fs.statSync(p);
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return '0';
  }
}

function loadHostI18nPack(options = {}) {
  const basePath = resolveBundledFile('zh-CN.v233.json', options) || resolveBundledFile('zh-CN.json', options);
  const suppPath = resolveBundledFile('zh-CN.supplement.json', options);
  const userPath = getUserCustomDictPath(options);

  const sig = [
    basePath || '', getFileMtimeSig(basePath),
    suppPath || '', getFileMtimeSig(suppPath),
    userPath || '', getFileMtimeSig(userPath)
  ].join('|');

  if (!options.force && cachedPack && cachedPackSig === sig) {
    return cachedPack;
  }

  const base = safeReadJson(basePath) || {};
  const supp = safeReadJson(suppPath) || {};
  const user = safeReadJson(userPath) || {};

  const exact = Object.create(null);
  const applyExact = (layer) => {
    if (!layer || typeof layer !== 'object') return;
    for (const [k, v] of Object.entries(layer)) {
      if (v === null) {
        delete exact[k];
      } else if (typeof v === 'string' && k) {
        exact[k] = v;
      }
    }
  };
  applyExact(base.exact);
  applyExact(supp.exact);
  applyExact(user.exact);

  const coreWords = Object.assign(
    Object.create(null),
    base.coreWords && typeof base.coreWords === 'object' ? base.coreWords : {},
    supp.coreWords && typeof supp.coreWords === 'object' ? supp.coreWords : {},
    user.coreWords && typeof user.coreWords === 'object' ? user.coreWords : {}
  );

  // Higher priority layers run first for pattern matching
  const patterns = [];
  for (const layer of [user.patterns, supp.patterns, base.patterns]) {
    if (!Array.isArray(layer)) continue;
    for (const p of layer) {
      if (p && typeof p.regex === 'string' && typeof p.replacement === 'string') {
        patterns.push({ regex: p.regex, replacement: p.replacement });
      }
    }
  }

  const pack = {
    ok: true,
    meta: {
      basePath: basePath ? path.basename(basePath) : null,
      targetHostVersion: base.meta?.targetHostVersion || '2.33.0+',
      exactCount: Object.keys(exact).length,
      coreWordsCount: Object.keys(coreWords).length,
      patternsCount: patterns.length,
      hasCustomLayer: Boolean(user && (user.exact || user.patterns)),
      customPath: userPath
    },
    exact,
    coreWords,
    patterns
  };

  if (!options.noCache) {
    cachedPack = pack;
    cachedPackSig = sig;
  }
  return pack;
}

function clearHostI18nCache() {
  cachedPack = null;
  cachedPackSig = '';
}

module.exports = {
  loadHostI18nPack,
  clearHostI18nCache,
  getUserCustomDictPath
};
