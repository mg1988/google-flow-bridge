#!/usr/bin/env python3
"""Google Flow 本地 Agent 桥接服务端

配合 Chrome 扩展「豆包调用 Google Flow」使用：
- 监听 ws://localhost:8765
- 在终端输入提示词，自动下发到浏览器插件，操作 Google Flow 生成图片/视频
- 插件执行状态与生成结果会实时打印（Agent 可通过此通道拿回结果）

用法：
  python3 -m pip install websockets
  python3 agent_server.py

提示词格式：
  直接输入文本           -> 生成视频（Flow 主打）
  以「图片」或「img 」开头 -> 生成图片
  输入 exit / quit / q   -> 退出
"""

import asyncio
import base64
import json
import os
import sys
import urllib.request

import websockets


class FlowBridge:
    def __init__(self):
        self.clients = set()
        self.download_dir = ""  # 由 CLI `dir <路径>` 设置，随指令下发给插件

    async def process_request(self, connection, request):
        """握手阶段鉴权：仅放行以下来源，其余直接 403
        - chrome-extension://*      offscreen 通道（Chrome 109+）
        - labs.google / flow.google.com   Flow 页面内通道（content script，Origin 为页面域名）
        - 空 Origin                  本地非浏览器客户端（如调试工具）

        兼容新旧 websockets：v10 的 request 本身是 Headers；v14+ 的 request 是带 .headers 的对象。
        """
        headers = getattr(request, "headers", request)
        origin = headers.get("Origin", "") or ""
        allowed = (
            not origin
            or origin.startswith("chrome-extension://")
            or "labs.google" in origin
            or "flow.google.com" in origin
        )
        if not allowed:
            print(f"[拒绝] 非受信来源连接: {origin}")
            return connection.respond(403, "origin not allowed")
        return None  # 放行

    async def handler(self, websocket, path=None):
        # path 参数兼容旧版 websockets（v10 要求 handler(websocket, path)）
        self.clients.add(websocket)
        origin = dict(websocket.request_headers).get("Origin", "") if hasattr(websocket, "request_headers") else ""
        if not origin:
            origin = dict(getattr(websocket, "headers", {})).get("Origin", "")
        print(f"[连接] 浏览器插件已连接: {websocket.remote_address} origin={origin[:60] or '(空=本地客户端)'} (当前共 {len(self.clients)} 个)")
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    bridge = data.get("bridge", "?")
                    if bridge == "DOWNLOAD_REQUEST":
                        await self.handle_download(data)
                    elif "action" in data or "prompt" in data:
                        # 外部 Agent 下发指令（send_cmd.py / CLI 之外的客户端）：转发给所有其他客户端（插件执行）
                        await self.broadcast(data, exclude=websocket)
                        print(f"[外部指令] 已广播给 {len(self.clients) - 1} 个客户端: "
                              + json.dumps(data, ensure_ascii=False)[:300])
                    else:
                        # 插件上报（STATUS/RESULT/AGENT_RESULT/...）：打印并转发给其他客户端（send_cmd 收进度）
                        print(f"[插件上报] {bridge}: {json.dumps(data, ensure_ascii=False)[:500]}")
                        await self.broadcast(data, exclude=websocket)
                except json.JSONDecodeError:
                    print(f"[插件上报] {message[:300]}")
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            print(f"[断开] 插件连接已断开 (剩余 {len(self.clients)} 个)")

    async def broadcast(self, payload, exclude=None):
        """向所有已连接客户端广播一条 JSON 消息（如保存成功回执）；exclude 排除发送者避免回环"""
        data = json.dumps(payload, ensure_ascii=False)
        for c in list(self.clients):
            if c is exclude:
                continue
            try:
                await c.send(data)
            except Exception:
                pass

    async def handle_download(self, data):
        """把生成结果保存到本地目录：优先用服务端 dir 指令设置的目录，其次插件请求里的 dir"""
        directory = (self.download_dir or (data.get("dir") or "")).strip()
        filename = (data.get("filename") or "flow-result").strip()
        url = data.get("url") or ""
        data_b64 = data.get("dataBase64") or ""
        if not directory:
            print("[下载] 未配置下载目录，忽略本地保存")
            return
        try:
            os.makedirs(directory, exist_ok=True)
            # 重名自动加序号，避免同批多张结果互相覆盖
            path = os.path.join(directory, filename)
            if os.path.exists(path):
                base, ext = os.path.splitext(filename)
                i = 1
                while os.path.exists(os.path.join(directory, f"{base}-{i}{ext}")):
                    i += 1
                path = os.path.join(directory, f"{base}-{i}{ext}")
            if url:
                # 同步下载会阻塞事件循环，丢到线程池
                def _fetch():
                    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=120) as resp:
                        return resp.read()
                raw = await asyncio.get_running_loop().run_in_executor(None, _fetch)
            elif data_b64:
                raw = base64.b64decode(data_b64)
            else:
                print("[下载] 请求缺少 url 或 dataBase64，忽略")
                return
            with open(path, "wb") as f:
                f.write(raw)
            print(f"[下载] 已保存: {path} ({len(raw)} 字节)")
            # 回执给插件/Agent：确认文件已落盘到确切路径（Agent 据此核对产物）
            await self.broadcast({
                "bridge": "DOWNLOADED",
                "path": path,
                "filename": os.path.basename(path),
                "bytes": len(raw),
                "ts": int(asyncio.get_running_loop().time() * 1000),
            })
        except Exception as e:
            print(f"[下载] 保存失败: {e}")

    async def cli(self):
        """异步命令行输入，不阻塞事件循环"""
        loop = asyncio.get_running_loop()
        print("输入提示词，回车下发（图片请以「图片」或「img」开头，输入 exit 退出）")
        while True:
            try:
                line = await loop.run_in_executor(None, input, "> ")
            except EOFError:
                print("(标准输入已关闭，转为纯 WebSocket 下发模式)")
                await asyncio.Future()  # 保持服务运行
            line = line.strip()
            if not line:
                continue
            if line.lower() in ("exit", "quit", "q"):
                for c in list(self.clients):
                    await c.close()
                print("已退出")
                return
            if line.lower().startswith("dir "):
                self.download_dir = line[4:].strip()
                print(f"下载目录已设置: {self.download_dir}（随后续指令下发给插件）")
                continue
            if not self.clients:
                print("⚠ 没有已连接的浏览器插件。请先打开 Chrome 的 Google Flow 页面，确认插件已加载且桥接已连接。")
                continue

            lower = line.lower()
            if lower.startswith("图片"):
                kind, prompt = "image", line[2:].strip()
            elif lower.startswith("img "):
                kind, prompt = "image", line[4:].strip()
            elif lower.startswith("重绘"):
                # 重绘 <图片路径> <提示词>：上传本地图给 Flow 作为参考重绘（去水印/重绘画面）
                rest = line[2:].strip()
                parts = rest.split(" ", 1)
                if len(parts) < 2 or not os.path.isfile(parts[0]):
                    print("[重绘] 用法: 重绘 <图片路径> <提示词>（图片文件不存在）")
                    continue
                img_path, prompt = parts[0].strip(), parts[1].strip()
                kind = "image"
                try:
                    with open(img_path, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode()
                    payload = {
                        "action": "generate_image",
                        "kind": "image",
                        "prompt": prompt,
                        "imageBase64": f"data:image/png;base64,{b64}",
                    }
                    if self.download_dir:
                        payload["downloadDir"] = self.download_dir
                    data = json.dumps(payload, ensure_ascii=False)
                    for c in list(self.clients):
                        await c.send(data)
                    print(f"[重绘] 已上传参考图 {os.path.basename(img_path)} 并下发提示词: {prompt}")
                except Exception as e:
                    print(f"[重绘] 失败: {e}")
                continue
            else:
                kind, prompt = "video", line

            if not prompt:
                print("提示词为空，请重新输入")
                continue

            payload = {
                "action": f"generate_{kind}",
                "kind": kind,
                "prompt": prompt,
            }
            if self.download_dir:
                payload["downloadDir"] = self.download_dir  # 下载目录随指令交给插件
            data = json.dumps(payload, ensure_ascii=False)
            for c in list(self.clients):
                await c.send(data)
            print(f"[下发] 已向插件提交{'图片' if kind == 'image' else '视频'}提示词: {prompt}"
                  + (f" → 下载到: {self.download_dir}" if self.download_dir else ""))

    async def main(self):
        async with websockets.serve(
            self.handler,
            "localhost",
            8765,
            max_size=64 * 1024 * 1024,
            process_request=self.process_request,
        ):
            print("=" * 56)
            print("  Google Flow 本地 Agent 桥接服务已启动")
            print("  监听: ws://localhost:8765")
            print("=" * 56)
            await asyncio.gather(self.cli(), asyncio.Future())


if __name__ == "__main__":
    try:
        asyncio.run(FlowBridge().main())
    except KeyboardInterrupt:
        print("\n已停止")
        sys.exit(0)
