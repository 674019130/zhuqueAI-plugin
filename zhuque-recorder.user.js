// ==UserScript==
// @name         朱雀AI检测记录助手
// @namespace    https://github.com/zhuque-ai-recorder
// @version      1.3.0
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

  // 诊断模式：在控制台输出详细日志，帮助排查问题
  const DEBUG = true;
  const _console_log = console.log.bind(console);
  const log = (...args) => DEBUG && _console_log('[朱雀记录]', ...args);

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
      log(' 新记录已保存', record);
      UI.refreshList();
      UI.flashButton();
    }
  }

  // ========== 网络拦截模块 ==========
  const NetHook = {
    init() {
      this.hookFetch();
      this.hookXHR();
      this.hookWebSocket();
    },

    // 深度扫描 JSON 对象，寻找包含数值百分比的检测结果
    // 策略：遍历所有键值对，寻找至少包含2个 0-100 数值的对象层级
    scanForDetectionData(obj, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 8) return null;

      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = this.scanForDetectionData(item, depth + 1);
          if (found) return found;
        }
        return null;
      }

      const entries = Object.entries(obj);

      // 检查当前层级的所有数值，看是否有多个 0-100 范围的浮点数
      const numericEntries = entries.filter(([, v]) => {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return !isNaN(n) && n >= 0 && n <= 100;
      });

      // 如果有至少2个数值字段且字段名包含检测相关关键词，认为是结果
      if (numericEntries.length >= 2) {
        const allKeys = entries.map(([k]) => k).join(' ');
        const keyStr = allKeys.toLowerCase();
        // 宽泛匹配：包含任何与检测结果相关的关键词
        const hasRelevantKey = /human|ai|machine|artificial|suspect|manual|人工|机器|疑似|score|rate|ratio|percent|prob|label|tag|type|category|feat|character/i.test(allKeys);
        if (hasRelevantKey) {
          log(' 在API响应中发现候选数据:', JSON.stringify(obj).slice(0, 500));
          return this.extractResult(obj);
        }
      }

      // 递归搜索所有子对象
      for (const [, val] of entries) {
        if (val && typeof val === 'object') {
          const found = this.scanForDetectionData(val, depth + 1);
          if (found) return found;
        }
      }

      return null;
    },

    extractResult(obj) {
      const entries = Object.entries(obj);

      // 按优先级尝试提取三项百分比
      const findVal = (patterns) => {
        for (const [key, val] of entries) {
          const k = key.toLowerCase();
          for (const p of patterns) {
            const matched = p instanceof RegExp ? p.test(key) : k.includes(p.toLowerCase());
            if (matched) {
              const n = typeof val === 'number' ? val : parseFloat(val);
              if (!isNaN(n) && n >= 0 && n <= 100) return n;
              if (typeof val === 'object' && val !== null) {
                for (const sub of ['percent', 'value', 'score', 'rate', 'ratio', 'prob']) {
                  if (val[sub] !== undefined) return parseFloat(val[sub]);
                }
              }
            }
          }
        }
        return null;
      };

      const humanPercent = findVal([/human/i, /artificial/i, /manual/i, /人工/, /person/i, /real/i, /origin/i]);
      const suspectedAIPercent = findVal([/suspect/i, /doubt/i, /疑似/, /maybe/i, /possible/i, /uncertain/i, /mix/i]);
      const aiPercent = findVal([/^ai$/i, /^ai[_-]/i, /[_-]ai$/i, /machine/i, /机器/, /robot/i, /generat/i, /aigc/i]);

      if (humanPercent === null && suspectedAIPercent === null && aiPercent === null) return null;

      // 提取判定/结论文本
      let verdict = '';
      for (const [key, val] of entries) {
        if (typeof val === 'string' && val.length > 2 && val.length < 200) {
          if (/verdict|conclusion|result|judge|判定|结论|label|desc|message|msg|text|summary|comment/i.test(key)) {
            verdict = val;
            break;
          }
        }
      }

      log(' 提取结果:', { humanPercent, suspectedAIPercent, aiPercent, verdict });
      return { humanPercent, suspectedAIPercent, aiPercent, verdict };
    },

    // 尝试解析响应文本，支持 JSON 和加密后包含 JSON 片段的情况
    tryParseResponse(text) {
      // 先尝试直接解析 JSON
      try {
        return JSON.parse(text);
      } catch {}

      // 尝试查找响应文本中的 JSON 子串
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {}
      }
      return null;
    },

    hookWebSocket() {
      const OrigWebSocket = window.WebSocket;
      const self = this;

      window.WebSocket = function (...args) {
        const ws = new OrigWebSocket(...args);
        log('WebSocket 连接:', args[0]);

        ws.addEventListener('message', (event) => {
          try {
            const raw = typeof event.data === 'string' ? event.data : '';
            if (!raw || raw.length < 10) return;

            log('WebSocket 消息 (前200字):', raw.slice(0, 200));

            const json = self.tryParseResponse(raw);
            if (json) {
              const data = self.scanForDetectionData(json);
              if (data) {
                log('WebSocket 中发现检测结果!');
                detectionActive = false;
                onNewRecord(buildRecord(data));
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        });

        return ws;
      };

      // 保留原型链
      window.WebSocket.prototype = OrigWebSocket.prototype;
      window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
      window.WebSocket.OPEN = OrigWebSocket.OPEN;
      window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
      window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
    },

    hookFetch() {
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        return origFetch.apply(this, args).then((response) => {
          // 拦截所有来自同域或腾讯域名的请求
          const url = response.url || '';
          if (/matrix\.tencent\.com|tencent\.com|qq\.com/i.test(url)) {
            const cloned = response.clone();
            cloned.text().then((text) => {
              if (!text || text.length < 10) return;
              const json = NetHook.tryParseResponse(text);
              if (!json) return;
              log(' fetch响应:', url.slice(0, 100), typeof json);
              const data = NetHook.scanForDetectionData(json);
              if (data) {
                detectionActive = false;
                onNewRecord(buildRecord(data));
              }
            }).catch(() => {});
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
        const url = this._zhuqueUrl || '';
        if (/matrix\.tencent\.com|tencent\.com|qq\.com/i.test(url)) {
          this.addEventListener('load', function () {
            try {
              const json = NetHook.tryParseResponse(this.responseText);
              if (!json) return;
              log(' XHR响应:', url.slice(0, 100), typeof json);
              const data = NetHook.scanForDetectionData(json);
              if (data) {
                detectionActive = false;
                onNewRecord(buildRecord(data));
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

        // 定时轮询备用：每2秒检查一次（防止 MutationObserver 漏掉框架更新）
        setInterval(() => {
          if (detectionActive) {
            log('定时轮询触发 check');
            this.check();
          }
        }, 2000);
      };

      if (document.body) {
        startWatch();
      } else {
        document.addEventListener('DOMContentLoaded', startWatch);
      }
    },

    // 监听页面上的检测按钮和 Ctrl+Enter 快捷键
    watchDetectButton() {
      // 点击检测按钮
      document.addEventListener('click', (e) => {
        const target = e.target;
        const btn = target.closest('button, [role="button"], a, div[class*="btn"], span[class*="btn"], div[class*="submit"], div[class*="detect"]');
        const text = (btn || target).textContent || '';
        if (/检测|detect|submit|提交/i.test(text)) {
          log(' 检测按钮被点击，激活捕获');
          detectionActive = true;
          this.lastValues = null;
        }
      }, true);

      // Ctrl+Enter 快捷键提交
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          log(' Ctrl+Enter 触发，激活捕获');
          detectionActive = true;
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

      // 输出页面文本中包含百分比的行，用于诊断
      const percentLines = pageText.split('\n').filter(l => /[\d.]+\s*%/.test(l));
      if (percentLines.length > 0) {
        log('DOM中包含百分比的行:', percentLines.slice(0, 10));
      }

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

      log('DOM标签匹配结果:', values);

      // 需要至少匹配到2个有标签的百分比才视为有效结果
      const matchCount = Object.keys(values).length;
      if (matchCount < 2) {
        log('匹配不足2个，跳过 (匹配数:', matchCount, ')');
        return;
      }

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

  log('脚本已加载 v1.3.0');
})();
