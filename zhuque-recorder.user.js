// ==UserScript==
// @name         朱雀AI检测记录助手
// @namespace    https://github.com/zhuque-ai-recorder
// @version      2.3.0
// @description  自动记录朱雀AI检测平台的每次检测结果，包括输入文本、检测百分比、判定结论和时间戳
// @author       ZhuqueRecorder
// @match        https://matrix.tencent.com/ai-detect/*
// @license      MIT
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'zhuque_detection_records';
  const _log = console.log.bind(console);

  // ========== WebSocket 拦截（必须在 document-start 执行）==========
  const OrigWebSocket = window.WebSocket;
  const wsMessages = []; // 暂存消息，等 UI 初始化后处理

  window.WebSocket = function (...args) {
    const ws = new OrigWebSocket(...args);
    const url = args[0] || '';
    _log('[朱雀记录] WebSocket 创建:', url);

    ws.addEventListener('message', function (event) {
      try {
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw || raw.length < 5) return;
        _log('[朱雀记录] WS消息:', raw.slice(0, 300));
        wsMessages.push(raw);
        processMessages();
      } catch (e) {}
    });

    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ========== 存储模块 ==========
  const Storage = {
    getRecords() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      } catch { return []; }
    },
    saveRecords(records) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    },
    addRecord(record) {
      const records = this.getRecords();
      const isDup = records.some(
        (r) =>
          Math.abs(new Date(r.timestamp) - new Date(record.timestamp)) < 5000 &&
          r.humanPercent === record.humanPercent &&
          r.aiPercent === record.aiPercent
      );
      if (isDup) return false;
      records.unshift(record);
      this.saveRecords(records);
      return true;
    },
    clear() {
      localStorage.removeItem(STORAGE_KEY);
    },
  };

  // ========== 工具函数 ==========
  function generateId() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
  }

  function getInputText() {
    const ta = document.querySelector('textarea');
    return ta ? ta.value.trim() : '';
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ========== 消息处理 ==========
  let lastRecordKey = null;

  function processMessages() {
    while (wsMessages.length > 0) {
      const raw = wsMessages.shift();
      tryExtract(raw);
    }
  }

  function tryExtract(raw) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch {}

    if (!obj) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { obj = JSON.parse(m[0]); } catch {}
    }

    if (obj) {
      _log('[朱雀记录] 解析后的WS数据:', JSON.stringify(obj).slice(0, 500));

      // 专门处理朱雀 labels_ratio 格式
      if (obj.status === 'success' && obj.labels_ratio) {
        const lr = obj.labels_ratio;
        const toP = (v) => Math.round(parseFloat(v) * 10000) / 100;
        // 从 segment_labels 提取输入文本
        let wsText = '';
        if (Array.isArray(obj.segment_labels)) {
          wsText = obj.segment_labels.map(s => s.text || '').join('');
        }
        const result = {
          humanPercent: lr['0'] !== undefined ? toP(lr['0']) : null,
          suspectedAIPercent: lr['1'] !== undefined ? toP(lr['1']) : null,
          aiPercent: lr['2'] !== undefined ? toP(lr['2']) : null,
          verdict: '',
          wsText: wsText,
        };
        _log('[朱雀记录] 提取到检测结果:', JSON.stringify({...result, wsText: truncate(wsText, 50)}));
        saveResult(result);
        setTimeout(fetchVerdictFromDOM, 1500);
        return;
      }

      const result = deepScan(obj);
      if (result) {
        saveResult(result);
        return;
      }
    }

    const textResult = extractFromText(raw);
    if (textResult) {
      saveResult(textResult);
    }
  }

  // 从 DOM 抓取判定文本（如 "未发现明显的人工创作特征"）
  function fetchVerdictFromDOM() {
    try {
      const body = document.body.innerText || '';
      const patterns = [
        /未发现明显的[^\n]{0,20}特征/,
        /发现明显的[^\n]{0,20}特征/,
        /具有[^\n]{0,20}特征/,
        /疑似[^\n]{0,20}生成/,
        /判定[：:]\s*([^\n]+)/,
      ];
      let verdict = '';
      for (const p of patterns) {
        const m = body.match(p);
        if (m) { verdict = m[0].trim(); break; }
      }
      if (verdict) {
        const records = Storage.getRecords();
        if (records.length > 0 && !records[0].verdict) {
          records[0].verdict = verdict;
          Storage.saveRecords(records);
          _log('[朱雀记录] 更新判定文本:', verdict);
          if (UI.panel) UI.refreshList();
        }
      }
    } catch (e) {}
  }

  // 深度扫描 JSON 寻找检测数据
  function deepScan(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 8) return null;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = deepScan(item, (depth || 0) + 1);
        if (r) return r;
      }
      return null;
    }

    const entries = Object.entries(obj);
    const nums = entries.filter(([, v]) => {
      const n = typeof v === 'number' ? v : parseFloat(v);
      return !isNaN(n) && n >= 0 && n <= 100;
    });

    if (nums.length >= 2) {
      const keys = entries.map(([k]) => k).join(' ');
      if (/human|ai|machine|artificial|suspect|人工|机器|疑似|score|rate|percent|prob|label|type|feat|character|ratio|concentration/i.test(keys)) {
        _log('[朱雀记录] 候选数据:', JSON.stringify(obj).slice(0, 300));
        const r = extractFields(obj);
        if (r) return r;
      }
    }

    for (const [, v] of entries) {
      if (v && typeof v === 'object') {
        const r = deepScan(v, (depth || 0) + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function extractFields(obj) {
    const find = (patterns) => {
      for (const [k, v] of Object.entries(obj)) {
        for (const p of patterns) {
          if (p.test(k)) {
            const n = typeof v === 'number' ? v : parseFloat(v);
            if (!isNaN(n) && n >= 0 && n <= 100) return n;
          }
        }
      }
      return null;
    };

    const hp = find([/human/i, /artificial/i, /manual/i, /人工/, /person/i, /real/i, /origin/i]);
    const sp = find([/suspect/i, /doubt/i, /疑似/, /maybe/i, /possible/i, /uncertain/i, /mix/i]);
    const ap = find([/^ai$/i, /^ai[_-]/i, /[_-]ai$/i, /machine/i, /机器/, /robot/i, /generat/i, /aigc/i]);

    if (hp === null && sp === null && ap === null) return null;

    let verdict = '';
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > 2 && v.length < 200 &&
          /verdict|conclusion|result|judge|判定|结论|label|desc|msg|summary/i.test(k)) {
        verdict = v;
        break;
      }
    }

    return { humanPercent: hp, suspectedAIPercent: sp, aiPercent: ap, verdict };
  }

  // 从原始文本提取（如果数据不是标准 JSON）
  function extractFromText(text) {
    const hp = text.match(/(?:human|人工)[^\d]{0,20}?([\d]+(?:\.[\d]+)?)/i);
    const sp = text.match(/(?:suspect|疑似)[^\d]{0,20}?([\d]+(?:\.[\d]+)?)/i);
    const ap = text.match(/(?:(?:^|[_\s])ai(?:[_\s]|$)|machine|机器|aigc)[^\d]{0,20}?([\d]+(?:\.[\d]+)?)/i);

    const hv = hp ? parseFloat(hp[1]) : null;
    const sv = sp ? parseFloat(sp[1]) : null;
    const av = ap ? parseFloat(ap[1]) : null;

    if ([hv, sv, av].filter(v => v !== null).length < 2) return null;
    return { humanPercent: hv, suspectedAIPercent: sv, aiPercent: av, verdict: '' };
  }

  function saveResult(data) {
    const key = `${data.humanPercent}-${data.suspectedAIPercent}-${data.aiPercent}`;
    if (key === lastRecordKey) return;
    lastRecordKey = key;

    // 优先用 WS 返回的文本，fallback 到 textarea
    const inputText = data.wsText || getInputText();
    const record = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      inputText: truncate(inputText, 200),
      inputTextFull: inputText,
      verdict: data.verdict || '',
      humanPercent: data.humanPercent,
      suspectedAIPercent: data.suspectedAIPercent,
      aiPercent: data.aiPercent,
    };

    _log('[朱雀记录] 保存记录:', record);
    const added = Storage.addRecord(record);
    if (added && typeof UI !== 'undefined' && UI.panel) {
      UI.refreshList();
      UI.flashButton();
    }
  }

  // ========== UI 模块 ==========
  const UI = {
    panel: null,
    btn: null,
    isOpen: false,

    init() {
      this.injectStyles();
      this.createButton();
      this.createPanel();
    },

    injectStyles() {
      const style = document.createElement('style');
      style.textContent = `
        #zhuque-float-btn {
          position: fixed; bottom: 24px; right: 24px; width: 48px; height: 48px;
          border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #fff; font-size: 22px; display: flex; align-items: center; justify-content: center;
          cursor: pointer; box-shadow: 0 4px 14px rgba(102,126,234,0.45); z-index: 99999;
          border: none; transition: transform 0.2s, box-shadow 0.2s; user-select: none;
        }
        #zhuque-float-btn:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(102,126,234,0.6); }
        #zhuque-float-btn.flash { animation: zhuque-flash 0.6s ease; }
        @keyframes zhuque-flash {
          0%,100% { transform: scale(1); }
          50% { transform: scale(1.3); box-shadow: 0 6px 24px rgba(102,126,234,0.8); }
        }
        #zhuque-panel {
          position: fixed; bottom: 80px; right: 24px; width: 420px; max-height: 520px;
          background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
          z-index: 99998; display: none; flex-direction: column; overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #zhuque-panel.open { display: flex; }
        #zhuque-panel-header {
          display: flex; align-items: center; justify-content: space-between; padding: 14px 18px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; cursor: move; user-select: none;
        }
        #zhuque-panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
        .zhuque-header-actions { display: flex; gap: 8px; }
        .zhuque-header-actions button {
          background: rgba(255,255,255,0.2); border: none; color: #fff; border-radius: 6px;
          padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 0.2s;
        }
        .zhuque-header-actions button:hover { background: rgba(255,255,255,0.35); }
        #zhuque-records-list { flex: 1; overflow-y: auto; padding: 8px 0; }
        #zhuque-records-list::-webkit-scrollbar { width: 5px; }
        #zhuque-records-list::-webkit-scrollbar-thumb { background: #c5c5c5; border-radius: 4px; }
        .zhuque-record-item {
          padding: 10px 14px 10px 18px; border-bottom: 1px solid #f0f0f0; font-size: 13px;
          line-height: 1.5; transition: background 0.15s; border-left: 4px solid transparent;
        }
        .zhuque-record-item:hover { background: #f8f9ff; }
        .zhuque-record-item.zhuque-level-human { border-left-color: #43a047; }
        .zhuque-record-item.zhuque-level-mixed { border-left-color: #ff9800; }
        .zhuque-record-item.zhuque-level-suspect { border-left-color: #ef6c00; }
        .zhuque-record-item.zhuque-level-ai { border-left-color: #e53935; }
        .zhuque-record-time { color: #999; font-size: 11px; margin-bottom: 4px; }
        .zhuque-record-text { color: #333; margin-bottom: 6px; word-break: break-all; }
        .zhuque-record-verdict { font-weight: 500; margin-bottom: 4px; font-size: 12px; }
        .zhuque-verdict-human { color: #2e7d32; }
        .zhuque-verdict-mixed { color: #e65100; }
        .zhuque-verdict-ai { color: #c62828; }
        .zhuque-record-percents { display: flex; gap: 8px; flex-wrap: wrap; }
        .zhuque-percent-tag {
          display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px;
          border-radius: 10px; font-size: 12px; font-weight: 500;
        }
        /* 人工 - 按等级 */
        .zhuque-tag-human-high { background: #c8e6c9; color: #1b5e20; }
        .zhuque-tag-human-mid { background: #e8f5e9; color: #2e7d32; }
        .zhuque-tag-human-low { background: #f1f8e9; color: #558b2f; }
        /* 疑似AI - 按等级 */
        .zhuque-tag-suspect-high { background: #ffe0b2; color: #e65100; }
        .zhuque-tag-suspect-mid { background: #fff3e0; color: #ef6c00; }
        .zhuque-tag-suspect-low { background: #fff8e1; color: #ff8f00; }
        /* AI - 按等级 */
        .zhuque-tag-ai-high { background: #ffcdd2; color: #b71c1c; }
        .zhuque-tag-ai-mid { background: #fce4ec; color: #c62828; }
        .zhuque-tag-ai-low { background: #fff0f0; color: #e53935; }
        .zhuque-empty { padding: 40px 20px; text-align: center; color: #aaa; font-size: 14px; }
        #zhuque-panel-footer {
          padding: 10px 18px; border-top: 1px solid #f0f0f0; display: flex;
          align-items: center; justify-content: space-between; font-size: 12px; color: #999;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    },

    createButton() {
      const btn = document.createElement('div');
      btn.id = 'zhuque-float-btn';
      btn.title = '\u6731\u96C0\u68C0\u6D4B\u8BB0\u5F55';
      btn.textContent = '\uD83D\uDCCB';
      btn.addEventListener('click', () => this.toggle());
      document.body.appendChild(btn);
      this.btn = btn;
    },

    createPanel() {
      const panel = document.createElement('div');
      panel.id = 'zhuque-panel';
      panel.innerHTML = `
        <div id="zhuque-panel-header">
          <h3>\u6731\u96C0\u68C0\u6D4B\u8BB0\u5F55</h3>
          <div class="zhuque-header-actions">
            <button id="zhuque-export-btn">\u5BFC\u51FA</button>
            <button id="zhuque-clear-btn">\u6E05\u7A7A</button>
            <button id="zhuque-close-btn">&times;</button>
          </div>
        </div>
        <div id="zhuque-records-list"></div>
        <div id="zhuque-panel-footer"><span id="zhuque-count">\u5171 0 \u6761\u8BB0\u5F55</span></div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      document.getElementById('zhuque-close-btn').addEventListener('click', () => this.toggle());
      document.getElementById('zhuque-clear-btn').addEventListener('click', () => {
        if (confirm('\u786E\u5B9A\u6E05\u7A7A\u6240\u6709\u68C0\u6D4B\u8BB0\u5F55\u5417\uFF1F')) {
          Storage.clear();
          lastRecordKey = null;
          this.refreshList();
        }
      });
      document.getElementById('zhuque-export-btn').addEventListener('click', () => this.exportJSON());
      this.enableDrag(panel, document.getElementById('zhuque-panel-header'));
      this.refreshList();
    },

    toggle() {
      this.isOpen = !this.isOpen;
      this.panel.classList.toggle('open', this.isOpen);
      if (this.isOpen) this.refreshList();
    },

    flashButton() {
      if (!this.btn) return;
      this.btn.classList.remove('flash');
      void this.btn.offsetWidth;
      this.btn.classList.add('flash');
    },

    refreshList() {
      const list = document.getElementById('zhuque-records-list');
      const count = document.getElementById('zhuque-count');
      if (!list) return;
      const records = Storage.getRecords();
      count.textContent = '\u5171 ' + records.length + ' \u6761\u8BB0\u5F55';
      if (records.length === 0) {
        list.innerHTML = '<div class="zhuque-empty">\u6682\u65E0\u68C0\u6D4B\u8BB0\u5F55<br>\u8FDB\u884CAI\u68C0\u6D4B\u540E\u5C06\u81EA\u52A8\u8BB0\u5F55</div>';
        return;
      }
      list.innerHTML = records.map((r) => {
        const h = r.humanPercent || 0;
        const a = r.aiPercent || 0;
        const s = r.suspectedAIPercent || 0;
        // 整体等级
        let level = 'mixed';
        if (h >= 70) level = 'human';
        else if (a >= 50) level = 'ai';
        else if (a >= 30 || s >= 50) level = 'suspect';
        // 自动判定文本
        let verdict = r.verdict || '';
        if (!verdict) {
          if (h >= 70) verdict = '\u2705 \u4EBA\u5DE5\u521B\u4F5C\u53EF\u80FD\u6027\u5927';
          else if (h >= 50) verdict = '\u2705 \u504F\u5411\u4EBA\u5DE5\u521B\u4F5C';
          else if (a >= 70) verdict = '\u26A0\uFE0F AI\u751F\u6210\u53EF\u80FD\u6027\u5927';
          else if (a >= 50) verdict = '\u26A0\uFE0F \u504F\u5411AI\u751F\u6210';
          else if (s >= 50) verdict = '\u2753 \u7591\u4F3CAI\u53C2\u4E0E';
          else verdict = '\u2753 \u4EBA\u673A\u6DF7\u5408';
        }
        const vClass = level === 'human' ? 'zhuque-verdict-human' : level === 'ai' ? 'zhuque-verdict-ai' : 'zhuque-verdict-mixed';
        // tag 等级
        const hTag = h >= 50 ? 'high' : h >= 30 ? 'mid' : 'low';
        const sTag = s >= 50 ? 'high' : s >= 30 ? 'mid' : 'low';
        const aTag = a >= 50 ? 'high' : a >= 30 ? 'mid' : 'low';
        return `
        <div class="zhuque-record-item zhuque-level-${level}">
          <div class="zhuque-record-time">${formatTime(r.timestamp)}</div>
          <div class="zhuque-record-text">${this.escapeHtml(r.inputText || '(\u65E0\u6587\u672C)')}</div>
          <div class="zhuque-record-verdict ${vClass}">${this.escapeHtml(verdict)}</div>
          <div class="zhuque-record-percents">
            ${r.humanPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-human-${hTag}">\u4EBA\u5DE5 ${r.humanPercent}%</span>` : ''}
            ${r.suspectedAIPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-suspect-${sTag}">\u7591\u4F3CAI ${r.suspectedAIPercent}%</span>` : ''}
            ${r.aiPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-ai-${aTag}">AI ${r.aiPercent}%</span>` : ''}
          </div>
        </div>`;
      }).join('');
    },

    escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    },

    exportJSON() {
      const records = Storage.getRecords();
      if (records.length === 0) return;
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zhuque-records-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    enableDrag(panel, handle) {
      let dragging = false, sx, sy, ox, oy;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = ox + (e.clientX - sx) + 'px';
        panel.style.top = oy + (e.clientY - sy) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { dragging = false; });
    },
  };

  // ========== 初始化 ==========
  const initUI = () => {
    if (document.body) {
      UI.init();
      processMessages(); // 处理 UI 初始化前暂存的消息
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        UI.init();
        processMessages();
      });
    }
  };
  initUI();

  _log('[朱雀记录] v2.3.0 已加载 (WebSocket拦截模式)');
})();
