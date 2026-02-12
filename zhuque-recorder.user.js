// ==UserScript==
// @name         朱雀AI检测记录助手
// @namespace    https://github.com/zhuque-ai-recorder
// @version      3.0.0
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
    removeById(id) {
      const records = this.getRecords().filter(r => r.id !== id);
      this.saveRecords(records);
    },
    toggleStar(id) {
      const records = this.getRecords();
      const r = records.find(r => r.id === id);
      if (r) { r.starred = !r.starred; this.saveRecords(records); }
    },
    setNote(id, note) {
      const records = this.getRecords();
      const r = records.find(r => r.id === id);
      if (r) { r.note = note; this.saveRecords(records); }
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
      inputText: inputText,
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

  // ========== Toast 通知模块 ==========
  const Toast = {
    container: null,
    init() {
      if (this.container) return;
      const c = document.createElement('div');
      c.id = 'zhuque-toast-container';
      document.body.appendChild(c);
      this.container = c;
    },
    show(msg, type = 'info') {
      this.init();
      const el = document.createElement('div');
      el.className = `zhuque-toast zhuque-toast-${type}`;
      el.textContent = msg;
      this.container.appendChild(el);
      requestAnimationFrame(() => el.classList.add('zhuque-toast-show'));
      setTimeout(() => {
        el.classList.remove('zhuque-toast-show');
        el.classList.add('zhuque-toast-hide');
        el.addEventListener('animationend', () => el.remove());
        setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
      }, 2000);
    },
  };

  // ========== ConfirmDialog 模块 ==========
  const ConfirmDialog = {
    _esc(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    },
    show({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'zhuque-confirm-overlay';
        overlay.innerHTML = `
          <div class="zhuque-confirm-box">
            <div class="zhuque-confirm-title">${this._esc(title || '确认操作')}</div>
            <div class="zhuque-confirm-msg">${this._esc(message || '')}</div>
            <div class="zhuque-confirm-actions">
              <button class="zhuque-confirm-cancel">${this._esc(cancelText)}</button>
              <button class="zhuque-confirm-ok ${danger ? 'zhuque-confirm-danger' : ''}">${this._esc(confirmText)}</button>
            </div>
          </div>
        `;
        const panel = document.getElementById('zhuque-panel');
        if (panel) panel.appendChild(overlay);
        else { document.body.appendChild(overlay); }
        requestAnimationFrame(() => overlay.classList.add('zhuque-confirm-visible'));
        let closed = false;
        const close = (val) => {
          if (closed) return;
          closed = true;
          overlay.classList.remove('zhuque-confirm-visible');
          overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
          setTimeout(() => overlay.remove(), 300);
          resolve(val);
        };
        overlay.querySelector('.zhuque-confirm-cancel').addEventListener('click', () => close(false));
        overlay.querySelector('.zhuque-confirm-ok').addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      });
    },
  };

  // ========== UI 模块 ==========
  const UI = {
    panel: null,
    btn: null,
    isOpen: false,
    currentTab: 'all', // 'all' | 'starred'
    expandedIds: new Set(),

    init() {
      this.injectStyles();
      this.createButton();
      this.createPanel();
    },

    injectStyles() {
      const style = document.createElement('style');
      style.textContent = `
        /* ===== Toast ===== */
        #zhuque-toast-container {
          position: fixed; bottom: 90px; right: 32px; z-index: 100001;
          display: flex; flex-direction: column-reverse; gap: 6px; pointer-events: none;
        }
        .zhuque-toast {
          padding: 8px 16px; border-radius: 8px; font-size: 13px; color: #fff;
          opacity: 0; transform: translateY(12px); pointer-events: auto;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15); white-space: nowrap;
        }
        .zhuque-toast-info { background: #555; }
        .zhuque-toast-success { background: #43a047; }
        .zhuque-toast-error { background: #e53935; }
        .zhuque-toast-show { opacity: 1; transform: translateY(0); transition: all 0.25s ease; }
        .zhuque-toast-hide { animation: zhuque-toast-out 0.25s ease forwards; }
        @keyframes zhuque-toast-out {
          to { opacity: 0; transform: translateY(-8px); }
        }

        /* ===== ConfirmDialog ===== */
        .zhuque-confirm-overlay {
          position: absolute; inset: 0; background: rgba(0,0,0,0.25);
          display: flex; align-items: center; justify-content: center;
          z-index: 10; opacity: 0; transition: opacity 0.2s; border-radius: 12px;
        }
        .zhuque-confirm-visible { opacity: 1; }
        .zhuque-confirm-box {
          background: #fff; border-radius: 12px; padding: 24px; width: 300px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.2); text-align: center;
        }
        .zhuque-confirm-title { font-size: 15px; font-weight: 600; color: #333; margin-bottom: 8px; }
        .zhuque-confirm-msg { font-size: 13px; color: #888; margin-bottom: 20px; line-height: 1.5; }
        .zhuque-confirm-actions { display: flex; gap: 10px; justify-content: center; }
        .zhuque-confirm-cancel {
          padding: 7px 20px; border: 1px solid #ddd; border-radius: 8px; background: #fff;
          color: #666; font-size: 13px; cursor: pointer; transition: all 0.15s;
        }
        .zhuque-confirm-cancel:hover { background: #f5f5f5; border-color: #ccc; }
        .zhuque-confirm-ok {
          padding: 7px 20px; border: none; border-radius: 8px;
          background: linear-gradient(135deg, #667eea, #764ba2); color: #fff;
          font-size: 13px; cursor: pointer; transition: all 0.15s;
        }
        .zhuque-confirm-ok:hover { opacity: 0.9; }
        .zhuque-confirm-danger {
          background: linear-gradient(135deg, #e53935, #c62828) !important;
        }
        .zhuque-confirm-danger:hover { opacity: 0.9; }

        /* ===== Float Button ===== */
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

        /* ===== Panel ===== */
        #zhuque-panel {
          position: fixed; bottom: 80px; right: 24px; width: 440px; max-height: 560px;
          background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
          z-index: 99998; display: none; flex-direction: column; overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #zhuque-panel.open { display: flex; }

        /* ===== Header ===== */
        #zhuque-panel-header {
          display: flex; align-items: center; justify-content: space-between; padding: 14px 18px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff;
          cursor: move; user-select: none; flex-shrink: 0;
        }
        #zhuque-panel-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
        .zhuque-header-actions { display: flex; gap: 6px; }
        .zhuque-header-actions button {
          background: rgba(255,255,255,0.2); border: none; color: #fff; border-radius: 6px;
          padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 0.2s;
        }
        .zhuque-header-actions button:hover { background: rgba(255,255,255,0.35); }

        /* ===== Tabs ===== */
        .zhuque-tabs {
          display: flex; border-bottom: 1px solid #f0f0f0; padding: 0 18px; flex-shrink: 0;
          background: #fafbff;
        }
        .zhuque-tab {
          padding: 10px 16px; font-size: 13px; color: #888; cursor: pointer;
          border-bottom: 2px solid transparent; transition: all 0.2s; user-select: none;
          display: flex; align-items: center; gap: 6px;
        }
        .zhuque-tab:hover { color: #555; }
        .zhuque-tab.active {
          color: #667eea; font-weight: 600;
          border-image: linear-gradient(135deg, #667eea, #764ba2) 1;
          border-bottom-width: 2px; border-bottom-style: solid;
        }
        .zhuque-tab-badge {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 18px; height: 18px; padding: 0 5px;
          border-radius: 9px; font-size: 11px; font-weight: 600;
          background: #eee; color: #999;
        }
        .zhuque-tab.active .zhuque-tab-badge {
          background: linear-gradient(135deg, #667eea, #764ba2); color: #fff;
        }

        /* ===== Records List ===== */
        #zhuque-records-list { flex: 1; overflow-y: auto; padding: 6px 0; }
        #zhuque-records-list::-webkit-scrollbar { width: 5px; }
        #zhuque-records-list::-webkit-scrollbar-thumb { background: #c5c5c5; border-radius: 4px; }

        /* ===== Record Card ===== */
        .zhuque-record-card {
          margin: 4px 10px; padding: 10px 14px; border-radius: 8px;
          background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          border-left: 4px solid transparent; font-size: 13px; line-height: 1.5;
          transition: box-shadow 0.15s; position: relative;
        }
        .zhuque-record-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
        .zhuque-record-card.zhuque-level-human { border-left-color: #43a047; }
        .zhuque-record-card.zhuque-level-mixed { border-left-color: #ff9800; }
        .zhuque-record-card.zhuque-level-suspect { border-left-color: #ef6c00; }
        .zhuque-record-card.zhuque-level-ai { border-left-color: #e53935; }

        /* ===== Card Header Row ===== */
        .zhuque-card-header {
          display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;
        }
        .zhuque-record-time { color: #999; font-size: 11px; }
        .zhuque-card-actions { display: flex; gap: 2px; align-items: center; }
        .zhuque-act-btn {
          width: 24px; height: 24px; border: none; background: transparent; color: #ccc;
          font-size: 14px; cursor: pointer; border-radius: 50%; display: flex;
          align-items: center; justify-content: center; padding: 0; line-height: 1;
          transition: all 0.15s;
        }
        .zhuque-act-btn:hover { background: #f0f0f0; color: #666; }
        .zhuque-act-btn.zhuque-btn-del:hover { background: #fee; color: #e53935; }
        .zhuque-act-btn.zhuque-btn-star { color: #ddd; font-size: 16px; }
        .zhuque-act-btn.zhuque-btn-star.zhuque-star-on { color: #f9a825; }
        .zhuque-act-btn.zhuque-btn-star:hover { color: #f9a825; }
        .zhuque-hover-btn { opacity: 0; transition: opacity 0.15s; }
        .zhuque-record-card:hover .zhuque-hover-btn { opacity: 1; }

        /* ===== Text Area ===== */
        .zhuque-record-text {
          color: #333; margin-bottom: 6px; word-break: break-all; cursor: default;
        }
        .zhuque-text-collapsed { cursor: pointer; }
        .zhuque-expand-link {
          color: #667eea; font-size: 12px; cursor: pointer; margin-left: 4px;
          user-select: none;
        }
        .zhuque-expand-link:hover { text-decoration: underline; }
        .zhuque-text-expanded {
          max-height: 200px; overflow-y: auto; cursor: pointer;
        }
        .zhuque-text-expanded::-webkit-scrollbar { width: 3px; }
        .zhuque-text-expanded::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }

        /* ===== Char Count ===== */
        .zhuque-char-count {
          font-size: 11px; color: #bbb; margin-bottom: 4px; display: flex; gap: 8px;
        }
        .zhuque-char-count span { white-space: nowrap; }

        /* ===== Verdict & Percents ===== */
        .zhuque-record-verdict { font-weight: 500; margin-bottom: 4px; font-size: 12px; }
        .zhuque-verdict-human { color: #2e7d32; }
        .zhuque-verdict-mixed { color: #e65100; }
        .zhuque-verdict-ai { color: #c62828; }
        .zhuque-record-percents { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
        .zhuque-percent-tag {
          display: inline-flex; align-items: center; gap: 3px; padding: 2px 10px;
          border-radius: 12px; font-size: 12px; font-weight: 500;
        }
        .zhuque-tag-human-high { background: #c8e6c9; color: #1b5e20; }
        .zhuque-tag-human-mid { background: #e8f5e9; color: #2e7d32; }
        .zhuque-tag-human-low { background: #f1f8e9; color: #558b2f; }
        .zhuque-tag-suspect-high { background: #ffe0b2; color: #e65100; }
        .zhuque-tag-suspect-mid { background: #fff3e0; color: #ef6c00; }
        .zhuque-tag-suspect-low { background: #fff8e1; color: #ff8f00; }
        .zhuque-tag-ai-high { background: #ffcdd2; color: #b71c1c; }
        .zhuque-tag-ai-mid { background: #fce4ec; color: #c62828; }
        .zhuque-tag-ai-low { background: #fff0f0; color: #e53935; }

        /* ===== Note ===== */
        .zhuque-record-note {
          color: #888; font-size: 11px; font-style: italic; margin-top: 6px;
          padding: 4px 8px; background: #f8f8f8; border-radius: 6px;
          word-break: break-all; display: flex; align-items: center; gap: 4px;
        }
        /* ===== Inline Note Editor ===== */
        .zhuque-note-editor {
          display: flex; align-items: center; gap: 6px; margin-top: 6px;
        }
        .zhuque-note-input {
          flex: 1; padding: 5px 8px; border: 1px solid #d0d0d0; border-radius: 6px;
          font-size: 12px; outline: none; font-family: inherit;
          transition: border-color 0.2s;
        }
        .zhuque-note-input:focus { border-color: #667eea; }
        .zhuque-note-save, .zhuque-note-cancel {
          width: 26px; height: 26px; border: none; border-radius: 6px;
          cursor: pointer; font-size: 14px; display: flex; align-items: center;
          justify-content: center; transition: all 0.15s; padding: 0;
        }
        .zhuque-note-save { background: #667eea; color: #fff; }
        .zhuque-note-save:hover { background: #5a6fd6; }
        .zhuque-note-cancel { background: #f0f0f0; color: #999; }
        .zhuque-note-cancel:hover { background: #e0e0e0; color: #666; }

        /* ===== Tip ===== */
        .zhuque-tip {
          font-size: 11px; color: #bbb; margin-top: 6px; padding: 4px 8px;
          background: #f9f9ff; border-radius: 6px; text-align: center;
        }
        .zhuque-tip a {
          color: #9a8ec1; text-decoration: none; font-weight: 500;
        }
        .zhuque-tip a:hover { color: #667eea; text-decoration: underline; }

        /* ===== Empty & Footer ===== */
        .zhuque-empty { padding: 40px 20px; text-align: center; color: #aaa; font-size: 14px; }
        #zhuque-panel-footer {
          padding: 8px 18px; border-top: 1px solid #f0f0f0; display: flex;
          flex-direction: column; align-items: center; gap: 4px;
          font-size: 12px; color: #999; flex-shrink: 0;
        }
        .zhuque-footer-link {
          font-size: 11px; color: #c0b8d6;
        }
        .zhuque-footer-link a {
          color: #9a8ec1; text-decoration: none;
        }
        .zhuque-footer-link a:hover { color: #667eea; text-decoration: underline; }
      `;
      (document.head || document.documentElement).appendChild(style);
    },

    createButton() {
      const btn = document.createElement('div');
      btn.id = 'zhuque-float-btn';
      btn.title = '朱雀检测记录';
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
          <h3>朱雀检测记录</h3>
          <div class="zhuque-header-actions">
            <button id="zhuque-export-btn">导出</button>
            <button id="zhuque-clear-btn">清空</button>
            <button id="zhuque-close-btn">&times;</button>
          </div>
        </div>
        <div class="zhuque-tabs">
          <div class="zhuque-tab active" data-tab="all">全部 <span class="zhuque-tab-badge" id="zhuque-badge-all">0</span></div>
          <div class="zhuque-tab" data-tab="starred">⭐ 收藏 <span class="zhuque-tab-badge" id="zhuque-badge-starred">0</span></div>
        </div>
        <div id="zhuque-records-list"></div>
        <div id="zhuque-panel-footer">
          <span id="zhuque-count">共 0 条记录</span>
          <span class="zhuque-footer-link">写作优化 → <a href="https://www.jiaoquaner.com/" target="_blank" rel="noopener">焦圈儿</a></span>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      // Close
      document.getElementById('zhuque-close-btn').addEventListener('click', () => this.toggle());

      // Clear — 使用 ConfirmDialog
      document.getElementById('zhuque-clear-btn').addEventListener('click', async () => {
        const ok = await ConfirmDialog.show({
          title: '确定清空所有检测记录吗？',
          message: '此操作不可恢复',
          confirmText: '确定清空',
          danger: true,
        });
        if (ok) {
          Storage.clear();
          lastRecordKey = null;
          this.refreshList();
          Toast.show('所有记录已清空', 'info');
        }
      });

      // Export
      document.getElementById('zhuque-export-btn').addEventListener('click', () => this.exportJSON());

      // Tab 切换
      panel.querySelector('.zhuque-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('.zhuque-tab');
        if (!tab) return;
        const tabName = tab.dataset.tab;
        if (tabName === this.currentTab) return;
        this.currentTab = tabName;
        panel.querySelectorAll('.zhuque-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        // 清空按钮仅在全部 Tab 显示
        document.getElementById('zhuque-clear-btn').style.display = tabName === 'all' ? '' : 'none';
        this.refreshList();
      });

      // 事件委托
      document.getElementById('zhuque-records-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) {
          // 点击展开/收起
          const expandLink = e.target.closest('.zhuque-expand-link');
          if (expandLink) {
            const card = expandLink.closest('[data-id]');
            if (card) this.toggleExpand(card.dataset.id);
            return;
          }
          const textEl = e.target.closest('.zhuque-text-collapsed, .zhuque-text-expanded');
          if (textEl) {
            const card = textEl.closest('[data-id]');
            if (card) this.toggleExpand(card.dataset.id);
          }
          return;
        }
        const card = btn.closest('[data-id]');
        if (!card) return;
        const id = card.dataset.id;
        const action = btn.dataset.action;
        if (action === 'del') {
          this.handleDelete(id);
        } else if (action === 'star') {
          Storage.toggleStar(id);
          const records = Storage.getRecords();
          const r = records.find(r => r.id === id);
          Toast.show(r && r.starred ? '已添加收藏' : '已取消收藏', 'success');
          this.refreshList();
        } else if (action === 'note') {
          this.openNoteEditor(id);
        }
      });

      this.enableDrag(panel, document.getElementById('zhuque-panel-header'));
      this.refreshList();
    },

    async handleDelete(id) {
      const ok = await ConfirmDialog.show({
        title: '删除此条记录？',
        message: '删除后无法恢复',
        confirmText: '删除',
        danger: true,
      });
      if (ok) {
        Storage.removeById(id);
        this.expandedIds.delete(id);
        this.refreshList();
        Toast.show('记录已删除', 'info');
      }
    },

    openNoteEditor(id) {
      const card = document.querySelector(`.zhuque-record-card[data-id="${id}"]`);
      if (!card || card.querySelector('.zhuque-note-editor')) return;
      const records = Storage.getRecords();
      const r = records.find(r => r.id === id);
      const current = r ? r.note || '' : '';

      // 移除现有备注显示
      const existingNote = card.querySelector('.zhuque-record-note');
      if (existingNote) existingNote.style.display = 'none';

      const editor = document.createElement('div');
      editor.className = 'zhuque-note-editor';
      editor.innerHTML = `
        <span style="font-size:13px;">📝</span>
        <input class="zhuque-note-input" type="text" value="${this.escapeAttr(current)}" placeholder="输入备注..." maxlength="200">
        <button class="zhuque-note-save" title="保存">✓</button>
        <button class="zhuque-note-cancel" title="取消">✗</button>
      `;
      card.appendChild(editor);
      const input = editor.querySelector('.zhuque-note-input');
      input.focus();
      input.select();

      const save = () => {
        const note = input.value.trim();
        Storage.setNote(id, note);
        Toast.show(note ? '备注已保存' : '备注已清除', 'success');
        this.refreshList();
      };
      const cancel = () => {
        editor.remove();
        if (existingNote) existingNote.style.display = '';
      };

      editor.querySelector('.zhuque-note-save').addEventListener('click', save);
      editor.querySelector('.zhuque-note-cancel').addEventListener('click', cancel);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
    },

    toggleExpand(id) {
      if (this.expandedIds.has(id)) {
        this.expandedIds.delete(id);
      } else {
        this.expandedIds.add(id);
      }
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
      Toast.show('新检测结果已记录', 'success');
    },

    refreshList() {
      const list = document.getElementById('zhuque-records-list');
      const footerCount = document.getElementById('zhuque-count');
      if (!list) return;

      const allRecords = Storage.getRecords();
      const starredCount = allRecords.filter(r => r.starred).length;

      // 更新 badge
      const badgeAll = document.getElementById('zhuque-badge-all');
      const badgeStarred = document.getElementById('zhuque-badge-starred');
      if (badgeAll) badgeAll.textContent = allRecords.length;
      if (badgeStarred) badgeStarred.textContent = starredCount;

      // 按 tab 筛选
      const records = this.currentTab === 'starred' ? allRecords.filter(r => r.starred) : allRecords;

      // Footer
      if (this.currentTab === 'all') {
        footerCount.textContent = `共 ${allRecords.length} 条记录 · ${starredCount} 条收藏`;
      } else {
        footerCount.textContent = `共 ${starredCount} 条收藏`;
      }

      if (records.length === 0) {
        const emptyMsg = this.currentTab === 'starred'
          ? '暂无收藏记录<br>点击记录上的 ☆ 可添加收藏'
          : '暂无检测记录<br>进行AI检测后将自动记录';
        list.innerHTML = `<div class="zhuque-empty">${emptyMsg}</div>`;
        return;
      }

      list.innerHTML = records.map((r) => {
        const h = r.humanPercent || 0;
        const a = r.aiPercent || 0;
        const s = r.suspectedAIPercent || 0;
        let level = 'mixed';
        if (h >= 50) level = 'human';
        else if (h >= 30 && h >= a) level = 'human';
        else if (a >= 50) level = 'ai';
        else if (a >= 30) level = 'suspect';

        let verdict = r.verdict || '';
        if (!verdict) {
          if (h >= 70) verdict = '✅ 人工创作可能性大';
          else if (h >= 50) verdict = '✅ 偏向人工创作';
          else if (h >= 30) verdict = '✅ 人工特征较明显';
          else if (a >= 70) verdict = '⚠️ AI生成可能性大';
          else if (a >= 50) verdict = '⚠️ 偏向AI生成';
          else if (a >= 30) verdict = '❓ 疑似AI参与';
          else verdict = '❓ 人机混合';
        }
        const vClass = level === 'human' ? 'zhuque-verdict-human' : level === 'ai' ? 'zhuque-verdict-ai' : 'zhuque-verdict-mixed';
        const hTag = h >= 50 ? 'high' : h >= 30 ? 'mid' : 'low';
        const sTag = s >= 50 ? 'high' : s >= 30 ? 'mid' : 'low';
        const aTag = a >= 50 ? 'high' : a >= 30 ? 'mid' : 'low';

        const inputText = r.inputText || '';
        const isLong = inputText.length > 100;
        const isExpanded = this.expandedIds.has(r.id);
        let textHtml;
        if (!inputText) {
          textHtml = '<div class="zhuque-record-text" style="color:#aaa;">(无文本)</div>';
        } else if (isExpanded) {
          textHtml = `<div class="zhuque-record-text zhuque-text-expanded">${this.escapeHtml(inputText)}</div>`;
        } else if (isLong) {
          textHtml = `<div class="zhuque-record-text zhuque-text-collapsed">${this.escapeHtml(inputText.slice(0, 100))}...<span class="zhuque-expand-link">展开</span></div>`;
        } else {
          textHtml = `<div class="zhuque-record-text">${this.escapeHtml(inputText)}</div>`;
        }

        const totalChars = inputText.length;
        const cnChars = (inputText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
        const charCountHtml = inputText
          ? `<div class="zhuque-char-count"><span>共 ${totalChars} 字符</span><span>中文 ${cnChars} 字</span></div>`
          : '';

        return `
        <div class="zhuque-record-card zhuque-level-${level}" data-id="${r.id}">
          <div class="zhuque-card-header">
            <span class="zhuque-record-time">${formatTime(r.timestamp)}</span>
            <div class="zhuque-card-actions">
              <button class="zhuque-act-btn zhuque-btn-star ${r.starred ? 'zhuque-star-on' : ''}" data-action="star" title="收藏">${r.starred ? '★' : '☆'}</button>
              <button class="zhuque-act-btn zhuque-hover-btn" data-action="note" title="备注">✏</button>
              <button class="zhuque-act-btn zhuque-btn-del zhuque-hover-btn" data-action="del" title="删除">×</button>
            </div>
          </div>
          ${textHtml}
          ${charCountHtml}
          <div class="zhuque-record-verdict ${vClass}">${this.escapeHtml(verdict)}</div>
          <div class="zhuque-record-percents">
            ${r.humanPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-human-${hTag}">人工 ${r.humanPercent}%</span>` : ''}
            ${r.suspectedAIPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-suspect-${sTag}">疑似AI ${r.suspectedAIPercent}%</span>` : ''}
            ${r.aiPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-ai-${aTag}">AI ${r.aiPercent}%</span>` : ''}
          </div>
          ${r.note ? `<div class="zhuque-record-note">📝 ${this.escapeHtml(r.note)}</div>` : ''}
          ${a >= 30 ? '<div class="zhuque-tip">AI 痕迹偏高？试试 <a href="https://www.jiaoquaner.com/" target="_blank" rel="noopener">焦圈儿</a> 优化表达</div>' : ''}
        </div>`;
      }).join('');
    },

    escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    },

    escapeAttr(str) {
      return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    exportJSON() {
      const records = Storage.getRecords();
      if (records.length === 0) {
        Toast.show('暂无记录可导出', 'info');
        return;
      }
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zhuque-records-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Toast.show(`已导出 ${records.length} 条记录`, 'success');
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
      processMessages();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        UI.init();
        processMessages();
      });
    }
  };
  initUI();

  _log('[朱雀记录] v3.0.0 已加载 (WebSocket拦截模式)');
})();
