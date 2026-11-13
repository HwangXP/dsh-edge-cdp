// dsh-edge-cdp — drive the user's real Edge/Chromium over CDP.
//
// No browser extension, no Playwright download: it launches (or attaches to)
// an Edge instance with --remote-debugging-port and talks CDP over Node's
// built-in WebSocket.
//
// Register in the profile's cordis.patch.yml:
//   - insert:
//       - id: edge-cdp
//         name: 'dsh-edge-cdp'

import { writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	DEFAULT_EDGE,
	DEFAULT_PROFILE,
	httpJson,
	isUp,
	launch as launchRaw,
	pages as pagesRaw,
	pickPage,
	withPage as withPageRaw,
	frames,
	evalIn,
	centerOf,
	mouseClick,
	mouseDrag,
	mouseMove,
	wheel,
	pressKey,
	typeText,
	watchDialogs,
	dialogState,
	handleDialog,
	startNetwork,
	listNetwork,
	responseBody,
	stopNetwork,
	clearNetwork,
	waitFor,
	openTab,
	closeTarget,
	activateTarget,
	bringToFront,
	collectVideos,
	controlVideo,
	listFrames,
	evalInFrame,
	getCookies,
	setCookie,
	clearCookies,
	download,
	startGuard,
	stopGuard,
	guardStatus,
	startAutoplay,
	stopAutoplay,
	autoplayStatus,
} from "./cdp.js";

const name = "edge-cdp";
const inject = ["tools"];

const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };

/** 现有工具沿用的两个短名：底层实现已搬到 lib/cdp.js（可被 scripts/selftest.mjs 直接测）。 */
const pages = (c) => pagesRaw(c.port);
const withPage = (c, urlMatch, fn) => withPageRaw(c.port, c.timeoutMs, urlMatch ? { urlMatch } : {}, fn);
const launch = (c) => launchRaw(c);

function cfg(config) {
	return {
		port: config?.port ?? 9222,
		edgePath: config?.edgePath ?? DEFAULT_EDGE,
		profileDir: config?.userDataDir ?? DEFAULT_PROFILE,
		timeoutMs: config?.commandTimeoutMs ?? 30000,
	};
}

// —— 连接 / 会话 / 输入 / 网络 / 对话框 / 等待 的底层实现都在 lib/cdp.js ——
// 这里只保留上面几个短名适配器，工具定义里继续沿用旧写法。

// 后台模式心跳：保持 CDP 会话 + 防止渲染进程被节流。
const bgTimers = new Map();

function startBackground(c, urlMatch, everyMs) {
	const key = urlMatch ?? "*";
	if (bgTimers.has(key)) return { already: true };
	const timer = setInterval(async () => {
		try {
			// 每次心跳都重贴焦点模拟：页面导航后 target/session 会变，设置不会自动保留
			await withPage(c, urlMatch, async (cdp) => {
				await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
				await cdp.send("Runtime.evaluate", {
					expression: "document.visibilityState",
					returnByValue: true,
				});
			});
		} catch {
			/* 下次心跳自愈 */
		}
	}, everyMs);
	if (timer.unref) timer.unref();
	bgTimers.set(key, timer);
	return { already: false, everyMs };
}

function stopBackground(urlMatch) {
	const key = urlMatch ?? "*";
	const t = bgTimers.get(key);
	if (!t) return false;
	clearInterval(t);
	bgTimers.delete(key);
	return true;
}

async function evalJs(c, js, urlMatch, awaitPromise = true) {
	return await withPage(c, urlMatch, async (cdp) => {
		const r = await cdp.send("Runtime.evaluate", {
			expression: js,
			returnByValue: true,
			awaitPromise,
		});
		if (r.exceptionDetails) {
			const d = r.exceptionDetails;
			throw new Error(d.exception?.description ?? d.text ?? "JS exception");
		}
		return r.result?.value ?? null;
	});
}

function genericCard(title, rawInput) {
	return { card: "generic", title, kind: "other", rawInput };
}

// 注入到每个新文档：所有 media 一出生就静音（含同源 iframe）
const MUTE_JS = `
(() => {
  const muteAll = (root) => {
    try {
      root.querySelectorAll && root.querySelectorAll('video,audio').forEach(m => {
        try { m.muted = true; m.volume = 0; } catch (e) {}
      });
    } catch (e) {}
    try {
      root.querySelectorAll && root.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) muteAll(f.contentDocument); } catch (e) {}
      });
    } catch (e) {}
  };
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { this.muted = true; this.volume = 0; } catch (e) {}
      return origPlay.apply(this, arguments);
    };
    document.addEventListener('DOMContentLoaded', () => muteAll(document));
    setInterval(() => muteAll(document), 1500);
  } catch (e) {}
})();
`;

const MUTE_NOW_JS = `
(() => {
  let n = 0;
  const walk = (doc) => {
    try {
      doc.querySelectorAll('video,audio').forEach(m => {
        try { m.muted = true; m.volume = 0; n++; } catch (e) {}
      });
      doc.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) walk(f.contentDocument); } catch (e) {}
      });
    } catch (e) {}
  };
  walk(document);
  return n;
})()
`;

async function mutePage(c, urlMatch) {
	return await withPage(c, urlMatch, async (cdp) => {
		try {
			await cdp.send("Page.enable");
		} catch {
			/* ignore */
		}
		let installed = true;
		try {
			await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MUTE_JS });
		} catch {
			installed = false;
		}
		const r = await cdp.send("Runtime.evaluate", {
			expression: MUTE_NOW_JS,
			returnByValue: true,
		});
		return { installed, muted: Number(r.result?.value ?? 0) };
	});
}

/** @type {(ctx: any, config: any) => void} */
function apply(ctx, config) {
	const c = cfg(config);

	ctx.inject(["tools"], (toolsCtx) => {
		const reg = (tool) => toolsCtx.tools.register(defineTool(tool));

		reg({
			name: "edge_status",
			description:
				"检查自动化 Edge 是否已启动（调试端口是否在监听）以及当前打开了哪些标签页。任何 Edge 操作前先调用它。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						running: { ...bool, required: true },
						port: { ...int, required: true },
						profileDir: { ...str, required: true },
						browser: str,
						tabs: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: { id: str, title: str, url: str },
							},
						},
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text: v.running
							? `Edge CDP 已连接（端口 ${v.port}，${v.tabs.length} 个标签页）${v.browser ? ` · ${v.browser}` : ""}`
							: `Edge CDP 未启动（端口 ${v.port}）。先调用 edge_launch。`,
					},
				],
			},
			presentCall: (args) => genericCard("检查 Edge CDP 状态", args),
			execute: async () => {
				const running = await isUp(c.port);
				let browser = "";
				let tabs = [];
				if (running) {
					try {
						const ver = await httpJson(c.port, "/json/version");
						browser = ver.Browser ?? "";
					} catch {
						/* ignore */
					}
					try {
						tabs = (await pages(c)).map((p) => ({ id: p.id, title: p.title, url: p.url }));
					} catch {
						/* ignore */
					}
				}
				return { running, port: c.port, profileDir: c.profileDir, browser, tabs };
			},
		});

		reg({
			name: "edge_launch",
			description:
				"启动一个带远程调试端口的 Edge（使用独立配置目录，不干扰用户日常 Edge）。启动后可用 edge_nav / edge_eval 操作任意网页。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						alreadyRunning: { ...bool, required: true },
						port: int,
					},
				},
				render: (_a, v) => [
					{ type: "text", text: v.alreadyRunning ? "Edge CDP 已在运行" : `已启动 Edge CDP（端口 ${v.port}）` },
				],
			},
			presentCall: (args) => genericCard("启动 Edge CDP", args),
			execute: async () => await launch(c),
		});

		reg({
			name: "edge_tabs",
			description: "列出自动化 Edge 的所有标签页（id / 标题 / URL）。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						tabs: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: { id: str, title: str, url: str },
							},
						},
					},
				},
				render: (_a, v) => [
					{ type: "text", text: v.tabs.map((t, i) => `${i + 1}. ${t.title || "(无标题)"} — ${t.url}`).join("\n") || "(无标签页)" },
				],
			},
			presentCall: (args) => genericCard("列出标签页", args),
			execute: async () => ({
				tabs: (await pages(c)).map((p) => ({ id: p.id, title: p.title, url: p.url })),
			}),
		});

		reg({
			name: "edge_nav",
			description: "让自动化 Edge 导航到指定 URL（可指定 urlMatch 选择哪个标签页，否则用第一个）。",
			parameters: {
				url: { ...str, required: true, description: "目标 URL" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { ...bool, required: true }, url: { ...str, required: true } },
				},
				render: (_a, v) => [{ type: "text", text: `已导航到 ${v.url}` }],
			},
			presentCall: (args) => genericCard("导航", args),
			execute: async (args) => {
				await launch(c);
				await withPage(c, args.urlMatch, async (cdp) => {
					await cdp.send("Page.enable");
					await cdp.send("Page.navigate", { url: args.url });
				});
				await new Promise((r) => setTimeout(r, 1500));
				return { ok: true, url: args.url };
			},
		});

		reg({
			name: "edge_eval",
			description:
				"在自动化 Edge 的当前页面里执行 JavaScript 并返回结果（DOM 级读写：读任务点状态、读题干、点选项、调 video.play() 等）。返回值必须是可 JSON 序列化的。",
			parameters: {
				expression: { ...str, required: true, description: "要执行的 JS 表达式（可用 await）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { value: { type: "object", additionalProperties: true, properties: {} }, json: { ...str, required: true } },
				},
				render: (_a, v) => [{ type: "text", text: v.json.slice(0, 4000) }],
			},
			presentCall: (args) => genericCard("执行 JS", args),
			execute: async (args) => {
				const value = await evalJs(c, args.expression, args.urlMatch);
				let json;
				try {
					json = JSON.stringify(value);
				} catch {
					json = String(value);
				}
				if (json === undefined) json = "null";
				return {
					...(value !== null && typeof value === "object" ? { value } : {}),
					json: json.slice(0, 200000),
				};
			},
		});

		reg({
			name: "edge_click",
			description: "按 CSS 选择器点击一个元素（滚动到可见后原生 click）。找不到元素会报错。",
			parameters: {
				selector: { ...str, required: true, description: "CSS 选择器" },
				index: { ...int, description: "匹配多个时取第几个（0 起，默认 0）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { ...bool, required: true }, matched: { ...int, required: true } },
				},
				render: (_a, v) => [{ type: "text", text: `已点击（匹配 ${v.matched} 个）` }],
			},
			presentCall: (args) => genericCard("点击元素", args),
			execute: async (args) => {
				const i = args.index ?? 0;
				const sel = JSON.stringify(args.selector);
				const js = `(() => {
					const els = document.querySelectorAll(${sel});
					if (!els.length) throw new Error("选择器无匹配: " + ${sel});
					const el = els[${i}];
					if (!el) throw new Error("索引越界: " + ${i});
					el.scrollIntoView({block:"center"});
					el.click();
					return els.length;
				})()`;
				const matched = await evalJs(c, js, args.urlMatch);
				return { ok: true, matched: Number(matched) || 0 };
			},
		});

		reg({
			name: "edge_type",
			description: "按 CSS 选择器给输入框填值（用原生 setter + input/change 事件，React/Vue 受控组件也能生效）。",
			parameters: {
				selector: { ...str, required: true, description: "CSS 选择器" },
				text: { ...str, required: true, description: "要填入的文本" },
				index: { ...int, description: "匹配多个时取第几个（0 起，默认 0）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { ...bool, required: true }, value: { ...str, required: true } },
				},
				render: (_a, v) => [{ type: "text", text: `已填入：${v.value.slice(0, 200)}` }],
			},
			presentCall: (args) => genericCard("填写输入框", args),
			execute: async (args) => {
				const i = args.index ?? 0;
				const sel = JSON.stringify(args.selector);
				const val = JSON.stringify(args.text);
				const js = `(() => {
					const els = document.querySelectorAll(${sel});
					if (!els.length) throw new Error("选择器无匹配: " + ${sel});
					const el = els[${i}];
					if (!el) throw new Error("索引越界: " + ${i});
					const v = ${val};
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
						: el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
					const desc = Object.getOwnPropertyDescriptor(proto, "value");
					el.focus();
					if (desc && desc.set) desc.set.call(el, v); else el.value = v;
					el.dispatchEvent(new Event("input", {bubbles:true}));
					el.dispatchEvent(new Event("change", {bubbles:true}));
					return el.value;
				})()`;
				const value = await evalJs(c, js, args.urlMatch);
				return { ok: true, value: String(value ?? "") };
			},
		});

		reg({
			name: "edge_screenshot",
			description: "把自动化 Edge 当前页面截图存成 PNG 文件（返回路径）。只在需要看图时用，读 DOM 优先用 edge_eval。",
			parameters: {
				path: { ...str, required: true, description: "保存的绝对路径（.png）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { ...bool, required: true }, path: { ...str, required: true } },
				},
				render: (_a, v) => [{ type: "text", text: `截图已保存: ${v.path}` }],
			},
			presentCall: (args) => genericCard("页面截图", args),
			execute: async (args) => {
				const b64 = await withPage(c, args.urlMatch, async (cdp) => {
					await cdp.send("Page.enable");
					const r = await cdp.send("Page.captureScreenshot", { format: "png" });
					return r.data;
				});
				writeFileSync(args.path, Buffer.from(b64, "base64"));
				return { ok: true, path: args.path };
			},
		});

		reg({
			name: "edge_mute",
			description:
				"把当前标签页的音视频静音（含同源 iframe 内嵌播放器），并注册到每个新页面上——之后导航到新页面也会自动静音。适合长时间播放或无人值守的自动化场景。",
			parameters: {
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						muted: { ...int, required: true },
						futurePages: { ...bool, required: true },
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text: `已静音 ${v.muted} 个音视频元素${v.futurePages ? "；后续新页面也会自动静音" : "（新页面自动静音注册失败）"}`,
					},
				],
			},
			presentCall: (args) => genericCard("标签页静音", args),
			execute: async (args) => {
				const r = await mutePage(c, args.urlMatch);
				return { ok: true, muted: r.muted, futurePages: r.installed };
			},
		});

		reg({
			name: "edge_background_mode",
			description:
				"后台模式：开启后保持 CDP 长连接 + 焦点模拟 + 心跳，让页面在窗口被最小化/切到别的虚拟桌面时仍然认为自己是 visible + focused，视频不会被判定为离开。用于长任务放后台。",
			parameters: {
				on: { ...bool, required: true, description: "true 开启，false 关闭" },
				everyMs: { ...int, description: "心跳间隔毫秒，默认 20000" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						background: { ...bool, required: true },
						focused: { ...bool, required: true },
						visibility: { ...str, required: true },
						everyMs: { ...int, required: true },
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text: v.background
							? `后台模式已开启（心跳 ${Math.round(v.everyMs / 1000)}s）· visibility=${v.visibility} · hasFocus=${v.focused}`
							: `后台模式已关闭 · visibility=${v.visibility}`,
					},
				],
			},
			presentCall: (args) => genericCard("后台模式", args),
			execute: async (args) => {
				const everyMs = args.everyMs ?? 20000;
				if (args.on) {
					await launch(c);
					await withPage(c, args.urlMatch, async (cdp) => {
						await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
					});
					startBackground(c, args.urlMatch, everyMs);
				} else {
					stopBackground(args.urlMatch);
					await withPage(c, args.urlMatch, async (cdp) => {
						await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
					});
				}
				const state = await evalJs(
					c,
					"JSON.stringify({v:document.visibilityState,f:document.hasFocus()})",
					args.urlMatch,
					false,
				);
				let parsed = {};
				try {
					parsed = JSON.parse(String(state ?? "{}"));
				} catch {
					parsed = {};
				}
				return {
					ok: true,
					background: Boolean(args.on),
					focused: Boolean(parsed.f),
					visibility: String(parsed.v ?? "unknown"),
					everyMs,
				};
			},
		});

		// ---------------- 0.2.0：真实输入 / 跨域 iframe / 窗口 / 对话框 / 网络 / 等待 ----------------

		reg({
			name: "edge_window",
			description:
				"新开一个独立的浏览器**窗口**（不是标签页）。区别很关键：后台标签页会被站点判定为 hidden 而暂停播放/计时，独立窗口只要不最小化就一直是 visible——实测同一站点两个标签页会互相暂停，两个窗口才能同时播放。",
			parameters: {
				url: { ...str, required: true, description: "窗口打开的 URL" },
				width: { ...int, description: "窗口宽（像素），默认 900" },
				height: { ...int, description: "窗口高（像素），默认 700" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						targetId: { ...str, required: true },
						url: { ...str, required: true },
						totalPages: { ...int, required: true },
					},
				},
				render: (_a, v) => [{ type: "text", text: `已开新窗口（${v.url}）· 当前共 ${v.totalPages} 个页面` }],
			},
			presentCall: (args) => genericCard("新开浏览器窗口", args),
			execute: async (args) => {
				await launch(c);
				const r = await withPage(c, null, async (cdp) =>
					await cdp.send("Target.createTarget", {
						url: args.url,
						newWindow: true,
						width: args.width ?? 900,
						height: args.height ?? 700,
					}),
				);
				await new Promise((r2) => setTimeout(r2, 1200));
				const list = await pages(c);
				return { ok: true, targetId: String(r.targetId ?? ""), url: args.url, totalPages: list.length };
			},
		});

		reg({
			name: "edge_dialog",
			description:
				"处理页面弹出的原生对话框（alert / confirm / prompt）。不处理时页面会被挂住，后续 edge_eval 只会报 Runtime.evaluate timeout——这是最常见的『卡住』原因。op=list 看捕获到的对话框，accept / dismiss 关掉（prompt 可带 promptText）。",
			parameters: {
				op: { ...str, required: true, description: "list | accept | dismiss" },
				promptText: { ...str, description: "op=accept 且对话框是 prompt 时填入的文本" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						count: { ...int, required: true },
						type: str,
						message: str,
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							v.op === "list"
								? `捕获到 ${v.count} 个对话框${v.message ? `，最近一个：${v.type} / ${v.message}` : "（当前没有挂起的对话框）"}`
								: `已${v.op === "accept" ? "确认" : "取消"}对话框${v.message ? `：${v.message}` : ""}`,
					},
				],
			},
			presentCall: (args) => genericCard("处理原生对话框", args),
			execute: async (args) => {
				const op = String(args.op ?? "list");
				return await withPage(c, args.urlMatch, async (cdp, page) => {
					await cdp.send("Page.enable").catch(() => {});
					const state = watchDialogs(cdp, page.id);
					const last = state.last ?? null;
					const info = last ? { type: String(last.type ?? ""), message: String(last.message ?? "").slice(0, 500) } : {};
					if (op === "list") return { ok: true, op, count: state.queue.length, ...info };
					await handleDialog(cdp, { accept: op === "accept", ...(args.promptText === undefined ? {} : { promptText: args.promptText }) });
					state.queue.length = 0;
					return { ok: true, op, count: 0, ...info };
				});
			},
		});

		reg({
			name: "edge_attach",
			description:
				"列出页面里的**跨域 iframe**（OOPIF）并在它内部执行 JS。同源 iframe 用 edge_eval + contentDocument 就能读；跨域 iframe 必须用 Target.setAutoAttach(flatten) 拿 sessionId。op=list 列出 iframe target，op=eval 在选中的 iframe 里跑 JS（frameUrl 子串或 frameIndex 选择）。",
			parameters: {
				op: { ...str, required: true, description: "list | eval" },
				js: { ...str, description: "op=eval 时在该 iframe 文档里执行的表达式" },
				frameUrl: { ...str, description: "iframe URL 含该子串" },
				frameIndex: { ...int, description: "第几个 iframe（0 起）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						count: { ...int, required: true },
						frames: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { url: str, sessionId: str },
							},
						},
						json: str,
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							v.op === "list"
								? (v.frames ?? []).map((f, i) => `${i + 1}. ${f.url}${f.sessionId ? "" : "（未建立会话）"}`).join("\n") || "没有跨域 iframe"
								: String(v.json ?? "").slice(0, 4000),
					},
				],
			},
			presentCall: (args) => genericCard("跨域 iframe", args),
			execute: async (args) => {
				const op = String(args.op ?? "list");
				return await withPage(c, args.urlMatch, async (cdp) => {
					const list = await frames(cdp);
					if (op === "list") {
						return {
							ok: true,
							op,
							count: list.length,
							frames: list.map((f) => ({ url: String(f.url ?? "").slice(0, 300), sessionId: String(f.sessionId ?? "") })),
						};
					}
					const expr = args.js ?? "JSON.stringify({href: location.href, text: document.body.innerText.slice(0,500)})";
					let target = null;
					if (args.frameUrl) target = list.find((f) => String(f.url ?? "").includes(args.frameUrl));
					if (!target && args.frameIndex !== undefined) target = list[args.frameIndex];
					if (!target) target = list.find((f) => f.sessionId) ?? list[0];
					if (!target || !target.sessionId) throw new Error("没有可用的 iframe 会话（页面里没有跨域 iframe？）");
					const value = await evalIn(cdp, expr, { sessionId: target.sessionId });
					let text;
					try {
						text = JSON.stringify(value);
					} catch {
						text = String(value);
					}
					return { ok: true, op, count: list.length, frames: [], json: String(text ?? "null").slice(0, 200000) };
				});
			},
		});

		reg({
			name: "edge_mouse",
			description:
				"发**真实鼠标事件**（Input.dispatchMouseEvent，不是 JS 的 element.click()）。很多站点只认真实输入：实测某平台用 JS click 点播放无效、真实鼠标点才生效。op=click/move/drag/wheel；给 selector 就点元素中心，或直接给视口 x/y。",
			parameters: {
				op: { ...str, required: true, description: "click | move | drag | wheel" },
				selector: { ...str, description: "CSS 选择器（给它就点元素中心）" },
				index: { ...int, description: "匹配多个时取第几个（0 起）" },
				x: { ...int, description: "视口 x" },
				y: { ...int, description: "视口 y" },
				toX: { ...int, description: "op=drag 的终点 x" },
				toY: { ...int, description: "op=drag 的终点 y" },
				deltaY: { ...int, description: "op=wheel 的纵向滚动量，默认 480" },
				button: { ...str, description: "left | right | middle，默认 left" },
				clickCount: { ...int, description: "连击次数，默认 1" },
				steps: { ...int, description: "移动分几步（默认 4；0 表示不预移动）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						x: { ...int, required: true },
						y: { ...int, required: true },
					},
				},
				render: (_a, v) => [{ type: "text", text: `${v.op} @ (${v.x}, ${v.y})` }],
			},
			presentCall: (args) => genericCard("真实鼠标操作", args),
			execute: async (args) => {
				const op = String(args.op ?? "click");
				return await withPage(c, args.urlMatch, async (cdp) => {
					let { x, y } = args;
					if (args.selector) {
						const ctr = await centerOf(cdp, args.selector, { index: args.index ?? 0 });
						if (!ctr) throw new Error(`选择器无匹配或元素不可见: ${args.selector}`);
						x = ctr.x;
						y = ctr.y;
					}
					if (x === undefined || y === undefined) throw new Error("需要 selector 或 x/y");
					if (op === "move") {
						await mouseMove(cdp, x, y);
					} else if (op === "click") {
						await mouseClick(cdp, x, y, { button: args.button ?? "left", clickCount: args.clickCount ?? 1, steps: args.steps ?? 4 });
					} else if (op === "drag") {
						if (args.toX === undefined || args.toY === undefined) throw new Error("op=drag 需要 toX/toY");
						await mouseDrag(cdp, { x, y }, { x: args.toX, y: args.toY }, { button: args.button ?? "left", steps: args.steps ?? 12 });
						return { ok: true, op, x: Math.round(args.toX), y: Math.round(args.toY) };
					} else if (op === "wheel") {
						await wheel(cdp, x, y, args.deltaY ?? 480);
					} else {
						throw new Error(`不支持的 op: ${op}`);
					}
					return { ok: true, op, x: Math.round(x), y: Math.round(y) };
				});
			},
		});

		reg({
			name: "edge_key",
			description:
				"发真实键盘事件。给 text 走 Input.insertText（能进受控组件）；给 keys 走 Input.dispatchKeyEvent（Enter / Tab / Escape / ArrowDown / PageDown / Space 等），modifiers 可做组合键（ctrl,shift,alt,meta）。",
			parameters: {
				keys: { ...str, description: "要按的键，逗号分隔：Enter,Tab,ArrowDown" },
				text: { ...str, description: "要输入的文本（text 优先于 keys）" },
				modifiers: { ...str, description: "修饰键，逗号分隔：ctrl,shift,alt,meta" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						mode: { ...str, required: true },
						detail: { ...str, required: true },
					},
				},
				render: (_a, v) => [{ type: "text", text: `${v.mode}: ${v.detail}` }],
			},
			presentCall: (args) => genericCard("真实键盘输入", args),
			execute: async (args) => {
				return await withPage(c, args.urlMatch, async (cdp) => {
					if (args.text !== undefined && args.text !== "") {
						await typeText(cdp, String(args.text));
						return { ok: true, mode: "insertText", detail: String(args.text).slice(0, 120) };
					}
					const mods = String(args.modifiers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
					const keys = String(args.keys ?? "Enter").split(",").map((s) => s.trim()).filter(Boolean);
					for (const k of keys) await pressKey(cdp, k, { modifiers: mods });
					return { ok: true, mode: "keys", detail: `${mods.length ? mods.join("+") + "+" : ""}${keys.join(",")}` };
				});
			},
		});

		reg({
			name: "edge_network",
			description:
				"抓页面网络请求（Network 域）。op=start 开始记录（必须先调，按标签页保存）、list 列出最近请求（filter 子串、onlyFailures 只看失败）、body 取某请求响应体（要 requestId）、stop / clear。比往页面里注入 XHR hook 干净。",
			parameters: {
				op: { ...str, required: true, description: "start | list | body | stop | clear" },
				filter: { ...str, description: "只保留 URL 含该子串的请求" },
				limit: { ...int, description: "最多返回多少条（默认 50）" },
				onlyFailures: { ...bool, description: "只看 status 为 0 或 ≥400 的" },
				requestId: { ...str, description: "op=body 时的请求 id" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						count: { ...int, required: true },
						requests: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { id: str, method: str, status: int, mime: str, url: str },
							},
						},
						body: str,
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							v.op === "body"
								? String(v.body ?? "").slice(0, 4000)
								: v.op === "list"
									? (v.requests ?? []).map((r) => `${r.status ?? "-"} ${r.method ?? ""} ${String(r.url ?? "").slice(0, 120)}`).join("\n") || "（没有记录；先 op=start）"
									: `network ${v.op} ok，当前 ${v.count} 条`,
					},
				],
			},
			presentCall: (args) => genericCard("网络请求", args),
			execute: async (args) => {
				const op = String(args.op ?? "list");
				return await withPage(c, args.urlMatch, async (cdp, page) => {
					if (op === "start") {
						const st = await startNetwork(cdp, page.id);
						return { ok: true, op, count: st.rows.length, requests: [] };
					}
					if (op === "stop") {
						const okStop = await stopNetwork(cdp, page.id);
						return { ok: okStop, op, count: listNetwork(page.id, { limit: 1000 }).length, requests: [] };
					}
					if (op === "clear") {
						clearNetwork(page.id);
						return { ok: true, op, count: 0, requests: [] };
					}
					if (op === "body") {
						if (!args.requestId) throw new Error("op=body 需要 requestId");
						const b = await responseBody(cdp, args.requestId);
						return { ok: true, op, count: 1, requests: [], body: b.body };
					}
					const rows = listNetwork(page.id, {
						filter: args.filter,
						onlyFailures: Boolean(args.onlyFailures),
						limit: args.limit ?? 50,
					});
					return {
						ok: true,
						op: "list",
						count: rows.length,
						requests: rows.map((r) => ({
							id: String(r.id ?? ""),
							method: String(r.method ?? ""),
							status: Number(r.status ?? 0),
							mime: String(r.mime ?? ""),
							url: String(r.url ?? ""),
						})),
					};
				});
			},
		});

		reg({
			name: "edge_wait",
			description:
				"等页面到某个状态再继续，替代盲目的 sleep。selector 出现 / JS 表达式为真可组合，都满足才算成立。超时返回 ok=false 而不是抛异常。",
			parameters: {
				selector: { ...str, description: "等这个选择器能匹配到元素" },
				js: { ...str, description: "等这个表达式为真" },
				timeoutMs: { ...int, description: "超时毫秒，默认 15000" },
				intervalMs: { ...int, description: "轮询间隔毫秒，默认 250" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						elapsedMs: { ...int, required: true },
						matched: int,
					},
				},
				render: (_a, v) => [
					{ type: "text", text: v.ok ? `等到了（${v.elapsedMs} ms，匹配 ${v.matched ?? "-"} 个）` : `等待超时（${v.elapsedMs} ms）` },
				],
			},
			presentCall: (args) => genericCard("等待页面状态", args),
			execute: async (args) => {
				if (!args.selector && !args.js) throw new Error("selector 与 js 至少给一个");
				return await withPage(c, args.urlMatch, async (cdp) => {
					const r = await waitFor(cdp, {
						selector: args.selector,
						js: args.js,
						timeoutMs: args.timeoutMs ?? 15000,
						intervalMs: args.intervalMs ?? 250,
					});
					return { ok: r.ok, elapsedMs: r.elapsedMs, matched: Number(r.matched ?? 0) };
				});
			},
		});

		// ---------------- 0.3.0：标签页 / 视频 / 同源 iframe / 播放守护 / Cookie / 下载 ----------------

		reg({
			name: "edge_tab",
			description:
				"标签页管理：op=open 新开一个标签页（不是窗口）、close 关掉指定标签页、activate 把它提到前台、list 列出。**activate 很关键**：新开的窗口/标签页默认在后台，有些播放器在后台不初始化（会一直空白），必须提到前台一次。",
			parameters: {
				op: { ...str, required: true, description: "open | close | activate | list" },
				url: { ...str, description: "op=open 的目标 URL" },
				targetId: { ...str, description: "要关/要提的 targetId（list 里能拿到）" },
				urlMatch: { ...str, description: "用 URL 子串定位要关/要提的标签页" },
				index: { ...int, description: "用序号定位（list 的顺序，0 起）" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						targetId: str,
						totalPages: { ...int, required: true },
						tabs: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { id: str, title: str, url: str },
							},
						},
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							v.op === "list"
								? (v.tabs ?? []).map((t, i) => `${i + 1}. ${t.title || "(无标题)"} — ${t.url}`).join("\n") || "(无标签页)"
								: `tab ${v.op} ok${v.targetId ? ` · ${v.targetId.slice(0, 8)}` : ""} · 当前 ${v.totalPages} 个页面`,
					},
				],
			},
			presentCall: (args) => genericCard("标签页管理", args),
			execute: async (args) => {
				const op = String(args.op ?? "list");
				await launch(c);
				const list = await withPage(c, null, async (cdp) => {
					if (op === "open") {
						const r = await openTab(cdp, args.url ?? "about:blank");
						await new Promise((r2) => setTimeout(r2, 900));
						return { cdp, targetId: r.targetId };
					}
					const pagesList = await pages(c);
					let target = null;
					if (args.targetId) target = pagesList.find((p) => p.id === args.targetId);
					if (!target && args.urlMatch) target = pagesList.find((p) => (p.url ?? "").includes(args.urlMatch));
					if (!target && args.index !== undefined) target = pagesList[args.index];
					if (op === "close" || op === "activate") {
						if (!target) throw new Error("没有匹配的标签页（给 targetId / urlMatch / index）");
						if (op === "close") await closeTarget(cdp, target.id);
						else await activateTarget(cdp, target.id);
					}
					return { cdp, targetId: target?.id ?? "" };
				});
				const after = await pages(c);
				return {
					ok: true,
					op,
					targetId: String(list.targetId ?? ""),
					totalPages: after.length,
					tabs: after.map((p) => ({ id: p.id, title: p.title, url: p.url })),
				};
			},
		});

		reg({
			name: "edge_video",
			description:
				"直接读/控页面里的 <video>（会钻进同源 iframe）。op=list 列出所有视频及其 currentTime/duration/paused/ended；play/pause/seek/rate/mute/unmute 按 path+index 操作。path 是 iframe 索引链（外层第一个 iframe 就是 \"0\"，再往里 \"0,1\"）。",
			parameters: {
				op: { ...str, required: true, description: "list | play | pause | seek | rate | mute | unmute" },
				path: { ...str, description: "iframe 索引链，逗号分隔，如 \"0\" 或 \"0,1\"（默认顶层）" },
				index: { ...int, description: "该文档里第几个 video，默认 0" },
				value: { ...num, description: "op=seek 的秒数 / op=rate 的倍速" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						count: { ...int, required: true },
						videos: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									index: int,
									src: str,
									currentTime: num,
									duration: num,
									paused: bool,
									ended: bool,
								},
							},
						},
						json: str,
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							v.op === "list"
								? (v.videos ?? [])
										.map(
											(x) =>
												`#${x.index} ${Math.round(x.currentTime ?? 0)}s / ${Math.round(x.duration ?? 0)}s ${x.paused ? "⏸" : "▶"}${x.ended ? " 已结束" : ""} ${String(x.src ?? "").slice(-40)}`,
										)
										.join("\n") || "（没找到 video）"
								: String(v.json ?? ""),
					},
				],
			},
			presentCall: (args) => genericCard("视频控制", args),
			execute: async (args) => {
				const op = String(args.op ?? "list");
				const path = String(args.path ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s !== "")
					.map(Number);
				const index = args.index ?? 0;
				return await withPage(c, args.urlMatch, async (cdp) => {
					if (op === "list") {
						const vids = await collectVideos(cdp, {});
						return {
							ok: true,
							op,
							count: vids.length,
							videos: vids.map((v, i) => ({
								index: i,
								src: String(v.src ?? ""),
								currentTime: Number(v.currentTime ?? 0),
								duration: Number(v.duration ?? 0),
								paused: Boolean(v.paused),
								ended: Boolean(v.ended),
							})),
						};
					}
					const r = await controlVideo(cdp, { path, index, action: op, value: args.value });
					return { ok: true, op, count: 1, videos: [], json: JSON.stringify(r) };
				});
			},
		});

		reg({
			name: "edge_frames",
			description:
				"同源 iframe 寻址：op=list 递归列出所有 iframe（path / src / id / 是否可读）；op=eval 在指定 path 的 iframe 里求值，表达式里用 doc 指代那个 document（如 doc.body.innerText）。跨域 iframe 用 edge_attach。",
			parameters: {
				op: { ...str, required: true, description: "list | eval" },
				path: { ...str, description: "iframe 索引链，如 \"0,1\"" },
				js: { ...str, description: "op=eval 的表达式，用 doc 访问目标文档" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						count: { ...int, required: true },
						frames: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { path: str, src: str, id: str, accessible: bool },
							},
						},
						json: str,
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							v.op === "list"
								? (v.frames ?? []).map((f) => `[${f.path}] ${f.accessible ? "可读" : "跨域"} ${f.id ? "#" + f.id : ""} ${f.src}`).join("\n") || "（没有 iframe）"
								: String(v.json ?? ""),
					},
				],
			},
			presentCall: (args) => genericCard("同源 iframe", args),
			execute: async (args) => {
				const op = String(args.op ?? "list");
				return await withPage(c, args.urlMatch, async (cdp) => {
					if (op === "list") {
						const list = await listFrames(cdp);
						return {
							ok: true,
							op,
							count: list.length,
							frames: list.map((f) => ({
								path: (f.path ?? []).join(","),
								src: String(f.src ?? ""),
								id: String(f.id ?? ""),
								accessible: Boolean(f.accessible),
							})),
						};
					}
					const path = String(args.path ?? "")
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s !== "")
						.map(Number);
					const value = await evalInFrame(cdp, { path, expression: args.js ?? "doc.body.innerText.slice(0,500)" });
					let text;
					try {
						text = JSON.stringify(value);
					} catch {
						text = String(value);
					}
					return { ok: true, op, count: 1, frames: [], json: String(text ?? "null").slice(0, 100000) };
				});
			},
		});

		reg({
			name: "edge_keep_playing",
			description:
				"**播放守护（刷课核心）**：给一组页面，插件自己每 N 秒检查一遍视频，暂停就续播；currentTime 连续几次不前进就判定卡死并重载页面。op=start 开始（targets 用 URL 子串，逗号分隔；不给则接管当前所有页面）、status 看进度与日志、stop 停止。把「agent 反复调用」变成「插件自己盯」，一个 40 分钟的视频只需调用一次。",
			parameters: {
				op: { ...str, required: true, description: "start | status | stop" },
				targets: { ...str, description: "URL 子串，逗号分隔（多个页面一起守护）" },
				everyMs: { ...int, description: "检查间隔毫秒，默认 4000" },
				autoReload: { ...bool, description: "卡死时自动重载页面，默认 true" },
				stallTicks: { ...int, description: "连续几次不前进算卡死，默认 3" },
				maxMinutes: { ...int, description: "最多守护多少分钟后自动停（0 = 不限）" },
				key: { ...str, description: "给这次守护起个名字，默认 default" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						running: { ...bool, required: true },
						targets: { type: "array", items: str },
						ticks: int,
						plays: int,
						reloads: int,
						stalls: int,
						errors: int,
						elapsedSec: int,
						log: { type: "array", items: str },
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							`守护${v.running ? "运行中" : "已停止"} · ${(v.targets ?? []).length} 个页面 · ${v.elapsedSec ?? 0}s · 心跳 ${v.ticks ?? 0} 次 · ` +
							`续播 ${v.plays ?? 0} · 重载 ${v.reloads ?? 0} · 卡死 ${v.stalls ?? 0} · 错误 ${v.errors ?? 0}\n` +
							(v.log ?? []).slice(-8).join("\n"),
					},
				],
			},
			presentCall: (args) => genericCard("播放守护", args),
			execute: async (args) => {
				const op = String(args.op ?? "status");
				const key = String(args.key ?? "default");
				if (op === "stop") {
					stopGuard(key);
				} else if (op === "start") {
					await launch(c);
					let targets = String(args.targets ?? "")
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					if (!targets.length) {
						targets = (await pages(c)).map((p) => p.url).filter((u) => u && !u.startsWith("about:"));
					}
					if (!targets.length) throw new Error("没有可守护的页面（先 edge_nav / edge_window 打开页面，或显式给 targets）");
					startGuard(c.port, c.timeoutMs, key, {
						targets,
						everyMs: args.everyMs ?? 4000,
						autoReload: args.autoReload !== false,
						stallTicks: args.stallTicks ?? 3,
						maxMinutes: args.maxMinutes ?? 0,
					});
				}
				const st = guardStatus(key);
				return {
					ok: true,
					op,
					running: Boolean(st.running),
					targets: st.targets ?? [],
					ticks: st.ticks ?? 0,
					plays: st.stats?.plays ?? 0,
					reloads: st.stats?.reloads ?? 0,
					stalls: st.stats?.stalls ?? 0,
					errors: st.stats?.errors ?? 0,
					elapsedSec: st.elapsedSec ?? 0,
					log: (st.log ?? []).map((x) => `${x.at} ${x.msg}`),
				};
			},
		});

		reg({
			name: "edge_cookies",
			description:
				"读写 Cookie：op=get 导出（可按 urls 过滤；includeValues=false 只给名字/域，适合打印）、set 写一条、clear 清空。用于登录态迁移或确认「到底哪条 cookie 决定登录」。",
			parameters: {
				op: { ...str, required: true, description: "get | set | clear" },
				urls: { ...str, description: "op=get 的 URL 过滤，逗号分隔；不给则全量" },
				includeValues: { ...bool, description: "op=get 是否返回 value，默认 true" },
				name: { ...str, description: "op=set 的 cookie 名" },
				value: { ...str, description: "op=set 的 cookie 值" },
				domain: { ...str, description: "op=set 的域（与 url 二选一）" },
				url: { ...str, description: "op=set 的 url（由它推域）" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						count: { ...int, required: true },
						json: { ...str, required: true },
					},
				},
				render: (_a, v) => [{ type: "text", text: `cookie ${v.op} · ${v.count} 条\n${String(v.json ?? "").slice(0, 3000)}` }],
			},
			presentCall: (args) => genericCard("Cookie", args),
			execute: async (args) => {
				const op = String(args.op ?? "get");
				return await withPage(c, args.urlMatch, async (cdp) => {
					if (op === "clear") {
						await clearCookies(cdp);
						return { ok: true, op, count: 0, json: "已清空" };
					}
					if (op === "set") {
						if (!args.name || args.value === undefined) throw new Error("op=set 需要 name 与 value");
						const cookie = { name: args.name, value: String(args.value), path: "/" };
						if (args.url) cookie.url = args.url;
						else if (args.domain) cookie.domain = args.domain;
						else throw new Error("op=set 需要 url 或 domain");
						const okSet = await setCookie(cdp, cookie);
						return { ok: okSet, op, count: okSet ? 1 : 0, json: JSON.stringify(cookie) };
					}
					const urls = String(args.urls ?? "")
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					const cookies = await getCookies(cdp, { urls, includeValues: args.includeValues !== false });
					return { ok: true, op, count: cookies.length, json: JSON.stringify(cookies, null, 1).slice(0, 100000) };
				});
			},
		});

		reg({
			name: "edge_download",
			description:
				"用浏览器自己的下载通道把 URL 存到本地（**保留登录态**，这是 fetch 做不到的）。给 savePath 就存到指定路径，不给就落到临时目录并返回路径。适合下载课程附件、导出文件的场景。",
			parameters: {
				url: { ...str, required: true, description: "要下载的 URL" },
				savePath: { ...str, description: "保存的绝对路径（不给则用临时目录）" },
				timeoutMs: { ...int, description: "超时毫秒，默认 60000" },
				urlMatch: { ...str, description: "只操作 URL 含该子串的标签页" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						path: str,
						size: int,
						reason: str,
					},
				},
				render: (_a, v) => [
					{ type: "text", text: v.ok ? `已下载 ${v.path}（${v.size} 字节）` : `下载失败：${v.reason ?? "未知"}（目录 ${v.path ?? "-"}）` },
				],
			},
			presentCall: (args) => genericCard("下载文件", args),
			execute: async (args) => {
				await launch(c);
				const r = await withPage(c, args.urlMatch, async (cdp) => await download(cdp, { url: args.url, savePath: args.savePath, timeoutMs: args.timeoutMs ?? 60000 }));
				return r;
			},
		});

		reg({
			name: "edge_autoplay",
			description:
				"**队列调度（一条条刷完）**：给定「列表页」和一段在列表页上求值的 JS（返回下一个要学的 {url,title} 或 null），插件自己打开、播放、播完自动切下一个，队列空了自己停。与 edge_keep_playing 分工：那个管「别停」，这个管「下一个是谁」。nextJs 可返回 Promise（内部会 await）。",
			parameters: {
				op: { ...str, required: true, description: "start | status | stop" },
				listMatch: { ...str, description: "列表页的 URL 子串（start 必填）" },
				nextJs: { ...str, description: "在列表页上求值的表达式，返回 JSON 字符串 {\"url\":\"…\",\"title\":\"…\"} 或 \"null\"" },
				everyMs: { ...int, description: "检查间隔毫秒，默认 5000" },
				maxItems: { ...int, description: "最多刷几个（0 = 不限），默认 0" },
				doneTolerance: { ...int, description: "距结束多少秒算完成，默认 3（内部会按视频长度缩到 10% 以内）" },
				key: { ...str, description: "任务名，默认 default" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { ...bool, required: true },
						op: { ...str, required: true },
						running: { ...bool, required: true },
						doneCount: { ...int, required: true },
						failCount: { ...int, required: true },
						ticks: int,
						elapsedSec: int,
						item: str,
						lastReason: str,
						log: { type: "array", items: str },
					},
				},
				render: (_a, v) => [
					{
						type: "text",
						text:
							`自动播放${v.running ? "运行中" : "已停止"} · 已完成 ${v.doneCount} · 失败 ${v.failCount} · 心跳 ${v.ticks ?? 0} 次 · ${v.elapsedSec ?? 0}s` +
							(v.item ? `\n当前：${v.item}` : "") +
							(v.lastReason ? `\n结束原因：${v.lastReason}` : "") +
							"\n" +
							(v.log ?? []).slice(-8).join("\n"),
					},
				],
			},
			presentCall: (args) => genericCard("队列自动播放", args),
			execute: async (args) => {
				const op = String(args.op ?? "status");
				const key = String(args.key ?? "default");
				await launch(c);
				if (op === "stop") {
					stopAutoplay(key);
				} else if (op === "start") {
					if (!args.listMatch) throw new Error("start 需要 listMatch（列表页 URL 子串）");
					if (!args.nextJs) throw new Error("start 需要 nextJs（返回下一个 {url,title} 的表达式）");
					startAutoplay(c.port, c.timeoutMs, key, {
						listMatch: args.listMatch,
						nextJs: args.nextJs,
						everyMs: args.everyMs ?? 5000,
						maxItems: args.maxItems ?? 0,
						doneTolerance: args.doneTolerance ?? 3,
					});
				}
				const st = autoplayStatus(key);
				return {
					ok: true,
					op,
					running: Boolean(st.running),
					doneCount: st.doneCount ?? 0,
					failCount: st.failCount ?? 0,
					ticks: st.ticks ?? 0,
					elapsedSec: st.elapsedSec ?? 0,
					item: st.item ? String(st.item.title ?? st.item.url ?? "") : "",
					lastReason: String(st.lastReason ?? ""),
					log: (st.log ?? []).map((x) => `${x.at} ${x.msg}`),
				};
			},
		});
	});

	ctx.logger?.info?.(`[edge-cdp] ready — port ${c.port}, profile ${c.profileDir}`);
}

export { name, inject, apply };
