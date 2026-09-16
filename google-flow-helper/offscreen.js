// offscreen.js — 在 offscreen document 中承载 WebSocket 长连接（MV3 service worker 存活不稳定，不能放那里）
(() => {
  "use strict";

  const WS_URL = "ws://localhost:8765";
  const RECONNECT_MS = 3000;

  let ws = null;
  let reconnectTimer = null;
  let closedByUs = false;

  function log(msg) {
    console.log("[FlowBridge]", msg);
  }

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (closedByUs) return;

    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      log("WebSocket 创建失败: " + err.message);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      log("已连接本地 Python Agent (" + WS_URL + ")");
      notifyStatus("connected");
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        log("收到非 JSON 消息，忽略");
        return;
      }
      log("收到本地 Agent 指令: " + JSON.stringify(data).slice(0, 200));
      // 转发给 background 处理（打开/操作 Flow 标签页）
      chrome.runtime
        .sendMessage({ type: "AGENT_CMD", cmd: data })
        .catch(() => {});
    };

    ws.onclose = (ev) => {
      log("与本地 Agent 断开(code=" + ev.code + ")，将在 " + RECONNECT_MS / 1000 + " 秒后重试");
      notifyStatus("disconnected", ev.code ? "连接关闭 (code " + ev.code + ")" : "");
      if (!closedByUs) scheduleReconnect();
    };

    ws.onerror = () => {
      // WebSocket 错误多为连接被拒（ECONNREFUSED）＝本地服务未启动
      try { ws.close(); } catch (_) { /* ignore */ }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer || closedByUs) return;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  }

  function notifyStatus(state, detail) {
    chrome.runtime
      .sendMessage({ type: "BRIDGE_STATUS", state, detail })
      .catch(() => {});
  }

  // 接收 background 转发的执行结果，回传本地 Agent
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "AGENT_RESULT" || msg.type === "RESULT" || msg.type === "STATUS") {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          const out = { bridge: msg.type, ts: Date.now() };
          Object.assign(out, msg.payload || msg);
          delete out.type;
          ws.send(JSON.stringify(out));
        } catch (err) {
          log("回传失败: " + err.message);
        }
      }
    }
  });

  connect();
})();
