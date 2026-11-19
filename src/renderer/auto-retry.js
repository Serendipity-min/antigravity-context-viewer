  // ============================================================================
  // Module: Transient 503 / Service-Unavailable Auto-Retry Guard (auto-retry.js)
  // Opt-in toggle with exponential backoff and strict max-retry cap.
  // Inspired by MIT-licensed KingYeon-Zoo/antigravity-auto-retry.
  // ============================================================================
  const AutoRetryController = (() => {
    const STORAGE_KEY = 'ag_personal_auto_retry_v1';
    const TRANSIENT_ERR_RE = /(?:\b503\b|\b502\b|\b504\b|no capacity available|service unavailable|server overloaded|temporarily unavailable|high demand|model is overloaded)/i;
    const RETRY_BTN_RE = /^(?:retry|try again|重试|重新尝试|再试一次)$/i;

    let cfg = { enabled: false, maxRetries: 2 };
    let attempts = 0;
    let totalTriggered = 0;
    let lastErrorSig = '';
    let pendingTimer = null;
    let pollTimer = null;

    function loadConfig() {
      try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          cfg.enabled = Boolean(parsed.enabled);
          const mr = Number(parsed.maxRetries);
          if (Number.isInteger(mr) && mr >= 1 && mr <= 3) cfg.maxRetries = mr;
        }
      } catch {}
      return { ...cfg };
    }

    function saveConfig(next) {
      cfg = {
        enabled: Boolean(next?.enabled),
        maxRetries: Math.max(1, Math.min(3, Number(next?.maxRetries) || 2))
      };
      try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
      syncUi();
      if (cfg.enabled) startWatcher();
      else stopWatcher();
      return { ...cfg };
    }

    function findRetryableErrorButton() {
      try {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (let i = buttons.length - 1; i >= 0; i--) {
          const btn = buttons[i];
          if (!btn || btn.disabled || btn.closest?.('#ag-context-meter')) continue;
          const label = (btn.textContent || btn.getAttribute?.('aria-label') || '').trim();
          if (!RETRY_BTN_RE.test(label)) continue;
          const rect = btn.getBoundingClientRect?.();
          if (!rect || rect.width === 0 || rect.height === 0) continue;
          // Walk up 4 levels to verify the surrounding error card matches transient 503/overload
          let box = btn.parentElement;
          let matchedText = '';
          for (let d = 0; box && d < 5; d++) {
            const txt = (box.innerText || box.textContent || '').trim();
            if (txt.length > 0 && txt.length < 1500 && TRANSIENT_ERR_RE.test(txt)) {
              matchedText = txt.slice(0, 120);
              break;
            }
            box = box.parentElement;
          }
          if (matchedText) return { btn, sig: `${location.pathname}|${matchedText}` };
        }
      } catch {}
      return null;
    }

    function tick() {
      if (!cfg.enabled || state.disposed) return;
      if (pendingTimer) return;
      const found = findRetryableErrorButton();
      if (!found) {
        if (lastErrorSig) {
          // Error banner gone -> stream recovered, reset retry counter
          attempts = 0;
          lastErrorSig = '';
          syncUi();
        }
        return;
      }
      if (found.sig !== lastErrorSig) {
        lastErrorSig = found.sig;
        attempts = 0;
      }
      if (attempts >= cfg.maxRetries) return;
      const delayMs = [3000, 6000, 12000][attempts] || 12000;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (!cfg.enabled || state.disposed) return;
        const again = findRetryableErrorButton();
        if (!again) return;
        attempts++;
        totalTriggered++;
        try { again.btn.click(); } catch {}
        syncUi();
      }, delayMs);
    }

    function startWatcher() {
      if (pollTimer || state.disposed) return;
      pollTimer = setInterval(tick, 2200);
    }

    function stopWatcher() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }

    function syncUi() {
      const chk = el('chk-auto-retry-503');
      const sel = el('sel-auto-retry-max');
      const badge = el('auto-retry-badge');
      const desc = el('auto-retry-status-desc');
      if (chk) chk.checked = cfg.enabled;
      if (sel) sel.value = String(cfg.maxRetries);
      if (badge) {
        badge.textContent = cfg.enabled ? `已开启 (上限 ${cfg.maxRetries} 次)` : '已关闭';
        badge.className = `key-pill ${cfg.enabled ? 'pill-ok' : 'pill-muted'}`;
      }
      if (desc) {
        desc.textContent = cfg.enabled
          ? `监听 503 / No capacity / 服务过载等瞬时错误，退避重试最多 ${cfg.maxRetries} 次（本次会话已自动重试 ${totalTriggered} 次）。`
          : '开启后，遇到 503 / No capacity available 等服务端瞬时错误时将自动退避重试，避免频繁手动点击 Retry。';
      }
    }

    function init() {
      loadConfig();
      syncUi();
      el('chk-auto-retry-503')?.addEventListener('change', (e) => {
        saveConfig({ enabled: Boolean(e.target.checked), maxRetries: cfg.maxRetries });
      });
      el('sel-auto-retry-max')?.addEventListener('change', (e) => {
        saveConfig({ enabled: cfg.enabled, maxRetries: Number(e.target.value) || 2 });
      });
      if (cfg.enabled) startWatcher();
    }

    return {
      init,
      dispose: stopWatcher,
      getState: () => ({ ...cfg, attempts, totalTriggered })
    };
  })();
