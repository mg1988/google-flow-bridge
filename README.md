# 豆包调用 Google Flow（google-flow-bridge）

让 AI Agent（豆包）直接操作 **Google Flow**（flow.google.com）网页端生成图片 / 视频，并把结果**自动下载回本地指定目录**的桥接工作流。

> 架构：本地 WebSocket 服务端（`agent_server.py`）↔ Chrome 扩展（`google-flow-helper`）↔ flow.google.com 页面。扩展自动完成：检查登录 → 定位输入框 → 填入提示词 → 点击生成 → 监控结果 → 下载落盘 → 回传结果。

## 特性

- 🔌 **Agent 直接调用**：任意本地程序 / Agent 通过 WebSocket 下发指令，无需人工操作 Flow 页面
- 🎬 **图片 / 视频都支持**：指令指定 `kind`（video / image），自动检测并下载结果
- 📥 **自动下载落盘**：视频默认走 base64 直存指定目录（支持 40MB 以内视频），无需浏览器弹下载框
- 🔁 **双向回传**：执行进度（STATUS）、生成结果（RESULT）、下载回执（DOWNLOADED）实时回传指令方
- 🛠 **抗页面变化**：SPA 路由跳转自动重扫、整页重载后恢复监控、按最近访问选择 Flow 标签页

## 架构

```
本地 Agent / send_cmd.py
   │  WebSocket 下发 {action, kind, prompt, downloadDir}
   ▼
agent_server.py (ws://localhost:8765)
   │  广播指令 / 转发回传
   ▼
Chrome 扩展 google-flow-helper (content.js)
   │  自动操作页面
   ▼
Google Flow 页面 (flow.google.com)
   │  生成完成
   ▼
扩展扫描到结果 → 下载到指定目录 → RESULT / DOWNLOADED 回传 Agent
```

## 目录结构

```
google-flow-bridge/
├── README.md                  # 本文档
├── agent_server.py            # 本地 WebSocket 服务端（接收指令、落盘文件、转发回传）
├── send_cmd.py                # 指令下发客户端（命令行直接发提示词）
├── google-flow-helper/        # Chrome 扩展（加载已解压的扩展程序）
│   ├── manifest.json
│   ├── content.js             # 页面自动操作 + 结果监控 + 下载
│   ├── background.js          # 后台服务（扩展生命周期、标签路由）
│   ├── popup.html / popup.js  # 扩展弹窗
│   ├── sidepanel.html / sidepanel.js  # 侧边面板
│   ├── options.html / options.js      # 设置页
│   ├── offscreen.html / offscreen.js  # 离屏通道
│   └── icons/
└── wechat/
    └── qrcode.jpg             # 公众号二维码（AI派生码农）
```

## 安装

### 1. 加载 Chrome 扩展

1. 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `google-flow-helper/` 目录
4. 打开并登录 https://flow.google.com/（labs.google/fx/tools/flow 会自动跳转）

### 2. 安装服务端依赖

```bash
pip install websockets
```

### 3. 启动服务端

```bash
cd google-flow-bridge
python3 agent_server.py
```

终端出现 `[连接] 浏览器插件已连接` 即连接成功。

## 使用

### 方式一：命令行下发（推荐）

```bash
# 生成视频（默认）
python3 send_cmd.py "生成一只会飞的企鹅"

# 生成图片
python3 send_cmd.py "一只橘猫戴墨镜" image

# 指定结果保存目录
python3 send_cmd.py "生成一只会飞的企鹅" video /path/to/your/dir
```

### 方式二：Agent / 程序直连

通过 WebSocket 连接 `ws://localhost:8765`，发送 JSON 指令：

```json
{"action": "generate_video", "kind": "video", "prompt": "生成一只会飞的企鹅", "downloadDir": "/path/to/your/dir"}
```

实时接收回传：

```json
{"bridge": "STATUS", "message": "已点击生成，等待 Flow 响应…"}
{"bridge": "DOWNLOADED", "path": "/path/.../flow-video-xxx.mp4", "filename": "flow-video-xxx.mp4", "bytes": 5612122}
{"bridge": "RESULT", "kind": "video", "url": "https://...", "filename": "flow-video-xxx.mp4", "pageUrl": "https://flow.google.com/project/xxx", "downloadable": true}
```

### 提示词写法

- **生成视频**：明确写「生成一个…10秒视频 / 生成视频」类措辞，配合动作与镜头描述效果最佳，例如：
  `请生成一个竖屏9:16的10秒视频：一位38岁的中国大叔，背对镜头站在雨夜的街头，转身换装…`
- **生成图片**：写「图片 / img」前缀或纯静态画面描述。

> 注意：Flow 生成视频是两阶段——先出**概念图**，需在 Flow 页面确认后才产出视频成片。扩展会自动监控并下载最终视频。

## 指令协议（WebSocket JSON）

| 方向 | 消息 | 说明 |
|---|---|---|
| 服务端→插件 | `{"action":"generate_video"/"generate_image","kind":"video"/"image","prompt":"...","downloadDir":"/path"}` | 生成指令；downloadDir 可选 |
| 插件→服务端 | `{"bridge":"STATUS","message":"...","cls":"..."}` | 执行进度 |
| 插件→服务端 | `{"bridge":"DOWNLOAD_REQUEST","url"/"dataBase64","filename","dir"}` | 结果文件交给服务端保存 |
| 插件→服务端 | `{"bridge":"RESULT","kind","url","filename",...}` | 生成结果元信息 |
| 服务端→插件 | `{"bridge":"DOWNLOADED","path","filename","bytes"}` | 下载落盘回执 |

鉴权：仅放行 Origin 为空、`chrome-extension://*`、`labs.google`、`flow.google.com`；其余 403。

## 常见故障排查

| 现象 | 处理 |
|---|---|
| 弹窗显示「检测中…」 | 服务端未启动，或 Flow 页面未刷新（Cmd+R 重新注入脚本） |
| 弹窗显示「脚本未注入」 | Flow 页面按 Cmd+R 刷新 |
| 下发后无任何 STATUS 回传 | 重新加载插件文件夹 + 刷新 Flow 页面；确认服务端已 `[连接]` 再下发 |
| 指令广播成功但插件零回传 | 确认 agent_server.py 是最新版（旧版不转发外部客户端指令），重启服务端 |
| 填词成功但点击无效 | Flow 改版导致选择器失效，更新 content.js 的 `generateButtonSelectors` |
| 视频生成成功但没自动下载 | 多为旧版 5MB 阈值导致回退浏览器下载；新版 40MB 内走 base64 直存 |
| 多窗口时指令发错标签 | 新版按最近访问自动选择 Flow 标签；可在扩展设置里固定目标标签 |

## 已知边界

- 插件只操作网页 UI，Flow 页面结构改版可能导致选择器失效（需更新配置）
- 视频超过 40MB 时回退浏览器默认下载（base64 后接近 WebSocket 64MB 上限）
- 下载目录由指令方下发，服务端重启后需重新指定
- 生成类型由提示词措辞主导，个别情况下 Flow 可能先出概念图，需在页面确认转视频

## 免责声明

本项目通过浏览器 UI 自动化调用 Google Flow 公开网页服务，仅供个人学习与研究使用。请遵守 Google Flow 服务条款与当地法律法规；Flow 页面结构变更可能导致功能失效。

---

## 📮 关注公众号：AI派生码农

AI 工具 × 效率工作流 × 码农日常。更多 AI Agent 实战、浏览器自动化、提示词工程教程持续更新。

![AI派生码农公众号](wechat/qrcode.jpg)
