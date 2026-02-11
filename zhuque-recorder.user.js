// ==UserScript==
// @name         朱雀AI检测记录助手
// @namespace    https://github.com/zhuque-ai-recorder
// @version      1.1.0
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

  // 检测激活标志：只有用户真正发起检测后才捕获结果
  let detectionActive = false;

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
      // 去重：同一秒内相同百分比视为重复
      const isDup = records.some(
        (r) =>
          Math.abs(new Date(r.timestamp) - new Date(record.timestamp)) < 3000 &&
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
    const textarea = document.querySelector(
      'textarea[placeholder*="检测"], textarea[placeholder*="ctrl+enter"], textarea'
    );
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

  // ========== 记录处理 ==========
  function buildRecord(data) {
    const inputText = data.inputText || getInputText();
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      inputText: truncate(inputText, 200),
      inputTextFull: inputText,
      verdict: data.verdict || '',
      humanPercent: data.humanPercent ?? null,
      suspectedAIPercent: data.suspectedAIPercent ?? null,
      aiPercent: data.aiPercent ?? null,
    };
  }

  function onNewRecord(record) {
    const added = Storage.addRecord(record);
    if (added) {
      console.log('[朱雀记录] 新记录已保存', record);
      UI.refreshList();
      UI.flashButton();
    }
  }

  // ========== 网络拦截模块 ==========
  const NetHook = {
    init() {
      this.hookFetch();
      this.hookXHR();
    },

    // 尝试从 API 响应中提取检测数据
    parseResponse(url, body) {
      if (!body || typeof body !== 'object') return null;

      // 递归搜索包含百分比数据的对象
      const search = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 5) return null;

        // 检查当前层级是否有百分比字段
        const keys = Object.keys(obj);
        const hasPercent = keys.some(
          (k) =>
            /human|artificial|manual|人工/i.test(k) ||
            /ai|machine|机器/i.test(k) ||
            /suspect|疑似/i.test(k)
        );

        if (hasPercent) {
          const result = this.extractFromApiData(obj);
          if (result) return result;
        }

        // 检查常见的数据包装字段
        for (const key of ['data', 'result', 'results', 'detail', 'info', 'body', 'content', 'response']) {
          if (obj[key]) {
            const found = search(obj[key], depth + 1);
            if (found) return found;
          }
        }

        // 检查数组
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = search(item, depth + 1);
            if (found) return found;
          }
        }

        return null;
      };

      return search(body);
    },

    extractFromApiData(obj) {
      // 尝试多种可能的字段命名
      const findValue = (patterns) => {
        for (const [key, val] of Object.entries(obj)) {
          for (const p of patterns) {
            if (p instanceof RegExp ? p.test(key) : key.toLowerCase().includes(p)) {
              const num = parseFloat(val);
              if (!isNaN(num)) return num;
              // 值可能嵌套在对象中
              if (typeof val === 'object' && val !== null) {
                const inner = val.percent ?? val.value ?? val.score ?? val.rate ?? val.ratio;
                if (inner !== undefined) return parseFloat(inner);
              }
            }
          }
        }
        return null;
      };

      const humanPercent = findValue([/human/i, /artificial/i, /manual/i, '人工', /person/i]);
      const suspectedAIPercent = findValue([/suspect/i, /doubt/i, '疑似', /maybe/i, /possible/i]);
      const aiPercent = findValue([/^ai$/i, /ai_/i, /machine/i, '机器', /robot/i, /ai[_-]?feat/i]);

      // 至少要有一个有效百分比
      if (humanPercent === null && suspectedAIPercent === null && aiPercent === null) return null;

      // 尝试提取判定文本
      let verdict = '';
      for (const [key, val] of Object.entries(obj)) {
        if (/verdict|conclusion|result|judge|判定|结论|label|desc/i.test(key) && typeof val === 'string') {
          verdict = val;
          break;
        }
      }

      return { humanPercent, suspectedAIPercent, aiPercent, verdict };
    },

    hookFetch() {
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const isDetectReq = /detect|check|ai-detect|analyse|analyze|verify/i.test(url);
        if (isDetectReq) {
          detectionActive = true;
        }
        return origFetch.apply(this, args).then((response) => {
          if (isDetectReq) {
            const cloned = response.clone();
            cloned
              .json()
              .then((json) => {
                const data = NetHook.parseResponse(url, json);
                if (data) {
                  onNewRecord(buildRecord(data));
                  detectionActive = false;
                }
              })
              .catch(() => {});
          }
          return response;
        });
      };
    },

    hookXHR() {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._zhuqueUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function (...args) {
        const isDetectReq = /detect|check|ai-detect|analyse|analyze|verify/i.test(this._zhuqueUrl || '');
        if (isDetectReq) {
          detectionActive = true;
          this.addEventListener('load', function () {
            try {
              const json = JSON.parse(this.responseText);
              const data = NetHook.parseResponse(this._zhuqueUrl, json);
              if (data) {
                onNewRecord(buildRecord(data));
                detectionActive = false;
              }
            } catch {}
          });
        }
        return origSend.apply(this, args);
      };
    },
  };

  // ========== DOM 监听模块 ==========
  const DomWatcher = {
    lastValues: null,

    init() {
      const startWatch = () => {
        // 监听检测按钮点击，激活捕获
        this.watchDetectButton();

        const observer = new MutationObserver(() => this.check());
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      };

      if (document.body) {
        startWatch();
      } else {
        document.addEventListener('DOMContentLoaded', startWatch);
      }
    },

    // 监听页面上的检测按钮，点击时激活捕获
    watchDetectButton() {
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('button, [role="button"], a');
        if (btn && /立即检测|开始检测|检测/.test(btn.textContent)) {
          detectionActive = true;
          // 重置 lastValues 以允许捕获新结果
          this.lastValues = null;
        }
      }, true);
    },

    reset() {
      this.lastValues = null;
    },

    check() {
      // 仅在检测激活后才捕获
      if (!detectionActive) return;

      // 使用 innerText 避免匹配 CSS/HTML 属性中的百分比
      const panel = document.getElementById('zhuque-panel');
      const btn = document.getElementById('zhuque-float-btn');
      // 临时隐藏自身面板以排除干扰
      const panelDisplay = panel ? panel.style.display : '';
      const btnDisplay = btn ? btn.style.display : '';
      if (panel) panel.style.display = 'none';
      if (btn) btn.style.display = 'none';
      const pageText = document.body.innerText;
      if (panel) panel.style.display = panelDisplay;
      if (btn) btn.style.display = btnDisplay;

      // 精确按标签提取：匹配 "人工特征 XX.XX%" / "疑似AI XX.XX%" / "AI特征 XX.XX%"
      const labelPatterns = [
        { key: 'human',    regex: /人工(?:特征)?[^\d]*?([\d]+(?:\.[\d]+)?)\s*%/ },
        { key: 'suspect',  regex: /疑似\s*AI[^\d]*?([\d]+(?:\.[\d]+)?)\s*%/ },
        { key: 'ai',       regex: /AI\s*(?:特征)?[^\d]*?([\d]+(?:\.[\d]+)?)\s*%/ },
      ];

      const values = {};
      for (const { key, regex } of labelPatterns) {
        const match = pageText.match(regex);
        if (match) {
          values[key] = parseFloat(match[1]);
        }
      }

      // 需要至少匹配到2个有标签的百分比才视为有效结果
      const matchCount = Object.keys(values).length;
      if (matchCount < 2) return;

      const humanPercent = values.human ?? null;
      const suspectedAIPercent = values.suspect ?? null;
      const aiPercent = values.ai ?? null;

      const key = `${humanPercent}-${suspectedAIPercent}-${aiPercent}`;
      if (this.lastValues === key) return;
      this.lastValues = key;

      // 提取判定文本
      let verdict = '';
      const verdictPatterns = [
        /未发现[^。\n]*/,
        /发现[^。\n]*/,
        /检测结[果论][^。\n]*/,
        /判定[^。\n]*/,
      ];
      for (const pattern of verdictPatterns) {
        const match = pageText.match(pattern);
        if (match) {
          verdict = match[0].trim();
          break;
        }
      }

      onNewRecord(
        buildRecord({ humanPercent, suspectedAIPercent, aiPercent, verdict })
      );
      detectionActive = false;
    },
  };

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
      document.head
        ? document.head.appendChild(style)
        : document.addEventListener('DOMContentLoaded', () =>
            document.head.appendChild(style)
          );
    },

    createButton() {
      const create = () => {
        const btn = document.createElement('div');
        btn.id = 'zhuque-float-btn';
        btn.title = '朱雀检测记录';
        btn.textContent = '\uD83D\uDCCB';
        btn.addEventListener('click', () => this.toggle());
        document.body.appendChild(btn);
        this.btn = btn;
      };
      if (document.body) create();
      else document.addEventListener('DOMContentLoaded', create);
    },

    createPanel() {
      const create = () => {
        const panel = document.createElement('div');
        panel.id = 'zhuque-panel';
        panel.innerHTML = `
          <div id="zhuque-panel-header">
            <h3>朱雀检测记录</h3>
            <div class="zhuque-header-actions">
              <button id="zhuque-export-btn" title="导出JSON">导出</button>
              <button id="zhuque-clear-btn" title="清空记录">清空</button>
              <button id="zhuque-close-btn" title="关闭">&times;</button>
            </div>
          </div>
          <div id="zhuque-records-list"></div>
          <div id="zhuque-panel-footer">
            <span id="zhuque-count">共 0 条记录</span>
          </div>
        `;
        document.body.appendChild(panel);
        this.panel = panel;

        // 事件绑定
        document.getElementById('zhuque-close-btn').addEventListener('click', () => this.toggle());
        document.getElementById('zhuque-clear-btn').addEventListener('click', () => {
          if (confirm('确定清空所有检测记录吗？')) {
            Storage.clear();
            DomWatcher.reset();
            detectionActive = false;
            this.refreshList();
          }
        });
        document.getElementById('zhuque-export-btn').addEventListener('click', () => this.exportJSON());

        // 拖拽
        this.enableDrag(panel, document.getElementById('zhuque-panel-header'));

        this.refreshList();
      };
      if (document.body) create();
      else document.addEventListener('DOMContentLoaded', create);
    },

    toggle() {
      this.isOpen = !this.isOpen;
      this.panel.classList.toggle('open', this.isOpen);
      if (this.isOpen) this.refreshList();
    },

    flashButton() {
      if (!this.btn) return;
      this.btn.classList.remove('flash');
      void this.btn.offsetWidth; // 重置动画
      this.btn.classList.add('flash');
    },

    refreshList() {
      const list = document.getElementById('zhuque-records-list');
      const count = document.getElementById('zhuque-count');
      if (!list) return;

      const records = Storage.getRecords();
      count.textContent = `共 ${records.length} 条记录`;

      if (records.length === 0) {
        list.innerHTML = '<div class="zhuque-empty">暂无检测记录<br>进行AI检测后将自动记录</div>';
        return;
      }

      list.innerHTML = records
        .map(
          (r) => `
        <div class="zhuque-record-item">
          <div class="zhuque-record-time">${formatTime(r.timestamp)}</div>
          <div class="zhuque-record-text">${this.escapeHtml(r.inputText || '(无文本)')}</div>
          ${r.verdict ? `<div class="zhuque-record-verdict">${this.escapeHtml(r.verdict)}</div>` : ''}
          <div class="zhuque-record-percents">
            ${r.humanPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-human">人工 ${r.humanPercent}%</span>` : ''}
            ${r.suspectedAIPercent !== null ? `<span class="zhuque-percent-tag zhuque-tag-suspect">疑似AI ${r.suspectedAIPercent}%</span>` : ''}
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
      if (records.length === 0) {
        alert('没有可导出的记录');
        return;
      }
      const blob = new Blob([JSON.stringify(records, null, 2)], {
        type: 'application/json',
      });
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
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.left = origX + dx + 'px';
        panel.style.top = origY + dy + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
    },
  };

  // ========== 初始化 ==========
  NetHook.init();
  DomWatcher.init();

  const initUI = () => {
    if (document.body) {
      UI.init();
    } else {
      document.addEventListener('DOMContentLoaded', () => UI.init());
    }
  };
  initUI();

  console.log('[朱雀记录] 脚本已加载 v1.0.0');
})();
