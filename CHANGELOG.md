# Changelog

## 0.1.3 — 2026-10-24

### 新增
- **`edge_mute`**：把当前标签页的音视频静音（递归进同源 iframe，超星那类两层嵌套播放器也能静音），并通过
  `Page.addScriptToEvaluateOnNewDocument` 注册到**每个新文档**——之后导航到新页面依然自动静音。
  实现细节：重写 `HTMLMediaElement.prototype.play`，任何音视频一播放就强制 `muted = true, volume = 0`，
  再加 `DOMContentLoaded` 与 1.5s 定时兜底扫描。

## 0.1.2 — 2026-10-24

### 修复
- **`edge_background_mode` 在页面导航后失效**：CDP 的 `Emulation` 设置是按 target/session 的，导航会换
  target，焦点模拟随之丢失。现在**每次心跳都重贴**一次 `Emulation.setFocusEmulationEnabled`。

### 实测
最小化窗口下连放 3 分钟，视频进度 `207 → 307 → 481 / 483`，页面始终 `hidden=false, visibility=visible, hasFocus=true`。

## 0.1.1 — 2026-10-24

### 新增
- **持久 CDP 会话**：同一标签页复用同一条 WebSocket（`sessions` 缓存），`Emulation` 类设置不再随调用丢失；
  连接失效（超时/关闭）时自动丢弃缓存重建。

## 0.1.0 — 2026-10-23

首个版本。由 DeepSeek Harness 的 `deepseek-flash` 智能体在真实任务中编写并实测。

### 新增
- **CDP 直连**：Node 内置 `WebSocket` 直连 `--remote-debugging-port`，不依赖浏览器扩展、Playwright 或任何额外下载。
- **工具集**：`edge_status` / `edge_launch` / `edge_tabs` / `edge_nav` / `edge_eval` / `edge_click` / `edge_type` / `edge_screenshot` / `edge_background_mode`。
- **后台模式**：长连接 + `Emulation.setFocusEmulationEnabled` + 心跳，窗口最小化时页面仍报告 `visible` + `focused`。
- **独立 Python 保活脚本** `scripts/edge-bg.py`：不装插件也能用；递归钻进同源 iframe 找 `<video>` 并自动续播。
- **抗节流启动参数**：`--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`、`--disable-features=CalculateNativeWinOcclusion`。

### 实测数据

Edge 155.0.4283.62，窗口最小化后：

| 时刻 | `document.hidden` | `visibilityState` | `hasFocus()` | 视频进度 |
|---|---|---|---|---|
| 前台 | false | visible | true | 4 / 483 s |
| 最小化 30 s | false | visible | true | 42 / 483 s |
| 最小化 ~5 min | false | visible | true | 307 / 483 s |

### 已知限制

- 仅 Chromium 系浏览器。
- 跨域 iframe 内的 `<video>` 取不到（需要 `Target.attachToTarget`，未实现）。
- 目标站点若用桌面客户端并检查真实前台窗口，本方案无效。
