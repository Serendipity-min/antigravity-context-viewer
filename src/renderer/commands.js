  // ============================================================================
  // Module: Slash Command & E:\agent_skills Hub (src/renderer/commands.js)
  // ============================================================================
  const CommandsHubController = (() => {
    let loaded = false;
    let loading = false;
    let payload = null;
    let activeTab = 'favorites'; // 'favorites' | 'all' | 'builtin' | 'installed' | 'agent_skills'
    let activeSubCat = 'ALL';
    let searchQuery = '';
    let expandedId = null;
    let toastTimer = null;

    function escapeHtmlCmd(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showToast(msg, isError = false) {
      const t = el('cmd-hub-toast');
      if (!t) return;
      if (toastTimer) clearTimeout(toastTimer);
      t.textContent = msg;
      t.className = `cmd-hub-toast ${isError ? 'is-error' : 'is-ok'}`;
      t.hidden = false;
      toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
    }

    async function callCommandsApi(method, arg1, arg2) {
      const api = window.contextMeterAPI;
      if (method === 'list' && api?.listCommands) return await api.listCommands(arg1 || {});
      if (method === 'savePrefs' && api?.saveCommandPrefs) return await api.saveCommandPrefs(arg1 || {});
      if (method === 'pin' && api?.toggleNativeSkillPin) return await api.toggleNativeSkillPin(arg1, arg2);
      const live = getLiveBridge();
      if (live) {
        const routeMap = { list: '/list-commands', savePrefs: '/save-command-prefs', pin: '/toggle-native-skill-pin' };
        const body = method === 'pin' ? { dir: arg1, pin: Boolean(arg2) } : (arg1 || {});
        const r = await fetch(`http://127.0.0.1:${live.port}${routeMap[method]}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token },
          body: JSON.stringify(body)
        });
        return await r.json();
      }
      return { ok: false, error: '命令中心后台通道未就绪' };
    }

    /**
     * Find active Antigravity chat composer input outside #ag-context-meter and insert text safely
     * (NEVER auto-sends; falls back to clipboard copy if editor DOM changes).
     */
    function insertCommandIntoComposer(text) {
      if (!text) return false;
      let target = null;
      try {
        const candidates = Array.from(document.querySelectorAll(
          '[data-lexical-editor="true"], [contenteditable="true"][role="textbox"], div[contenteditable="true"], textarea'
        )).filter(node => {
          if (!node || (typeof node.closest === 'function' && node.closest('#ag-context-meter'))) return false;
          const r = node.getBoundingClientRect?.();
          return r && r.width > 100 && r.height >= 16;
        });
        // Prefer the visible editable element closest to the bottom of the viewport (chat composer)
        candidates.sort((a, b) => (b.getBoundingClientRect().bottom || 0) - (a.getBoundingClientRect().bottom || 0));
        target = candidates[0] || null;
      } catch {}

      if (target) {
        try {
          target.focus();
          if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
            const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
            const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
            const cur = target.value || '';
            const nextVal = cur && !cur.endsWith('\n') && !cur.endsWith(' ') ? `${cur} ${text}` : `${cur}${text}`;
            if (setter) setter.call(target, nextVal);
            else target.value = nextVal;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }

          // Contenteditable / Lexical editor path
          const sel = window.getSelection?.();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(target);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }

          let inserted = false;
          try {
            if (typeof InputEvent === 'function') {
              const beforeEv = new InputEvent('beforeinput', {
                inputType: 'insertText',
                data: text,
                bubbles: true,
                cancelable: true
              });
              const notCanceled = target.dispatchEvent(beforeEv);
              // Lexical consumes beforeinput and updates state itself when prevented
              if (!notCanceled) inserted = true;
            }
          } catch {}

          if (!inserted) {
            try {
              inserted = Boolean(document.execCommand && document.execCommand('insertText', false, text));
            } catch {}
          }

          if (inserted) return true;
        } catch {}
      }

      // Clipboard fallback
      try {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text);
          return 'clipboard';
        }
      } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return 'clipboard';
      } catch {}
      return false;
    }

    function filterItems() {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const q = searchQuery.trim().toLowerCase();

      return items.filter(item => {
        if (activeTab === 'favorites' && !item.isFavorite && item.recentRank < 0) return false;
        if (activeTab === 'builtin' && item.source !== 'builtin' && item.source !== 'builtin_skill') return false;
        if (activeTab === 'installed' && item.source !== 'plugin' && item.source !== 'global_skill') return false;
        if (activeTab === 'agent_skills') {
          if (item.source !== 'agent_skills') return false;
          if (activeSubCat !== 'ALL' && item.category !== activeSubCat) return false;
        }
        if (!q) return true;
        const hay = [
          item.command,
          ...(Array.isArray(item.aliases) ? item.aliases : []),
          item.title,
          item.summary,
          item.category,
          item.sourceLabel,
          item.directory,
          item.enDescription
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      }).sort((a, b) => {
        if (activeTab === 'favorites') {
          if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
          if (a.recentRank !== b.recentRank) {
            if (a.recentRank >= 0 && b.recentRank >= 0) return a.recentRank - b.recentRank;
            return a.recentRank >= 0 ? -1 : 1;
          }
        }
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
        if (a.nativeMounted !== b.nativeMounted && a.source === 'agent_skills' && b.source === 'agent_skills') {
          return a.nativeMounted ? -1 : 1;
        }
        return String(a.command).localeCompare(String(b.command));
      });
    }

    function renderSubCategories() {
      const wrap = el('cmd-subcat-bar');
      if (!wrap) return;
      if (activeTab !== 'agent_skills') {
        wrap.hidden = true;
        return;
      }
      const cats = Array.isArray(payload?.stats?.agentSkillsCategories) ? payload.stats.agentSkillsCategories : [];
      wrap.hidden = cats.length === 0;
      const pills = ['ALL', ...cats].map(cat => {
        const label = cat === 'ALL' ? '全部分类' : cat;
        const active = activeSubCat === cat ? 'active' : '';
        return `<button type="button" class="cmd-subcat-pill ${active}" data-subcat="${escapeHtmlCmd(cat)}">${escapeHtmlCmd(label)}</button>`;
      }).join('');
      wrap.innerHTML = pills;
    }

    function renderList(resetScroll = false) {
      const listEl = el('cmd-hub-list');
      const metaEl = el('cmd-hub-stats');
      if (!listEl) return;

      renderSubCategories();
      const filtered = filterItems();
      const stats = payload?.stats;
      if (metaEl && stats) {
        metaEl.textContent = `当前 ${filtered.length} / 共 ${stats.total} 项（官方 ${stats.builtinCount} · 插件/全局 ${stats.installedCount} · agent_skills ${stats.agentSkillsCount}）· 原生挂载 ${stats.nativePinnedCount} 项 (~${stats.nativePinnedTokens} tok)`;
      }

      if (resetScroll) listEl.scrollTop = 0;

      if (!filtered.length) {
        listEl.innerHTML = `<div class="cmd-empty-state">${searchQuery ? '未找到匹配的指令或技能，请尝试更换关键词。' : '当前分类暂无条目。'}</div>`;
        return;
      }

      const maxRender = 300;
      const visible = filtered.slice(0, maxRender);
      const htmlCards = visible.map(item => {
        const isExp = expandedId === item.id;
        const toneClass = item.costTone === 'good' ? 'pill-ok' : (item.costTone === 'warn' ? 'pill-warn' : (item.costTone === 'info' ? 'pill-info' : 'pill-muted'));
        const starChar = item.isFavorite ? '★' : '☆';
        const starCls = item.isFavorite ? 'is-fav' : '';
        const aliasHint = Array.isArray(item.aliases) && item.aliases.length
          ? `<span class="cmd-alias-tag">${escapeHtmlCmd(item.aliases[0])}</span>`
          : '';
        const pinBtn = item.canPinNative
          ? `<button type="button" class="cmd-pin-btn ${item.nativeMounted ? 'is-pinned' : ''}" data-cmd-action="pin" data-cmd-id="${escapeHtmlCmd(item.id)}" data-cmd-dir="${escapeHtmlCmd(item.directory)}" data-cmd-pinned="${item.nativeMounted ? '1' : '0'}" title="开启后将同步写入 ~/.gemini/config/skills.json，支持原生 / 补全（会占用少量系统提示预算）；关闭则零常驻占用，按需触发">${item.nativeMounted ? '⚡ 已原生挂载' : '＋ 设为原生 /'}</button>`
          : '';

        return `
          <div class="cmd-card ${isExp ? 'is-expanded' : ''}" data-cmd-card="${escapeHtmlCmd(item.id)}">
            <div class="cmd-card-head" data-cmd-action="expand" data-cmd-id="${escapeHtmlCmd(item.id)}">
              <div class="cmd-card-main">
                <div class="cmd-card-top-row">
                  <code class="cmd-slash-code">${escapeHtmlCmd(item.command)}</code>
                  ${aliasHint}
                  <span class="cmd-card-title">${escapeHtmlCmd(item.title)}</span>
                </div>
                <div class="cmd-card-summary">${escapeHtmlCmd(item.summary)}</div>
              </div>
              <div class="cmd-card-actions">
                <span class="key-pill ${toneClass}" style="font-size:9.5px;padding:1px 5px;white-space:nowrap">${escapeHtmlCmd(item.costTag || item.category)}</span>
                <button type="button" class="cmd-icon-btn ${starCls}" data-cmd-action="fav" data-cmd-id="${escapeHtmlCmd(item.id)}" title="${item.isFavorite ? '取消收藏' : '加入常用收藏'}">${starChar}</button>
                <button type="button" class="cmd-insert-btn" data-cmd-action="insert" data-cmd-id="${escapeHtmlCmd(item.id)}" title="仅填入对话框输入框，不会自动发送">填入</button>
              </div>
            </div>
            ${isExp ? `
              <div class="cmd-card-detail">
                <div class="cmd-detail-meta">
                  <span>来源：${escapeHtmlCmd(item.sourceLabel || item.source)}</span>
                  <span>分类：${escapeHtmlCmd(item.category || '通用')}</span>
                  ${item.estimatedTokens ? `<span>元数据估算：~${item.estimatedTokens} tok</span>` : ''}
                </div>
                ${item.whenToUse ? `<div class="cmd-detail-row"><strong>适用场景：</strong>${escapeHtmlCmd(item.whenToUse)}</div>` : ''}
                ${item.whenNotToUse ? `<div class="cmd-detail-row"><strong>不建议：</strong>${escapeHtmlCmd(item.whenNotToUse)}</div>` : ''}
                ${item.example ? `<div class="cmd-detail-row"><strong>用法示例：</strong><code>${escapeHtmlCmd(item.example)}</code></div>` : ''}
                ${item.enDescription && item.enDescription !== item.summary ? `<div class="cmd-detail-row cmd-detail-en"><strong>原文描述：</strong>${escapeHtmlCmd(item.enDescription.slice(0, 260))}${item.enDescription.length > 260 ? '…' : ''}</div>` : ''}
                ${item.skillPath ? `<div class="cmd-detail-row cmd-detail-path"><strong>文件路径：</strong><code>${escapeHtmlCmd(item.skillPath)}</code></div>` : ''}
                <div class="cmd-detail-footer">
                  ${pinBtn}
                  <button type="button" class="cmd-copy-btn" data-cmd-action="copy" data-cmd-id="${escapeHtmlCmd(item.id)}">复制指令文本</button>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
      const overflowNote = filtered.length > maxRender
        ? `<div class="cmd-empty-state">仅展示前 ${maxRender} 项（共 ${filtered.length} 项匹配），可输入关键词进一步筛选。</div>`
        : '';
      listEl.innerHTML = htmlCards + overflowNote;
    }

    async function refresh(force = false) {
      if (loading) return;
      if (loaded && !force && payload) {
        renderList();
        return;
      }
      loading = true;
      const listEl = el('cmd-hub-list');
      const refreshBtn = el('btn-refresh-commands');
      if (refreshBtn) {
        refreshBtn.classList.add('is-spinning');
        refreshBtn.disabled = true;
      }
      if (listEl && !payload) listEl.innerHTML = '<div class="cmd-empty-state">正在扫描内置指令、已装插件与 E:\\agent_skills 技能库…</div>';
      try {
        const res = await callCommandsApi('list', { force });
        if (res && res.ok) {
          payload = res;
          loaded = true;
          renderList(force);
          if (force && res.stats) {
            showToast(`已重新扫描本地指令与技能：共 ${res.stats.total} 项（agent_skills ${res.stats.agentSkillsCount}）`);
          }
        } else {
          const errMsg = res?.error || '未知错误';
          if (listEl && !payload) listEl.innerHTML = `<div class="cmd-empty-state">加载失败：${escapeHtmlCmd(errMsg)}</div>`;
          if (force) showToast(`刷新失败：${errMsg}`, true);
        }
      } catch (e) {
        if (listEl && !payload) listEl.innerHTML = `<div class="cmd-empty-state">加载异常：${escapeHtmlCmd(e.message)}</div>`;
        if (force) showToast(`刷新异常：${e.message}`, true);
      } finally {
        loading = false;
        if (refreshBtn) {
          refreshBtn.classList.remove('is-spinning');
          refreshBtn.disabled = false;
        }
      }
    }

    async function handleListClick(e) {
      const actionEl = e.target?.closest?.('[data-cmd-action]');
      if (!actionEl) return;
      e.stopPropagation();
      const action = actionEl.getAttribute('data-cmd-action');
      const id = actionEl.getAttribute('data-cmd-id');
      const item = (payload?.items || []).find(i => i.id === id);
      if (!item) return;

      if (action === 'expand') {
        expandedId = expandedId === id ? null : id;
        renderList();
        return;
      }

      if (action === 'fav') {
        const prevFavs = Array.isArray(payload?.prefs?.favorites) ? payload.prefs.favorites.slice() : [];
        const nextFavs = item.isFavorite ? prevFavs.filter(f => f !== id) : [id, ...prevFavs.filter(f => f !== id)];
        item.isFavorite = !item.isFavorite;
        if (payload?.prefs) payload.prefs.favorites = nextFavs;
        renderList();
        await callCommandsApi('savePrefs', { favorites: nextFavs });
        return;
      }

      if (action === 'insert') {
        const res = insertCommandIntoComposer(item.insertText);
        // Track MRU recent
        const prevRec = Array.isArray(payload?.prefs?.recent) ? payload.prefs.recent.slice() : [];
        const nextRec = [id, ...prevRec.filter(r => r !== id)].slice(0, 12);
        if (payload?.prefs) payload.prefs.recent = nextRec;
        void callCommandsApi('savePrefs', { recent: nextRec });

        if (res === true) {
          showToast(`已填入 ${item.command}（未自动发送，请按需补全后回车）`);
          if (typeof closeAllPanels === 'function') closeAllPanels();
        } else if (res === 'clipboard') {
          showToast(`已复制 ${item.command} 到剪贴板，请直接粘贴到对话框`);
        } else {
          showToast('未能定位输入框，请点击“复制指令文本”手动粘贴', true);
        }
        return;
      }

      if (action === 'copy') {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(item.insertText);
          showToast(`已复制 ${item.command} 到剪贴板`);
        } catch {
          showToast('复制失败，请手动选中复制', true);
        }
        return;
      }

      if (action === 'pin') {
        const dir = actionEl.getAttribute('data-cmd-dir');
        const currentlyPinned = actionEl.getAttribute('data-cmd-pinned') === '1';
        actionEl.disabled = true;
        const res = await callCommandsApi('pin', dir, !currentlyPinned);
        if (res && res.ok && res.data) {
          payload = res.data;
          renderList();
          showToast(!currentlyPinned
            ? `已原生挂载 /${item.slashName} 至 skills.json（新会话或重启后原菜单即可直接补全）`
            : `已取消原生挂载 ${item.command}（改为 0 Token 常驻、按需填入触发）`);
        } else {
          actionEl.disabled = false;
          showToast(res?.error || '更新原生挂载状态失败', true);
        }
      }
    }

    function bindEvents() {
      const searchInput = el('cmd-hub-search');
      searchInput?.addEventListener('input', (e) => {
        searchQuery = e.target.value || '';
        renderList();
      });

      const tabsWrap = el('cmd-hub-tabs');
      tabsWrap?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('[data-cmd-tab]');
        if (!btn) return;
        activeTab = btn.getAttribute('data-cmd-tab') || 'favorites';
        activeSubCat = 'ALL';
        tabsWrap.querySelectorAll('[data-cmd-tab]').forEach(b => b.classList.toggle('active', b === btn));
        renderList(true);
      });

      el('cmd-subcat-bar')?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('[data-subcat]');
        if (!btn) return;
        activeSubCat = btn.getAttribute('data-subcat') || 'ALL';
        renderList(true);
      });

      el('cmd-hub-list')?.addEventListener('click', (e) => { void handleListClick(e); });
      el('btn-refresh-commands')?.addEventListener('click', () => { void refresh(true); });
    }

    return {
      bindEvents,
      refresh
    };
  })();
