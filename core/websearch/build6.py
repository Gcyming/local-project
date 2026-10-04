

"""build6.py — Slime Search v3.1.0：新增「全网」模式（对接 core/websearch/server.py）。

在现有「本地 / 联网」双模式基础上接入自建全网搜索服务（BM25 倒排索引，
server.py 默认 http://127.0.0.1:8600，CORS 已放开，file:// 可直接 fetch）。

编辑全部基于唯一锚点的受控替换；任何锚点未命中即构建失败（fail fast）。
用法：python3 build6.py [源index.html] [输出index.html]
"""
import os
import sys

SRC_DEFAULT = '/mnt/local/pilot_project/apps/local-search-engine/index.html'
OUT_DEFAULT = '/mnt/work/websearch/index_v31.html'

edits = []  


def add(anchor, repl, label, occ=None):
    if occ is None:
        edits.append((anchor, repl, label))
    else:
        edits.append((anchor, repl, label, occ))



add(
    '<meta name="description" content="Slime Search：slime 程序的搜索器。本地倒排索引检索 + 接入项目浏览器内核的联网检索；搜索历史 / 热门搜索 / 联想提示 / 相关搜索一应俱全；配色随主程序切换，离线可用。">',
    '<meta name="description" content="Slime Search：slime 程序的搜索器。本地倒排索引 + 项目浏览器内核联网检索 + 自建爬虫的全网搜索（BM25 服务）；搜索历史 / 热门搜索 / 联想提示 / 相关搜索一应俱全；配色随主程序切换，离线可用。">',
    'meta description')


add(
    '.hist-badge.online { color: var(--accent-2); border-color: var(--accent-2); }\n'
    '.hist-time { margin-left: auto;',
    '.hist-badge.online { color: var(--accent-2); border-color: var(--accent-2); }\n'
    '.hist-badge.web { color: #43c78c; border-color: #43c78c; }\n'
    '.hist-time { margin-left: auto;',
    'css web badge', 0)

add(
    '/* 联网提示条 */',
    '/* 联网提示条 */\n'
    '/* 全网模式提示条与状态网格 */\n'
    '.online-note.web { border-left-color: #43c78c; }\n'
    '.web-note-grid { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 8px; align-items: center; }\n'
    '.web-note-grid .wk { color: var(--fg-faint); }\n'
    '.web-note-grid .wv { color: var(--fg); font-family: var(--font-mono); font-size: 12.5px; }\n'
    '.web-addr { display: inline-flex; gap: 8px; align-items: center; margin-top: 10px; width: 100%; }\n'
    '.web-addr input { flex: 1 1 auto; min-width: 0; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--fg); border-radius: 8px; padding: 6px 10px; font-family: var(--font-mono); font-size: 12.5px; }\n'
    '.web-addr button { flex: 0 0 auto; }',
    'css web note')


add(
    '''            <button type="button" id="modeOnline" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/></svg>
              联网
            </button>''',
    '''            <button type="button" id="modeOnline" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/></svg>
              联网
            </button>
            <button type="button" id="modeWeb" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12c0 4.4-3.6 8-8 8"/><path d="M3 12c0-4.4 3.6-8 8-8"/><path d="M3.6 9h16.8M3.6 15h16.8"/><path d="M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16"/></svg>
              全网
            </button>''',
    'mode button web')


add(
    '''    <!-- 联网模式说明 -->
    <div class="online-note" id="onlineNote" hidden>
      <span>🌐</span>
      <div>
        <strong>联网搜索</strong>：输入关键词回车，本页会调用 <strong>slime 项目的浏览器内核</strong>打开搜索页并解析结果。
        独立打开本页时内核不可用，请改用「本地」模式，或在主程序内嵌入本页以获得联网能力。
      </div>
    </div>''',
    '''    <!-- 联网模式说明 -->
    <div class="online-note" id="onlineNote" hidden>
      <span>🌐</span>
      <div>
        <strong>联网搜索</strong>：输入关键词回车，本页会调用 <strong>slime 项目的浏览器内核</strong>打开搜索页并解析结果。
        独立打开本页时内核不可用，请改用「本地」模式，或在主程序内嵌入本页以获得联网能力。
      </div>
    </div>

    <!-- 全网模式说明（自建爬虫 + BM25 服务） -->
    <div class="online-note web" id="webNote" hidden>
      <span>🕸️</span>
      <div style="flex:1 1 auto;min-width:0">
        <strong>全网搜索</strong>：查询 <strong>Slime 自建全网索引服务</strong>（core/websearch：爬虫 → 倒排索引 → BM25 排序）。
        <div class="web-note-grid" id="webStatus">正在连接服务…</div>
        <div class="web-addr">
          <input id="webServerAddr" type="text" spellcheck="false" autocomplete="off" aria-label="全网搜索服务地址">
          <button class="ghost-btn" id="webReconnect" type="button">重新连接</button>
        </div>
      </div>
    </div>''',
    'web note panel')


add(
    "  var state = { mode: 'local', query: '', page: 0, last: null, view: 'home', indexing: false, searching: false };\n"
    "  var online = { hostReady: false, engineName: '', seq: 0, hello: false, probeDone: false };",
    "  var state = { mode: 'local', query: '', page: 0, last: null, view: 'home', indexing: false, searching: false };\n"
    "  var online = { hostReady: false, engineName: '', seq: 0, hello: false, probeDone: false };\n"
    "  var WEB_LS_KEY = 'slime.search.webserver';\n"
    "  var WEB_DEFAULT = 'http://127.0.0.1:8600';\n"
    "  var web = { base: WEB_DEFAULT, online: false, pages: 0, terms: 0, engine: 'Slime 自建全网索引', probing: false };",
    'state + web object')


add(
    "  /* ══════════ 联网：接入项目浏览器内核 ══════════ */",
    '''  /* ══════════ 全网：自建爬虫 + BM25 服务 ══════════ */
  function webBase() { return (web.base || WEB_DEFAULT).replace(/\\/+$/, ''); }
  function probeWeb(showErr) {
    web.probing = true;
    renderWebStatus();
    return fetch(webBase() + '/status', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
      .then(function (d) {
        web.online = !!(d && d.ok);
        web.pages = (d && d.pages) || 0;
        web.terms = (d && d.terms) || 0;
        web.probing = false;
        renderWebStatus(); renderEnginePill();
      })
      .catch(function (e) {
        web.online = false; web.probing = false;
        renderWebStatus(); renderEnginePill();
        if (showErr) { showToast('连不上全网服务：' + msgOf(e) + '（先启动 core/websearch/server.py）'); }
      });
  }
  function renderWebStatus() {
    var box = $('webStatus'); if (!box) { return; }
    if (web.probing) { box.innerHTML = '<span class="wk">状态</span><span class="wv">连接中…</span>'; return; }
    if (!web.online) {
      box.innerHTML = '<span class="wk">状态</span><span class="wv" style="color:#e0a35b">未连接</span>' +
        '<span class="wk">提示</span><span class="wv">在 core/websearch 下执行 python3 server.py --db search.db --port 8600</span>';
      return;
    }
    box.innerHTML = '<span class="wk">状态</span><span class="wv" style="color:#43c78c">已连接</span>' +
      '<span class="wk">收录</span><span class="wv">' + web.pages.toLocaleString('zh-CN') + ' 页 / ' + web.terms.toLocaleString('zh-CN') + ' 词</span>' +
      '<span class="wk">索引</span><span class="wv">BM25 + 标题加权</span>';
  }
  function webSearch(query, page) {
    var p = Math.max(0, page || 0);
    var url = webBase() + '/search?q=' + encodeURIComponent(query) + '&page=' + p + '&size=' + PAGE_SIZE;
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
      .then(function (d) {
        if (d && d.ok === false) { return { ok: false, error: d.error || '查询失败' }; }
        var items = (d && d.items) || [];
        return { ok: true, total: (d && d.total != null) ? d.total : items.length,
                 took: (d && d.took_ms != null) ? d.took_ms : 0, items: items,
                 engine: (d && d.engine) || web.engine };
      });
  }

  /* ══════════ 联网：接入项目浏览器内核 ══════════ */''',
    'webSearch/probeWeb block')


add(
    "    stats: function () { return { docs: engine.size(), terms: engine.termCount(), onlineHost: online.hostReady, engineName: online.engineName }; },",
    "    stats: function () { return { docs: engine.size(), terms: engine.termCount(), onlineHost: online.hostReady, engineName: online.engineName, webOnline: web.online, webPages: web.pages, webTerms: web.terms, webBase: web.base }; },",
    'SlimeSearch.stats web')


add(
    '''  function renderEnginePill() {
    var pill = $('enginePill'); if (!pill) { return; }
    var txt = $('engineText');
    if (online.hostReady) {
      pill.className = 'engine-pill is-live';
      if (txt) { txt.textContent = '已接入：' + (online.engineName || '项目浏览器内核'); }
    } else {
      pill.className = 'engine-pill is-off';
      if (txt) { txt.textContent = '未接入浏览器内核（独立运行）'; }
    }
  }''',
    '''  function renderEnginePill() {
    var pill = $('enginePill'); if (!pill) { return; }
    var txt = $('engineText');
    if (state.mode === 'web') {
      if (web.online) {
        pill.className = 'engine-pill is-live';
        if (txt) { txt.textContent = '全网索引 · ' + web.pages.toLocaleString('zh-CN') + ' 页'; }
      } else {
        pill.className = 'engine-pill is-off';
        if (txt) { txt.textContent = '全网服务未连接'; }
      }
      return;
    }
    if (online.hostReady) {
      pill.className = 'engine-pill is-live';
      if (txt) { txt.textContent = '已接入：' + (online.engineName || '项目浏览器内核'); }
    } else {
      pill.className = 'engine-pill is-off';
      if (txt) { txt.textContent = '未接入浏览器内核（独立运行）'; }
    }
  }''',
    'renderEnginePill web')


add(
    "    el.localPanel = $('localPanel');\n    el.onlineNote = $('onlineNote');",
    "    el.localPanel = $('localPanel');\n    el.onlineNote = $('onlineNote');\n    el.webNote = $('webNote');",
    'el.webNote bind')

add(
    "    $('modeLocal').addEventListener('click', function () { setMode('local'); });\n"
    "    $('modeOnline').addEventListener('click', function () { setMode('online'); });",
    "    $('modeLocal').addEventListener('click', function () { setMode('local'); });\n"
    "    $('modeOnline').addEventListener('click', function () { setMode('online'); });\n"
    "    $('modeWeb').addEventListener('click', function () { setMode('web'); });",
    'modeWeb listener')


add(
    "    wireDrop();\n    wireKeyboard();",
    "    var addr = $('webServerAddr');\n"
    "    if (addr) { addr.value = web.base; }\n"
    "    var reconn = $('webReconnect');\n"
    "    if (reconn) { reconn.addEventListener('click', function () { var a = $('webServerAddr'); web.base = (a && a.value.trim()) || WEB_DEFAULT; safeSet(WEB_LS_KEY, web.base); probeWeb(true); }); }\n"
    "    if (addr) { addr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); web.base = addr.value.trim() || WEB_DEFAULT; safeSet(WEB_LS_KEY, web.base); probeWeb(true); } }); }\n"
    "    probeWeb(false);\n\n"
    "    wireDrop();\n    wireKeyboard();",
    'web addr wiring + probe')


add(
    "    showToast('搜索就绪：本地索引已载入示例语料；切到「联网」可经由项目浏览器内核检索。');\n    hostNotify('ready', { version: '3.0.0', onlineHost: online.hostReady });",
    "    showToast('搜索就绪：本地索引已载入示例语料；「联网」走浏览器内核，「全网」走自建索引服务。');\n    hostNotify('ready', { version: '3.1.0', onlineHost: online.hostReady, webOnline: web.online });",
    'ready toast + version')

add(
    "  window.SlimeSearch = {\n    version: '3.0.0',",
    "  window.SlimeSearch = {\n    version: '3.1.0',",
    'SlimeSearch.version')


add(
    '''  function setMode(m, silent) {
    state.mode = m === 'online' ? 'online' : 'local';
    var l = $('modeLocal'), o = $('modeOnline');
    if (l) { l.setAttribute('aria-pressed', state.mode === 'local' ? 'true' : 'false'); }
    if (o) { o.setAttribute('aria-pressed', state.mode === 'online' ? 'true' : 'false'); }
    if (el.localPanel) { el.localPanel.hidden = state.mode !== 'local'; }
    if (el.onlineNote) { el.onlineNote.hidden = state.mode !== 'online'; }
    if (el.input) {
      el.input.placeholder = state.mode === 'online'
        ? '联网搜索（经由项目浏览器内核）…'
        : '搜索本地已索引的文档…';
    }
    if (!silent) { showToast(state.mode === 'online' ? '已切换到联网搜索。' : '已切换到本地搜索。'); }
    hostNotify('mode', { mode: state.mode });
    if (state.view === 'results' && state.query) { state.page = 0; doSearch(); }
  }''',
    '''  function setMode(m, silent) {
    state.mode = (m === 'online' || m === 'web') ? m : 'local';
    var l = $('modeLocal'), o = $('modeOnline'), w = $('modeWeb');
    if (l) { l.setAttribute('aria-pressed', state.mode === 'local' ? 'true' : 'false'); }
    if (o) { o.setAttribute('aria-pressed', state.mode === 'online' ? 'true' : 'false'); }
    if (w) { w.setAttribute('aria-pressed', state.mode === 'web' ? 'true' : 'false'); }
    if (el.localPanel) { el.localPanel.hidden = state.mode !== 'local'; }
    if (el.onlineNote) { el.onlineNote.hidden = state.mode !== 'online'; }
    if (el.webNote) { el.webNote.hidden = state.mode !== 'web'; }
    if (el.input) {
      el.input.placeholder = state.mode === 'online'
        ? '联网搜索（经由项目浏览器内核）…'
        : (state.mode === 'web' ? '全网搜索（自建索引服务）…' : '搜索本地已索引的文档…');
    }
    if (state.mode === 'web') { probeWeb(false); }
    if (!silent) { showToast(state.mode === 'online' ? '已切换到联网搜索。' : (state.mode === 'web' ? '已切换到全网搜索。' : '已切换到本地搜索。')); }
    hostNotify('mode', { mode: state.mode });
    renderEnginePill();
    if (state.view === 'results' && state.query) { state.page = 0; doSearch(); }
  }''',
    'setMode tri-mode')


add(
    "  function doSearch() {\n    addHistory(state.query, state.mode);\n    if (state.mode === 'online') { runOnline(); } else { runLocal(); }\n  }",
    "  function doSearch() {\n    addHistory(state.query, state.mode);\n    if (state.mode === 'online') { runOnline(); } else if (state.mode === 'web') { runWeb(); } else { runLocal(); }\n  }",
    'doSearch dispatch')


add(
    "      tag.textContent = state.mode === 'online' ? '联网' : '本地';",
    "      tag.textContent = state.mode === 'online' ? '联网' : (state.mode === 'web' ? '全网' : '本地');",
    'tag text')


add(
    "  function runOnline() {",
    '''  function runWeb() {
    showResultsView();
    state.searching = true;
    if (el.heroRow) { el.heroRow.classList.add('is-busy'); }
    el.resultHead.textContent = '正在查询自建全网索引…';
    el.resultList.innerHTML = '<div class="loading"><span class="spinner"></span>正在查询 Slime 自建全网索引服务…</div>';
    el.pager.innerHTML = '';
    var t0 = now();
    webSearch(state.query, state.page).then(function (r) {
      state.searching = false;
      if (el.heroRow) { el.heroRow.classList.remove('is-busy'); }
      var took = now() - t0;
      if (!r.ok) { renderWebError(r.error, took); hostNotify('error', { mode: 'web', query: state.query, error: r.error || '全网检索失败' }); return; }
      state.last = { kind: 'web', items: r.items, total: r.total, took: r.took || took, engine: r.engine };
      renderWebResults();
      hostNotify('results', { mode: 'web', query: state.query, count: r.total, took: Math.round(took), engine: r.engine || '', items: briefItems(r.items) });
    }).catch(function (err) {
      state.searching = false;
      if (el.heroRow) { el.heroRow.classList.remove('is-busy'); }
      renderWebError(msgOf(err), now() - t0);
      hostNotify('error', { mode: 'web', query: state.query, error: msgOf(err) });
    });
  }

  function runOnline() {''',
    'runWeb block')


add(
    "  /* ══════════ 渲染：联网 ══════════ */",
    '''  /* ══════════ 渲染：全网（自建索引） ══════════ */
  function renderWebResults() {
    var items = state.last.items || [];
    var total = state.last.total != null ? state.last.total : items.length;
    var took = state.last.took || 0;
    if (!total) {
      el.resultHead.textContent = '自建索引中没有与「' + state.query + '」匹配的网页';
      el.resultList.innerHTML = webEmptyHTML();
      el.pager.innerHTML = '';
      renderRelated();
      return;
    }
    el.resultHead.textContent = '约 ' + total.toLocaleString('zh-CN') + ' 条结果 · 来自 ' + (state.last.engine || '自建索引') + '（' + Number(took).toFixed(1) + ' 毫秒）';
    var frag = '';
    var start = state.page * PAGE_SIZE;
    for (var i = 0; i < items.length; i += 1) { frag += onlineCardHTML(items[i], start + i + 1); }
    el.resultList.innerHTML = frag;
    renderPager(total, PAGE_SIZE);
  }

  function renderWebError(err, took) {
    el.resultHead.textContent = '全网检索未完成（' + (took || 0).toFixed(0) + ' 毫秒）';
    el.resultList.innerHTML = '' +
      '<div class="empty">' +
        '<div class="empty-mark">🕸️</div>' +
        '<p class="empty-title">连不上全网搜索服务</p>' +
        '<p class="empty-hint">' + LS.escapeHTML(err || '网络错误') +
          '<br><br>请在 core/websearch 下启动服务：<code>python3 server.py --db search.db --port 8600</code>（先用 crawler.py 抓站、indexer.py 建索引）。' +
        '</p>' +
      '</div>';
    el.pager.innerHTML = '';
  }

  function webEmptyHTML() {
    return '' +
      '<div class="empty">' +
        '<div class="empty-mark">∅</div>' +
        '<p class="empty-title">自建索引未命中</p>' +
        '<p class="empty-hint">索引词条：' +
          ((LS.parseQuery(state.query).terms || []).map(function (t) { return '<code>' + LS.escapeHTML(t) + '</code>'; }).join(' ') || '—') +
          '<br>可先扩大爬取范围（crawler.py --max-pages / --max-depth）后重建索引。</p>' +
      '</div>';
  }

  /* ══════════ 渲染：联网 ══════════ */''',
    'renderWebResults block')


add(
    "    if (state.last && state.last.kind === 'online') { renderOnlineResults(); } else { renderLocalResults(); }",
    "    if (state.last && state.last.kind === 'online') { renderOnlineResults(); } else if (state.last && state.last.kind === 'web') { runWeb(); return; } else { renderLocalResults(); }",
    'pager kind web')


add(
    "      } else if (state.last && state.last.kind === 'online' && state.last.items) {\n        state.last.items.slice(0, 20).forEach(function (it) { absorb(it.title || ''); });\n      }",
    "      } else if (state.last && (state.last.kind === 'online' || state.last.kind === 'web') && state.last.items) {\n        state.last.items.slice(0, 20).forEach(function (it) { absorb(it.title || ''); });\n      }",
    'relatedTerms web')


add(
    "'<span class=\"hist-badge' + (h.m === 'online' ? ' online' : '') + '\">' + (h.m === 'online' ? '联网' : '本地') + '</span>' +",
    "'<span class=\"hist-badge' + (h.m === 'online' ? ' online' : (h.m === 'web' ? ' web' : '')) + '\">' + (h.m === 'online' ? '联网' : (h.m === 'web' ? '全网' : '本地')) + '</span>' +",
    'history badge web')


add(
    '''    if (state.mode === 'online') {
      showToast('手气不错：正在用浏览器内核取回首个结果…');
      onlineSearch(q).then(function (r) {
        if (r && r.ok && r.items && r.items.length && r.items[0].url) {
          addHistory(q, 'online');
          try { window.open(r.items[0].url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
        } else {
          showToast('未拿到可直达的结果，改为展示列表。');
          state.page = 0;
          doSearch();
        }
      });
      return;
    }''',
    '''    if (state.mode === 'online') {
      showToast('手气不错：正在用浏览器内核取回首个结果…');
      onlineSearch(q).then(function (r) {
        if (r && r.ok && r.items && r.items.length && r.items[0].url) {
          addHistory(q, 'online');
          try { window.open(r.items[0].url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
        } else {
          showToast('未拿到可直达的结果，改为展示列表。');
          state.page = 0;
          doSearch();
        }
      });
      return;
    }
    if (state.mode === 'web') {
      showToast('手气不错：正在从自建索引取回首个结果…');
      webSearch(q, 0).then(function (r) {
        if (r && r.ok && r.items && r.items.length && r.items[0].url) {
          addHistory(q, 'web');
          try { window.open(r.items[0].url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
        } else {
          showToast('未拿到可直达的结果，改为展示列表。');
          state.page = 0;
          doSearch();
        }
      }).catch(function (e) { showToast('全网服务不可达：' + msgOf(e)); });
      return;
    }''',
    'lucky web branch')


add(
    "        if (nm.tagName === 'A') {\n          // 联网结果：点开外链 → 上报，对话侧据此\"时刻准备接受需求\"\n          hostNotify('open', { mode: 'online', query: state.query, url: nm.getAttribute('href') || '', title: (nm.textContent || '').trim(), rank: rank });\n          return;\n        }",
    "        if (nm.tagName === 'A') {\n          // 联网/全网结果：点开外链 → 上报，对话侧据此\"时刻准备接受需求\"\n          hostNotify('open', { mode: state.mode === 'web' ? 'web' : 'online', query: state.query, url: nm.getAttribute('href') || '', title: (nm.textContent || '').trim(), rank: rank });\n          return;\n        }",
    'result open hostNotify web')


add(
    "    list.unshift({ q: q, ts: Date.now(), m: mode === 'online' ? 'online' : 'local' });",
    "    list.unshift({ q: q, ts: Date.now(), m: (mode === 'online' || mode === 'web') ? mode : 'local' });",
    'addHistory web')


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC_DEFAULT
    out = sys.argv[2] if len(sys.argv) > 2 else OUT_DEFAULT
    with open(src, 'r', encoding='utf-8') as f:
        html = f.read()
    applied = 0
    for entry in edits:
        if len(entry) == 4:
            anchor, repl, label, occ = entry
        else:
            anchor, repl, label = entry
            occ = None
        n = html.count(anchor)
        if occ is None:
            if n != 1:
                print('✗ 锚点未命中/不唯一(%d)：%s' % (n, label))
                print('  锚点前 60 字符: %r' % anchor[:60])
                return 1
            html = html.replace(anchor, repl, 1)
        else:
            if n <= occ:
                print('✗ 锚点命中数不足(%d, 需>%d)：%s' % (n, occ, label))
                return 1
            pos = -1
            for _ in range(occ + 1):
                pos = html.find(anchor, pos + 1)
            html = html[:pos] + repl + html[pos + len(anchor):]
        applied += 1
        print('✓ %s' % label)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('\n应用 %d 处编辑 → %s（%d 字节）' % (applied, out, os.path.getsize(out)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
