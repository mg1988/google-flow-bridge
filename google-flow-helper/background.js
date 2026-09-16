// background.js — Google Flow 助手 Service Worker
const FLOW_URLS = [
  "https://labs.google/fx/tools/flow*",
  "https://labs.google/flow*",
  "https://flow.google.com/*"
];
const FLOW_MAIN = "https://labs.google/fx/tools/flow";

// ---------- 工具 ----------
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForComplete(tabId, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      throw new Error("Flow 标签页已被关闭");
    }
    if (tab.status === "complete") return;
    if (Date.now() - t0 > timeoutMs) return; // 超时不阻塞，交给 sendMessage 重试
    await wait(400);
  }
}

async function sendWithRetry(tabId, msg, attempts = 6, gap = 700) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (err) {
      lastErr = err;
      await wait(gap);
    }
  }
  throw lastErr || new Error("content script 未就绪");
}

// ---------- offscreen document（承载 WebSocket） ----------
async function setBridgeStatus(patch) {
  try {
    const cur = (await chrome.storage.local.get("bridge_status")).bridge_status || {};
    await chrome.storage.local.set({ bridge_status: { ...cur, ...patch, ts: Date.now() } });
  } catch (_) { /* ignore */ }
}

async function ensureOffscreen() {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "保持与本地 Python Agent 的 WebSocket 长连接，桥接生成指令与结果",
      });
    }
    await setBridgeStatus({ offscreen: "ok" });
  } catch (err) {
    const msg = String(err && err.message || err);
    console.warn("[FlowBridge] 创建 offscreen 失败:", msg);
    await setBridgeStatus({ offscreen: "error", error: msg });
  }
}

// 强制重建 offscreen（诊断用；offscreen 不可用时由页面通道接管）
async function reconnectBridge() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) { /* ignore */ }
  await ensureOffscreen();
}

// ---------- 打开/聚焦 Flow 标签页 ----------
async function openFlowTab() {
  let tabs = await chrome.tabs.query({ url: FLOW_URLS });
  tabs = (tabs || []).slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  // 多个 Flow 标签时选最近访问的那个（Agent 当前正操作的），避免指令发到旧标签
  let tab = tabs && tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: FLOW_MAIN });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await waitForComplete(tab.id);
  return tab;
}

async function runOnFlowTab(payload) {
  const tab = await openFlowTab();
  const resp = await sendWithRetry(tab.id, {
    type: "RUN_GENERATE",
    prompt: payload.prompt,
    kind: payload.kind,
    settings: payload.settings || {},
    downloadDir: payload.downloadDir || "",
    imageBase64: payload.imageBase64 || "",
    ts: Date.now(),
  });
  return resp || {};
}

// ---------- popup 手动生成 ----------
async function handleGenerate(msg) {
  return runOnFlowTab(msg);
}

// ---------- 本地 Agent 指令（来自 offscreen WebSocket） ----------
function kindFromCmd(cmd) {
  if (cmd.kind) return cmd.kind;
  const a = String(cmd.action || "").toLowerCase();
  if (a.includes("image") || a.includes("图片") || a.includes("img")) return "image";
  if (a.includes("video") || a.includes("视频")) return "video";
  return "video"; // 默认视频（Flow 主打视频）
}

async function handleAgentCmd(cmd) {
  if (!cmd || !cmd.prompt) {
    return { ok: false, error: "指令缺少 prompt 字段" };
  }
  const payload = {
    prompt: String(cmd.prompt),
    kind: kindFromCmd(cmd),
    settings: cmd.settings || {},
    downloadDir: cmd.downloadDir || "", // 本地 Agent 随指令下发下载目录
    imageBase64: cmd.imageBase64 || "", // 参考图（重绘/图生图用），content 上传后走同一条生成流程
  };
  try {
    await runOnFlowTab(payload);
    return { ok: true, prompt: payload.prompt, kind: payload.kind };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ---------- 下载 ----------
async function handleDownload({ url, filename }) {
  try {
    let finalUrl = url;
    if (url && url.startsWith("blob:")) {
      const blob = await (await fetch(url)).blob();
      const ext = filename && filename.includes(".")
        ? filename.split(".").pop()
        : (blob.type.includes("video") ? "mp4" : "png");
      const safeName = filename || ("flow-result." + ext);
      const objUrl = URL.createObjectURL(blob);
      finalUrl = objUrl;
      await chrome.downloads.download({
        url: finalUrl,
        filename: safeName,
        conflictAction: "uniquify",
        saveAs: false,
      });
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
      return { ok: true };
    }
    await chrome.downloads.download({
      url: finalUrl,
      filename: filename || "flow-result",
      conflictAction: "uniquify",
      saveAs: false,
    });
    return { ok: true };
  } catch (err) {
    console.error("download failed", err);
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ---------- 消息路由 ----------
// 双通道（offscreen / content）可能同时收到同一指令，2 秒内去重
let lastAgentCmd = { key: "", ts: 0 };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "GENERATE") {
    handleGenerate(msg)
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // 异步响应
  }

  if (msg.type === "AGENT_CMD") {
    // 来自 offscreen 或 content（本地 Python Agent），结果通过 RESULT/STATUS relay 回传
    const key = msg.cmd ? String(msg.cmd.prompt || "") + "|" + String(msg.cmd.kind || "") : "";
    const now = Date.now();
    if (key && key === lastAgentCmd.key && now - lastAgentCmd.ts < 3000) {
      return false; // 双通道重复指令，忽略
    }
    if (key) {
      lastAgentCmd.key = key;
      lastAgentCmd.ts = now;
    }
    handleAgentCmd(msg.cmd)
      .then((res) => {
        chrome.runtime
          .sendMessage({ type: "AGENT_RESULT", payload: { stage: "submitted", ...res } })
          .catch(() => {});
      });
    return false;
  }

  if (msg.type === "DOWNLOAD") {
    handleDownload(msg)
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === "BRIDGE_STATUS") {
    const patch = typeof msg.state === "string" ? { ws: msg.state } : { ...(msg.state || {}) };
    if (msg.detail) patch.error = msg.detail;
    if (msg.ws_source) patch.ws_source = msg.ws_source;
    setBridgeStatus(patch);
    return false;
  }

  if (msg.type === "BRIDGE_RECONNECT") {
    reconnectBridge()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === "GET_BRIDGE_STATUS") {
    // popup 打开时主动唤醒：确保 offscreen 已创建，并返回实时状态 + Flow 页面/脚本检测
    ensureOffscreen()
      .then(async () => {
        const { bridge_status } = await chrome.storage.local.get("bridge_status");
        const flowTabs = await chrome.tabs.query({ url: FLOW_URLS });
        let contentAlive = false;
        if (flowTabs && flowTabs.length) {
          try {
            const ping = await chrome.tabs.sendMessage(flowTabs[0].id, { type: "PING" });
            contentAlive = !!(ping && ping.pong);
          } catch (_) {
            contentAlive = false; // 页面未注入 content script
          }
        }
        sendResponse({
          ok: true,
          bridge_status: bridge_status || {},
          flowTabOpen: !!(flowTabs && flowTabs.length),
          contentAlive,
        });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // content script 上报：持久化结果 + 转发给 popup / options / offscreen
  if ((msg.type === "RESULT" || msg.type === "STATUS") && sender.tab) {
    if (msg.type === "RESULT") {
      // 权威持久化：即使弹窗关闭，结果也会保留
      chrome.storage.local
        .get("gf_results")
        .then(({ gf_results: list = [] }) => {
          const next = [msg, ...list].slice(0, 20);
          return chrome.storage.local.set({ gf_results: next });
        })
        .catch(() => {});
    }
    // 展开 payload 转发（offscreen 会原样回传本地 Agent）
    const relay = { ...msg, fromRelay: true, payload: { ...msg } };
    delete relay.payload.type;
    chrome.runtime.sendMessage(relay).catch(() => {});
  }
  return false;
});

// ---------- 启动时确保 offscreen ----------
chrome.runtime.onStartup.addListener(() => { ensureOffscreen(); });
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen(); });
ensureOffscreen();

// ---------- 侧边栏模式（Chrome 114+）：点击图标在侧边栏常驻打开，不随失焦关闭 ----------
try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("[FlowBridge] 侧边栏行为设置失败（将回退弹窗）:", err && err.message));
  }
} catch (_) {
  // 旧版 Chrome 无 sidePanel API，自动回退到 default_popup 弹窗
}
