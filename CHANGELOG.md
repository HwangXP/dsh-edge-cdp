# Changelog

## 0.1.0 — 2026-10-23

首个版本。由 DeepSeek Harness 的 `deepseek-flash` 智能体在真实任务中编写并实测。

### 新增

- **CDP 直连**：Node 内置 `WebSocket` 直连 `--remote-debugging-port`，不依赖浏览器扩展、Playwright 或任何额外下载。
- **工具集**：`edge_status` / `edge_launch` / `edge_tabs` / `edge_nav` / `edge_eval` / `edge_click` / `edge_type` / `edge_screenshot` / `edge_background_mode`。
- **持久 CDP 会话**：同一标签页复用连接，`Emulation` 类设置不再随调用丢失。
- **后台模式 `edge_background_mode`**：长连接 + `Emulation.setFocusEmulationEnabled` + 心跳，窗口最小化时页面仍报告 `visible` + `focused`。
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
