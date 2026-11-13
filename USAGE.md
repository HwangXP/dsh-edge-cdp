# 使用说明（Recipes）

这里按「你想干什么」组织，不讲工具参数（那看 README）。所有例子都在本机实测过。

## 0. 先分清三种用法

| 你想干的事 | 用哪个 | 特点 |
|---|---|---|
| 点一下、读一段 DOM、截个图 | `edge_eval` / `edge_click` / `edge_screenshot` … | 一次一个动作，agent 主导 |
| **让一段长媒体自己播完，中途别停** | `edge_keep_playing` | 插件内定时器，调一次就一直盯 |
| **让一串页面自己一个接一个播完** | `edge_autoplay` | 自己找下一个、播完自己切、队列空自停 |

后两种是「调用一次、它自己跑几小时」的模式。前一种是「调用一次、做一件事」。

## 1. 起手三件事

```text
edge_launch()                          # 用独立配置目录起一个带调试端口的 Edge
edge_nav({url: "<目标页面>"})
edge_status()                          # 确认 running / 端口 / 标签页
```

调试端口默认 `9222`，配置目录 `~/.dsh/edge-cdp-profile`（独立，不碰你日常浏览器）。

## 2. 让一段长媒体自己播完

适合「一个页面里就一段长视频，中途会被暂停或卡住」的场景。

```text
edge_mute()                                              # 静音，新页面也自动静音
edge_keep_playing({op: "start", targets: "<URL 子串>"})   # 开始守护
edge_keep_playing({op: "status"})                        # 看心跳 / 续播次数 / 最近日志
edge_keep_playing({op: "stop"})
```

它的行为：

- 每 `everyMs`（默认 4 秒）检查一次页面里的 `<video>`，暂停就 `play()`
- `currentTime` 连续 `stallTicks`（默认 3）次不前进 → 判卡死 → 自动重载页面
- `maxMinutes` 可到点自停

## 3. 让一串页面自己播完

适合「有一个列表页，上面挂着一串待看的条目，看完一条要点下一条」的场景
（视频合集、播放列表、章节式的培训材料都属于这一类）。

```text
edge_autoplay({
  op: "start",
  listMatch: "<列表页 URL 子串>",
  nextJs: "<在列表页上求值，返回 {'{'}url,title{'}'} 或 null>",
  everyMs: 5000
})
```

工作方式：

1. 每隔 `everyMs` 在**列表页**上执行一次 `nextJs`；
2. 拿到 `{url,title}` 就打开它（自动选/自动开一个工作标签页）并播放；
3. **页内所有视频都播完**（或 `ended`）才算这一条完成，清空条目，下一拍继续找下一条；
4. `nextJs` 返回 `null` → 自己停，`lastReason = 队列空`；
5. 页面里没有视频时，如果设了 `dwellSec` 就地停留够秒数；没设则 25 秒后记一次失败并**跳过**。

### 三种页面形态怎么配

| 形态 | 配法 |
|---|---|
| 一页一个视频 | 默认，什么都不用加 |
| **一页多个视频** | 默认支持——全部播完才算完成 |
| **文档 / PPT 类（没有 `<video>`）** | `dwellSec: 30`（秒），`dwellScroll` 默认边停边往下滚 |
| **SPA：点「下一节」不换 URL** | 改用 `advanceJs`（见下） |

文档类只能「停够时间」——它的完成条件本来就是你看了多久，插件不会假装瞬间读完。

### SPA：URL 不变怎么推进

有的站点换了内容但 URL 一个字都不变，`nextJs` 给不出新地址。这时用 `advanceJs`：

```text
edge_autoplay({
  op: "start",
  advanceJs: "(() => { const b = document.querySelector('#next'); if (!b || b.disabled) return 'null'; b.click(); return b.disabled ? 'null' : 'true'; })()",
  everyMs: 5000
})
```

规则很简单：**返回真值 = 已进入下一节；返回 `null`/`false` = 队列结束**。
只给 `advanceJs`、不给 `nextJs` 时，从当前页开始播。

`nextJs` 可以返回 Promise（内部会 await），所以查接口也行：

```js
(async () => JSON.stringify(await (await fetch('/api/next')).json()))()
```

**插件不内置任何站点的解析规则**——「下一个是谁」完全由你写的 `nextJs` 决定。
这既是它的边界，也是它的通用性来源。

一个最小的 `nextJs` 长这样（在列表页里挑一个还没打勾的条目）：

```js
(() => {
  const items = [...document.querySelectorAll('<entry 选择器>')];
  const next = items.find(a => a.querySelector('<未完成标记选择器>'));
  return next ? JSON.stringify({ url: next.href, title: next.textContent.trim() }) : 'null';
})()
```

把两个选择器换成你那个页面的即可，这也是这类站点最常见的形态：
**列表页上有若干条目，每条带一个「未完成」标记。**

## 4. 多个窗口并行

先明确一件事：**后台标签页会被页面自己暂停**（不是插件的问题）。

实测：同一个窗口开两个标签页各放一段视频，切走的那页 45 秒只前进 5 秒；
两个**独立窗口**则能同时推进。所以并行要用窗口：

```text
edge_window({url: "<页面 A>"})
edge_window({url: "<页面 B>"})
edge_tab({op: "activate"})       # 新窗口默认在后台，有些播放器在后台根本不初始化
edge_keep_playing({op: "start", targets: "<A 的 URL 子串>", key: "a"})
edge_keep_playing({op: "start", targets: "<B 的 URL 子串>", key: "b"})
```

⚠️ **`edge_autoplay` 目前只适合单队列**：它选工作页的规则是「第一个不是列表页的页面」，
同时启多个队列会抢同一个工作页。多路并行请用 `keep_playing`，或者一次跑一路。

## 5. 卡住的常见原因（排查表）

| 现象 | 原因 | 解法 |
|---|---|---|
| `Runtime.evaluate timeout` | 页面弹了原生对话框（alert/confirm），把渲染进程挂住了 | `edge_dialog({op: "accept"})` |
| 视频不动，`paused: true` | 后台标签页被站点 `pause()` | 用 `edge_window` 开独立窗口 |
| 新窗口一片空白 | 窗口开在后台，播放器没初始化 | `edge_tab({op: "activate"})` |
| `edge_video` 找不到视频 | 视频在跨域 iframe 里 | `edge_attach({op: "list"})` + `op: "eval"` |
| `edge_eval` 读不到 iframe 内容 | 同源/跨域搞混了 | 同源用 `edge_frames`，跨域用 `edge_attach` |
| `edge_network` 列表是空的 | 没先 `op: "start"` | 先 `start`，再触发请求，再 `list` |
| 页面元素点不动 | 站点只认真实输入 | `edge_mouse({op: "click", selector})` 而不是 `edge_click` |

## 6. 边界与责任

- 本插件只提供**浏览器能力**（读 DOM、发真实输入、控媒体、抓请求）。它不内置任何站点的解析规则，
  也不包含任何绕过检测、伪造观看、破解计时的代码。
- 页面自己会因为失焦而暂停、站点可能检测自动化特征——这些是环境事实，不是 bug。检测到会怎样，
  取决于目标站点的条款，**由使用者自己判断并承担**。
- 调试端口只监听 `127.0.0.1`；用的是独立配置目录，不读你日常浏览器的书签和密码。
- `edge_eval` 能在页面里跑任意 JS —— 只对可信的 agent 开放。

**一句话**：它把「浏览器能被程序驱动」这件事做完整了；至于用它做什么，取决于你。
