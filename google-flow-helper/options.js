// options.js — 设置页逻辑
const FIELDS = [
  "mode",
  "promptSelectors",
  "generateButtonSelectors",
  "resultScanIntervalMs",
  "imageMinSize",
  "imageTimeoutMs",
  "videoTimeoutMs",
];

const DEFAULTS = {
  mode: "auto",
  promptSelectors: "",
  generateButtonSelectors: 'button[aria-label="开始生成"], button.generate-icon-button, button[type="submit"]',
  resultScanIntervalMs: 1500,
  imageMinSize: 220,
  imageTimeoutMs: 240000,
  videoTimeoutMs: 900000,
};

function toText(v) {
  return Array.isArray(v) ? v.join(", ") : String(v == null ? "" : v);
}

function toList(s) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function toInt(s, fallback) {
  const n = parseInt(s, 10);
  return isNaN(n) || n <= 0 ? fallback : n;
}

function collect() {
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    promptSelectors: toList($("promptSelectors").value),
    generateButtonSelectors: toList($("generateButtonSelectors").value),
    resultScanIntervalMs: toInt($("resultScanIntervalMs").value, DEFAULTS.resultScanIntervalMs),
    imageMinSize: toInt($("imageMinSize").value, DEFAULTS.imageMinSize),
    imageTimeoutMs: toInt($("imageTimeoutMs").value, DEFAULTS.imageTimeoutMs),
    videoTimeoutMs: toInt($("videoTimeoutMs").value, DEFAULTS.videoTimeoutMs),
  };
}

function applyToForm(s) {
  document.querySelector(`input[name="mode"][value="${s.mode === "semi" ? "semi" : "auto"}"]`).checked = true;
  $("promptSelectors").value = toText(s.promptSelectors);
  $("generateButtonSelectors").value = toText(s.generateButtonSelectors);
  $("resultScanIntervalMs").value = s.resultScanIntervalMs;
  $("imageMinSize").value = s.imageMinSize;
  $("imageTimeoutMs").value = s.imageTimeoutMs;
  $("videoTimeoutMs").value = s.videoTimeoutMs;
}

const $ = (id) => document.getElementById(id);

(async function init() {
  const { gf_settings = {} } = await chrome.storage.sync.get("gf_settings");
  applyToForm({ ...DEFAULTS, ...gf_settings });

  $("saveBtn").addEventListener("click", async () => {
    await chrome.storage.sync.set({ gf_settings: collect() });
    const msg = $("saveMsg");
    msg.textContent = "已保存 ✓";
    setTimeout(() => (msg.textContent = ""), 2000);
  });
})();
