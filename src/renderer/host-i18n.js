  // ============================================================================
  // Module: Reversible Live-Toggle Host Chinese Localization (v2.33.0+)
  // Sandbox-safe: dictionary loaded via Main-Process IPC (meter-i18n-host.js).
  // Non-destructive: original English text/attributes stored in WeakMaps so
  // toggling OFF restores English instantaneously without restarting Antigravity.
  // ============================================================================
  const HostI18nController = (() => {
    let enabled = false;
    let loading = false;
    let pack = null;
    let exactMap = null;
    let lowerMap = null;
    let coreWordsMap = null;
    let compiledPatterns = [];
    let stringCache = new Map();
    let observer = null;
    let idleTimer = null;
    let flushScheduled = false;
    let typingUntil = 0;
    let listenersBound = false;

    const MAX_CACHE = 8000;
    const origTextMap = new WeakMap();
    const origAttrMap = new WeakMap();
    const trackedTexts = new Set();
    const trackedElements = new Set();
    const pendingNodes = new Set();

    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'KBD', 'SAMP', 'VAR', 'SVG', 'PATH',
      'MATH', 'CODE', 'PRE', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'MJX-CONTAINER'
    ]);

    const PROTECTED_CLOSEST_SELECTOR = [
      '#ag-context-meter',
      '[data-testid="user-message-content"]',
      '[data-lexical-editor="true"]',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[data-language]',
      '[data-code]',
      '[data-line]',
      '[data-line-number]',
      '[role="code"]',
      '[data-testid="model-selector-trigger"]',
      '.group\\/user-input-step',
      '.user-message',
      '.thought-content',
      '.thinking-content',
      '.thought-box',
      '.katex',
      '.katex-display',
      '.katex-html',
      '.mjx-container',
      '.monaco-editor',
      '.editor-instance',
      '.xterm',
      '.hljs',
      '.code-block',
      '.code-line',
      '.view-line',
      '.markdown',
      '.prose'
    ].join(',');

    const MENTION_ALLOWLIST = new Set([
      'Rules', 'Conversation', 'PDF Document', 'MCP Resource',
      'Browser Page', 'Browser Text', 'Directory', 'Git Commit', 'Git Diff'
    ]);

    function isInsideThinkingBody(el) {
      try {
        let cur = el;
        for (let depth = 0; cur && depth < 8; depth++) {
          const parent = cur.parentElement;
          if (!parent) break;
          const trig = parent.querySelector?.(':scope > button[data-testid="thinking-collapsible-trigger"]');
          if (trig && cur !== trig && !trig.contains(cur)) return true;
          cur = parent;
        }
      } catch {}
      return false;
    }

    function shouldSkipElement(el) {
      if (!el || el.nodeType !== 1) return true;
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.isContentEditable) return true;
      try {
        if (el.closest && el.closest(PROTECTED_CLOSEST_SELECTOR)) {
          // Allow thinking toggle button itself and queued decorators outside user text
          if (el.closest('button[data-testid="thinking-collapsible-trigger"]')) return false;
          return true;
        }
      } catch {}
      if (isInsideThinkingBody(el)) return true;
      // Protect /slash commands and @file paths in mention popups unless it's a known section header
      try {
        const menuLabel = el.closest?.('[data-testid="menu-option-label"]');
        if (menuLabel) {
          const txt = (menuLabel.textContent || '').trim();
          if (!MENTION_ALLOWLIST.has(txt)) return true;
        }
      } catch {}
      return false;
    }

    function isNewBadgeElement(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return false;
      if (el.closest?.('[data-testid="sidecar-new-button"]')) return false;
      const cls = String(el.className || '');
      return cls.includes('rounded-full') || (cls.includes('bg-secondary') && cls.includes('rounded'));
    }

    function buildLookupStructures(rawPack) {
      exactMap = new Map();
      lowerMap = new Map();
      coreWordsMap = new Map();
      compiledPatterns = [];
      stringCache.clear();

      if (rawPack && rawPack.exact && typeof rawPack.exact === 'object') {
        for (const [k, v] of Object.entries(rawPack.exact)) {
          if (typeof v !== 'string' || !k) continue;
          exactMap.set(k, v);
          const lk = k.toLowerCase();
          if (!lowerMap.has(lk)) lowerMap.set(lk, v);
        }
      }
      if (rawPack && rawPack.coreWords && typeof rawPack.coreWords === 'object') {
        for (const [k, v] of Object.entries(rawPack.coreWords)) {
          if (typeof v === 'string' && k) coreWordsMap.set(k.toLowerCase(), v);
        }
      }
      if (rawPack && Array.isArray(rawPack.patterns)) {
        for (const item of rawPack.patterns) {
          if (!item || typeof item.regex !== 'string' || typeof item.replacement !== 'string') continue;
          try {
            compiledPatterns.push({ re: new RegExp(item.regex), rep: item.replacement });
          } catch {}
        }
      }
    }

    function translateText(raw, parentEl) {
      if (!raw || typeof raw !== 'string' || !exactMap) return null;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 400) return null;
      // Fast bailout: no ASCII letters -> already localized or numeric/punctuation
      if (!/[A-Za-z]/.test(trimmed)) return null;
      // Protect timestamps (e.g. 24m, 2h, 3d), file paths, URLs, slash commands, model IDs
      if (/^(?:\/[a-z0-9_-]+|https?:\/\/|[a-zA-Z]:\\|\/[\w.-]+\/|\d+(?:ms|s|m|h|d|mo|y)$)/i.test(trimmed)) return null;
      if (/\.(?:js|ts|tsx|jsx|json|md|py|css|html|db|pb|asar|exe|sh|bat)$/i.test(trimmed)) return null;

      // Special context-sensitive badge "New" vs button "New"
      if (trimmed === 'New' && isNewBadgeElement(parentEl)) {
        return raw.replace('New', '新');
      }
      if (trimmed === 'NEW') {
        return raw.replace('NEW', '新');
      }

      const norm = trimmed.replace(/\s+/g, ' ');
      const cached = stringCache.get(norm);
      if (cached !== undefined) {
        if (cached === null) return null;
        const idx = raw.indexOf(trimmed);
        return idx >= 0 ? raw.slice(0, idx) + cached + raw.slice(idx + trimmed.length) : cached;
      }

      let translated = null;
      if (exactMap.has(norm)) {
        translated = exactMap.get(norm);
      } else if (norm.length <= 64 && lowerMap.has(norm.toLowerCase())) {
        translated = lowerMap.get(norm.toLowerCase());
      } else {
        // Strip single trailing colon/ellipsis and retry exact lookup
        const punctMatch = norm.match(/^(.+?)([:：…]+|\.\.\.)$/);
        if (punctMatch) {
          const baseHit = exactMap.get(punctMatch[1]) || (punctMatch[1].length <= 48 ? lowerMap.get(punctMatch[1].toLowerCase()) : null);
          if (baseHit) {
            translated = baseHit + (punctMatch[2] === ':' ? '：' : punctMatch[2]);
          }
        }
        if (!translated && compiledPatterns.length) {
          for (let i = 0; i < compiledPatterns.length; i++) {
            const p = compiledPatterns[i];
            if (p.re.test(norm)) {
              const cand = norm.replace(p.re, p.rep);
              if (cand && cand !== norm) {
                translated = cand;
                break;
              }
            }
          }
        }
      }

      if (stringCache.size >= MAX_CACHE) {
        let drop = 0;
        for (const k of stringCache.keys()) {
          stringCache.delete(k);
          if (++drop >= 1000) break;
        }
      }
      stringCache.set(norm, translated);
      if (!translated) return null;
      const idx = raw.indexOf(trimmed);
      return idx >= 0 ? raw.slice(0, idx) + translated + raw.slice(idx + trimmed.length) : translated;
    }

    function translateTextNode(node) {
      if (!enabled || !node || node.nodeType !== 3) return;
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent)) return;
      const cur = node.nodeValue;
      if (!cur || !/[A-Za-z]/.test(cur)) return;
      const out = translateText(cur, parent);
      if (out && out !== cur) {
        if (!origTextMap.has(node)) {
          origTextMap.set(node, cur);
          trackedTexts.add(node);
        }
        node.nodeValue = out;
      }
    }

    function translateElementAttrs(el) {
      if (!enabled || !el || el.nodeType !== 1) return;
      const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
      if (isInput) {
        if (el.parentElement && shouldSkipElement(el.parentElement)) return;
      } else if (shouldSkipElement(el)) {
        return;
      }
      const attrs = isInput ? ['placeholder', 'title', 'aria-label'] : ['title', 'aria-label', 'placeholder'];
      for (const attr of attrs) {
        const val = el.getAttribute?.(attr);
        if (!val || !/[A-Za-z]/.test(val)) continue;
        const out = translateText(val, el);
        if (out && out !== val) {
          let rec = origAttrMap.get(el);
          if (!rec) {
            rec = Object.create(null);
            origAttrMap.set(el, rec);
            trackedElements.add(el);
          }
          if (!(attr in rec)) rec[attr] = val;
          el.setAttribute(attr, out);
        }
      }
    }

    function walkAndTranslate(root) {
      if (!enabled || !root) return;
      if (root.nodeType === 3) {
        translateTextNode(root);
        return;
      }
      if (root.nodeType !== 1 && root.nodeType !== 11) return;
      if (root.nodeType === 1) {
        if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') {
          translateElementAttrs(root);
          return;
        }
        if (shouldSkipElement(root)) return;
        translateElementAttrs(root);
      }
      try {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (node.nodeType === 1) {
              if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') return NodeFilter.FILTER_ACCEPT;
              if (shouldSkipElement(node)) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let cur = walker.nextNode();
        let count = 0;
        while (cur && count < 4000) {
          count++;
          if (cur.nodeType === 3) translateTextNode(cur);
          else if (cur.nodeType === 1) translateElementAttrs(cur);
          cur = walker.nextNode();
        }
      } catch {}
    }

    function flushPending() {
      flushScheduled = false;
      if (!enabled || state.disposed) {
        pendingNodes.clear();
        return;
      }
      // Anti-Thrashing Typing Guard: defer DOM translation while user is actively typing
      const now = Date.now();
      if (now < typingUntil) {
        flushScheduled = true;
        setTimeout(flushPending, Math.max(80, typingUntil - now + 20));
        return;
      }
      const batch = Array.from(pendingNodes).slice(0, 120);
      for (const n of batch) pendingNodes.delete(n);
      if (observer) observer.disconnect();
      try {
        for (const n of batch) {
          if (n && n.isConnected !== false) walkAndTranslate(n);
        }
      } finally {
        attachObserver();
      }
      if (pendingNodes.size > 0) scheduleFlush();
    }

    function scheduleFlush() {
      if (flushScheduled || !enabled) return;
      flushScheduled = true;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flushPending);
      } else {
        setTimeout(flushPending, 32);
      }
    }

    function attachObserver() {
      if (!enabled || state.disposed || typeof MutationObserver === 'undefined' || !document.body) return;
      if (!observer) {
        observer = new MutationObserver((mutations) => {
          if (!enabled) return;
          for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (m.type === 'characterData' && m.target) {
              if (pendingNodes.size < 400) pendingNodes.add(m.target);
            } else if (m.type === 'childList' && m.addedNodes?.length) {
              for (let j = 0; j < m.addedNodes.length; j++) {
                const added = m.addedNodes[j];
                if (pendingNodes.size < 400) pendingNodes.add(added);
              }
            }
          }
          if (pendingNodes.size > 0) scheduleFlush();
        });
      }
      try {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch {}
    }

    const onTypingActivity = (e) => {
      const t = e?.target;
      if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.closest?.('[data-lexical-editor="true"]'))) {
        typingUntil = Date.now() + 260;
      }
    };

    function bindTypingGuard() {
      if (listenersBound || typeof document === 'undefined') return;
      listenersBound = true;
      document.addEventListener('keydown', onTypingActivity, true);
      document.addEventListener('input', onTypingActivity, true);
    }

    function unbindTypingGuard() {
      if (!listenersBound || typeof document === 'undefined') return;
      listenersBound = false;
      document.removeEventListener('keydown', onTypingActivity, true);
      document.removeEventListener('input', onTypingActivity, true);
    }

    async function ensureDictionaryLoaded(force = false) {
      if (pack && !force) return pack;
      if (loading) return pack;
      loading = true;
      try {
        let res = null;
        if (window.contextMeterAPI?.getHostI18nPack) {
          res = await window.contextMeterAPI.getHostI18nPack({ force });
        } else {
          const live = getLiveBridge();
          if (live) {
            const r = await fetch(`http://127.0.0.1:${live.port}/get-host-i18n-pack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
              body: JSON.stringify({ force })
            });
            res = await r.json();
          }
        }
        if (res && res.ok && res.exact) {
          pack = res;
          buildLookupStructures(res);
        }
      } catch {} finally {
        loading = false;
      }
      return pack;
    }

    async function enable() {
      const loaded = await ensureDictionaryLoaded(false);
      if (!loaded) return { ok: false, error: '未加载到汉化词典包' };
      enabled = true;
      bindTypingGuard();
      if (observer) observer.disconnect();
      try {
        walkAndTranslate(document.body);
      } finally {
        attachObserver();
      }
      if (!idleTimer) {
        idleTimer = setInterval(() => {
          if (!enabled || state.disposed || Date.now() < typingUntil) return;
          if (observer) observer.disconnect();
          try { walkAndTranslate(document.body); } finally { attachObserver(); }
        }, 12000);
      }
      return { ok: true, enabled: true, meta: pack.meta };
    }

    function disable() {
      enabled = false;
      pendingNodes.clear();
      if (observer) {
        try { observer.disconnect(); } catch {}
      }
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      unbindTypingGuard();
      // Restore all mutated text nodes and attributes back to exact original English
      for (const node of trackedTexts) {
        try {
          if (node && node.isConnected && origTextMap.has(node)) {
            node.nodeValue = origTextMap.get(node);
          }
          origTextMap.delete(node);
        } catch {}
      }
      trackedTexts.clear();
      for (const el of trackedElements) {
        try {
          const rec = origAttrMap.get(el);
          if (el && el.isConnected && rec) {
            for (const [attr, origVal] of Object.entries(rec)) {
              el.setAttribute(attr, origVal);
            }
          }
          origAttrMap.delete(el);
        } catch {}
      }
      trackedElements.clear();
      return { ok: true, enabled: false };
    }

    function dispose() {
      if (observer) {
        try { observer.disconnect(); } catch {}
        observer = null;
      }
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      unbindTypingGuard();
      pendingNodes.clear();
    }

    return {
      enable,
      disable,
      dispose,
      isEnabled: () => enabled,
      getMeta: () => pack?.meta || null
    };
  })();
