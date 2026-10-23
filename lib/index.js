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

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "edge-cdp";
const inject = ["tools"];

const DEFAULT_EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEFAULT_PROFILE = join(homedir(), ".dsh", "edge-cdp-profile");

const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };

function cfg(config) {
	return {
		port: config?.port ?? 9222,
		edgePath: config?.edgePath ?? DEFAULT_EDGE,
		profileDir: config?.userDataDir ?? DEFAULT_PROFILE,
		timeoutMs: config?.commandTimeoutMs ?? 30000,
	};
}

async function httpJson(port, path) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

async function isUp(port) {
	try {
		await httpJson(port, "/json/version");
		return true;
	} catch {
		return false;
	}
}

class CDP {
	constructor(wsUrl, timeoutMs) {
		this.timeoutMs = timeoutMs;
		this.id = 0;
		this.pending = new Map();
		this.ws = new WebSocket(wsUrl);
		this.ready = new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
			this.ws.addEventListener("open", () => {
				clearTimeout(t);
				resolve();
			});
			this.ws.addEventListener("error", (e) => {
				clearTimeout(t);
				reject(new Error("CDP connect error: " + (e?.message ?? "unknown")));
			});
		});
		this.ws.addEventListener("message", (ev) => {
			let msg;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
			} catch {
				return;
			}
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject, timer } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				clearTimeout(timer);
				if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
				else resolve(msg.result ?? {});
			}
		});
	}

	async send(method, params = {}) {
		await this.ready;
		this.id += 1;
		const id = this.id;
		const payload = JSON.stringify({ id, method, params });
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timeout`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.ws.send(payload);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err);
			}
		});
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
	}
}

async function pages(c) {
	return (await httpJson(c.port, "/json")).filter((t) => t.type === "page");
}

function pickPage(list, urlMatch) {
	if (!list.length) throw new Error("没有可用的标签页；先 edge_launch 或 edge_nav");
	if (urlMatch) {
		const hit = list.find((p) => (p.url ?? "").includes(urlMatch));
		if (hit) return hit;
		throw new Error(`没有匹配 "${urlMatch}" 的标签页`);
	}
	return list[0];
}

const sessions = new Map();

async function withPage(c, urlMatch, fn) {
	const page = pickPage(await pages(c), urlMatch);
	const key = page.webSocketDebuggerUrl;
	let cdp = sessions.get(key);
	if (!cdp) {
		cdp = new CDP(page.webSocketDebuggerUrl, c.timeoutMs);
		sessions.set(key, cdp);
	}
	try {
		return await fn(cdp, page);
	} catch (err) {
		const msg = String(err?.message ?? err);
		if (/timeout|closed|connecting|connect error/i.test(msg)) {
			sessions.delete(key);
			try {
				cdp.close();
			} catch {
				/* ignore */
			}
		}
		throw err;
	}
}

// 后台模式心跳：保持 CDP 会话 + 防止渲染进程被节流。
const bgTimers = new Map();

function startBackground(c, urlMatch, everyMs) {
	const key = urlMatch ?? "*";
	if (bgTimers.has(key)) return { already: true };
	const timer = setInterval(async () => {
		try {
			await evalJs(c, "document.visibilityState", urlMatch, false);
		} catch {
			/* 下次调用自愈 */
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

async function launch(c) {
	if (await isUp(c.port)) return { alreadyRunning: true };
	mkdirSync(c.profileDir, { recursive: true });
	const child = spawn(
		c.edgePath,
		[
			`--remote-debugging-port=${c.port}`,
			"--remote-allow-origins=*",
			`--user-data-dir=${c.profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			"--disable-features=CalculateNativeWinOcclusion",
			"about:blank",
		],
		{ detached: true, stdio: "ignore", windowsHide: false },
	);
	child.unref();
	for (let i = 0; i < 40; i += 1) {
		await new Promise((r) => setTimeout(r, 500));
		if (await isUp(c.port)) return { alreadyRunning: false, port: c.port };
	}
	throw new Error("Edge 启动后 20 秒内没有开放调试端口");
}

function genericCard(title, rawInput) {
	return { card: "generic", title, kind: "other", rawInput };
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
			name: "edge_background_mode",
			description:
				"后台模式：开启后保持 CDP 长连接 + 焦点模拟 + 心跳，让页面在窗口被最小化/切到别的虚拟桌面时仍然认为自己是 visible + focused，视频不会被判定为离开。用于挂课/长任务放后台。",
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
	});

	ctx.logger?.info?.(`[edge-cdp] ready — port ${c.port}, profile ${c.profileDir}`);
}

export { name, inject, apply };
