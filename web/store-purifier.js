/*!
 * 商店净化 · Store Purifier —— 给 KiraAI 插件商店加「不感兴趣」
 * 由 KiraAI 插件 kira-ai-plugin-store-purifier（v3.0.1）注入，也可手动单独挂载
 * 功能：
 *   1) 插件商店每张卡片的「安装」按钮左侧增加「不感兴趣」按钮
 *   2) 点击后隐藏该卡片，本页剩余卡片自动往前补空位（不跨页补位；缺的那张由下次刷新时官方重排）
 *   3) 标签栏「插件商店」右侧增加「不感兴趣插件」标签页，集中展示已隐藏的卡片
 *   4) 隐藏页卡片上「安装」按钮左侧显示「取消不感兴趣」，点击后恢复；该页按官方每页 12 张分页
 * 隐藏名单只保存在当前浏览器 localStorage。
 */
(function () {
  'use strict';

  if (window.__storePurifier) return;
  window.__storePurifier = { version: '3.0.1' };

  // 2.x 的旧版脚本若还挂在这个页面上（旧 index.html 缓存 / 曾手动挂载过），
  // 它插进来的按钮与面板用的是 kn-ni- 前缀；先拆干净再接管，免得出现两排按钮。
  // 旧脚本自己的幂等守卫是 window.__kiraNotInterested，这里不复用，直接覆盖其界面。
  (function dropLegacyUi() {
    var staleIds = ['kn-ni-tab', 'kn-ni-panel', 'kn-ni-style', 'kn-ni-toast'];
    for (var i = 0; i < staleIds.length; i++) {
      var node = document.getElementById(staleIds[i]);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    var staleBtns = document.querySelectorAll('[data-kn-ni]');
    for (var j = 0; j < staleBtns.length; j++) {
      if (staleBtns[j].parentNode) staleBtns[j].parentNode.removeChild(staleBtns[j]);
    }
  })();

  var LS_KEY = 'kira.pluginStore.notInterested.v1';
  var TAB_ID = 'ksp-tab';
  var PANEL_ID = 'ksp-panel';
  var BTN_ATTR = 'data-ksp';

  var TAB_BASE = 'px-3 py-2 text-sm font-medium border-b-2 focus:outline-none transition-colors duration-150';
  var TAB_ON = 'border-blue-600 dark:border-blue-500 text-blue-600 dark:text-blue-500';
  var TAB_OFF = 'border-transparent text-theme-subtle text-theme-subtle-hover hover:border-gray-300 dark:hover:border-gray-600';
  var BTN_NEUTRAL = 'px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-theme-body hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800 transition-colors';
  // 蓝色描边按钮：自建卡片上的「取消隐藏」与「安装」观感一致，共用一套样式
  var BTN_PRIMARY = 'px-3 py-1.5 text-xs font-medium rounded-md border border-blue-300 text-blue-600 hover:bg-blue-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30 transition-colors';
  var BTN_DISABLED = 'px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 text-theme-faint cursor-default dark:border-gray-700';
  var PAGE_BTN = 'px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 text-theme-body hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';
  // 标签胶囊：官方详情弹窗与自建卡片用同一套配色，只差字号
  var TAG_CHIP = 'inline-block rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400';
  // 与官方 PluginView.vue 的 STORE_PAGE_SIZE 保持一致
  var STORE_PAGE_SIZE = 12;
  // 官方拉取插件商店列表的接口（webui/frontend/src/api/pluginStore.ts:47）
  var STORE_URL = '/api/plugin-store/fetch';

  // ---------------------------------------------------------------- 文案
  function lang() {
    try {
      var l = localStorage.getItem('language');
      if (l === 'zh' || l === 'en') return l;
    } catch (e) { /* ignore */ }
    return String(navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }
  var TEXT = {
    zh: {
      tab: '不感兴趣插件',
      storeTab: '插件商店',
      mark: '不感兴趣',
      undo: '取消不感兴趣',
      install: '安装',
      installed: '已安装',
      update: '更新',
      installing: '安装中...',
      empty: '还没有标记为「不感兴趣」的插件',
      emptyHint: '在插件商店点击卡片上的「不感兴趣」即可收纳到这里',
      noRepo: '该插件缺少仓库地址，无法安装',
      installStarted: '已提交安装任务，可到「插件」页查看进度',
      installFailed: '安装失败',
      close: '关闭',
      detailsTitle: '插件详情',
      pluginId: '插件 ID',
      version: '版本',
      author: '作者',
      repoUrl: '仓库链接',
      category: '分类',
      coreVersion: 'KiraAI 版本',
      tags: '标签',
      noDescription: '暂无描述',
      prevPage: '上一页',
      nextPage: '下一页',
      clearAll: '清空名单',
      clearConfirm: '确定清空「不感兴趣」名单？清空后所有插件都会回到商店。',
      cleared: '名单已清空，正在重新加载插件商店',
      saveFailed: '名单保存失败（本地存储不可写），这次标记没有生效'
    },
    en: {
      tab: 'Not interested plugins',
      storeTab: 'Plugin Store',
      mark: 'Not interested',
      undo: 'Undo not interested',
      install: 'Install',
      installed: 'Installed',
      update: 'Update',
      installing: 'Installing...',
      empty: 'No plugins marked as "not interested" yet',
      emptyHint: 'Click "Not interested" on a store card to collect it here',
      noRepo: 'This plugin has no repository URL, cannot install',
      installStarted: 'Install task submitted — see the Plugins tab for progress',
      installFailed: 'Install failed',
      close: 'Close',
      detailsTitle: 'Plugin Details',
      pluginId: 'Plugin ID',
      version: 'Version',
      author: 'Author',
      repoUrl: 'Repository',
      category: 'Category',
      coreVersion: 'KiraAI Version',
      tags: 'Tags',
      noDescription: 'No description',
      prevPage: 'Previous',
      nextPage: 'Next',
      clearAll: 'Clear list',
      clearConfirm: 'Clear the "not interested" list? All plugins will return to the store.',
      cleared: 'List cleared, reloading the plugin store',
      saveFailed: 'Could not save the list (local storage unavailable), nothing was hidden'
    }
  };
  // 当前语言的文案表
  function T() { return TEXT[lang()] || TEXT.en; }
  var langSeen = lang();
  // 界面语言切换后：商店卡片上的按钮是建卡时写死的文案，摘掉让下一轮按新语言重建；
  // 自建页则整页重渲染（标签文案由 ensureTab 每轮自行更新）
  function syncLanguage() {
    var now = lang();
    if (now === langSeen) return;
    langSeen = now;
    // 标签文案平时由 ensureTab 每轮更新，但切语言通常只走快同步这条捷径，这里顺手改掉
    var tabBtn = document.getElementById(TAB_ID);
    if (tabBtn) tabBtn.textContent = T().tab;
    var old = document.querySelectorAll('[' + BTN_ATTR + ']');
    for (var i = 0; i < old.length; i++) {
      if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
    }
    if (mineActive) renderMine();
  }

  // ---------------------------------------------------------------- 状态
  function loadHidden() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (e) { /* ignore */ }
    return {};
  }
  // 把隐藏名单写回 localStorage。
  // 写回前先合并：同一插件可能先按「title:名称」存过、商店数据到了又按 id 存一份，
  // 内存里合并了但存储里没合并，取消时只删掉 id 键，剩下的标题记录刷新后会让它复活。
  // 本次会话里显式删掉的键。写盘前会把磁盘上的新增合并回来（另一个标签页刚藏了
  // 插件时不能被这场覆盖），但刚删的键不能被这份旧磁盘数据捞回来。
  var removedKeys = nullMap();
  function mergeWithDisk() {
    // loadHidden / normalizeHidden 都不抛（前者内部已兜住解析失败），这里不用再套 try
    var disk = normalizeHidden(loadHidden());
    var merged = nullMap();
    var dk = Object.keys(disk);
    for (var i = 0; i < dk.length; i++) {
      if (!removedKeys[dk[i]]) merged[dk[i]] = disk[dk[i]];
    }
    var mk = Object.keys(hidden || {});
    for (var j = 0; j < mk.length; j++) merged[mk[j]] = hidden[mk[j]];
    return merged;
  }
  // 返回值 = 有没有真的落到磁盘。写不进去（配额满、无痕模式）时界面不能装作隐藏成功，
  // 否则刷新后插件全回来，用户只会以为是"功能坏了"。
  function saveHidden() {
    hidden = normalizeHidden(mergeWithDisk());
    removedKeys = nullMap();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(hidden));
      return true;
    } catch (e) {
      if (window.console && console.warn) {
        console.warn('[store-purifier] 隐藏名单写入本地存储失败（可能已满或处于无痕模式）:', e);
      }
      return false;
    } finally {
      // 名单变了，按下标索引的判断缓存立刻作废
      invalidateHiddenIndex();
    }
  }
  // 同一条记录可能先按「title:名称」存下，商店数据到了又按 id 存一遍。
  // 这里合并成一条（有 id 的优先），否则自建页会把同一个插件列两次。
  // 用无原型对象：插件名/仓库名可能正好是 __proto__、constructor、toString，
  // 普通对象上这些键会命中原型，写入不落地、读取拿到函数/对象，名单随即错乱。
  function nullMap() {
    return Object.create(null);
  }
  function normalizeHidden(raw) {
    var out = nullMap();
    var byTitle = nullMap();
    var keys = Object.keys(raw || {});
    for (var i = 0; i < keys.length; i++) {
      var rec = raw[keys[i]];
      if (!rec || typeof rec !== 'object') continue;
      var id = rec.id != null ? String(rec.id) : '';
      var title = rec.title ? String(rec.title) : '';
      var repo = rec.repo ? String(rec.repo) : '';
      if (!id && !title && !repo) continue;
      var key = id || (title ? 'title:' + title : 'repo:' + repo);
      if (out[key]) continue;
      var t = title ? normName(title) : '';
      var prevKey = t ? byTitle[t] : null;
      var prev = prevKey ? out[prevKey] : null;
      if (prev) {
        if (prev.id != null && !id) continue;           // 已有的 id 记录信息更全
        if (prev.id == null && id) delete out[prevKey];  // 标题键记录升级成 id 键
        else if (prev.id == null && !id) continue;       // 两条都只有标题：当作同一条
      }
      out[key] = rec;
      if (t) byTitle[t] = key;
    }
    return out;
  }
  var hidden = normalizeHidden(loadHidden());

  // ---------------------------------------------------------------- 商店数据观察（只读，不修改任何响应）
  // 官方每次拉取插件商店列表时顺手存一份，用于把 DOM 卡片对回真实条目（拿到插件 id）。
  var itemsCache = [];
  // 名称索引（归一化名称 → 条目数组）：卡片匹配与 isHiddenItem 都按标题找条目，
  // 每轮每卡线性扫 itemsCache 太浪费，这里在 ingest 时一次性建好。
  var itemsByTitle = {};
  // id / 仓库索引：自建页渲染前用它把过期快照刷新成最新状态（是否已安装等）
  var itemsById = nullMap();
  var itemsByRepo = nullMap();
  // 每个仓库下出现过哪些插件（按名字去重）：一个仓库挂多个插件是合法的（官方对 repo
  // 没有唯一性约束），repo 兜底只在「这个仓库只有一个插件」时才敢用，否则会把用户
  // 没点过的插件一起藏掉。按名字而不是按条目统计：官方重算 id 时同一条目会以新 id
  // 再进一次缓存，按条目数会被算成 2 个插件。
  var repoTitles = nullMap();
  function repoAlone(rk) {
    var t = repoTitles[rk];
    if (!t) return false;
    return Object.keys(t).length === 1;
  }
  // 缓存商店列表（按 id 去重、与旧数据合并），并重建名称索引
  function ingestItems(list) {
    if (!Array.isArray(list) || !list.length) return;
    var seen = nullMap();
    var out = [];
    var i;
    var k;
    for (i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || it.id == null) continue;
      k = String(it.id);
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(it);
    }
    for (i = 0; i < itemsCache.length; i++) {
      var old = itemsCache[i];
      k = String(old && old.id);
      if (k === 'undefined' || k === 'null' || seen[k]) continue;
      seen[k] = 1;
      out.push(old);
    }
    itemsCache = out;
    itemsByTitle = nullMap();
    itemsById = nullMap();
    itemsByRepo = nullMap();
    repoTitles = nullMap();
    for (i = 0; i < out.length; i++) {
      var names = nameCandidates(out[i]);
      for (k = 0; k < names.length; k++) {
        var nk = normName(names[k]);
        if (!nk) continue;
        // name 与 display_name 常常同一个字符串：同一条目只进索引一次，
        // 否则重名分支里会数出两个"候选"其实是同一个插件
        var bucket = itemsByTitle[nk] || (itemsByTitle[nk] = []);
        if (bucket.indexOf(out[i]) < 0) bucket.push(out[i]);
      }
      if (out[i].id != null) itemsById[String(out[i].id)] = out[i];
      var rk = normName(out[i].repo);
      if (rk) {
        itemsByRepo[rk] = out[i];
        var bucket = repoTitles[rk] || (repoTitles[rk] = nullMap());
        bucket[normName(nameCandidates(out[i])[0]) || String(out[i].id)] = 1;
      }
    }
  }
  // 粗判响应是不是商店列表，避免把别的数组当商店数据
  function looksLikeStoreItems(data) {
    return Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === 'object' && ('version' in data[0] || 'author' in data[0]);
  }

  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      var textDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
      var respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
      var isStoreUrl = function (u) { return String(u || '').indexOf(STORE_URL) >= 0; };
      // 把响应里已标记"不感兴趣"的插件直接剔除：官方表格拿到的就是过滤后的列表，
      // 分页因此按过滤后的结果重排，同一页后面的插件会自动补上来，而不是留下空位。
      // 返回值：过滤后的数组；没有任何条目被剔除时返回 null（调用方保留原始数据，省一次序列化）。
      var filterList = function (arr) {
        if (!looksLikeStoreItems(arr)) return null;
        ingestItems(arr);
        var keep = [];
        for (var i = 0; i < arr.length; i++) {
          if (!isHiddenItem(arr[i])) keep.push(arr[i]);
        }
        return keep.length === arr.length ? null : keep;
      };
      var filterBody = function (raw) {
        if (typeof raw !== 'string' || !raw) return raw;
        var data;
        try { data = JSON.parse(raw); } catch (e) { return raw; }
        var keep = filterList(data);
        return keep ? JSON.stringify(keep) : raw;
      };
      XHR.prototype.open = function (method, url) {
        try {
          this.__knUrl = String(url || '');
          // 复用同一个 XHR 实例发第二个请求时，上一次定义在实例上的 getter 还在，
          // 会把新请求的响应也过滤掉（哪怕新请求根本不是商店列表）。
          delete this.responseText;
          delete this.response;
        } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var self = this;
        try {
          var rt = this.responseType;
          if (isStoreUrl(this.__knUrl) && (!rt || rt === 'text' || rt === 'json')) {
            if (textDesc && textDesc.get) {
              Object.defineProperty(this, 'responseText', {
                configurable: true,
                get: function () {
                  var raw = textDesc.get.call(self);
                  if (!isStoreUrl(self.__knUrl)) return raw;
                  try { return filterBody(raw); } catch (e) { return raw; }
                }
              });
            }
            if (rt === 'json' && respDesc && respDesc.get) {
              Object.defineProperty(this, 'response', {
                configurable: true,
                get: function () {
                  var raw = respDesc.get.call(self);
                  if (!isStoreUrl(self.__knUrl)) return raw;
                  try {
                    var keep = filterList(raw);
                    return keep || raw;
                  } catch (e) { return raw; }
                }
              });
            }
          }
        } catch (e) { /* ignore */ }
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) { /* ignore */ }

  try {
    if (window.fetch) {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var p = origFetch.apply(this, arguments);
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (String(url).indexOf(STORE_URL) >= 0 && p && p.then) {
            p.then(function (res) {
              try {
                if (res && res.clone) {
                  res.clone().json().then(function (data) {
                    if (looksLikeStoreItems(data)) ingestItems(data);
                  }).catch(function () { /* ignore */ });
                }
              } catch (e) { /* ignore */ }
            }).catch(function () { /* ignore */ });
          }
        } catch (e) { /* ignore */ }
        return p;
      };
    }
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- DOM 定位
  // 「插件」页、「MCP」页、「技能」页的卡片网格类名与「插件商店」完全一致，
  // 而面板在 DOM 中的顺序又与标签按钮顺序不同，所以绝不能靠"第一个匹配的网格"定位商店。
  // 判定顺序：① 记住的网格仍有效；② 官方商店标签激活时取当前可见的那个；
  //           ③ 商店工具条的「插件源」按钮是商店面板独有特征；④ 判不出就什么都不做。
  var storeGridRef = null;

  // 元素是否属于自建面板（官方卡片与自建卡片结构一致，必须区分）
  function isMineEl(el) {
    return !!(el && el.closest && el.closest('#' + PANEL_ID));
  }
  // 元素自身或祖先是否已被隐藏（含 display:none 与隐藏类）
  function hiddenInTree(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 60) {
      if (node.classList && node.classList.contains('ksp-hide-store')) return true;
      // 直接读 inline display：没写过 style 属性的元素也能判，不依赖属性字符串
      if (node.style && node.style.display === 'none') return true;
      node = node.parentElement;
    }
    return false;
  }
  // 页面上所有「商店式三栏网格」候选（排除自建页）
  function gridCandidates() {
    var out = [];
    var grids = document.querySelectorAll('div.grid');
    for (var i = 0; i < grids.length; i++) {
      // 变量别叫 el：会遮蔽全局的 el(tag, cls, txt) 工厂
      var box = grids[i];
      if (isMineEl(box)) continue; // 自建面板的网格类名与官方一致，必须排除
      var cls = String(box.className || '');
      if (cls.indexOf('grid-cols-1') >= 0 && cls.indexOf('sm:grid-cols-2') >= 0 && cls.indexOf('lg:grid-cols-3') >= 0) out.push(box);
    }
    return out;
  }
  // 官方「插件商店」标签当前是否高亮
  function storeTabActive() {
    var tb = findTabBar();
    if (!tb) return false;
    var cls = String(tb.store.className || '');
    return cls.indexOf('border-blue-600') >= 0 || cls.indexOf('border-blue-500') >= 0;
  }
  // 从元素向上找到标签栏同级的官方面板容器
  function panelOf(el) {
    var tb = findTabBar();
    if (!el || !tb || !tb.bar.parentElement) return null;
    var host = tb.bar.parentElement;
    var node = el;
    var guard = 0;
    while (node && node.parentElement && node.parentElement !== host && guard++ < 40) node = node.parentElement;
    if (!node || node === tb.bar || node.parentElement !== host) return null;
    return node;
  }
  // 按文案在子树里找第一颗按钮：标签栏、刷新按钮、「插件源」探针都靠它
  function findButton(root, test) {
    var btns = root ? root.querySelectorAll('button') : [];
    for (var i = 0; i < btns.length; i++) {
      if (test(btns[i])) return btns[i];
    }
    return null;
  }
  // 商店面板独有特征：工具条上有「插件源」按钮
  function hasSourceButton(panel) {
    return !!findButton(panel, function (b) {
      var t = String(b.textContent || '');
      return t.indexOf('插件源') >= 0 || /\bsources?\b/i.test(t);
    });
  }
  // 处于显示状态的官方面板（v-show 一定会写 inline style，这正是面板特征）
  function visiblePanels() {
    var tb = findTabBar();
    var host = tb ? tb.bar.parentElement : null;
    if (!host) return [];
    var out = [];
    var seenBar = false;
    var kids = host.children;
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child === tb.bar) { seenBar = true; continue; }
      if (!seenBar || child.tagName !== 'DIV' || child.id === PANEL_ID) continue;
      // 用 inline display 判可见：初次渲染的 v-show 面板可能压根没有 style 属性，
      // 按属性存在性判断会漏掉它，切到自建页时官方那个面板就会留在原地
      if (child.style.display === 'none') continue;
      out.push(child);
    }
    return out;
  }
  function storeGrid() {
    if (storeGridRef && storeGridRef.isConnected && !isMineEl(storeGridRef)) return storeGridRef;
    var cands = gridCandidates();
    var i;
    if (storeTabActive()) {
      for (i = 0; i < cands.length; i++) {
        if (!hiddenInTree(cands[i])) { storeGridRef = cands[i]; return storeGridRef; }
      }
    }
    for (i = 0; i < cands.length; i++) {
      if (hasSourceButton(panelOf(cands[i]))) { storeGridRef = cands[i]; return storeGridRef; }
    }
    return null;
  }
  // 当前商店网格里的卡片节点（与官方卡片同构：role=button + tabindex=0）
  function storeCards() {
    var grid = storeGrid();
    if (!grid) return [];
    var out = [];
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      // 变量别叫 el：会遮蔽全局的 el(tag, cls, txt) 工厂
      var node = kids[i];
      if (node.tagName === 'DIV' && node.getAttribute('role') === 'button' && node.getAttribute('tabindex') === '0') out.push(node);
    }
    return out;
  }
  // 标签栏定位结果缓存：querySelectorAll('button') 会扫全页（几百个按钮），
  // 而 storeTabActive / panelOf / visiblePanels 每轮都要用，缓存后每轮只查一次。
  var tabBarCache = null;

  function findTabBar() {
    if (tabBarCache) {
      try {
        if (tabBarCache.bar && tabBarCache.bar.isConnected && tabBarCache.store && tabBarCache.store.isConnected) return tabBarCache;
      } catch (e) { /* ignore */ }
      tabBarCache = null;
    }
    var labels = [TEXT.zh.storeTab, TEXT.en.storeTab];
    var hit = findButton(document, function (b) {
      if (labels.indexOf(String(b.textContent || '').trim()) < 0) return false;
      var bar = b.parentElement;
      if (!bar) return false;
      return (bar.querySelectorAll(':scope > button').length || bar.querySelectorAll('button').length) >= 3;
    });
    if (!hit) return null;
    tabBarCache = { bar: hit.parentElement, store: hit };
    return tabBarCache;
  }
  // 商店网格所在的官方面板
  function storePanel() {
    var grid = storeGrid();
    return grid ? panelOf(grid) : null;
  }

  // ---------------------------------------------------------------- 工具
  function text(card, sel) {
    var el = card.querySelector(sel);
    return el ? String(el.textContent || '').trim() : '';
  }
  // 官方卡片各字段选择器（与 PluginCard.vue 的类名对齐）
  function cardTitle(card) { return text(card, 'div.text-base.font-semibold'); }
    // 版本 / 作者行只取纯文本节点：官方在「有更新」时于同一行末尾塞一个角标 span，
  // 连它一起取会把「作者B 可更新」当成作者名存进名单、也会污染版本号匹配
  function cardSub(card) {
    var box = card.querySelector('div.mt-1.text-xs');
    if (!box) return '';
    var out = '';
    for (var i = 0; i < box.childNodes.length; i++) {
      var n = box.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  function cardDesc(card) { return text(card, 'p.text-sm'); }
  function cardIcon(card) {
    var img = card.querySelector('div.flex.h-10.w-10 img') || card.querySelector('img');
    return img ? String(img.getAttribute('src') || '') : '';
  }
  function cardTags(card) {
    var spans = card.querySelectorAll('div.flex.flex-wrap.gap-1\\.5 > span');
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      var v = String(spans[i].textContent || '').trim();
      if (v) out.push(v);
    }
    return out;
  }
  // 插件所有可能显示名（含各语言 display_name）
  function nameCandidates(item) {
    var out = [];
    if (item && item.name) out.push(String(item.name).trim());
    if (item && item.display_name) out.push(String(item.display_name).trim());
    var loc = (item && item.locales) || {};
    for (var k in loc) {
      if (Object.prototype.hasOwnProperty.call(loc, k) && loc[k] && loc[k].display_name) out.push(String(loc[k].display_name).trim());
    }
    return out;
  }
  // 两个图标地址是否指向同一张图（商店给的可能是相对路径，卡片上是绝对 URL）
  function sameIcon(a, b) {
    var pick = function (v) {
      var s = String(v || '').split(/[?#]/)[0];
      var cut = s.lastIndexOf('/');
      return cut >= 0 ? s.slice(cut + 1) : s;
    };
    var x = pick(a);
    var y = pick(b);
    return !!x && x === y;
  }
  // 把 DOM 卡片对回商店条目：先查名称索引，重名时用版本号区分，
  // 版本也相同时再比作者与图标——否则同名同版本的两个插件会共用同一个存储键，
  // 标记其中一个会把另一个一起藏掉（连坐）。
  // 按测试条件收窄候选池，返回全部命中项（0 条 = 该条件无助于区分，多条 = 继续往下比）
  function narrow(pool, test) {
    var hit = [];
    for (var i = 0; i < pool.length; i++) {
      if (test(pool[i])) hit.push(pool[i]);
    }
    return hit;
  }
  function matchItem(card, title) {
    var t = title != null ? title : cardTitle(card);
    if (!t) return null;
    var cands = itemsByTitle[normName(t)];
    if (!cands || !cands.length) return null;
    if (cands.length === 1) return cands[0];
    var sub = cardSub(card);
    // 版本号能把候选收窄到唯一一条就直接用；收不窄（同名同版本）才继续往下比。
    // 注意不能"先命中就返回"：两个同名同版本的插件第一轮会同时命中同一个候选。
    var pool = narrow(cands, function (c) { return c.version && sub.indexOf('v' + c.version) >= 0; });
    if (!pool.length) pool = cands.slice();
    if (pool.length === 1) return pool[0];
    // 同名同版本很常见（不同作者的插件重名）。作者能唯一命中就用作者；命中不止一条时
    // 收窄候选池继续比，不能"先命中就返回"——那会让两张卡都指向第一条（连坐）。
    var hit = narrow(pool, function (c) { return c.author && sub.indexOf(String(c.author)) >= 0; });
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) pool = hit;
    var icon = cardIcon(card);
    if (icon) {
      hit = narrow(pool, function (c) { return c.icon && sameIcon(icon, c.icon); });
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) pool = hit;
    }
    // 到这一步候选在卡片上完全不可区分（同名同版本同作者同图标）。官方按列表顺序渲染，
    // 隐藏只把 display 置 none、卡片仍留在 DOM 里，所以「本卡在同标题卡片中的序号」
    // 与数据数组的序号一一对应；用它认领，第二张才不会记成第一张的 id。
    var idx = sameTitleIndex(card, t);
    if (idx >= 0 && idx < cands.length && cands[idx] && pool.indexOf(cands[idx]) >= 0) return cands[idx];
    return pool[0];
  }
  // 本卡在同标题卡片中的序号（0 起）。取不到（不在商店网格里）返回 -1。
  // 只在完全无法区分的歧义分支调用，平时不花这个开销。
  function sameTitleIndex(card, title) {
    var want = normName(title);
    if (!want) return -1;
    var cards = storeCards();
    var idx = 0;
    for (var i = 0; i < cards.length; i++) {
      if (normName(cardTitle(cards[i])) !== want) continue;
      if (cards[i] === card) return idx;
      idx++;
    }
    return -1;
  }
  // 卡片的存储键：优先插件 id，商店数据未到时退回标题
  function keyOf(card) {
    var title = cardTitle(card);
    var item = matchItem(card, title);
    var idKey = item && item.id != null ? String(item.id) : null;
    var titleKey = title ? 'title:' + title : null;
    if (!idKey && !titleKey) return null;
    return { key: idKey || titleKey, altKey: idKey && titleKey ? titleKey : null, item: item, title: title };
  }
  // 记录键可能是 id 也可能是标题（取决于点击时商店数据是否已加载），两者任一命中即视为已隐藏，
  // 否则数据晚到会让已隐藏的卡片自己"复活"。
  function hiddenEntry(info) {
    if (!info) return null;
    if (hidden[info.key]) return hidden[info.key];
    if (info.altKey && hidden[info.altKey]) return hidden[info.altKey];
    // 记录键与卡片标题的空格/大小写不完全一致（旧版本写的记录、商店改过名字）时按归一化标题认领。
    // 卡片已经对上商店条目、却要拿标题去认一条带 id 的记录时跳过：商店里同名插件不止一个，会连坐。
    if (info.title) {
      var want = normName(info.title);
      // 卡片对上条目时，带 id 的记录上面已经按 id / "title:" 键认领过，只剩「商店数据还没到
      // 就点了按钮」留下的无 id 标题记录需要兜底。先查标题索引直接排除绝大多数情况：
      // 这段每轮每张卡都要跑，名单攒到几百条时整表扫会把官方列表拖卡。
      if (info.item && !hiddenIndex().titles[want]) return null;
      var keys = Object.keys(hidden);
      for (var i = 0; i < keys.length; i++) {
        var rec = hidden[keys[i]];
        if (!rec || !rec.title || normName(rec.title) !== want) continue;
        if (info.item && rec.id != null) continue;
        return rec;
      }
    }
    return null;
  }
  // 把卡片内容与商店条目揉成一条可离线渲染的记录
  function snapshot(card, item, title) {
    var sub = cardSub(card);
    var parts = sub.split('·');
    var ver = (parts[0] || '').replace(/^\s*v/i, '').trim();
    var snap = {
      id: item && item.id != null ? String(item.id) : null,
      title: title || cardTitle(card),
      version: (item && item.version) || ver || '',
      author: (item && item.author) || (parts[1] || '').trim(),
      description: (item && item.description) || cardDesc(card) || '',
      repo: (item && item.repo) || null,
      commit_sha: (item && item.commit_sha) || null,
      icon: (item && item.icon) || cardIcon(card) || '',
      tags: (item && item.tags) || cardTags(card) || [],
      installed: !!(item && item.installed),
      hiddenAt: Date.now()
    };
    // 完整条目留一份：自建卡片点开官方详情弹窗时要用原始字段（downloads/stars/locales…）
    if (item) {
      try { snap.raw = JSON.parse(JSON.stringify(item)); } catch (e) { /* ignore */ }
    }
    return snap;
  }

  // 标记时存下的快照会过期：插件可能后来被装上了，快照里还是「未安装」。
  // 渲染前用最新拉到的条目覆盖易变字段（安装状态 / 版本 / commit），
  // 否则自建页会对着已安装插件再显示一次「安装」，点下去就是重复安装任务。
  function liveRecord(rec) {
    if (!rec) return rec;
    var it = rec.id != null ? itemsById[String(rec.id)] : null;
    if (!it && rec.repo) it = itemsByRepo[normName(rec.repo)];
    // 早期点按钮时商店数据还没到，记录里既没有 id 也没有仓库地址，只能按标题认领；
    // 标题命中多个条目时不敢乱配，宁可维持原样。
    if (!it && rec.title) {
      var cands = itemsByTitle[normName(rec.title)];
      if (cands && cands.length === 1) it = cands[0];
    }
    if (!it) return rec;
    var merged = {};
    for (var k in rec) {
      if (Object.prototype.hasOwnProperty.call(rec, k)) merged[k] = rec[k];
    }
    // 安装状态取并集：商店列表可能还没重新拉过（刚提交完安装任务时它仍是 false），
    // 记录里的 true 是更新的事实；反过来，用户之后卸载了插件，这里会一直显示已安装，
    // 直到重新标记或刷新列表——宁可让按钮不可点，也不重复排安装任务。
    merged.installed = !!(it.installed || rec.installed);
    if (it.version) merged.version = it.version;
    if (it.commit_sha) merged.commit_sha = it.commit_sha;
    // 快照早于商店数据时缺仓库地址，「安装」按钮就永远点不动；补上。
    if (!merged.repo && it.repo) merged.repo = it.repo;
    // 原始条目整份刷新：详情弹窗的版本、分类、KiraAI 版本号都取自这里，
    // 沿用标记当时那份会让升级过的插件在详情里显示旧版本
    try { merged.raw = JSON.parse(JSON.stringify(it)); } catch (e) { merged.raw = it; }
    return merged;
  }

  // 自建页卡片点击 → 打开与官方同款详情弹窗。
  // 存下来的记录字段名与 showDetails 读的完全一致（id/title/version/…），直接传即可，
  // 不用再摊平一层；缺 raw 的早期记录也能开，只是少 KiraAI 版本与分类两行。
  function openDetails(snap) {
    if (snap) showDetails(snap);
  }

  // ---------------------------------------------------------------- 详情弹窗（官方桥拿不到时的等价实现）
  var dlgWrap = null;

  function onDlgKey(ev) {
    if (ev && ev.key === 'Escape') closeDetails();
  }

  // 关闭详情弹窗并解绑全局监听
  function closeDetails() {
    if (dlgWrap && dlgWrap.parentNode) dlgWrap.parentNode.removeChild(dlgWrap);
    dlgWrap = null;
    document.removeEventListener('keydown', onDlgKey, true);
  }

  // 弹窗右上角的 × 图标（内联 SVG，不依赖图标库）
  function svgCloseIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('class', 'w-6 h-6');
    var p1 = document.createElementNS(ns, 'path');
    p1.setAttribute('d', 'M6 6l12 12');
    var p2 = document.createElementNS(ns, 'path');
    p2.setAttribute('d', 'M18 6L6 18');
    svg.appendChild(p1);
    svg.appendChild(p2);
    return svg;
  }

  // 详情弹窗里的一行「字段名 + 值」
  function dlRow(term, valueClass, child) {
    var box = el('div');
    box.appendChild(el('dt', 'text-theme-subtle', term));
    var dd = el('dd', valueClass || 'mt-1 text-theme-high');
    if (child && child.nodeType === 1) dd.appendChild(child);
    else dd.textContent = String(child == null ? '' : child);
    box.appendChild(dd);
    return box;
  }

  // 标签胶囊组：详情弹窗带「标签」小标题、卡片不带，只差外层与字号
  function tagChips(tags, boxCls, chipCls) {
    var box = el('div', boxCls);
    for (var i = 0; i < tags.length; i++) box.appendChild(el('span', chipCls, String(tags[i])));
    return box;
  }

  // 复刻官方详情弹窗（PluginView.vue:928-988，Modal content-class="max-w-4xl"）：
  // 垂直+水平居中、遮罩 black/50、面板 max-w-4xl 且限高 90vh、头部「插件详情」+ 插件名 + ✕、
  // 主体 = 描述 + 两列字段表（插件 ID / 版本 / 作者 / 仓库链接 / 分类 / KiraAI 版本）+ 标签。
  // 官方 README 区只对「已安装」插件有内容（README 取自本地插件目录），故这里同样不显示。
  function showDetails(snap) {
    closeDetails();
    var tx = T();
    var item = snap || {};
    var raw = item.raw || {};
    var idText = item.id != null ? String(item.id) : '';
    var version = item.version || raw.version || '';
    var author = item.author || raw.author || '';
    var description = item.description || raw.description || '';
    var repo = item.repo || raw.repo || '';
    var tags = item.tags || raw.tags || [];
    var coreVersion = raw.core_version || item.core_version || '';
    var category = raw.category_name || raw.category || '';

    var wrap = el('div', 'fixed inset-0 flex items-center justify-center');
    wrap.setAttribute('data-ksp-dlg', '1');
    // 屏幕阅读器要知道这是个模态弹窗（官方 Modal 也会带同样语义）
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', tx.detailsTitle);
    wrap.style.zIndex = '99999';

    var overlay = el('div', 'absolute inset-0');
    overlay.style.background = 'rgba(0, 0, 0, 0.5)';
    wrap.appendChild(overlay);

    var panel = el('div', 'relative w-full mx-4 max-w-4xl');
    var box = el('div', 'bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full flex flex-col overflow-hidden');
    box.style.maxHeight = '90vh';

    var head = el('div', 'flex items-start justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700');
    var hleft = el('div', 'min-w-0 pr-4');
    hleft.appendChild(el('h3', 'text-lg font-semibold text-theme-strong', tx.detailsTitle));
    hleft.appendChild(el('p', 'mt-1 text-sm text-theme-subtle break-words', item.title || idText));
    head.appendChild(hleft);
    var closeBtn = el('button', 'flex-shrink-0 text-theme-faint text-theme-faint-hover');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', tx.close);
    closeBtn.appendChild(svgCloseIcon());
    closeBtn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); closeDetails(); });
    head.appendChild(closeBtn);
    box.appendChild(head);

    var body = el('div', 'px-6 py-5 flex-1 min-h-0 overflow-y-auto space-y-5');
    if (description) body.appendChild(el('p', 'whitespace-pre-wrap text-sm leading-6 text-theme-supporting', description));
    else body.appendChild(el('p', 'text-sm text-theme-faint', tx.noDescription));

    var dl = el('dl', 'grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 text-sm');
    if (idText) dl.appendChild(dlRow(tx.pluginId, 'mt-1 font-mono break-all text-theme-high', idText));
    if (version) dl.appendChild(dlRow(tx.version, null, 'v' + version));
    if (author) dl.appendChild(dlRow(tx.author, null, author));
    if (repo) {
      // 仓库地址来自第三方商店 JSON：只给 http(s) 链接，其它协议（javascript:/data:）当纯文本显示
      var repoVal = repo;
      if (/^https?:\/\//i.test(repo)) {
        repoVal = document.createElement('a');
        repoVal.setAttribute('href', repo);
        repoVal.setAttribute('target', '_blank');
        repoVal.setAttribute('rel', 'noopener noreferrer');
        repoVal.className = 'text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300 break-all';
        repoVal.textContent = repo;
      }
      dl.appendChild(dlRow(tx.repoUrl, 'mt-1 break-all', repoVal));
    }
    if (category) dl.appendChild(dlRow(tx.category, null, category));
    if (coreVersion) dl.appendChild(dlRow(tx.coreVersion, null, coreVersion));
    if (dl.children.length) body.appendChild(dl);

    if (tags && tags.length) {
      var tagBox = el('div');
      tagBox.appendChild(el('p', 'text-sm text-theme-subtle', tx.tags));
      tagBox.appendChild(tagChips(tags, 'mt-2 flex flex-wrap gap-1.5', TAG_CHIP + ' text-xs'));
      body.appendChild(tagBox);
    }
    box.appendChild(body);

    panel.appendChild(box);
    wrap.appendChild(panel);

    // 官方 Modal 的关闭规则：按下与抬起都在面板外才算点遮罩（拖选文本不会误关）
    var downOutside = false;
    wrap.addEventListener('mousedown', function (ev) { downOutside = !panel.contains(ev.target); });
    wrap.addEventListener('mouseup', function (ev) {
      if (downOutside && !panel.contains(ev.target)) closeDetails();
      downOutside = false;
    });
    wrap.addEventListener('click', function (ev) { if (ev.target === overlay) closeDetails(); });

    document.body.appendChild(wrap);
    dlgWrap = wrap;
    document.addEventListener('keydown', onDlgKey, true);
  }

  var touched = [];

  // 早期版本在商店数据还没到时按「title:名称」存记录，这类记录只能靠标题认人，
  // 商店里同名插件一多就会连坐。数据到了以后把它升级成 id 记录，认领立刻变精确：
  // 标题在当前数据里必须唯一命中，否则不动（宁可继续按标题认，也不乱配）。
  function upgradeTitleRecords() {
    var keys = Object.keys(hidden);
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var oldKey = keys[i];
      var rec = hidden[oldKey];
      if (!rec || rec.id != null || !rec.title) continue;
      var bucket = itemsByTitle[normName(rec.title)];
      if (!bucket || bucket.length !== 1) continue;
      var it = bucket[0];
      if (!it || it.id == null) continue;
      var nk = String(it.id);
      if (!hidden[nk]) {
        var merged = {};
        for (var k in rec) {
          if (Object.prototype.hasOwnProperty.call(rec, k)) merged[k] = rec[k];
        }
        merged.id = nk;
        if (!merged.repo && it.repo) merged.repo = it.repo;
        hidden[nk] = merged;
      }
      // 有同 id 记录时这条标题记录只是重复项；否则内容已搬去新键 —— 两种都丢掉旧键
      delete hidden[oldKey];
      removedKeys[oldKey] = 1;
      changed = true;
    }
    if (changed) saveHidden();
  }

  // 一轮里每张卡的「卡片 ↔ 商店条目」匹配只算一次：按钮注入与隐藏判定都要用，
  // 各算一遍等于把 keyOf（几次 querySelector + 名字归一化）跑成两倍。
  function cardInfos(cards) {
    var list = cards || storeCards();
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ card: list[i], info: keyOf(list[i]) });
    return out;
  }

  // 把当前页所有已标记卡片隐藏（官方列表重渲染后也要补一次）
  function applyHidden(infos) {
    upgradeTitleRecords();
    // 守卫：激活态下面板一旦被置成 display:none，官方面板又被 ksp-hide-store 藏着，
    // 屏幕上就什么都没有了。放在这里是因为 quickSync 的快捷分支只跑 applyHidden
    // （不跑 ensurePanel / applyStoreHidden），搁别处白屏得等 2.5s 轮询才修好。
    var self = document.getElementById(PANEL_ID);
    if (self && mineActive && self.style.display === 'none') self.style.display = '';
    for (var i = touched.length - 1; i >= 0; i--) {
      var node = touched[i];
      if (!node.isConnected) { touched.splice(i, 1); continue; }
      var info = keyOf(node);
      if (!hiddenEntry(info)) {
        node.style.display = '';
        touched.splice(i, 1);
      }
    }
    var list = infos || cardInfos();
    for (var j = 0; j < list.length; j++) {
      var card = list[j].card;
      if (!card.isConnected) continue;
      if (hiddenEntry(list[j].info)) {
        card.style.display = 'none';
        if (touched.indexOf(card) < 0) touched.push(card);
      } else if (card.style.display === 'none') {
        // 官方重排后可能复用了我们隐藏过的 DOM 节点：不该隐藏的要还原，否则会留下空位
        card.style.display = '';
      }
    }
  }

  // 名字比较用的归一化：抹掉首尾与内部多余空白、统一小写
  function normName(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // 名单的键级索引：商店一次返回上千条，每条都线性扫一遍名单会拖慢官方列表的
  // 首屏渲染（500 条 × 300 条记录 = 15 万次字符串归一化）。名单每次落盘后置空重建。
  var hiddenIdx = null;
  function invalidateHiddenIndex() { hiddenIdx = null; }
  function hiddenIndex() {
    if (hiddenIdx) return hiddenIdx;
    var idx = { ids: nullMap(), repos: nullMap(), titles: nullMap() };
    var keys = Object.keys(hidden);
    for (var i = 0; i < keys.length; i++) {
      var rec = hidden[keys[i]];
      if (!rec) continue;
      if (rec.id != null) idx.ids[String(rec.id)] = 1;
      if (rec.repo) idx.repos[normName(rec.repo)] = 1;
      // 只有无 id 的记录才按标题认人（有 id 的记录拿标题匹配会连坐同名插件）
      if (rec.id == null && rec.title) idx.titles[normName(rec.title)] = 1;
    }
    hiddenIdx = idx;
    return idx;
  }
  // 隐藏记录可能以 id / 标题保存，两种都要能认出来。它是响应过滤的唯一判据。
  // 有 id 的记录只认 id 与仓库地址：商店里同名插件不止一个，拿标题去匹配会连坐。
  // 只有「商店数据还没拉到就点了按钮」留下的无 id 记录，才退回标题匹配。
  function isHiddenItem(item) {
    if (!item) return false;
    var id = item.id != null ? String(item.id) : null;
    // 键就是 id 的记录最常见，先直接命中，连索引都不用建
    if (id && hidden[id]) return true;
    var idx = hiddenIndex();
    if (id && idx.ids[id]) return true;
    var repo = normName(item.repo);
    // 同一个仓库挂多个插件时，repo 兜底会把没点过的插件一起藏掉；只有「这个仓库
    // 在商店里确实只有一个插件」才敢用它认出「id 变了但还是同一个插件」。
    if (repo && idx.repos[repo] && repoAlone(repo)) return true;
    var names = nameCandidates(item);
    for (var n = 0; n < names.length; n++) {
      if (idx.titles[normName(names[n])]) return true;
    }
    return false;
  }
  function hideCard(card, item, key, title) {
    if (item && item.id != null) key = String(item.id);
    // id 与标题都拿不到时，这条记录存不住（normalizeHidden 会丢弃它），
    // 那就不要先把卡片藏起来——藏了又冒回来比按钮无效更让人困惑。
    if (key == null || key === '') return;
    var prev = hidden[key];
    hidden[key] = snapshot(card, item, title);
    if (!saveHidden()) {
      if (prev) hidden[key] = prev; else delete hidden[key];
      toast(T().saveFailed, 'err');
      return;
    }
    if (touched.indexOf(card) < 0) touched.push(card);
    // 卡片当场消失，本页剩余卡片由 CSS grid 自动前移；不跨页补位
    try { card.style.display = 'none'; } catch (e) { /* ignore */ }
    if (mineActive) renderMine();
  }

  // 官方商店的列表来自响应：标记时 entry 已被从 JSON 里剔除，取消后那份数据
  // 不会自己回来，只把卡片 display 还原是放不回去的——点一次官方「刷新」让它重拉。
  // 刷新按钮随工具条一起渲染，找不到就只能靠「清空名单」兜底。
  var lastRefreshAt = 0;
  function refreshStore() {
    var now = Date.now();
    if (now - lastRefreshAt < 1500) return false;
    var btn = findButton(storePanel(), function (b) {
      return /^(刷新|重新加载|refresh|reload)$/i.test(String(b.textContent || '').trim());
    });
    if (!btn) return false;
    lastRefreshAt = now;
    btn.click();
    return true;
  }
  // 取消标记，并让插件回到商店
  function undoHidden(key) {
    delete hidden[key];
    removedKeys[key] = 1;
    // 写不进本地存储时界面已经恢复了，刷新后却会复活——必须让用户当场知道
    if (!saveHidden()) toast(T().saveFailed, 'err');
    // 官方列表里若还有这张卡（页面还没重新拉过），applyHidden 会把它当场放回去
    applyHidden();
    renderMine();
    refreshStore();
  }
  // 名单与真实数据错配（同名连坐、id 变化）时唯一能自救的出口：
  // 清空后重拉一次商店，一切回到原始状态。
  function clearAllHidden() {
    var keys = Object.keys(hidden);
    for (var i = 0; i < keys.length; i++) removedKeys[keys[i]] = 1;
    hidden = nullMap();
    var saved = saveHidden();
    applyHidden();
    renderMine();
    refreshStore();
    toast(saved ? T().cleared : T().saveFailed, saved ? undefined : 'err');
  }

  // ---------------------------------------------------------------- 商店卡片按钮
  function actionRow(card) {
    return card.querySelector('div.flex.items-center.justify-end');
  }

  // 先看按钮行文案（官方渲染的「已安装」），命中就不必再查商店数据；
  // 传入 info 时复用调用方已经算好的匹配结果，省一次 keyOf。
  function isInstalledCard(card, row, info) {
    var r = row || actionRow(card);
    if (r) {
      var t = String(r.textContent || '');
      // 「已安装」和「更新」都是已装插件的按钮文案：官方对装了又有新版的卡片只显示「更新」，
      // 漏掉它就会给已装插件塞一个「不感兴趣」，藏进自建页后还点不了安装
      if (t.indexOf(TEXT.zh.installed) >= 0 || t.indexOf(TEXT.en.installed) >= 0) return true;
      if (t.indexOf(TEXT.zh.update) >= 0 || t.indexOf(TEXT.en.update) >= 0) return true;
    }
    var it = (info || keyOf(card) || {}).item;
    return !!(it && it.installed);
  }

  // 给商店卡片补「不感兴趣」按钮；装好后自动摘掉
  function ensureCardButtons(infos) {
    var list = infos || cardInfos();
    for (var i = 0; i < list.length; i++) {
      var card = list[i].card;
      var row = actionRow(card);
      if (!row) continue;
      var existing = row.querySelector('[' + BTN_ATTR + ']');
      var info = list[i].info;
      // 已安装的插件不再需要"不感兴趣"；安装状态变化时还要把残留的按钮摘掉
      if (isInstalledCard(card, row, info)) {
        if (existing) row.removeChild(existing);
        continue;
      }
      if (existing) continue;
      if (!info) continue;
      var btn = clickBtn(BTN_NEUTRAL + ' mr-2', T().mark, function (self) {
        var c = self.__knCard;
        if (!c || !c.isConnected) return;
        var inf = keyOf(c) || self.__knInfo;
        if (!inf) return;
        hideCard(c, inf.item, inf.key, inf.title);
      });
      btn.setAttribute(BTN_ATTR, '1');
      btn.__knCard = card;
      btn.__knInfo = info;
      row.insertBefore(btn, row.firstChild);
    }
  }

  // ---------------------------------------------------------------- 标签页
  var mineActive = false;
  // 路由切走时 Vue 会把整个插件页（连同自建面板）一起卸载，面板没了但状态变量还是 true。
  // 不复位的话：重建出来的面板按"隐藏"创建、applyStoreHidden 又把官方面板全藏掉，
  // 回到插件页就是一片空白。面板不在了就当作回到了官方页。
  function reclaimViewState() {
    var mine = document.getElementById(PANEL_ID);
    var gone = !mine || !document.documentElement.contains(mine);
    // 详情弹窗挂在 body 上，不随视图卸载：离开插件页后它会一直盖在别的页面上
    if (gone && dlgWrap) closeDetails();
    if (!mineActive) return;
    if (gone) mineActive = false;
  }
  var minePage = 1; // 自建页当前页码（每页 STORE_PAGE_SIZE 张）

  // 在官方标签栏里维护「不感兴趣插件」标签
  function ensureTab() {
    var tb = findTabBar();
    if (!tb) return;
    var btn = document.getElementById(TAB_ID);
    if (!btn) {
      btn = clickBtn(TAB_BASE + ' ' + TAB_OFF, T().tab, function () { setMine(true); });
      btn.id = TAB_ID;
      tb.store.parentElement.insertBefore(btn, tb.store.nextSibling);
    } else {
      if (btn.parentElement !== tb.store.parentElement || btn.previousElementSibling !== tb.store) {
        tb.store.parentElement.insertBefore(btn, tb.store.nextSibling);
      }
      if (btn.textContent !== T().tab) btn.textContent = T().tab;
    }
    btn.className = TAB_BASE + ' ' + (mineActive ? TAB_ON : TAB_OFF);
    tb.bar.setAttribute('data-ksp-tabbar', '1');
    // 官方标签页保持自己的配色，不再压制（顺手清掉历史遗留的压制类）
    if (tb.bar.classList.contains('ksp-tabactive')) tb.bar.classList.remove('ksp-tabactive');
    // 但自建页激活时官方「插件商店」不该继续显示激活态：借用官方自己的未激活 class 换掉
    applyStoreTabLook(tb.store);
  }

  function applyStoreTabLook(storeBtn) {
    if (!storeBtn) return;
    var saved = storeBtn.getAttribute('data-ksp-tab-saved');
    if (mineActive) {
      if (saved == null) storeBtn.setAttribute('data-ksp-tab-saved', storeBtn.className);
      var want = TAB_BASE + ' ' + TAB_OFF;
      if (storeBtn.className !== want) storeBtn.className = want;
    } else if (saved != null) {
      if (storeBtn.className !== saved) storeBtn.className = saved;
      storeBtn.removeAttribute('data-ksp-tab-saved');
    }
  }

  // 注入样式（只注入一次）
  function injectStyle() {
    if (document.getElementById('ksp-style')) return;
    var st = document.createElement('style');
    st.id = 'ksp-style';
    st.textContent =
      '.ksp-hide-store{display:none !important;}' +
      '#ksp-panel img{max-width:100%;}' +
      '#' + TAB_ID + '{white-space:nowrap;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // 在官方面板同级容器里维护自建面板
  function ensurePanel() {
    var tb = findTabBar();
    var panel = storePanel();
    // 官方面板找不到时（例如从未打开过插件商店、网格尚未渲染）退化挂到标签栏同级容器末尾
    var host = panel ? panel.parentElement : (tb ? tb.bar.parentElement : null);
    if (!host) return;
    var mine = document.getElementById(PANEL_ID);
    if (!mine) {
      mine = document.createElement('div');
      mine.id = PANEL_ID;
      mine.style.display = 'none';
      var tools = el('div', 'flex items-center justify-end mb-3');
      var clearBtn = clickBtn(
        'px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-theme-supporting hover:text-theme-strong',
        T().clearAll,
        function () {
          var ask = window.confirm ? window.confirm(T().clearConfirm) : true;
          if (ask) clearAllHidden();
        }
      );
      clearBtn.setAttribute('data-ksp-clear', '1');
      tools.appendChild(clearBtn);
      mine.appendChild(tools);
      var grid = el('div', 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4');
      grid.setAttribute('data-ksp-grid', '1');
      mine.appendChild(grid);
      var pager = document.createElement('div');
      pager.setAttribute('data-ksp-pager', '1');
      pager.style.display = 'none';
      mine.appendChild(pager);
      host.insertBefore(mine, panel ? panel.nextSibling : null);
      renderMine();
    } else if (panel) {
      if (mine.previousElementSibling !== panel) host.insertBefore(mine, panel.nextSibling);
    } else if (mine.parentElement !== host) {
      host.appendChild(mine);
    }
  }

  // 用自注入的 CSS 类（而非 inline style）隐藏官方面板：
  // v-show 只会改写 inline display，压不过 !important，因此不会被 Vue 覆盖掉。
  // 切到「不感兴趣插件」页时，当前显示的官方面板（不论哪个）都应让位。
  function applyStoreHidden() {
    var marked = document.querySelectorAll('.ksp-hide-store');
    var want = mineActive ? visiblePanels() : [];
    var i;
    for (i = 0; i < marked.length; i++) {
      if (want.indexOf(marked[i]) < 0) marked[i].classList.remove('ksp-hide-store');
    }
    for (i = 0; i < want.length; i++) {
      if (!want[i].classList.contains('ksp-hide-store')) want[i].classList.add('ksp-hide-store');
    }
  }


  // 切换自建页 / 官方商店页
  function setMine(on) {
    mineActive = !!on;
    var mine = document.getElementById(PANEL_ID);
    if (mine) mine.style.display = mineActive ? '' : 'none';
    applyStoreHidden();
    if (mineActive) renderMine();
    ensureTab();
  }

  // 点击任何官方标签页时，关闭自定义页
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var btn = t.closest('button');
    if (!btn) return;
    if (btn.id === TAB_ID) return;
    if (!mineActive) return;
    var tb = findTabBar();
    if (tb && tb.bar.contains(btn)) setMine(false);
  }, true);

  // ---------------------------------------------------------------- 自定义页渲染
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  // 自建页卡片：结构与官方 PluginCard 的 store 模式一致
  // 造一颗「不冒泡」的按钮：卡片自身 click 会开详情、面板里也有全局监听，
  // 按钮处理完必须 stopPropagation，否则会被当成点卡片。disabled 时也顺手禁掉点击。
  function clickBtn(cls, label, onClick, disabled) {
    var btn = el('button', cls, label);
    btn.type = 'button';
    btn.style.whiteSpace = 'nowrap';
    btn.disabled = !!disabled;
    if (onClick) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        onClick(btn);
      });
    }
    return btn;
  }

  function buildCard(key, snap) {
    var card = el('div', 'bg-white dark:bg-gray-900 rounded-lg shadow p-4 flex flex-col cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    // 和官方卡片行为一致：点卡片空白处打开详情弹窗，点按钮/链接不触发
    card.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('a, button, input, select, textarea')) return;
      openDetails(snap);
    });
    // 官方卡片支持回车/空格打开详情（PluginCard.vue:8-9），自建卡片也要能用键盘
    card.addEventListener('keydown', function (ev) {
      if (!ev || (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar')) return;
      ev.preventDefault();
      openDetails(snap);
    });

    var head = el('div', 'flex items-start justify-between mb-3');
    var left = el('div', 'flex min-w-0 items-start gap-3');
    if (snap.icon) {
      var iconWrap = el('div', 'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px]');
      var img = document.createElement('img');
      img.setAttribute('src', snap.icon);
      img.setAttribute('alt', '');
      img.className = 'h-full w-full object-contain';
      iconWrap.appendChild(img);
      left.appendChild(iconWrap);
    }
    var titleBox = el('div', 'min-w-0');
    titleBox.appendChild(el('div', 'text-base font-semibold text-theme-high truncate', snap.title || ''));
    var sub = 'v' + (snap.version || '?') + (snap.author ? ' · ' + snap.author : '');
    titleBox.appendChild(el('div', 'mt-1 text-xs text-theme-subtle', sub));
    left.appendChild(titleBox);
    head.appendChild(left);
    card.appendChild(head);

    if (snap.description) card.appendChild(el('p', 'text-sm text-theme-supporting line-clamp-3 mb-3', snap.description));

    if (snap.tags && snap.tags.length) {
      card.appendChild(tagChips(snap.tags, 'flex flex-wrap gap-1.5 mb-3', TAG_CHIP + ' text-[10px]'));
    }

    var bottom = el('div', 'mt-auto');
    var row = el('div', 'flex items-center justify-end');

    row.appendChild(clickBtn(BTN_PRIMARY + ' mr-2', T().undo, function () { undoHidden(key); }));

    var installed = !!snap.installed;
    // 「已安装」只靠样式变灰还不够，要真的禁用（对齐官方 installed 模式的 disabled 按钮）
    row.appendChild(clickBtn(
      installed ? BTN_DISABLED : BTN_PRIMARY,
      installed ? T().installed : T().install,
      installed ? null : function (btn) { installSnap(snap, btn, key); },
      installed
    ));

    bottom.appendChild(row);
    card.appendChild(bottom);
    return card;
  }

  // 分页条复刻官方（PluginView.vue:636-656）：只在超过一页时出现，中缝显示「第 x / y 页」
  function pagerText(page, total) {
    return lang() === 'zh' ? ('第 ' + page + ' / ' + total + ' 页') : ('Page ' + page + ' of ' + total);
  }

  function renderPager(totalItems) {
    var mine = document.getElementById(PANEL_ID);
    if (!mine) return;
    var pager = mine.querySelector('[data-ksp-pager]');
    if (!pager) return;
    pager.textContent = '';
    var totalPages = Math.max(1, Math.ceil(totalItems / STORE_PAGE_SIZE));
    if (totalItems <= STORE_PAGE_SIZE) { pager.style.display = 'none'; pager.className = ''; return; }
    pager.style.display = '';
    pager.className = 'mt-6 flex items-center justify-center gap-3';
    pager.appendChild(clickBtn(PAGE_BTN, T().prevPage, function () {
      if (minePage > 1) { minePage--; renderMine(); }
    }, minePage <= 1));
    pager.appendChild(el('span', 'text-sm text-theme-subtle', pagerText(minePage, totalPages)));
    pager.appendChild(clickBtn(PAGE_BTN, T().nextPage, function () {
      if (minePage < totalPages) { minePage++; renderMine(); }
    }, minePage >= totalPages));
  }

  // 渲染自建页（按 hiddenAt 倒序、每页 STORE_PAGE_SIZE 张）
  function renderMine() {
    var mine = document.getElementById(PANEL_ID);
    if (!mine) return;
    var grid = mine.querySelector('[data-ksp-grid]');
    if (!grid) return;
    grid.textContent = '';
    var keys = Object.keys(hidden);
    keys.sort(function (a, b) {
      return ((hidden[b] && hidden[b].hiddenAt) || 0) - ((hidden[a] && hidden[a].hiddenAt) || 0);
    });
    if (!keys.length) {
      var empty = el('div', 'flex flex-col items-center justify-center py-16 gap-2 col-span-full');
      empty.style.gridColumn = '1 / -1';
      empty.appendChild(el('div', 'text-sm text-theme-subtle', T().empty));
      empty.appendChild(el('div', 'text-xs text-theme-faint', T().emptyHint));
      grid.appendChild(empty);
      renderPager(0);
      return;
    }
    var totalPages = Math.max(1, Math.ceil(keys.length / STORE_PAGE_SIZE));
    if (minePage > totalPages) minePage = totalPages;
    if (minePage < 1) minePage = 1;
    var start = (minePage - 1) * STORE_PAGE_SIZE;
    var slice = keys.slice(start, start + STORE_PAGE_SIZE);
    for (var i = 0; i < slice.length; i++) {
      grid.appendChild(buildCard(slice[i], liveRecord(hidden[slice[i]] || {})));
    }
    renderPager(keys.length);
  }

  // ---------------------------------------------------------------- 安装
  // key 是这条记录在名单里的键：装完后把已安装状态记回去，重开页面不会再显示「安装」
  function installSnap(snap, btn, key) {
    if (!snap.repo) { toast(T().noRepo, 'err'); return; }
    var token = null;
    try { token = localStorage.getItem('jwt_token'); } catch (e) { /* ignore */ }
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    // commit_sha 只接受完整 40 位（后端对短 sha 直接 422），拿不到就传 null 退化成下载 HEAD
    var sha = snap.commit_sha ? String(snap.commit_sha).trim().toLowerCase() : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) sha = null;
    var old = btn.textContent;
    var started = false;
    btn.disabled = true;
    btn.textContent = T().installing;
    fetch('/api/plugins/install/github/tasks', {
      method: 'POST',
      headers: headers,
      // gh_proxy: 'auto' 与官方商店安装一致（PluginView.vue:2509）：后端会测速挑最快的镜像。
      // 不带这个字段后端直连 github.com，国内网络下经常下载失败。
      body: JSON.stringify({ repo_url: snap.repo, gh_proxy: 'auto', commit_sha: sha })
    }).then(function (res) {
      if (res.ok) {
        started = true;
        toast(T().installStarted);
        return;
      }
      // 失败原因在后端 detail 里（422 下载失败 / 409 已安装），只报状态码帮不上用户
      return Promise.resolve()
        .then(function () { return typeof res.text === 'function' ? res.text() : ''; })
        .then(function (txt) {
          var detail = '';
          try {
            var obj = JSON.parse(String(txt));
            if (obj && obj.detail) detail = String(obj.detail);
          } catch (e2) { /* 非 JSON 响应 */ }
          throw new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''));
        });
    }).catch(function (e) {
      toast(T().installFailed + ': ' + (e && e.message ? e.message : e), 'err');
    }).then(function () {
      // 提交成功后保持「已安装」的禁用态：任务已入队，再点一次只会多排一个安装任务
      if (started) {
        btn.textContent = T().installed;
        btn.disabled = true;
        if (key && hidden[key]) { hidden[key].installed = true; saveHidden(); }
        return;
      }
      btn.disabled = false;
      btn.textContent = old;
    });
  }

  // 轻提示，2.6s 后自动消失
  function toast(msg, kind) {
    var box = document.getElementById('ksp-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ksp-toast';
      box.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(box);
    }
    var bg = kind === 'err' ? 'background:#b91c1c;' : 'background:#111827;';
    var item = document.createElement('div');
    item.style.cssText = 'padding:8px 14px;border-radius:8px;font-size:13px;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;transition:opacity .18s ease;' + bg;
    item.textContent = String(msg);
    box.appendChild(item);
    requestAnimationFrame(function () { item.style.opacity = '1'; });
    setTimeout(function () {
      item.style.opacity = '0';
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 220);
    }, 2600);
  }

  // ---------------------------------------------------------------- 主循环
  // 只做"立刻见效"的那几件事：官方一渲染出卡片就当场隐藏。
  // MutationObserver 直接调它（不经过 120ms 防抖），切页/翻页回来才不会先亮一下再消失。
  var syncing = false;
  function quickSync() {
    if (syncing) return;
    syncing = true;
    try {
      // 路由切回插件页时整个视图是新建的：标签与面板都不在了，只做"隐藏卡片"不够，
      // 否则「不感兴趣插件」标签要等 2.5s 轮询才回来。缺件时直接跑一轮完整同步。
      if (!document.getElementById(TAB_ID) || !document.getElementById(PANEL_ID)) tick();
      else {
        // 切语言会触发整页重渲染，落在网格里就只会走这条路：语言刷新必须放在这儿
        syncLanguage();
        applyHidden();
      }
      ensureCardButtons();
    } catch (e) {
      if (window.console && console.warn) console.warn('[store-purifier]', e);
    }
    syncing = false;
  }

  // 变化是否落在商店卡片网格里（含网格自己被重建）
  function touchesStoreGrid(muts) {
    var grid = storeGrid();
    if (!grid) return false;
    for (var i = 0; i < muts.length; i++) {
      var n = muts[i] && muts[i].target;
      var node = n && n.nodeType === 1 ? n : (n && n.parentNode);
      if (!node) continue;
      if (node === grid || grid.contains(node) || (node.contains && node.contains(grid))) return true;
    }
    return false;
  }

  var timer = null;
  // 主循环：维持标签 / 面板 / 样式 / 隐藏状态
  function tick() {
    // 视图状态必须每轮复位：详情弹窗挂在 body 上，离开插件页后不会自己消失。
    try { reclaimViewState(); } catch (e) { /* ignore */ }
    // 既没有官方标签栏也没有我们的面板 = 不在插件页。此时后面的同步全是白跑：
    // 在聊天页/设置页也会每 120ms 扫一遍网格候选、跑完整同步。
    if (!findTabBar() && !document.getElementById(PANEL_ID)) return;
    try {
      injectStyle();
      syncLanguage();
      ensureTab();
      ensurePanel();
      // 卡片匹配只算一次，按钮注入与隐藏判定共用（两者都不改卡片自身的可识别信息）
      var infos = cardInfos();
      applyStoreHidden();
      ensureCardButtons(infos);
      applyHidden(infos);
    } catch (e) {
      if (window.console && console.warn) console.warn('[store-purifier]', e);
    }
  }
  // 120ms 防抖，避免一阵 DOM 变化触发多次重排
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; tick(); }, 120);
  }

  // 首次运行，并监听 DOM 变化持续同步
  function boot() {
    tick();
    try {
      var mo = new MutationObserver(function (muts) {
        if (touchesStoreGrid(muts)) quickSync();
        else schedule();
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    } catch (e) { /* ignore */ }
    setInterval(tick, 2500);
    window.addEventListener('storage', function (ev) {
      // 别的标签页改了名单：同样要经过合并，避免把重复记录又带回来
      if (ev && ev.key === LS_KEY) {
        hidden = normalizeHidden(loadHidden());
        invalidateHiddenIndex();
        if (mineActive) renderMine();
        applyHidden();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
