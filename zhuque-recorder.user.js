// ==UserScript==
// @name         朱雀AI检测记录助手
// @namespace    https://github.com/zhuque-ai-recorder
// @version      2.0.0
// @description  自动记录朱雀AI检测平台的每次检测结果，包括输入文本、检测百分比、判定结论和时间戳
// @author       ZhuqueRecorder
// @match        https://matrix.tencent.com/ai-detect/*
// @license      MIT
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'zhuque_detection_records';

  // ========== 存储模块 ==========
  const Storage = {
    getRecords() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      } catch {
        return [];
      }
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
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
      ((Math.random() * 16) | 0).toString(16)
    );
  }

  function getInputText() {
    const textarea = document.querySelector('textarea');
    return textarea ? textarea.value.trim() : '';
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ========== 检测结果捕获 ==========
  const Capture = {
    lastCaptured: null,
    polling: null,

    // 开始轮询 DOM 等待结果出现
    startPolling() {
      if (this.polling) return;
      let attempts = 0;
      this.polling = setInterval(() => {
        attempts++;
        const result = this.extractFromDOM();
        if (result) {
          this.stopPolling();
          this.handleResult(result);
        } else if (attempts > 30) {
          // 60秒超时
          this.stopPolling();
        }
      }, 2000);
    },

    stopPolling() {
      if (this.polling) {
        clearInterval(this.polling);
        this.polling = null;
      }
    },

    // 从页面可见文本中提取带标签的百分比
    extractFromDOM() {
      // 隐藏自身面板再取文本
      const panel = document.getElementById('zhuque-panel');
      const floatBtn = document.getElementById('zhuque-float-btn');
      if (panel) panel.style.visibility = 'hidden';
      if (floatBtn) floatBtn.style.visibility = 'hidden';
      const text = document.body.innerText;
      if (panel) panel.style.visibility = '';
      if (floatBtn) floatBtn.style.visibility = '';

      // 按标签精确匹配
      const humanMatch = text.match(/人工(?:特征|创作)?[^\d]{0,10}?([\d]+(?:\.[\d]+)?)\s*%/);
      const suspectMatch = text.match(/疑似\s*AI[^\d]{0,10}?([\d]+(?:\.[\d]+)?)\s*%/);
      const aiMatch = text.match(/AI\s*(?:特征|生成)?[^\d]{0,10}?([\d]+(?:\.[\d]+)?)\s*%/);

      const humanPercent = humanMatch ? parseFloat(humanMatch[1]) : null;
      const suspectedAIPercent = suspectMatch ? parseFloat(suspectMatch[1]) : null;
      // AI特征的匹配要排除"疑似AI"的结果
      let aiPercent = aiMatch ? parseFloat(aiMatch[1]) : null;
      if (aiPercent !== null && suspectedAIPercent !== null && aiPercent === suspectedAIPercent) {
        // "AI特征" regex 可能匹配到了 "疑似AI" 的值，尝试再找一个
        const allAI = [...text.matchAll(/AI\s*(?:特征|生成)?[^\d]{0,10}?([\d]+(?:\.[\d]+)?)\s*%/g)];
        const distinct = allAI.map(m => parseFloat(m[1])).filter(v => v !== suspectedAIPercent);
        aiPercent = distinct.length > 0 ? distinct[distinct.length - 1] : null;
      }

      // 至少需要2个有效百分比
      const validCount = [humanPercent, suspectedAIPercent, aiPercent].filter(v => v !== null).length;
      if (validCount < 2) return null;

      // 去重键
      const key = `${humanPercent}-${suspectedAIPercent}-${aiPercent}`;
      if (this.lastCaptured === key) return null;

      // 提取判定文本
      let verdict = '';
      const verdictMatch = text.match(/(?:未发现|发现|检测结[果论]|判定)[^\n]{0,50}/);
      if (verdictMatch) verdict = verdictMatch[0].trim();

      return { humanPercent, suspectedAIPercent, aiPercent, verdict, key };
    },

    handleResult(result) {
      this.lastCaptured = result.key;
      const inputText = getInputText();
      const record = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        inputText: truncate(inputText, 200),
        inputTextFull: inputText,
        verdict: result.verdict,
        humanPercent: result.humanPercent,
        suspectedAIPercent: result.suspectedAIPercent,
        aiPercent: result.aiPercent,
      };
      const added = Storage.addRecord(record);
      if (added) {
        UI.refreshList();
        UI.flashButton();
      }
    },

    reset() {
      this.lastCaptured = null;
      this.stopPolling();
    },
  };

  // ========== 检测触发监听 ==========
  function watchTriggers() {
    // 点击检测按钮
    document.addEventListener('click', (e) => {
      const target = e.target;
      const el = target.closest('button, [role="button"], div, span, a');
      const text = (el || target).textContent || '';
      if (/立即检测|开始检测/.test(text)) {
        Capture.lastCaptured = null;
        Capture.startPolling();
      }
    }, true);

    // Ctrl+Enter
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        Capture.lastCaptured = null;
        Capture.startPolling();
      }
    }, true);
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
          position: fixed;
          bottom: 24px;
          right: 24px;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #fff;
          font-size: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(102, 126, 234, 0.45);
          z-index: 99999;
          border: none;
          transition: transform 0.2s, box-shadow 0.2s;
          user-select: none;
        }
        #zhuque-float-btn:hover {
          transform: scale(1.1);
          box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
        }
        #zhuque-float-btn.flash {
          animation: zhuque-flash 0.6s ease;
        }
        @keyframes zhuque-flash {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.3); box-shadow: 0 6px 24px rgba(102, 126, 234, 0.8); }
        }

        #zhuque-panel {
          position: fixed;
          bottom: 80px;
          right: 24px;
          width: 420px;
          max-height: 520px;
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
          z-index: 99998;
          display: none;
          flex-direction: column;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        #zhuque-panel.open { display: flex; }

        #zhuque-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 18px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #fff;
          cursor: move;
          user-select: none;
        }
        #zhuque-panel-header h3 {
          margin: 0;
          font-size: 15px;
          font-weight: 600;
        }
        .zhuque-header-actions {
          display: flex;
          gap: 8px;
        }
        .zhuque-header-actions button {
          background: rgba(255,255,255,0.2);
          border: none;
          color: #fff;
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.2s;
        }
        .zhuque-header-actions button:hover {
          background: rgba(255,255,255,0.35);
        }

        #zhuque-records-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px 0;
        }
        #zhuque-records-list::-webkit-scrollbar {
          width: 5px;
        }
        #zhuque-records-list::-webkit-scrollbar-thumb {
          background: #c5c5c5;
          border-radius: 4px;
        }

        .zhuque-record-item {
          padding: 10px 18px;
          border-bottom: 1px solid #f0f0f0;
          font-size: 13px;
          line-height: 1.5;
          transition: background 0.15s;
        }
        .zhuque-record-item:hover {
          background: #f8f9ff;
        }
        .zhuque-record-time {
          color: #999;
          font-size: 11px;
          margin-bottom: 4px;
        }
        .zhuque-record-text {
          color: #333;
          margin-bottom: 6px;
          word-break: break-all;
        }
        .zhuque-record-verdict {
          color: #764ba2;
          font-weight: 500;
          margin-bottom: 4px;
        }
        .zhuque-record-percents {
          display: flex;
          gap: 12px;
        }
        .zhuque-percent-tag {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 500;
        }
        .zhuque-tag-human {
          background: #e8f5e9;
          color: #2e7d32;
        }
        .zhuque-tag-suspect {
          background: #fff3e0;
          color: #e65100;
        }
        .zhuque-tag-ai {
          background: #fce4ec;
          color: #c62828;
        }

        .zhuque-empty {
          padding: 40px 20px;
          text-align: center;
          color: #aaa;
          font-size: 14px;
        }

        #zhuque-panel-footer {
          padding: 10px 18px;
          border-top: 1px solid #f0f0f0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12px;
          color: #999;
        }
      `;
      document.head.appendChild(style);
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
            <button id="zhuque-export-btn" title="\u5BFC\u51FAJSON">\u5BFC\u51FA</button>
            <button id="zhuque-clear-btn" title="\u6E05\u7A7A\u8BB0\u5F55">\u6E05\u7A7A</button>
            <button id="zhuque-close-btn" title="\u5173\u95ED">&times;</button>
          </div>
        </div>
        <div id="zhuque-records-list"></div>
        <div id="zhuque-panel-footer">
          <span id="zhuque-count">\u5171 0 \u6761\u8BB0\u5F55</span>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      document.getElementById('zhuque-close-btn').addEventListener('click', () => this.toggle());
      document.getElementById('zhuque-clear-btn').addEventListener('click', () => {
        if (confirm('\u786E\u5B9A\u6E05\u7A7A\u6240\u6709\u68C0\u6D4B\u8BB0\u5F55\u5417\uFF1F')) {
          Storage.clear();
          Capture.reset();
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

      list.innerHTML = records
        .map(
          (r) => `
        <div class="zhuque-record-item">
          <div class="zhuque-record-time">${formatTime(r.timestamp)}</div>
          <div class="zhuque-record-text">${this.escapeHtml(r.inputText || '(\u65E0\u6587\u672C)')}</div>
          ${r.verdict ? `<div class="zhuque-record-verdict">${this.escapeHtml(r.verdict)}</div>` : ''}
          <div class="zhuque-record-percents">
            ${r.humanPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-human">\u4EBA\u5DE5 ${r.humanPercent}%</span>` : ''}
            ${r.suspectedAIPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-suspect">\u7591\u4F3CAI ${r.suspectedAIPercent}%</span>` : ''}
            ${r.aiPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-ai">AI ${r.aiPercent}%</span>` : ''}
          </div>
        </div>
      `
        )
        .join('');
    },

    escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
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
      let isDragging = false;
      let startX, startY, origX, origY;

      handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = origX + (e.clientX - startX) + 'px';
        panel.style.top = origY + (e.clientY - startY) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
    },
  };

  // ========== 初始化 ==========
  UI.init();
  watchTriggers();
  console.log('[朱雀记录] v2.0.0 已加载');
})();
