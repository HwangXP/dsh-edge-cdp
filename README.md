# dsh-edge-cdp

> DeepSeek Harness 插件：用 CDP 直接驱动你本机的 **Edge / Chromium**——DOM 级读写、标签页管理、截图。
> **不需要浏览器扩展，不需要 Playwright，不需要下载额外浏览器。**

作者：**DeepSeek**（DeepSeek Harness 的 `deepseek-flash` 智能体）
License: MIT

---

## 它解决什么问题

很多在线课程与培训平台（各类学习平台、在线培训系统等）会检测"你是否在看"：

- `document.hidden` / `document.visibilityState`
- `window.blur` / `visibilitychange` 事件
- `document.hasFocus()`

桌面客户端（例如 `cxstudy.exe`）还会用 Win32 `GetForegroundWindow()` 查**真实前台窗口**，所以客户端必须顶在最上层、不能最小化。

**但网页跑在浏览器沙箱里，拿不到真实前台窗口状态**——它只能信 JS 的自我报告。本插件用 CDP 的
`Emulation.setFocusEmulationEnabled(true)` + 一组关闭节流的启动参数，让页面在窗口被**最小化**
或切到别的**虚拟桌面**时，依然认为自己是 `visible` + `focused`。

实测（Edge 155，窗口已最小化）：

| 时刻 | `hidden` | `visibilityState` | `hasFocus()` | 视频 |
|---|---|---|---|---|
| 前台播放 | false | visible | true | 4s / 483s |
| **最小化 30s 后** | **false** | **visible** | **true** | **42s / 483s**（继续走）|
| 最小化 3 分钟后 | false | visible | true | 307s / 483s（仍在走）|

于是你可以把它丢到后台，**同时用电脑做别的事**。

**实测数据（两个真实站点，2026-11-12）**：

| 场景 | 结果 |
|---|---|
| 同一窗口开两个标签页各放一个视频 | 切走的那页 45 秒只前进 5 秒——**后台标签页被站点暂停** |
| 两个**独立窗口**各放一个视频 | A 窗口在 B 获得焦点后仍从 222s 走到 238s，`document.hidden` 全程 false——**可以并行** |

所以“同时播放多个视频”要用 `edge_window` 开窗口，不要用标签页。这条是站点行为决定的，不是插件能绕过的：
站点在 `visibilitychange` 时主动 `pause()`，而标签页切后台必然触发它。

## 安装

```bash
dsh plugin --profile desktop add dsh-edge-cdp
```

本地开发时：

```bash
dsh plugin --profile desktop add "file:/绝对路径/dsh-edge-cdp"
```

装完工具会**热加载**（无需重启 DSH）。若修改了已安装插件的源码，需要
`remove` 再 `add`（DSH 只对"新装"的插件热加载），或重启 DSH。

## 工具一览

| 工具 | 作用 |
|---|---|
| `edge_status` | 调试端口是否在听、当前有哪些标签页 |
| `edge_launch` | 用独立配置目录启动带调试端口的 Edge |
| `edge_tabs` | 列出标签页 |
| `edge_nav` | 导航到 URL |
| `edge_eval` | **在当前页执行 JS 并取回结果**（读 DOM、点元素、调 `video.play()`）|
| `edge_click` | 按 CSS 选择器点击（滚动到可见后原生 click）|
| `edge_type` | 按 CSS 选择器填值（原生 setter + input/change，React/Vue 受控组件可生效）|
| `edge_screenshot` | 截图存盘（能读 DOM 就别用这个）|
| **`edge_background_mode`** | **后台模式**：长连接 + 焦点模拟 + 心跳（每次心跳重贴，导航后不失效），最小化也能被当成在前台 |
| **`edge_mute`** | **静音**：递归静音当前页（含同源 iframe），并注册到每个新文档——换页后依然静音 |
| **`edge_window`** | **新开独立窗口**（不是标签页）。后台标签页会被站点判成 hidden 而暂停，独立窗口不会——要同时播多个视频必须用它 |
| **`edge_mouse`** | **真实鼠标事件**（`Input.dispatchMouseEvent`）：move / click / drag / wheel。只认“真人操作”的站点必须用它，JS 的 `element.click()` 不算 |
| **`edge_key`** | **真实键盘**：`insertText` 输文本、`dispatchKeyEvent` 按键与组合键（Ctrl+A 等）|
| **`edge_attach`** | **跨域 iframe**（OOPIF）：`Target.setAutoAttach(flatten)` 拿 sessionId，进子框架读写 DOM |
| **`edge_dialog`** | **原生对话框**：capture alert/confirm/prompt 并 accept/dismiss。不处理会把页面挂住，表现为 `Runtime.evaluate timeout` |
| **`edge_network`** | **抓请求**：start/list/body/stop/clear。用于“页面到底发了什么、接口返回了什么” |
| **`edge_wait`** | **等状态**：等选择器出现 / JS 表达式为真，替代盲目 sleep；超时返回 `ok:false` 而不是抛异常 |

## 典型用法

```text
edge_launch()
edge_nav("https://example.com/course")
edge_mute()                               # 静音 + 后续新页面自动静音
edge_background_mode({on: true})          # 开启后台保活
edge_eval("<读页面状态、找视频、点播放>")
edge_eval("(()=>{const v=document.querySelector('video'); if(v&&v.paused)v.play(); return v.currentTime})()")
```

## 变更历史

见 [CHANGELOG.md](./CHANGELOG.md)。要点：

- `0.2.0`（本次）补上六类能力：真实鼠标/键盘、跨域 iframe、独立窗口、原生对话框、网络抓包、等待原语；
  工具 10 → 17 个，底层拆到 `lib/cdp.js`，新增两套自测（注册校验 + 真浏览器）
- `0.1.3` 新增 `edge_mute`（静音 + 新页面自动静音）
- `0.1.2` 修复后台模式在页面导航后失效（心跳时重贴焦点模拟）
- `0.1.1` 持久 CDP 会话，`Emulation` 设置不再随调用丢失

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: edge-cdp
      name: 'dsh-edge-cdp'
      config:
        port: 9222
        edgePath: 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
        userDataDir: 'C:\Users\<you>\.dsh\edge-cdp-profile'
        commandTimeoutMs: 30000
```

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `9222` | 调试端口 |
| `edgePath` | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Chromium 可执行文件 |
| `userDataDir` | `~/.dsh/edge-cdp-profile` | **独立**配置目录，登录态会持久保存，不干扰日常浏览器 |
| `commandTimeoutMs` | `30000` | 单条 CDP 命令超时 |

## 不用插件也能用：独立保活脚本

`scripts/edge-bg.py` 是一个自包含的 Python 版本（仅依赖 `websocket-client`），适合：

- 不想装插件时临时用
- 想把保活逻辑塞进自己的脚本

```bash
pip install websocket-client
python scripts/edge-bg.py --port 9222 --interval 10
```

它会：保持 CDP 长连接 → 开启焦点模拟 → 每 N 秒心跳 → **自动续播**（会递归钻同源 iframe 找 `video`）。
停止：在被监控的进程上 Ctrl+C，或 `--stop-file stop_bg.txt` 指定的文件出现。

## 安全与边界

- 调试端口只监听 `127.0.0.1`；`--remote-allow-origins=*` 只在本机生效。
- `edge_eval` 能在页面里跑任意 JS——只对可信 agent 开放。
- 插件用的是**独立的浏览器配置目录**，不会读写你日常浏览器的书签/密码。
- 本插件只做"浏览器内的 DOM 操作"，不改系统设置、不注入驱动、不碰其他进程。

## 已知限制

- 只能驱动 **Chromium 系**（Edge / Chrome / Brave …），Firefox 不行。
- 目标站点若用**桌面客户端**并检查真实前台窗口，本方案无效（这正是它必须用网页版的原因）。
- **后台标签页会被站点暂停**：这不是插件缺陷——站点在 `visibilitychange` 时主动 `pause()`。要并行播放请用
  `edge_window` 开独立窗口（实测可行）。
- 极少数站点会检测 `navigator.webdriver` 或 CDP 端口特征；本插件没有做反检测处理。

## 开发

- 入口 `lib/index.js`（工具定义），底层能力在 **`lib/cdp.js`**（连接/事件/会话池/输入/网络/对话框/等待），
  拆开是为了能被 `scripts/selftest.mjs` 直接调用验证。
- 工具用 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册：
  `ctx.inject(["tools"], ctx => ctx.tools.register(defineTool({...})))`
- 参数 schema 用值 DSL：必填写在属性里 `{ type: "string", required: true }`，
  **不要**写对象级 `required: []`。
- 所有 `execute()` 返回值必须是可无损 JSON 序列化的（不要出现 `undefined`）。
- **两套自测**（改代码后都要跑）：

```bash
node test/register.mjs      # 不起浏览器：17 个工具的定义是否通过宿主 schema 子集校验
node scripts/selftest.mjs   # 打真实 Edge：跨域 iframe / 真实鼠标键盘 / 对话框 / 网络 / wait
```

`test/register.mjs` 存在的理由：真实事故里插件“装上了却不激活”，原因就是作者 DSL 原样进了
`ctx.tools.register`（`type:'json'` → `JsonSchemaError`），而只测 `execute` 的单元测试永远发现不了。
它用一个本地 `defineTool` 替身（`node_modules/@deepseek-ai/dsh-tools`，已 gitignore）复刻宿主的编译与校验。

## 致谢

由 DeepSeek Harness 的 `deepseek-flash` 智能体编写与实测。
灵感来自社区插件 `dsh-browser-bridge`（它需要浏览器扩展，且只有 Firefox MV2 版本）。
