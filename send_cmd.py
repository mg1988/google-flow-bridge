#!/usr/bin/env python3
"""Flow 桥接指令下发客户端：连接 ws://localhost:8765，发送生成指令并实时打印服务端回传。
用法:
  python3 send_cmd.py "<prompt>" [kind] [downloadDir]
  kind: video(默认) | image
"""
import asyncio
import json
import sys
import time

import websockets

URL = "ws://localhost:8765"


async def main():
    if len(sys.argv) < 2:
        print("用法: send_cmd.py <prompt> [kind] [downloadDir]")
        return
    prompt = sys.argv[1]
    kind = sys.argv[2] if len(sys.argv) > 2 else "video"
    dl_dir = sys.argv[3] if len(sys.argv) > 3 else ""

    payload = {"action": f"generate_{kind}", "kind": kind, "prompt": prompt}
    if dl_dir:
        payload["downloadDir"] = dl_dir

    try:
        async with websockets.connect(URL, max_size=64 * 1024 * 1024) as ws:
            print(f"[发送] {json.dumps(payload, ensure_ascii=False)}", flush=True)
            await ws.send(json.dumps(payload, ensure_ascii=False))
            t0 = time.time()
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=120)
                    print(f"[回传 {time.time()-t0:.1f}s] {msg[:2000]}", flush=True)
                except asyncio.TimeoutError:
                    print(f"[静默 {time.time()-t0:.0f}s，仍在等待…]", flush=True)
    except Exception as e:
        print(f"[错误] {e}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
