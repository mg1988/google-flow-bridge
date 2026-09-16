// content.js — Google Flow 页面自动化：填提示词 → 点生成 → 监控结果并下载
(() => {
  "use strict";

  // 注入标记：页面 console 检查 document.documentElement.getAttribute('data-flow-helper') 是否为 injected
  try {
    document.documentElement.setAttribute("data-flow-helper", "injected");
  } catch (_) { /* ignore */ }

  const DEFAULT_SETTINGS = {
    mode: "auto",                 // auto | semi（半自动：只填词不点击，用户手动点生成）
    promptSelectors: [],          // 用户显式指定输入框选择器
    generateButtonSelectors: [    // 精确选择器（优先于关键词启发式）——依据 Flow 实际 DOM 配置
      'button[aria-label="开始生成"]',
      "button.generate-icon-button",
      'button[type="submit"]',
    ],
    resultScanIntervalMs: 1500,
    imageMinSize: 220,            // 过滤 UI 图标的最小像素
    imageTimeoutMs: 240000,
    videoTimeoutMs: 900000,
    autoDownload: true,           // 自动下载结果
    promptKeywords: [
      "describe", "prompt", "what would you like", "what do you want",
      "idea", "create", "imagine", "生成", "描述", "提示词", "想生成", "创作", "镜头", "场景"
    ],
    generateKeywords: [
      "generate", "create", "生成", "创作", "制作", "开始"
    ],
    downloadAriaKeywords: ["download", "下载", "保存"],
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    seenUrls: new Set(),
    watching: false,
    observer: null,
    scanTimer: null,
    timeoutTimer: null,
    running: false,
  };

  // ---------- 工具 ----------
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const st = window.getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function textOf(el) {
    const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const title = (el.getAttribute("title") || "").trim().toLowerCase();
    const ph = (el.getAttribute("placeholder") || "").trim().toLowerCase();
    const own = (el.textContent || "").trim().toLowerCase().slice(0, 200);
    return { aria, title, ph, own };
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(Object.assign({ fromContent: true }, msg)).catch(() => {});
    } catch (_) { /* 扩展上下文被卸载时忽略 */ }
  }

  // 页面通道直连回传（offscreen 不可用时，本地 Agent 状态/结果走这条最可靠路径）
  function bridgeSend(payload) {
    if (offscreenOk !== true && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      try {
        bridgeWs.send(JSON.stringify(payload));
        return true;
      } catch (_) { /* ignore */ }
    }
    return false;
  }

  function status(message, cls = "") {
    // 直连回传服务端（终端实时可见）
    bridgeSend({ bridge: "STATUS", ts: Date.now(), message, cls });
    // 同时上报 background（弹窗/侧边栏展示）
    send({ type: "STATUS", message, cls });
  }

  // ---------- 登录检测 ----------
  function detectNotLoggedIn() {
    const bodyText = (document.body ? document.body.innerText : "").slice(0, 4000);
    const signInHits = (bodyText.match(/sign in|signin|log in|登录|登入/gi) || []).length;
    const hasEditor = !!findPromptInput({ silent: true });
    if (signInHits >= 2 && !hasEditor) return true;
    return false;
  }

  // ---------- 输入框定位 ----------
  function findPromptInput(opts = {}) {
    const { promptSelectors } = state.settings;

    // 1) 用户显式选择器
    if (promptSelectors && promptSelectors.length) {
      for (const sel of promptSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (isVisible(el)) return el;
        }
      }
    }

    // 2) 关键词启发式
    const candidates = [];
    document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]').forEach((el) => {
      if (!isVisible(el)) return;
      const { aria, title, ph, own } = textOf(el);
      const area = el.getBoundingClientRect().width * el.getBoundingClientRect().height;
      let score = Math.min(area / 8000, 30); // 越大越可能是主输入框

      const kw = state.settings.promptKeywords || DEFAULT_SETTINGS.promptKeywords;
      const hay = [aria, title, ph, own].join(" ");
      if (kw.some((k) => hay.includes(k.toLowerCase()))) score += 40;

      if (el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true") score += 15;

      // contenteditable 空白文本（真正空的输入框）
      const emptyish = (el.textContent || "").trim().length < 40;
      if (emptyish) score += 8;

      candidates.push({ el, score });
    });

    candidates.sort((a, b) => b.score - a.score);
    if (opts.silent === false && candidates.length) {
      status("已定位输入框（" + candidates[0].el.tagName + "）");
    }
    return candidates.length ? candidates[0].el : null;
  }

  // ---------- 填词（contenteditable 用 execCommand 真实输入路径，Angular/React 均能同步） ----------
  function setPrompt(el, text) {
    if (!el) return false;
    el.focus();

    if (el.isContentEditable || el.tagName === "DIV" || el.getAttribute("contenteditable") === "true") {
      try {
        // execCommand 模拟真实键盘输入：框架（Angular/React）能正确识别并更新内部状态
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("delete", false, null);
        document.execCommand("insertText", false, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {
        // 兜底：直接赋值 + input 事件
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }

  // ---------- 模拟完整点击序列（React/WebComponents 对 mousedown/mouseup 敏感） ----------
  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // 按钮描述（诊断用）
  function btnDescOf(btn) {
    return (
      btn.getAttribute("aria-label") ||
      btn.getAttribute("title") ||
      (btn.className && String(btn.className).toString().slice(0, 40)) ||
      btn.tagName
    );
  }

  // ---------- 生成按钮定位 ----------
  function findGenerateButton() {
    const { generateButtonSelectors } = state.settings;
    if (generateButtonSelectors && generateButtonSelectors.length) {
      for (const sel of generateButtonSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (isVisible(el)) return el;
        }
      }
    }

    const kws = state.settings.generateKeywords || DEFAULT_SETTINGS.generateKeywords;
    // 补充发送类关键词（Flow 发送按钮可能是纯图标，用 aria/title 语义兜底）
    const extra = ["send", "submit", "go", "arrow", "发送", "提交"];

    // 1) 输入框锚点：Flow 的发送按钮就贴在输入框旁边，优先在输入框祖先容器内找
    const input = findPromptInput({ silent: true });
    if (input) {
      const ir = input.getBoundingClientRect();
      let semantic = null;
      let rightOfInput = null;   // 输入框右侧同一水平线的按钮（发送键典型位置）
      let materialBtn = null;    // Angular Material 按钮（mat-focus-indicator 特征）
      let last = null;
      let node = input;
      for (let depth = 0; node && depth < 6; node = node.parentElement, depth++) {
        const btns = node.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          if (b === input) continue;
          if (!isVisible(b)) continue;
          const r = b.getBoundingClientRect();
          if (r.width < 24 || r.height < 24) continue;
          const { aria, title, own } = textOf(b);
          const full = [aria, title, own].join(" ");
          if (/new project|新建|upload|上传|share|分享|attach|附件|emoji|表情|undo|redo|撤销|重做|delete|删除/.test(full)) continue;
          if (b.querySelectorAll("svg").length > 3) continue;
          last = b;
          // 位置信号：按钮中心在输入框右侧同一水平线（发送键典型位置）
          const rightSide = r.left >= ir.right - 12 && r.top < ir.bottom && r.bottom > ir.top;
          if ([...kws, ...extra].some((k) => full.includes(k.toLowerCase()))) {
            semantic = semantic || b;
          } else if (rightSide) {
            rightOfInput = rightOfInput || b;
          }
          // Angular Material 按钮特征（mat-focus-indicator 内部标记）
          if (b.querySelector(".mat-focus-indicator") || /(^|\s)mat-/.test(b.className || "")) {
            materialBtn = materialBtn || b;
          }
        }
      }
      if (semantic) return semantic;        // 有明确发送语义，优先
      if (rightOfInput) return rightOfInput; // 输入框右侧的按钮（发送键位置）
      if (materialBtn) return materialBtn;   // Material 按钮兜底
      if (last) return last;
    }

    // 2) 关键词启发式（兜底）
    const buttons = document.querySelectorAll('button, [role="button"], a[href]');
    let best = null;
    let bestScore = 0;

    for (const b of buttons) {
      if (!isVisible(b)) continue;
      const { aria, title, own } = textOf(b);
      const full = [aria, title, own].join(" ");
      let score = 0;
      [...kws, ...extra].forEach((k) => {
        if (full.includes(k.toLowerCase())) {
          score += k === "generate" || k === "生成" || k === "send" || k === "发送" || k === "提交" ? 25 : 12;
        }
      });
      // 排除导航/新建类
      if (/new project|newproject|新建|add|上传|share|分享|save|保存|undo|redo|撤销|重做/.test(full)) score -= 30;
      // 按钮里含 sparkle 图标/较近的生成语义
      if (b.querySelector("svg")) score += 3;
      // 排除小图标按钮
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 24) score -= 15;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return bestScore >= 10 ? best : null;
  }

  // ---------- 下载按钮 / 结果元素 ----------
  function findDownloadButton(container) {
    const kws = state.settings.downloadAriaKeywords || DEFAULT_SETTINGS.downloadAriaKeywords;
    // 搜索范围逐级扩大：结果元素所在容器 → 卡片/资产容器 → 整个文档（Flow 下载可能藏在外层工具栏/三点菜单）
    const scopes = [
      container,
      container && container.closest('[class*="card"], [class*="result"], [class*="asset"], [data-testid]'),
      document,
    ].filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const scope of scopes) {
      const els = scope.querySelectorAll('button, [role="button"], a, [aria-label], [title]');
      for (const el of els) {
        if (!isVisible(el)) continue;
        const { aria, title } = textOf(el);
        const svgTitle = (el.querySelector("svg title, svg desc") || { textContent: "" }).textContent.toLowerCase();
        const full = [aria, title, svgTitle].join(" ");
        let score = 0;
        kws.forEach((k) => {
          if (full.includes(k.toLowerCase())) score += 20;
        });
        // Flow 下载入口常藏在三点菜单里：菜单按钮/菜单项带 more/menu/更多 语义时加分
        if (/(^|[\s\-_])more|menu|更多|⋮|⋯/.test(full)) score += 8;
        if (/share|复制|copy|embed|删除|delete|edit|编辑|rename|重命名/.test(full)) score -= 30;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (bestScore >= 20) break; // 已在本层找到明确下载语义，不再扩大
    }
    return bestScore >= 20 ? best : null;
  }

  function isUISmallImg(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0) {
      return Math.max(w, h) < state.settings.imageMinSize;
    }
    const r = img.getBoundingClientRect();
    return Math.max(r.width, r.height) < state.settings.imageMinSize * 0.5;
  }

  function isUIIconSrc(src) {
    return /logo|icon|avatar|emoji|favicon|data:image\/svg|\.svg(\?|$)/i.test(src || "");
  }

  function collectImageResults() {
    const results = [];
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      if (isUIIconSrc(src)) continue;
      if (isUISmallImg(img)) continue;
      if (state.seenUrls.has(src)) continue;
      // 仅接受页面自身来源的生成结果（blob 或 google 存储域）
      const ok = src.startsWith("blob:") || /^https?:\/\//.test(src);
      if (!ok) continue;
      results.push({ img, src });
    }
    return results;
  }

  function collectVideoResults() {
    const results = [];
    const vids = document.querySelectorAll("video");
    for (const v of vids) {
      const src = v.currentSrc || (v.querySelector("source") || {}).src || v.src || "";
      if (!src || src.startsWith("blob:null")) continue;
      if (state.seenUrls.has(src)) continue;
      if (isUIIconSrc(src)) continue;
      // 视频不能像图片那样用 naturalWidth 判断（video 无该属性）；只排除完全不可见/零尺寸
      // 的元素（刚插入尚未布局的播放器下一轮扫描会再捕获），不再强制 120x80 尺寸
      if (!isVisible(v)) continue;
      const r = v.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue;
      results.push({ video: v, src });
    }
    return results;
  }

  // ---------- 结果处理：下载 + 上报 ----------
  // 浏览器原生下载（a[download] 触发）
  function downloadViaBrowser(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  }

  async function handleResult({ kind, src, el, container }) {
    state.seenUrls.add(src);

    // 已捕获到新结果：清除"页面重载恢复"标记（若有）
    try {
      if (sessionStorage.getItem("gf_pending")) sessionStorage.removeItem("gf_pending");
    } catch (_) { /* ignore */ }

    const ts = Date.now();
    // 文件名含毫秒 + 全局序号，避免同批多张结果互相覆盖
    const stamp = new Date(ts).toISOString().replace(/[:.]/g, "").slice(0, 17);
    const ext = kind === "image" ? "png" : "mp4";
    state.dlSeq = (state.dlSeq || 0) + 1;
    const filename = "flow-" + kind + "-" + stamp + "-" + state.dlSeq + "." + ext;
    const url = src;
    const isBlob = src.startsWith("blob:");
    // 下载目录优先级：本地 Agent 随指令下发 > 设置（旧字段兜底）> 空=浏览器默认下载
    const localDir = state.currentDownloadDir || state.settings.localDownloadDir || "";

    status("检测到新生成的" + (kind === "image" ? "图片" : "视频") + "，正在获取…");

    // 0) 配置了本地下载目录：结果交给本地 Python Agent 直接保存到指定目录
    if (localDir) {
      try {
        if (/^https?:/.test(src)) {
          bridgeSend({ bridge: "DOWNLOAD_REQUEST", url: src, filename, dir: localDir });
          status("已发送下载请求到本地目录：" + filename, "success");
        } else if (isBlob) {
          const blob = await fetch(src).then((r) => r.blob());
          if (blob && blob.size > 40 * 1024 * 1024) {
            // 超大 blob（base64 后接近 WebSocket 64MB 上限），回退浏览器下载
            status("视频超过 40MB，改走浏览器下载（保存到 Chrome 下载目录）…", "warn");
            await downloadViaBrowser(blob, filename);
          } else if (blob && blob.size > 100) {
            const dataBase64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            bridgeSend({ bridge: "DOWNLOAD_REQUEST", dataBase64, filename, dir: localDir });
            status("已发送下载请求到本地目录：" + filename, "success");
          }
        }
      } catch (e) {
        status("转交本地下载失败（" + e.message + "），回退浏览器下载", "error");
        await downloadViaBrowser(await fetch(src).then((r) => r.blob()), filename);
      }
      // 无论哪种路径都上报结果（含 URL 供查看）
      bridgeSend({ bridge: "RESULT", ts, kind, url, filename, pageUrl: location.href, downloadable: !isBlob });
      send({ type: "RESULT", kind, url, filename, ts, pageUrl: location.href, downloadable: !isBlob });
      return;
    }

    // 1) 优先点击语义明确的下载按钮（浏览器原生下载真实文件）
    let downloadedByButton = false;
    if (state.settings.autoDownload !== false) {
      const btn = findDownloadButton(container || el.parentElement);
      if (btn) {
        try {
          btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          btn.click();
          downloadedByButton = true;
          status("已触发 Flow 下载按钮，文件将保存到浏览器下载目录", "success");
        } catch (_) { /* 继续兜底 */ }
      }
    }

    // 2) 兜底：blob → 页面内 fetch + a[download]（无需扩展权限，原生下载）
    if (!downloadedByButton && state.settings.autoDownload !== false && isBlob) {
      try {
        const blob = await fetch(src).then((r) => r.blob());
        if (blob && blob.size > 100) {
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = objUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
          downloadedByButton = true;
          status("已下载 " + filename + "（保存到浏览器下载目录）", "success");
        } else if (blob && blob.size <= 100) {
          status("结果 blob 异常为空，可能是流式视频，请手动点下载按钮", "error");
        }
      } catch (e) {
        status("自动下载失败（流式视频常见）：" + e.message + "，请手动点下载按钮", "error");
      }
    }

    // 3) https URL：交给 background 用 downloads API 下载
    if (!downloadedByButton && state.settings.autoDownload !== false && /^https?:/.test(src)) {
      try {
        chrome.runtime.sendMessage({ type: "DOWNLOAD", url: src, filename }).catch(() => {});
      } catch (_) { /* ignore */ }
    }

    // 上报结果（无论是否自动下载都记录；blob URL 只在页面内有效，标记不可再次下载）
    // 页面通道直连回传本地 Agent（终端实时可见）
    bridgeSend({ bridge: "RESULT", ts, kind, url, filename, pageUrl: location.href, downloadable: !isBlob });
    // 同时上报 background 持久化（弹窗/侧边栏「最近生成结果」列表）
    send({
      type: "RESULT",
      kind,
      url,
      filename,
      ts,
      pageUrl: location.href,
      downloadable: !isBlob,
    });
  }

  // ---------- 扫描主循环 ----------
  function scanOnce() {
    if (!state.watching) return;

    // 图片
    const imgs = collectImageResults();
    for (const { img, src } of imgs) {
      handleResult({ kind: "image", src, el: img, container: img.closest('[class*="card"], [class*="result"], [class*="asset"], [data-testid]') || img.parentElement });
    }

    // 视频
    const vids = collectVideoResults();
    for (const { video, src } of vids) {
      handleResult({ kind: "video", src, el: video, container: video.closest('[class*="card"], [class*="result"], [class*="asset"], [data-testid]') || video.parentElement });
    }
  }

  function startWatching() {
    if (state.watching) return;
    // 基线快照：把页面上已存在的素材/历史结果标记为已见，只监控本次新生成的内容
    for (const { src } of collectImageResults()) state.seenUrls.add(src);
    for (const { src } of collectVideoResults()) state.seenUrls.add(src);
    state.watching = true;
    installScanLoop();
    installSpaNavWatcher();
  }

  function installScanLoop() {
    const scan = () => scanOnce();
    state.scanTimer = setInterval(scan, state.settings.resultScanIntervalMs || 1500);

    state.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") { scan(); break; }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  }

  // 页面重载后恢复监控：跳过基线快照（生成结果可能已存在于页面），直接扫描捕获
  function resumeWatchingAfterReload() {
    if (state.watching) return;
    state.watching = true;
    installScanLoop();
    installSpaNavWatcher();
    scanOnce();
  }

  // SPA 路由跳转（Flow 生成完常跳到视频编辑页 /edit/...）后立即重新扫描，避免监控停在旧页面
  let spaNavWrapped = false;
  function installSpaNavWatcher() {
    if (spaNavWrapped) return;
    spaNavWrapped = true;
    const reScan = () => {
      setTimeout(() => {
        if (!state.watching) return;
        scanOnce();
      }, 600);
    };
    try {
      const h = window.history;
      const wrap = (orig) => function (...args) {
        const ret = orig.apply(this, args);
        reScan();
        return ret;
      };
      h.pushState = wrap(h.pushState);
      h.replaceState = wrap(h.replaceState);
      window.addEventListener("popstate", reScan);
    } catch (_) { /* ignore */ }
  }

  function stopWatching() {
    state.watching = false;
    if (state.scanTimer) clearInterval(state.scanTimer);
    if (state.observer) state.observer.disconnect();
    state.scanTimer = null;
    state.observer = null;
  }

  // ---------- 自动确认生成弹窗（Flow 可能弹「消耗点数/开始生成」确认框，不点掉不会开始） ----------
  async function watchAndApprove(timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const dialogs = document.querySelectorAll('[role="dialog"], dialog');
      for (const dlg of dialogs) {
        if (!isVisible(dlg)) continue;
        const btns = dlg.querySelectorAll('button, [role="button"]');
        for (const b of btns) {
          if (!isVisible(b)) continue;
          const { aria, title, own } = textOf(b);
          const full = [aria, title, own].join(" ");
          if (/批准|确认|同意|开始生成|继续/.test(full) && !/取消|关闭|退出|返回|back/.test(full)) {
            simulateClick(b);
            status("已自动确认生成确认框（" + full.slice(0, 20) + "）", "success");
            return true;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // ---------- 结果超时监控（独立于指令执行，不阻塞后续命令） ----------
  function startTimeoutWatch(kind) {
    if (state.timeoutTimer) {
      clearInterval(state.timeoutTimer);
      state.timeoutTimer = null;
    }
    const timeoutMs = kind === "image" ? state.settings.imageTimeoutMs : state.settings.videoTimeoutMs;
    const before = state.seenUrls.size;
    const t0 = Date.now();
    state.timeoutTimer = setInterval(() => {
      const newFound = state.seenUrls.size > before;
      if (newFound || Date.now() - t0 > timeoutMs) {
        clearInterval(state.timeoutTimer);
        state.timeoutTimer = null;
        if (!newFound) {
          status("等待超时，未捕获到新结果。可能是页面结构变化，请到设置调整选择器或改用半自动模式", "error");
          stopWatching();
        } else {
          status("完成。可再次生成，或关闭面板", "success");
        }
      }
    }, 2000);
  }

  // ---------- 生成是否已开始的检测（输入框清空 / 出现生成中 UI） ----------
  function generationStarted(input) {
    try {
      const txt = (input.textContent || input.value || "").trim();
      if (txt.length === 0) return true; // Flow 提交后通常清空输入框
      const busy = document.querySelector(
        '.mat-progress-spinner, .mat-progress-bar, [class*="generat"], [class*="loading"], [class*="progress"], [class*="busy"]'
      );
      if (busy && isVisible(busy)) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  // ---------- 上传参考图（重绘/图生图：注入 Flow 的 file input） ----------
  async function uploadReferenceImage(dataUrl) {
    status("正在上传参考图…（查找上传控件）");
    const fail = (m) => { status("上传参考图失败：" + m, "error"); return false; };
    const withTimeout = (p, ms, tag) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + " 超时")), ms))]);
    try {
      let fileInput = await withTimeout(Promise.resolve(document.querySelector('input[type="file"]')), 3000, "查找文件控件");
      if (!fileInput) {
        const uploadBtn = Array.from(document.querySelectorAll("button, [role=button], [aria-label]")).find(
          (b) => isVisible(b) && /upload|上传|image|图片|帧|frame/i.test(textOf(b).own || textOf(b).aria || "")
        );
        if (uploadBtn) { simulateClick(uploadBtn); status("已点击上传入口，等待文件控件出现…"); }
        let tries = 0;
        while (!fileInput && tries < 6) {
          await new Promise((r) => setTimeout(r, 800));
          fileInput = document.querySelector('input[type="file"]');
          tries++;
        }
      }
      if (!fileInput) return fail("页面没有上传控件，Flow 生图可能不支持参考图，已降级为纯提示词生成");
      status("已找到上传控件，注入参考图…");
      const blob = await withTimeout((await fetch(dataUrl)).blob(), 8000, "读取图片数据");
      const ext = blob.type.includes("png") ? "png" : blob.type.includes("gif") ? "gif" : "jpg";
      const file = new File([blob], "ref_" + Date.now() + "." + ext, { type: blob.type || "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      await withTimeout(new Promise((r) => setTimeout(r, 4000)), 6000, "等待上传");
      status("参考图已上传");
      return true;
    } catch (e) {
      return fail(String(e.message || e));
    }
  }

  // ---------- 主流程（只负责“提交”：填词 + 点击；结果监控由扫描循环独立完成） ----------
  async function runGenerate(prompt, kind, imageBase64) {
    state.running = true;

    if (imageBase64) {
      const uploaded = await uploadReferenceImage(imageBase64);
      if (!uploaded) status("未携带参考图，按纯提示词生成", "warn");
    }

    status("正在检查登录状态…");
    await new Promise((r) => setTimeout(r, 800));
    if (detectNotLoggedIn()) {
      status("未检测到创作界面，可能未登录 Google，请先登录 Flow 页面", "error");
      state.running = false;
      return { notLoggedIn: true };
    }

    // 定位输入框（重试过程实时上报，避免“看起来没触发”）
    let input = findPromptInput({ silent: false });
    if (!input) {
      // 页面可能刚加载 / 有弹窗（New project），再等几秒重试
      let tries = 0;
      while (!input && tries < 6) {
        status("正在定位提示词输入框…（第 " + (tries + 1) + "/6 次重试）");
        await new Promise((r) => setTimeout(r, 800));
        input = findPromptInput({ silent: true });
        tries++;
      }
    }
    if (!input) {
      status("未找到提示词输入框，请确认已进入 Flow 创作界面，或到设置里配置选择器", "error");
      state.running = false;
      return { ok: false, error: "未找到提示词输入框" };
    }

    // 填词
    status("已填入提示词…");
    setPrompt(input, prompt);
    input.scrollIntoView({ block: "center" });

    // 开始监控结果（先做基线快照，只监控本次新生成的内容）
    startWatching();

    // 记录"正在等待生成结果"：若 Flow 生成完跳转/整页重载（常见于跳到视频编辑页），
    // content script 重载后会据此自动恢复监控并捕获已出现在页面的结果
    try {
      sessionStorage.setItem("gf_pending", JSON.stringify({ kind, ts: Date.now() }));
    } catch (_) { /* ignore */ }

    if (state.settings.mode === "semi") {
      status("半自动模式：提示词已填好，请手动点击生成按钮，生成结果将自动获取", "");
      state.running = false;
      return { ok: true, semi: true };
    }

    // 点击生成（重试过程实时上报）
    let btn = findGenerateButton();
    if (!btn) {
      // 部分 UI 在填词后才出现生成按钮
      let tries = 0;
      while (!btn && tries < 5) {
        status("正在定位生成按钮…（第 " + (tries + 1) + "/5 次重试）");
        await new Promise((r) => setTimeout(r, 800));
        btn = findGenerateButton();
        tries++;
      }
    }
    if (!btn) {
      // 兜底：生成类输入框通常支持回车提交
      let viaEnter = false;
      try {
        status("未找到生成按钮，尝试回车提交…");
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        viaEnter = true;
      } catch (_) {
        viaEnter = false;
      }
      if (!viaEnter) {
        status("未找到生成按钮，请手动点击生成；结果监控仍会自动获取", "");
      }
      state.running = false;
      startTimeoutWatch(kind);
      return { ok: true, manual: true, viaEnter };
    }

    try {
      // 填词后等待 Angular 变更检测，再点按钮
      await new Promise((r) => setTimeout(r, 400));

      // 多策略点击，直到检测到生成开始
      const strategies = [];
      strategies.push(() => {
        simulateClick(btn);
        status("已点击生成（按钮: " + btnDescOf(btn) + "），等待 Flow 响应…");
      });
      const form = btn.closest("form");
      if (form) {
        strategies.push(() => {
          try { form.requestSubmit(); } catch (_) { /* ignore */ }
          status("已尝试表单提交（requestSubmit）…");
        });
      }
      strategies.push(() => {
        try {
          input.focus();
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          status("已尝试回车提交…");
        } catch (_) { /* ignore */ }
      });

      let triggered = false;
      for (const s of strategies) {
        try { s(); } catch (_) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1600));
        if (generationStarted(input)) {
          triggered = true;
          break;
        }
      }

      if (triggered) {
        status(
          kind === "image"
            ? "已触发生成，正在等待图片结果…（自动监控中）"
            : "已触发生成，视频生成需要几十秒到几分钟，正在等待…（自动监控中）"
        );
      } else {
        status("已尝试多种提交方式但未检测到生成开始，请手动点击发送；结果监控仍会自动获取", "error");
      }
      watchAndApprove(15000); // 自动点掉可能出现的「确认/扣费」弹窗（不阻塞）
    } catch (e) {
      status("点击生成按钮出错：" + e.message + "，请手动点击", "error");
    }
    state.running = false;
    startTimeoutWatch(kind); // 超时提示后台运行，不阻塞下一条指令
    return { ok: true };
  }

  // ---------- 消息入口 ----------
  // 指令串行队列：同一时刻只执行一条提交，后续指令排队，避免并发操作 DOM 互相覆盖
  let cmdQueue = Promise.resolve();
  let activeCmds = 0;
  function enqueueCmd(prompt, kind, imageBase64) {
    activeCmds++;
    if (activeCmds > 1) status("上一条指令仍在执行，本条指令排队等待…");
    const task = cmdQueue
      .then(() => runGenerate(prompt, kind, imageBase64))
      .finally(() => { activeCmds--; });
    cmdQueue = task.then(() => {}, () => {}); // 吞掉错误，保证队列继续
    return task;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === "PING") {
      sendResponse({ pong: true }); // 供 popup 诊断：确认脚本已注入
      return false;
    }
    if (msg.type !== "RUN_GENERATE") return false;
    state.currentDownloadDir = msg.downloadDir || ""; // 本地 Agent 下发的下载目录（每次指令更新）
    enqueueCmd(msg.prompt, msg.kind, msg.imageBase64 || "")
      .then((res) => sendResponse(res || { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });

  // 应用设置
  chrome.storage.sync.get("gf_settings", (res) => {
    if (res.gf_settings) {
      state.settings = { ...DEFAULT_SETTINGS, ...res.gf_settings };
      // 旧设置里生成按钮选择器为空时，保留内置精确选择器
      if (!state.settings.generateButtonSelectors || !state.settings.generateButtonSelectors.length) {
        state.settings.generateButtonSelectors = DEFAULT_SETTINGS.generateButtonSelectors;
      }
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.gf_settings) {
      state.settings = { ...DEFAULT_SETTINGS, ...(changes.gf_settings.newValue || {}) };
    }
  });

  // ---------- 页面内 WebSocket 兜底通道 ----------
  // offscreen（Chrome 109+）不可用时，改用本通道：在 Flow 页面内保持连接，
  // 任何 Chrome 版本可用，前提是 Flow 页面处于打开状态。
  const BRIDGE_WS_URL = "ws://localhost:8765";
  const BRIDGE_RECONNECT_MS = 3000;

  let bridgeWs = null;
  let bridgeWsTimer = null;
  let offscreenOk = null; // null=未知, true=offscreen 可用, false=不可用

  async function refreshOffscreenFlag() {
    try {
      const { bridge_status } = await chrome.storage.local.get("bridge_status");
      offscreenOk = !!(bridge_status && bridge_status.offscreen === "ok");
    } catch (_) {
      offscreenOk = false;
    }
    return offscreenOk;
  }

  function notifyBridge(state, detail) {
    chrome.runtime
      .sendMessage({ type: "BRIDGE_STATUS", state, detail, ws_source: "content" })
      .catch(() => {});
  }

  function closeBridgeWs() {
    if (bridgeWs) {
      try { bridgeWs.close(); } catch (_) { /* ignore */ }
      bridgeWs = null;
    }
    if (bridgeWsTimer) {
      clearTimeout(bridgeWsTimer);
      bridgeWsTimer = null;
    }
  }

  function connectBridgeWs() {
    if (bridgeWs || offscreenOk === true) return;
    try {
      bridgeWs = new WebSocket(BRIDGE_WS_URL);
    } catch (_) {
      scheduleBridgeWs();
      return;
    }

    bridgeWs.onopen = () => notifyBridge("connected");
    bridgeWs.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      // 诊断打点：验证页面通道是否真正收到广播（服务端日志可见）
      status("页面通道收到指令：" + String(data.prompt || data.action || "").slice(0, 24), "");
      // 与 offscreen 通道走同一路径，background 会做去重；带重试防 worker 冷启动丢消息
      const forward = (n) => {
        chrome.runtime
          .sendMessage({ type: "AGENT_CMD", cmd: data, source: "content" })
          .catch(() => {
            if (n > 0) setTimeout(() => forward(n - 1), 500);
          });
      };
      forward(3);
    };
    bridgeWs.onclose = (ev) => {
      bridgeWs = null;
      notifyBridge("disconnected", ev.code ? "连接关闭 (code " + ev.code + ")" : "");
      scheduleBridgeWs();
    };
    bridgeWs.onerror = () => {
      try { bridgeWs.close(); } catch (_) { /* ignore */ }
    };
  }

  function scheduleBridgeWs() {
    if (bridgeWsTimer || offscreenOk === true) return;
    bridgeWsTimer = setTimeout(() => {
      bridgeWsTimer = null;
      connectBridgeWs();
    }, BRIDGE_RECONNECT_MS);
  }

  async function bridgeWsTick() {
    const flag = await refreshOffscreenFlag();
    if (flag === true) {
      closeBridgeWs(); // offscreen 通道已就绪，关闭页面通道避免双连接
    } else {
      connectBridgeWs();
    }
  }

  // background 主动下发的确认消息（AGENT_RESULT）转发给本地 Agent；
  // STATUS/RESULT 已由 status()/handleResult() 页面通道直连回传，不再经此转发（避免重复）
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "AGENT_RESULT") {
      if (offscreenOk !== true && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
        try {
          const out = { bridge: "AGENT_RESULT", ts: Date.now() };
          Object.assign(out, msg.payload || msg);
          delete out.type;
          bridgeWs.send(JSON.stringify(out));
        } catch (_) { /* ignore */ }
      }
    }
  });

  bridgeWsTick();
  setInterval(bridgeWsTick, 5000);

  // 页面重载恢复：若上次指令仍在等待生成结果（Flow 生成完常整页跳转到视频编辑页），
  // content script 重载后自动恢复监控，直接捕获已出现在页面的结果，不再需要重发指令
  try {
    const pendingRaw = sessionStorage.getItem("gf_pending");
    if (pendingRaw) {
      const pending = JSON.parse(pendingRaw);
      if (pending && pending.ts && Date.now() - pending.ts < 25 * 60 * 1000) {
        state.pendingKind = pending.kind || "video";
        setTimeout(() => {
          resumeWatchingAfterReload();
          status("检测到上次生成未完成（页面已跳转/重载），已自动恢复结果监控…", "warn");
        }, 1500);
      } else {
        sessionStorage.removeItem("gf_pending");
      }
    }
  } catch (_) { /* ignore */ }

  status("Google Flow 助手已就绪（" + (state.settings.mode === "semi" ? "半自动模式" : "自动模式") + "）");
})();
