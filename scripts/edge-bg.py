#!/usr/bin/env python3
"""edge-bg.py — 让 Edge/Chromium 页面在窗口最小化或不在前台时仍被视为 visible + focused。

自包含版本：只需要 websocket-client。

    pip install websocket-client
    python edge-bg.py --port 9222 --interval 10

停止：Ctrl+C，或创建 --stop-file 指定的文件。

原理：
  1. 用 CDP 连到已开启 --remote-debugging-port 的浏览器
  2. 发送 Emulation.setFocusEmulationEnabled(true) —— 页面从此认为自己在焦点上
  3. 每 N 秒心跳一次（顺便防止渲染进程被节流）
  4. 发现 <video> 暂停且没播完就自动续播（会递归进入同源 iframe）

启动浏览器时建议加这些参数（否则最小化后定时器会被节流）：

    --remote-debugging-port=9222 --remote-allow-origins=*
    --user-data-dir=<独立目录>
    --disable-background-timer-throttling
    --disable-renderer-backgrounding
    --disable-backgrounding-occluded-windows
    --disable-features=CalculateNativeWinOcclusion
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import websocket


def http_json(port, path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def pick_page(port, url_match=None):
    pages = [t for t in http_json(port, "/json") if t.get("type") == "page"]
    if not pages:
        raise SystemExit("没有可用的页面标签")
    if url_match:
        for p in pages:
            if url_match in (p.get("url") or ""):
                return p
        raise SystemExit("没有 URL 含 %r 的标签" % url_match)
    return pages[0]


class CDP(object):
    def __init__(self, ws_url, timeout=25):
        self.ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
        self.timeout = timeout
        self.i = 0

    def send(self, method, params=None, timeout=None):
        self.i += 1
        mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        end = time.time() + (timeout or self.timeout)
        while time.time() < end:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", "cdp error"))
                return msg.get("result", {})
        raise TimeoutError(method)

    def eval(self, js, user_gesture=True):
        r = self.send("Runtime.evaluate", {
            "expression": js,
            "returnByValue": True,
            "awaitPromise": True,
            "userGesture": user_gesture,
        })
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text") or "js error")
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


# 在自身上下文中定义递归查找器（每次都是新闭包，避免重复声明冲突）
FIND = """
const __find = (doc) => {
  try {
    const v = doc.querySelector('video');
    if (v) return { v, doc };
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        const cd = f.contentDocument;
        if (!cd) continue;
        const r = __find(cd);
        if (r) return r;
      } catch (e) {}
    }
  } catch (e) {}
  return null;
};
"""

PROBE = "(() => {" + FIND + """
  const r = __find(document);
  const v = r ? r.v : null;
  return JSON.stringify({
    hidden: document.hidden,
    vis: document.visibilityState,
    focus: document.hasFocus(),
    title: (document.title || '').slice(0, 60),
    video: v ? { paused: v.paused, t: Math.round(v.currentTime), d: Math.round(v.duration || 0) } : null
  });
})()
"""

PLAY = "(() => {" + FIND + """
  const r = __find(document);
  if (!r) return 'no-video';
  const v = r.v;
  const btn = r.doc.querySelector('.vjs-play-control') || r.doc.querySelector('.vjs-big-play-button')
           || r.doc.querySelector('[class*=play]');
  if (v.paused && (v.duration ? v.currentTime < v.duration - 2 : true)) {
    if (btn) btn.click();
    try { v.play(); } catch (e) {}
    return 'resumed';
  }
  return v.paused ? 'paused-finished' : 'playing';
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--url-match", default=None, help="只监控 URL 含该子串的标签")
    ap.add_argument("--stop-file", default="stop_bg.txt")
    ap.add_argument("--log", default=None, help="日志文件（默认只打印到 stdout）")
    ap.add_argument("--no-autoplay", action="store_true")
    args = ap.parse_args()

    def log(msg):
        line = "%s %s" % (time.strftime("%H:%M:%S"), msg)
        print(line, flush=True)
        if args.log:
            try:
                with open(args.log, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass

    if os.path.exists(args.stop_file):
        os.remove(args.stop_file)

    page = pick_page(args.port, args.url_match)
    cdp = CDP(page["webSocketDebuggerUrl"])
    cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
    log("后台保活已开启 port=%d interval=%ss url=%s" % (args.port, args.interval, (page.get("url") or "")[:80]))

    n = 0
    try:
        while True:
            if os.path.exists(args.stop_file):
                log("检测到 %s，退出" % args.stop_file)
                break
            try:
                info = json.loads(cdp.eval(PROBE) or "{}")
                play = None if args.no_autoplay else cdp.eval(PLAY)
                n += 1
                if n % 3 == 1 or play == "resumed":
                    v = info.get("video")
                    vs = "no-video" if not v else "%d/%ds %s" % (
                        v.get("t", 0), v.get("d", 0), "paused" if v.get("paused") else "playing")
                    log("vis=%s hidden=%s focus=%s video=%s%s" % (
                        info.get("vis"), info.get("hidden"), info.get("focus"), vs,
                        "" if play is None else " play=" + str(play)))
            except Exception as e:
                log("心跳异常: %s（重连）" % e)
                cdp.close()
                time.sleep(3)
                try:
                    page = pick_page(args.port, args.url_match)
                    cdp = CDP(page["webSocketDebuggerUrl"])
                    cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
                    log("已重连并重开焦点模拟")
                except Exception as e2:
                    log("重连失败: %s" % e2)
                    time.sleep(10)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("Ctrl+C，退出")
    finally:
        cdp.close()


if __name__ == "__main__":
    main()
