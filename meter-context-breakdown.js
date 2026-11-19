'use strict';
/**
 * Authoritative Context Token Breakdown & KV Cache Telemetry Engine (meter-context-breakdown.js)
 *
 * Pure Node.js (zero external dependencies):
 *  1. Decodes Antigravity conversation SQLite DB (`gen_metadata.data` + `steps`) protobuf wire format
 *     to extract authoritative ContextWindowMetadata token attribution across:
 *     System Prompt, System Tools, Rules, MCP Tools, Skills, Subagents, Workflows, Plugins,
 *     Chat Messages (User / Agent / Tool / System), Checkpoint Buffer, and opened Knowledge / Artifact / Skill files.
 *     (Category mapping adapted from MIT-licensed dimitr-io/antigravity-desktop-context.)
 *  2. Computes accurate KV Cache Hit Rate including cacheCreation/cacheWrite as uncached prompt input
 *     (aligned with upstream PR #37).
 *  3. Classifies Go `context canceled` / aborted streams as neutral interruptions (aligned with PR #38).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}

// Protobuf wire decoder (zero-dep, lazy field indexing)
function parseProtoFields(buf) {
  const fields = new Map();
  if (!Buffer.isBuffer(buf) || buf.length === 0) return fields;
  const len = buf.length;
  let pos = 0;

  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    while (pos < len && shift < 70n) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    return null;
  };

  const add = (num, val) => {
    let arr = fields.get(num);
    if (!arr) {
      arr = [];
      fields.set(num, arr);
    }
    arr.push(val);
  };

  while (pos < len) {
    const tag = readVarint();
    if (tag === null) break;
    const wire = Number(tag & 7n);
    const fieldNum = Number(tag >> 3n);
    if (fieldNum <= 0) break;

    if (wire === 0) {
      const v = readVarint();
      if (v === null) break;
      add(fieldNum, { wire: 0, value: v });
    } else if (wire === 1) {
      if (pos + 8 > len) break;
      add(fieldNum, { wire: 1, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      const slenBig = readVarint();
      if (slenBig === null) break;
      const slen = Number(slenBig);
      if (slen < 0 || pos + slen > len) break;
      add(fieldNum, { wire: 2, value: buf.subarray(pos, pos + slen) });
      pos += slen;
    } else if (wire === 5) {
      if (pos + 4 > len) break;
      add(fieldNum, { wire: 5, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

class ProtoMsg {
  constructor(buf) {
    this._buf = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);
    this._fields = null;
  }
  _ensure() {
    if (!this._fields) this._fields = parseProtoFields(this._buf);
    return this._fields;
  }
  has(num) {
    return this._ensure().has(num);
  }
  int(num, signed32 = false) {
    const arr = this._ensure().get(num);
    if (!arr || !arr.length) return 0;
    const last = arr[arr.length - 1];
    if (last.wire !== 0) return 0;
    let v = Number(BigInt.asIntN(64, last.value));
    if (signed32) v = Number(BigInt.asIntN(32, last.value));
    return Number.isFinite(v) ? v : 0;
  }
  str(num) {
    const arr = this._ensure().get(num);
    if (!arr || !arr.length) return '';
    const last = arr[arr.length - 1];
    if (last.wire !== 2) return '';
    try {
      return last.value.toString('utf8');
    } catch {
      return '';
    }
  }
  msg(num) {
    const arr = this._ensure().get(num);
    if (!arr || !arr.length) return EMPTY_MSG;
    const last = arr[arr.length - 1];
    if (last.wire !== 2) return EMPTY_MSG;
    return new ProtoMsg(last.value);
  }
  msgs(num) {
    const arr = this._ensure().get(num);
    if (!arr || !arr.length) return [];
    const out = [];
    for (const item of arr) {
      if (item.wire === 2) out.push(new ProtoMsg(item.value));
    }
    return out;
  }
}

const EMPTY_MSG = new ProtoMsg(Buffer.alloc(0));

const STEP_CATEGORY_BY_TYPE = {
  0: 'system_messages',
  2: 'system_messages',
  101: 'system_messages',
  14: 'user',
  15: 'agent',
  23: 'agent'
};

const STEP_NAME_TO_CATEGORY = {
  USER_INPUT: 'user',
  CORTEX_STEP_TYPE_USER_INPUT: 'user',
  PLANNER_RESPONSE: 'agent',
  CORTEX_STEP_TYPE_PLANNER_RESPONSE: 'agent',
  CHECKPOINT: 'agent',
  CORTEX_STEP_TYPE_CHECKPOINT: 'agent',
  UNSPECIFIED: 'system_messages',
  FINISH: 'system_messages',
  SYSTEM_MESSAGE: 'system_messages',
  CORTEX_STEP_TYPE_SYSTEM_MESSAGE: 'system_messages'
};

const CATEGORY_META = [
  { key: 'system_prompt', label: '系统提示词', group: 'system' },
  { key: 'system_tools', label: '内置工具定义', group: 'system' },
  { key: 'system_overhead', label: '系统开销', group: 'system' },
  { key: 'rules', label: '规则 (Rules)', group: 'custom' },
  { key: 'skills', label: '技能 (Skills)', group: 'custom' },
  { key: 'mcp_tools', label: 'MCP 工具', group: 'custom' },
  { key: 'plugins', label: '插件 (Plugins)', group: 'custom' },
  { key: 'workflows', label: '工作流 (Flows)', group: 'custom' },
  { key: 'legacy_workflows', label: '旧版工作流', group: 'custom' },
  { key: 'subagents', label: '子智能体定义', group: 'custom' },
  { key: 'user', label: '用户消息', group: 'chat' },
  { key: 'agent', label: '助手回复', group: 'chat' },
  { key: 'tool', label: '工具调用与输出', group: 'chat' },
  { key: 'system_messages', label: '系统消息', group: 'chat' }
];

function normalizeUriToPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  if (s.startsWith('file:///')) {
    try {
      s = decodeURIComponent(s.slice(8));
      if (/^[a-zA-Z]:/.test(s)) s = s.replace(/\//g, '\\');
      else s = '/' + s;
    } catch {}
  }
  return s;
}

function classifyChatChildName(name) {
  if (!name || typeof name !== 'string') return 'tool';
  const m = name.match(/:\s*([A-Z0-9_]+)\s*$/);
  const token = m ? m[1] : name.trim().toUpperCase();
  if (STEP_NAME_TO_CATEGORY[token]) return STEP_NAME_TO_CATEGORY[token];
  if (token.includes('USER_INPUT')) return 'user';
  if (token.includes('PLANNER_RESPONSE') || token.includes('CHECKPOINT')) return 'agent';
  if (token.includes('SYSTEM_MESSAGE') || token === 'FINISH' || token === 'UNSPECIFIED') return 'system_messages';
  return 'tool';
}

function parseBreakdownFromGenMetadataBuf(genBuf) {
  const gen = new ProtoMsg(genBuf);
  const chat = gen.msg(1);
  const chatStart = chat.msg(9);
  const cwm = chatStart.msg(10);

  const modelId = gen.msg(3).str(28) || chat.str(21) || chat.str(19) || '';
  const requestBudgetTokens = cwm.int(4, true);
  const activeCheckpoint = chatStart.int(2, true);
  const groups = cwm.msg(3).msgs(1);

  const counts = {};
  for (const meta of CATEGORY_META) counts[meta.key] = 0;

  let chatTokTotal = 0;
  let chatChildren = [];
  let hasSystemPromptOrTools = false;

  for (const g of groups) {
    const gtype = g.int(2);
    const gtok = Math.max(0, g.int(4, true));
    const children = g.msgs(5);

    if (gtype === 1) {
      hasSystemPromptOrTools = true;
      let extracted = 0;
      for (const ch of children) {
        const cname = ch.str(1).toLowerCase();
        const ctok = Math.max(0, ch.int(3, true));
        if (cname === 'flows') {
          counts.workflows += ctok;
          extracted += ctok;
        } else if (cname === 'skills') {
          counts.skills += ctok;
          extracted += ctok;
        } else if (cname === 'subagents') {
          counts.subagents += ctok;
          extracted += ctok;
        }
      }
      counts.system_prompt += Math.max(0, gtok - extracted);
    } else if (gtype === 2) {
      hasSystemPromptOrTools = true;
      counts.system_tools += gtok;
    } else if (gtype === 3) {
      counts.rules += gtok;
    } else if (gtype === 4) {
      counts.mcp_tools += gtok;
    } else if (gtype === 5) {
      counts.skills += gtok;
    } else if (gtype === 6) {
      counts.subagents += gtok;
    } else if (gtype === 7) {
      chatTokTotal += gtok;
      chatChildren = chatChildren.concat(children);
    } else if (gtype === 8) {
      counts.legacy_workflows += gtok;
    } else if (gtype === 9) {
      counts.plugins += gtok;
    } else if (gtype === 10) {
      counts.workflows += gtok;
    }
  }

  let matchedChatChildren = 0;
  for (const ch of chatChildren) {
    const ctok = Math.max(0, ch.int(3, true));
    if (ctok <= 0) continue;
    const cat = classifyChatChildName(ch.str(1));
    counts[cat] += ctok;
    matchedChatChildren += ctok;
  }
  if (chatTokTotal > matchedChatChildren) {
    counts.tool += (chatTokTotal - matchedChatChildren);
  }

  if (!hasSystemPromptOrTools && chatTokTotal > 0) {
    const usage = chat.msg(4);
    const apiInput = Math.max(0, usage.int(2)) + Math.max(0, usage.int(5));
    if (apiInput > chatTokTotal) {
      counts.system_overhead += (apiInput - chatTokTotal);
    }
  }

  const usedTokens = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    hasBreakdown: groups.length > 0 && usedTokens > 0,
    modelId,
    requestBudgetTokens: requestBudgetTokens > 0 ? requestBudgetTokens : null,
    activeCheckpoint,
    counts,
    usedTokens
  };
}

function extractOpenedFilesFromSteps(stepRows) {
  const knowledgeSet = new Set();
  const artifactSet = new Set();
  const skillSet = new Set();

  for (const row of stepRows) {
    const payload = row?.step_payload;
    if (!Buffer.isBuffer(payload) || payload.length === 0) continue;
    const step = new ProtoMsg(payload);
    const stepType = Number(row.step_type);

    // Code action (field 10): knowledge_file (24) / artifact_file (21)
    if (step.has(10)) {
      const ca = step.msg(10);
      const uri = normalizeUriToPath(ca.msg(2).msg(1).str(8));
      if (uri) {
        if (ca.int(24) !== 0) knowledgeSet.add(uri);
        if (ca.int(21) !== 0) artifactSet.add(uri);
      }
    }

    // View file (field 14): skill_file (17)
    if (step.has(14)) {
      const vf = step.msg(14);
      const uri = normalizeUriToPath(vf.str(1));
      if (uri && (vf.int(17) !== 0 || /[/\\]skill\.md$/i.test(uri))) {
        skillSet.add(uri);
      }
    }

    // Generic tool call (type 132 / field 140) reading SKILL.md
    if (stepType === 132 && step.has(140)) {
      const rawStr = step.msg(140)._buf.toString('utf8');
      const m = rawStr.match(/([A-Za-z]:\\[^\x00-\x1f"']+?\\SKILL\.md|\/[^\x00-\x1f"']+?\/SKILL\.md)/i);
      if (m && m[1]) skillSet.add(normalizeUriToPath(m[1]));
    }
  }

  return {
    knowledgeFiles: Array.from(knowledgeSet),
    artifactFiles: Array.from(artifactSet),
    skillFiles: Array.from(skillSet)
  };
}

const breakdownCache = new Map();
const MAX_BREAKDOWN_CACHE = 48;

function resolveConversationDbPath(cascadeId, options = {}) {
  if (!cascadeId || typeof cascadeId !== 'string') return null;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(cascadeId)) return null;
  const agDir = options.agDir
    || process.env.AG_DATA_DIR
    || path.join(os.homedir(), '.gemini', 'antigravity');
  const dbPath = path.join(agDir, 'conversations', `${cascadeId}.db`);
  return fs.existsSync(dbPath) ? dbPath : null;
}

function readConversationContextBreakdown(cascadeId, options = {}) {
  const empty = {
    available: false,
    reason: '',
    categories: [],
    groups: { system: 0, custom: 0, chat: 0 },
    totalTokens: 0,
    requestBudgetTokens: null,
    openedFiles: { knowledgeFiles: [], artifactFiles: [], skillFiles: [] }
  };

  if (!DatabaseSync) {
    empty.reason = 'node:sqlite unavailable';
    return empty;
  }

  const dbPath = options.dbPath || resolveConversationDbPath(cascadeId, options);
  if (!dbPath || !fs.existsSync(dbPath)) {
    empty.reason = 'conversation db not found';
    return empty;
  }

  let cacheKey = '';
  try {
    const st = fs.statSync(dbPath);
    const walPath = `${dbPath}-wal`;
    const walSig = fs.existsSync(walPath)
      ? (() => { const ws = fs.statSync(walPath); return `${ws.size}:${Math.trunc(ws.mtimeMs)}`; })()
      : '0';
    cacheKey = `${dbPath}|${st.size}:${Math.trunc(st.mtimeMs)}|${walSig}`;
    if (!options.force && breakdownCache.has(cacheKey)) {
      return breakdownCache.get(cacheKey);
    }
  } catch {}

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let genRow = null;
    try {
      genRow = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    } catch {
      try {
        genRow = db.prepare('SELECT data FROM gen_metadata ORDER BY rowid DESC LIMIT 1').get();
      } catch {}
    }

    let parsed = null;
    if (genRow && genRow.data) {
      const buf = Buffer.isBuffer(genRow.data) ? genRow.data : Buffer.from(genRow.data);
      parsed = parseBreakdownFromGenMetadataBuf(buf);
    }

    let openedFiles = { knowledgeFiles: [], artifactFiles: [], skillFiles: [] };
    try {
      const stepRows = db.prepare('SELECT step_type, step_payload FROM steps ORDER BY idx').all();
      openedFiles = extractOpenedFilesFromSteps(stepRows);
    } catch {}

    if (!parsed || !parsed.hasBreakdown) {
      const partial = {
        ...empty,
        available: openedFiles.skillFiles.length > 0 || openedFiles.artifactFiles.length > 0 || openedFiles.knowledgeFiles.length > 0,
        hasBreakdown: false,
        openedFiles
      };
      if (cacheKey) {
        if (breakdownCache.size >= MAX_BREAKDOWN_CACHE) breakdownCache.delete(breakdownCache.keys().next().value);
        breakdownCache.set(cacheKey, partial);
      }
      return partial;
    }

    const total = parsed.usedTokens;
    const denom = parsed.requestBudgetTokens && parsed.requestBudgetTokens > 0 ? parsed.requestBudgetTokens : total;
    const groups = { system: 0, custom: 0, chat: 0 };
    const categories = [];
    for (const meta of CATEGORY_META) {
      const tokens = parsed.counts[meta.key] || 0;
      if (tokens <= 0) continue;
      groups[meta.group] = (groups[meta.group] || 0) + tokens;
      categories.push({
        key: meta.key,
        label: meta.label,
        group: meta.group,
        tokens,
        sharePct: total > 0 ? Number(((tokens / total) * 100).toFixed(1)) : 0,
        budgetPct: denom > 0 ? Number(((tokens / denom) * 100).toFixed(1)) : 0
      });
    }
    categories.sort((a, b) => b.tokens - a.tokens);

    const result = {
      available: true,
      hasBreakdown: true,
      modelId: parsed.modelId,
      activeCheckpoint: parsed.activeCheckpoint,
      requestBudgetTokens: parsed.requestBudgetTokens,
      totalTokens: total,
      groups,
      categories,
      openedFiles
    };

    if (cacheKey) {
      if (breakdownCache.size >= MAX_BREAKDOWN_CACHE) breakdownCache.delete(breakdownCache.keys().next().value);
      breakdownCache.set(cacheKey, result);
    }
    return result;
  } catch (e) {
    empty.reason = e.message || String(e);
    return empty;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

/**
 * KV Cache Hit Rate computation (aligned with upstream PR #37)
 * cacheWriteTokens is counted as uncached prompt input, never as cache read.
 */
function calculateCacheHitStats(uncachedInput, cacheReadTokens, cacheWriteTokens = 0) {
  const safeInput = (Number.isFinite(Number(uncachedInput)) && Number(uncachedInput) > 0) ? Number(uncachedInput) : 0;
  const safeWrite = (Number.isFinite(Number(cacheWriteTokens)) && Number(cacheWriteTokens) > 0) ? Number(cacheWriteTokens) : 0;
  const safeCached = (Number.isFinite(Number(cacheReadTokens)) && Number(cacheReadTokens) > 0) ? Number(cacheReadTokens) : 0;
  const effectiveUncached = safeInput + safeWrite;
  const totalPromptTokens = effectiveUncached + safeCached;
  const hitRate = totalPromptTokens > 0
    ? Number(((safeCached / totalPromptTokens) * 100).toFixed(1))
    : null;
  let tier = 'none';
  if (hitRate !== null) {
    if (hitRate >= 80) tier = 'high';
    else if (hitRate >= 40) tier = 'mid';
    else tier = 'low';
  }
  return {
    uncachedInput: effectiveUncached,
    cacheWriteTokens: safeWrite,
    cacheReadTokens: safeCached,
    totalPromptTokens,
    hitRate,
    tier
  };
}

/**
 * Neutral cancellation classifier (aligned with upstream PR #38)
 */
const CANCELED_STREAM_REGEX = /(?:\bcontext cancel(?:l)?ed\b|\buser cancel(?:l)?ed\b|request was aborted|AbortError)/i;

function isCanceledStreamMessage(msg) {
  return typeof msg === 'string' && CANCELED_STREAM_REGEX.test(msg);
}

module.exports = {
  ProtoMsg,
  parseProtoFields,
  parseBreakdownFromGenMetadataBuf,
  readConversationContextBreakdown,
  calculateCacheHitStats,
  isCanceledStreamMessage,
  CATEGORY_META,
  STEP_CATEGORY_BY_TYPE
};
