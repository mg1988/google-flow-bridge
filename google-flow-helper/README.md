# 豆包调用 Google Flow（Chrome 扩展）

一键调用 [Google Flow](https://labs.google/fx/tools/flow) 生成**图片 / 视频**，生成结果自动下载到浏览器下载目录。

## 功能

- 工具栏弹窗输入提示词，一键切换「图片 / 视频」
- 自动打开 / 聚焦 Flow 页面：填入提示词 → 点击生成 → 监控到结果自动下载
- 图片（Nano Banana 等）与视频（Veo 等）均支持
- **自动 / 半自动**两种模式，页面结构变化时可到设置页微调选择器
- 结果列表持久化，可随时重新下载

## 安装

1. 打开 Chrome，访问 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录 `google-flow-helper`
4. 工具栏出现「Google Flow 助手」图标

## 使用

1. **首次使用**：先在浏览器里打开 <https://labs.google/fx/tools/flow>，登录你的 Google 账号（Flow 需要登录才能生成）
2. 点工具栏图标 → 输入提示词 → 选「图片」或「视频」→ 点「生成」
3. 插件自动在 Flow 页面填词、点生成，生成完成后自动下载到浏览器下载目录
4. 视频生成较慢（几十秒～几分钟），期间可切回 Flow 页面查看进度

## 两种模式

| 模式 | 行为 | 适用场景 |
|---|---|---|
| **自动**（默认） | 填词 + 点击生成 + 自动下载 | 常规使用 |
| **半自动** | 只填词，生成按钮手动点，结果仍自动获取下载 | 页面改版导致按钮定位不准 / 想手动确认 |

在设置页（弹窗底部「高级设置」）切换。

## 故障排查

| 现象 | 处理 |
|---|---|
| 提示「未登录」 | 先手动打开 Flow 页面登录 Google 账号 |
| 找不到输入框 / 生成按钮 | 改用**半自动模式**；或在设置页填写选择器（F12 审查元素后复制） |
| 图片生成了但没自动下载 | 打开设置页确认「自动下载」开启；结果列表里点「下载」手动重下 |
| 视频自动下载失败 | 视频常为流式播放，请手动点 Flow 卡片上的下载按钮；或等生成完再点一次「下载」 |
| 页面结构变化后失效 | 更新设置页中的输入框 / 生成按钮选择器 |

## 文件结构

```
google-flow-helper/
├── manifest.json      # MV3 清单
├── popup.html/js      # 主界面（弹窗）
├── background.js      # Service Worker：标签页管理、下载
├── content.js         # Flow 页面自动化：填词、点生成、监控结果
├── options.html/js    # 设置页（模式、选择器、参数）
└── icons/             # 图标
```

## 隐私说明

- 插件只在你主动点击「生成」或本地 Agent 下发指令后操作 Flow 页面，不采集任何数据
- 提示词仅在本地存储（结果列表），不上传任何第三方
- 需要权限：`activeTab`/`scripting`/`tabs`（操作 Flow 标签页）、`downloads`（下载结果）、`storage`（保存设置与结果列表）、`notifications`

---

## 本地 Agent 桥接（Python 联动）

让本地 Python 脚本 / Agent 通过 WebSocket 直接向插件下发提示词，生成图片/视频，并拿回结果。桥接连接由插件的 offscreen document 承载（MV3 service worker 存活不稳定，不放那里）。

### 架构

```
本地 Python Agent (agent_server.py, ws://localhost:8765)
        │  WebSocket（仅允许 chrome-extension:// 来源）
        ▼
Chrome 扩展 offscreen → background → content script
        │
        ▼
Google Flow 页面（填提示词 → 点生成 → 监控结果 → 自动下载）
        │  生成完成 / 状态
        ▼
结果实时回传打印到 Python 终端（文件名、URL、状态）
```

### 联动测试步骤

1. **加载插件**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `google-flow-helper` 目录
2. **打开 Flow**：浏览器打开 <https://labs.google/fx/tools/flow> 并保持登录
3. **启动本地服务**：
   ```bash
   pip install websockets
   python3 agent_server.py
   ```
   看到 `监听: ws://localhost:8765` 即成功；插件会自动连接（弹窗里「本地 Agent」显示绿色已连接）
4. **下发指令**：在 Python 终端输入提示词回车：
   - 直接输入 → 生成**视频**：`清晨金色光里，老渔夫在河口撒网，暖侧光，缓慢推近`
   - 以「图片」或「img 」开头 → 生成**图片**：`图片 一只戴工程师帽的橘猫在写代码`
   - 输入 `exit` 退出
5. **拿回结果**：生成完成后插件自动下载到浏览器下载目录，Python 终端实时打印结果（文件名/URL/状态）；图片/视频完成消息带文件名，Agent 可直接使用

### 消息协议（供二次开发）

| 方向 | 消息 | 说明 |
|---|---|---|
| Python → 插件 | `{"action":"generate_video","kind":"video","prompt":"..."}` | `kind` 也可为 `image` |
| 插件 → Python | `{"bridge":"RESULT","kind":"image","filename":"...","url":"...","ts":...}` | 生成完成 |
| 插件 → Python | `{"bridge":"STATUS","message":"...","cls":"..."}` | 过程状态 |
| 插件 → Python | `{"bridge":"AGENT_RESULT","stage":"submitted","ok":true,...}` | 已下发确认 |

> 注意：`blob:` URL 只在 Flow 页面内有效，跨会话不可再次下载（结果已自动保存到下载目录，消息中 `downloadable:false`）。

### 双通道与鉴权

桥接支持两条通道，插件自动选择：
- **offscreen 通道**（Chrome 109+）：扩展后台稳定长连接，无需保持页面激活
- **Flow 页面内通道**（任何 Chrome 版本）：WebSocket 直接建在 Flow 页面脚本里，需保持 Flow 页面打开（`offscreen` 不可用时自动启用，弹窗会显示「通道：Flow 页面」）

服务端仅放行 `chrome-extension://*`、`labs.google`、`flow.google.com` 及无 Origin 的本地连接，其余来源一律 403 拒绝，防止恶意网页劫持。
