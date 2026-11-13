# Changelog

## 0.2.0 — 2026-11-13

第二次大更新：把「只能 eval + JS 点击」升级成「能模拟真人输入、能进跨域 iframe、能开窗口、能处理弹窗与网络」。
每一项都来自真实任务里撞过的墙，不是凭空加功能。

### 新增

- **`edge_mouse`**：真实鼠标事件（`Input.dispatchMouseEvent`）。move / click / drag / wheel，
  给 CSS 选择器自动算元素中心，或直接给视口坐标。`steps` 会先分几步移动过去——有些站点只在
  `mousemove` 之后才挂上处理函数。**实测依据**：某培训平台用 JS `element.click()` 点播放完全无效，
  换成真实鼠标事件才生效。
- **`edge_key`**：真实键盘。`text` 走 `Input.insertText`（能进 React/Vue 受控组件），
  `keys` 走 `Input.dispatchKeyEvent`（Enter/Tab/Escape/方向键/翻页键/Space），`modifiers` 支持组合键。
- **`edge_attach`**：跨域 iframe（OOPIF）。`Target.setAutoAttach({flatten:true})` 拿 sessionId，
  之后 `Runtime.evaluate` 带 sessionId 就能读写子框架 DOM。**补掉了 0.1.0 起就写在「已知限制」里的缺口。**
- **`edge_window`**：开**独立窗口**（`Target.createTarget({newWindow:true})`）。与标签页的区别是实测出来的：
  同一窗口两个标签页，切走的那页 45 秒只前进 5 秒（站点在 `visibilitychange` 时主动 pause）；
  两个独立窗口则能同时推进（A 在 B 获得焦点后仍从 222s 走到 238s，`document.hidden` 保持 false）。
- **`edge_dialog`**：原生对话框（alert/confirm/prompt）。之前弹窗一出现，`edge_eval` 只会报
  `Runtime.evaluate timeout`，看起来像页面卡死。现在能列出并 accept/dismiss。
- **`edge_network`**：Network 域抓包。start/list/body/stop/clear。之前要抓
  `multimedia/log?playingTime=…` 这类上报，只能往页面里注入 XHR hook，脏且容易漏。
- **`edge_wait`**：等选择器出现 / 等 JS 为真，超时返回 `ok:false` 而不是抛异常——替代盲目 sleep。

### 结构

- 底层能力从 `lib/index.js` 拆到 **`lib/cdp.js`**（连接/事件总线/会话池/输入/网络/对话框/等待），
  这样 `scripts/selftest.mjs` 能直接 import 验证，不必绕过 DSH 宿主。
- `CDP` 类补上**事件分发**（`on/emit`）与 **sessionId 透传**——对话框与网络依赖事件；
  0.1.x 的 `send` 只处理带 id 的响应，事件被丢弃。
- `pickPage` 支持 `urlMatch` / `titleMatch` / `index` 三种定位，避免多标签时抓错页。

### 自测（本机 2026-11-13 实测）

- **`scripts/selftest.mjs`**：打真实 Edge，**12 项全绿**——status / pages+pickPage / evalIn /
  frames / attach 后跨域 eval / centerOf / 真实鼠标点击 / 真实键盘输入 / 对话框捕获与确认 /
  网络捕获 / waitFor 命中 / waitFor 超时。
- **`test/register.mjs`**：不起浏览器，用替身 `defineTool` 复刻宿主 schema 编译与子集校验，
  17 个工具定义全部过一遍。存在理由：真实事故里插件「装上了却不激活」就是作者 DSL 原样进了
  `ctx.tools.register`，只测 `execute` 的测试永远发现不了。

### 修复

- 网络状态注册缺 `nets.set(key, state)`：请求抓到了但 `list` 恒为空（自测当场抓到）。
- `pickPage` 之前只认 urlMatch，多标签场景容易抓错页。

### 说明

- **0.1.5 从未发布成功**（npm 的 Trusted Publisher 区块至今不显示），所以 0.2.0 直接跨过它；
  GitHub 上那个空 tag `v0.1.5` 一并作废。

## 0.1.5 — 2026-10-26

### 新增
- **npm 自动发布**：`.github/workflows/publish.yml`，用 npm **Trusted Publishing（OIDC）** 发布——
  不需要 NPM_TOKEN、不需要 2FA 验证码。触发方式：GitHub 发布 Release，或手动 Run workflow。
- 发布带 `--provenance`（来源证明），npm 页面会显示"此包由该仓库的此提交构建"。

### 说明
- 0.1.4 曾在 npm 上留下未完成的半成品记录（元数据在、tarball 不可取），故跳到 **0.1.5** 重新发布。

## 0.1.3 — 2026-10-24

### 新增
- **`edge_mute`**：把当前标签页的音视频静音（递归进同源 iframe，多级 iframe 嵌套的播放器也能静音），并通过
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
