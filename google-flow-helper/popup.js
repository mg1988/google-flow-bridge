// popup.js — Google Flow 助手主界面逻辑
const $ = (id) => document.getElementById(id);

const promptEl = $("prompt");
const generateBtn = $("generateBtn");
const statusEl = $("status");
const resultListEl = $("resultList");

const RESULTS_KEY = "gf_results";
const MAX_RESULTS = 20;

// ---------- 结果本地存储 ----------
async function loadResults() {
  const { [RESULTS_KEY]: results = [] } = await chrome.storage.local.get(RESULTS_KEY);
  return results;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderResults(results) {
  if (!results.length) {
    resultListEl.innerHTML = '<div class="empty">暂无结果，生成后会自动出现在这里</div>';
    return;
  }
  resultListEl.innerHTML = "";
  for (const r of results) {
    const item = document.createElement("div");
    item.className = "result-item";

    const badge = document.createElement("span");
    badge.className = "type-badge " + r.kind;
    badge.textContent = r.kind === "image" ? "图片" : "视频";

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${fmtTime(r.ts)} · ${r.filename || "未命名"}`;
    meta.title = r.filename || "";

    const dl = document.createElement("a");
    if (r.downloadable) {
      dl.href = "#";
      dl.textContent = "下载";
      dl.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "DOWNLOAD", url: r.url, filename: r.filename });
      });
    } else {
      dl.textContent = "已保存";
      dl.style.color = "#9aa0a6";
      dl.title = "blob 结果已自动保存到下载目录，不可重复下载";
    }

    item.append(badge, meta, dl);
    resultListEl.appendChild(item);
  }
}

// ---------- 状态 ----------
function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// ---------- 生成 ----------
async function handleGenerate() {
  const prompt = promptEl.value.trim();
  const kind = document.querySelector('input[name="type"]:checked').value;

  if (!prompt) {
    setStatus("请先输入提示词", "error");
    return;
  }

  const { gf_settings: settings = {} } = await chrome.storage.sync.get("gf_settings");

  generateBtn.disabled = true;
  setStatus("正在打开 Google Flow 页面…");

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "GENERATE",
      prompt,
      kind,
      settings,
      ts: Date.now(),
    });
    if (resp && resp.ok === false) {
      setStatus(resp.error || "生成失败", "error");
      generateBtn.disabled = false;
      return;
    }
    if (resp && resp.notLoggedIn) {
      setStatus("检测到未登录 Google 账号，请先在 Flow 页面登录后重试", "error");
      generateBtn.disabled = false;
      return;
    }
    setStatus(
      kind === "image"
        ? "已提交生成，等待图片结果…（可打开 Flow 页面查看进度）"
        : "已提交生成，视频需要几十秒到几分钟，等待结果…"
    );
    // 注意：不要立即恢复按钮，等 content 上报完成
  } catch (err) {
    setStatus("打开 Flow 页面失败：" + err.message, "error");
    generateBtn.disabled = false;
  }
}

generateBtn.addEventListener("click", handleGenerate);
promptEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleGenerate();
});

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "STATUS") {
    setStatus(msg.message, msg.cls || "");
    if (msg.cls === "success" || msg.cls === "error") generateBtn.disabled = false;
  } else if (msg.type === "RESULT") {
    setStatus("已获取生成结果：" + msg.filename, "success");
    // 结果由 background 持久化，这里只刷新展示
    setTimeout(() => loadResults().then(renderResults), 150);
    generateBtn.disabled = false;
  }
});

// ---------- 初始化 ----------
function renderBridge(bridge, flowTabOpen, contentAlive) {
  const box = document.getElementById("bridgeStatus");
  const stateEl = document.getElementById("bridgeState");
  const detailEl = document.getElementById("bridgeDetail");

  box.classList.remove("connected", "error");
  detailEl.textContent = "";

  const ws = bridge && bridge.ws;
  if (ws === "connected") {
    box.classList.add("connected");
    stateEl.textContent = "已连接";
  } else if (ws === "reconnecting") {
    stateEl.textContent = "重连中…";
  } else if (ws === "error") {
    box.classList.add("error");
    stateEl.textContent = "连接错误";
  } else if (ws === "disconnected") {
    stateEl.textContent = "未连接";
  } else {
    stateEl.textContent = "检测中…";
  }

  const parts = [];
  if (bridge && bridge.offscreen === "error") {
    parts.push("offscreen 不可用，已切换到 Flow 页面内通道（请保持 Flow 页面打开）");
  }
  if (bridge && bridge.error && bridge.ws !== "connected") parts.push(bridge.error);
  if (bridge && bridge.offscreen === "ok" && ws !== "connected") {
    parts.push("offscreen 正常，等待连接本地服务（请先运行 python3 agent_server.py）");
  }
  if (ws === "connected" && bridge && bridge.ws_source) {
    parts.push("通道：" + (bridge.ws_source === "content" ? "Flow 页面" : "offscreen"));
  }
  if (ws !== "connected" && !bridge) {
    parts.push("正在检测桥接状态…");
  } else if (ws !== "connected") {
    if (flowTabOpen === false) {
      parts.push("未检测到打开的 Flow 页面，请先打开 labs.google/fx/tools/flow");
    } else if (flowTabOpen === true && contentAlive === false) {
      parts.push("Flow 页面已打开但插件脚本未注入，请在该页面按 Cmd+R 刷新");
    } else if (flowTabOpen === true) {
      parts.push("脚本已注入，等待页面通道连接本地服务（python3 agent_server.py）…");
    }
  }
  if (parts.length) detailEl.textContent = parts.join(" · ");
}

(async function init() {
  const results = await loadResults();
  renderResults(results);

  // 本地 Agent 桥接状态（主动请求，唤醒后台并确保 offscreen 创建）
  const refreshBridge = async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_BRIDGE_STATUS" });
      if (resp && resp.ok) renderBridge(resp.bridge_status, resp.flowTabOpen, resp.contentAlive);
      else if (resp && resp.error) renderBridge({ ws: "error", error: resp.error });
    } catch (err) {
      renderBridge({ ws: "error", error: "无法访问扩展后台: " + (err && err.message || err) });
    }
  };
  refreshBridge();
  // 弹窗打开期间每 2 秒自动刷新状态（避免连接建立后仍显示旧快照）
  setInterval(refreshBridge, 2000);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bridge_status) renderBridge(changes.bridge_status.newValue);
  });

  // 手动重连
  const reconnectBtn = document.getElementById("reconnectBtn");
  reconnectBtn.addEventListener("click", async () => {
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = "重连中…";
    await chrome.runtime.sendMessage({ type: "BRIDGE_RECONNECT" }).catch(() => {});
    setTimeout(() => {
      refreshBridge();
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = "重连";
    }, 1500);
  });
})();
