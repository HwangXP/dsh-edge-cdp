// CDP 底座：连接、事件、会话（含跨域 iframe / OOPIF）、真实输入、网络、对话框、等待原语。
//
// 设计约束（改代码请守住）：
//   1. 零依赖 —— 只用 Node 内置 fetch / WebSocket，不引 Playwright / Puppeteer。
//   2. 每个能力都要能被 scripts/selftest.mjs 直接调用验证（本文件不依赖 DSH 上下文）。
//   3. 事件必须能被消费：CDP.send 只处理带 id 的响应，事件（Page.javascriptDialogOpening、
//      Network.responseReceived…）走 on()/bus，否则对话框和网络这两个能力无法实现。

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
export const DEFAULT_PROFILE = join(homedir(), ".dsh", "edge-cdp-profile");

export async function httpJson(port, path) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

export async function isUp(port) {
	try {
		await httpJson(port, "/json/version");
		return true;
	} catch {
		return false;
	}
}

export async function launch({ port, edgePath, profileDir }) {
	if (await isUp(port)) return { alreadyRunning: true };
	mkdirSync(profileDir, { recursive: true });
	const child = spawn(
		edgePath,
		[
			`--remote-debugging-port=${port}`,
			"--remote-allow-origins=*",
			`--user-data-dir=${profileDir}`,
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
		if (await isUp(port)) return { alreadyRunning: false, port };
	}
	throw new Error("Edge 启动后 20 秒内没有开放调试端口");
}

export async function pages(port) {
	return (await httpJson(port, "/json")).filter((t) => t.type === "page");
}

/**
 * 选标签页。支持三种匹配：
 *   urlMatch —— URL 含子串（原有行为）
 *   titleMatch —— 标题含子串
 *   index —— 第几个（0 起）
 * 都不给则第一个。多个标签页时**务必**用其中一种，否则可能抓错页（踩过：后台任务把用户的课程页顶掉）。
 */
export function pickPage(list, { urlMatch, titleMatch, index } = {}) {
	if (!list.length) throw new Error("没有可用的标签页；先 edge_launch 或 edge_nav");
	if (index !== undefined && index !== null) {
		const p = list[index];
		if (!p) throw new Error(`标签页索引越界: ${index}（共 ${list.length} 个）`);
		return p;
	}
	if (urlMatch) {
		const hit = list.find((p) => (p.url ?? "").includes(urlMatch));
		if (hit) return hit;
		throw new Error(`没有 URL 含 "${urlMatch}" 的标签页`);
	}
	if (titleMatch) {
		const hit = list.find((p) => (p.title ?? "").includes(titleMatch));
		if (hit) return hit;
		throw new Error(`没有标题含 "${titleMatch}" 的标签页`);
	}
	return list[0];
}

export class CDP {
	constructor(wsUrl, timeoutMs = 30000) {
		this.timeoutMs = timeoutMs;
		this.id = 0;
		this.pending = new Map();
		this.bus = new Map(); // method -> Set<fn>
		this.closed = false;
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
		this.ws.addEventListener("close", () => {
			this.closed = true;
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
				return;
			}
			if (msg.method) this.emit(msg.method, msg.params ?? {}, msg.sessionId);
		});
	}

	on(method, fn) {
		if (!this.bus.has(method)) this.bus.set(method, new Set());
		this.bus.get(method).add(fn);
		return () => this.bus.get(method)?.delete(fn);
	}

	emit(method, params, sessionId) {
		const set = this.bus.get(method);
		if (!set) return;
		for (const fn of set) {
			try {
				fn(params, sessionId);
			} catch {
				/* 监听器异常不能影响消息循环 */
			}
		}
	}

	/** sessionId 给出时，命令在该子会话（跨域 iframe / OOPIF）里执行。 */
	async send(method, params = {}, sessionId) {
		await this.ready;
		this.id += 1;
		const id = this.id;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timeout`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.ws.send(JSON.stringify(payload));
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

// ---------------- 会话池 ----------------

const sessions = new Map();

/** 每个标签页复用一条 WebSocket；连接失效时丢弃重建。 */
export async function withPage(port, timeoutMs, target, fn) {
	const list = await pages(port);
	const page = pickPage(list, typeof target === "string" ? { urlMatch: target } : target ?? {});
	const key = page.webSocketDebuggerUrl;
	let cdp = sessions.get(key);
	if (!cdp || cdp.closed) {
		cdp = new CDP(page.webSocketDebuggerUrl, timeoutMs);
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

export function closeAllSessions() {
	for (const cdp of sessions.values()) {
		try {
			cdp.close();
		} catch {
			/* ignore */
		}
	}
	sessions.clear();
}

// ---------------- 跨域 iframe（OOPIF） ----------------

/**
 * 列出页面里的**跨域** iframe target，并为它们建立 flatten 会话。
 *
 * 原理：同源 iframe 直接 contentDocument 就能读；跨域 iframe 是独立的渲染进程（OOPIF），
 * 只有 Target.setAutoAttach({flatten:true}) / Target.attachToTarget 才能拿到 sessionId，
 * 之后所有命令带上 sessionId 就作用在那个文档里。实测：file:// 页面里嵌 http:// 的 iframe
 * 能被正确 attach，并读出它自己的 location.href 与 body 文本。
 */
export async function frames(cdp, { attach = true, waitMs = 900 } = {}) {
	const found = new Map();
	cdp.on("Target.attachedToTarget", (p) => {
		const info = p.targetInfo ?? {};
		if (info.type === "iframe") found.set(info.targetId, { targetId: info.targetId, url: info.url, sessionId: p.sessionId });
	});
	if (attach) {
		await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
		await new Promise((r) => setTimeout(r, waitMs));
	}
	const infos = (await cdp.send("Target.getTargets")).targetInfos ?? [];
	for (const t of infos) {
		if (t.type !== "iframe" || found.has(t.targetId)) continue;
		try {
			const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
			found.set(t.targetId, { targetId: t.targetId, url: t.url, sessionId });
		} catch {
			found.set(t.targetId, { targetId: t.targetId, url: t.url, sessionId: null });
		}
	}
	return [...found.values()];
}

export async function evalIn(cdp, js, { sessionId, awaitPromise = true } = {}) {
	const r = await cdp.send(
		"Runtime.evaluate",
		{ expression: js, returnByValue: true, awaitPromise },
		sessionId,
	);
	if (r.exceptionDetails) {
		const d = r.exceptionDetails;
		throw new Error(d.exception?.description ?? d.text ?? "JS exception");
	}
	return r.result?.value ?? null;
}

// ---------------- 真实输入 ----------------

const BUTTON_MASK = { left: 1, right: 2, middle: 4, none: 0 };

export async function mouseMove(cdp, x, y, { sessionId, buttons = 0 } = {}) {
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons }, sessionId);
}

/**
 * 在视口坐标 (x,y) 上做一次真实鼠标点击。
 * steps>0 时先分几步移动过去（有些站点只在 mousemove 后才挂上处理函数）。
 */
export async function mouseClick(cdp, x, y, { sessionId, button = "left", clickCount = 1, steps = 4 } = {}) {
	if (steps > 0) {
		for (let i = 1; i <= steps; i += 1) {
			await mouseMove(cdp, x, y, { sessionId });
			await new Promise((r) => setTimeout(r, 30));
		}
	}
	const mask = BUTTON_MASK[button] ?? 1;
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: mask, clickCount }, sessionId);
	await new Promise((r) => setTimeout(r, 40));
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount }, sessionId);
	return { x, y, button, clickCount };
}

export async function mouseDrag(cdp, from, to, { sessionId, button = "left", steps = 12 } = {}) {
	const mask = BUTTON_MASK[button] ?? 1;
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, buttons: 0 }, sessionId);
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button, buttons: mask, clickCount: 1 }, sessionId);
	for (let i = 1; i <= steps; i += 1) {
		const x = from.x + ((to.x - from.x) * i) / steps;
		const y = from.y + ((to.y - from.y) * i) / steps;
		await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: mask }, sessionId);
		await new Promise((r) => setTimeout(r, 16));
	}
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button, buttons: 0, clickCount: 1 }, sessionId);
	return { from, to };
}

export async function wheel(cdp, x, y, deltaY, { sessionId, deltaX = 0 } = {}) {
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, buttons: 0 }, sessionId);
}

const KEYS = {
	Enter: { key: "Enter", code: "Enter", vk: 13 },
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	Delete: { key: "Delete", code: "Delete", vk: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	Home: { key: "Home", code: "Home", vk: 36 },
	End: { key: "End", code: "End", vk: 35 },
	PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
	PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
	Space: { key: " ", code: "Space", vk: 32 },
};

const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

function keyInfo(name) {
	if (KEYS[name]) return KEYS[name];
	if (/^[a-zA-Z]$/.test(name)) {
		const up = name.toUpperCase();
		return { key: name, code: `Key${up}`, vk: up.charCodeAt(0) };
	}
	if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0) };
	return { key: name, code: "", vk: 0 };
}

/** 按一次键（可带修饰键，如 ctrl+a）。 */
export async function pressKey(cdp, name, { sessionId, modifiers = [] } = {}) {
	const info = keyInfo(name);
	const mask = modifiers.reduce((acc, m) => acc | (MOD[String(m).toLowerCase()] ?? 0), 0);
	const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers: mask };
	await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
	return { key: name, modifiers };
}

/** 逐字符输入文本（走 Input.insertText，能进受控组件）。 */
export async function typeText(cdp, text, { sessionId } = {}) {
	await cdp.send("Input.insertText", { text }, sessionId);
	return { length: String(text).length };
}

// ---------------- 对话框 ----------------

const dialogs = new Map(); // wsUrl -> {queue: [], state}

export function watchDialogs(cdp, key) {
	if (dialogs.has(key)) return dialogs.get(key);
	const state = { queue: [], last: null };
	dialogs.set(key, state);
	cdp.on("Page.javascriptDialogOpening", (p) => {
		state.last = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt, url: p.url, at: Date.now() };
		state.queue.push(state.last);
		if (state.queue.length > 20) state.queue.shift();
	});
	return state;
}

export function dialogState(key) {
	return dialogs.get(key) ?? { queue: [], last: null };
}

export async function handleDialog(cdp, { accept = true, promptText } = {}) {
	await cdp.send("Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
	return { accept, promptText: promptText ?? null };
}

// ---------------- 网络 ----------------

const nets = new Map(); // wsUrl -> {rows, byId, on}

export async function startNetwork(cdp, key, { max = 500 } = {}) {
	if (nets.has(key) && nets.get(key).on) return nets.get(key);
	const state = nets.get(key) ?? { rows: [], byId: new Map(), on: false };
	nets.set(key, state); // 必须先登记，否则 listNetwork 读不到这份状态（踩过：行数有、列表为空）
	state.rows = [];
	state.byId = new Map();
	cdp.on("Network.requestWillBeSent", (p) => {
		const row = {
			id: p.requestId,
			method: p.request?.method,
			url: p.request?.url,
			type: p.type,
			postData: p.request?.postData?.slice(0, 2000),
			status: null,
			mime: null,
			at: Date.now(),
		};
		state.byId.set(p.requestId, row);
		state.rows.push(row);
		if (state.rows.length > max) {
			const drop = state.rows.shift();
			if (drop) state.byId.delete(drop.id);
		}
	});
	cdp.on("Network.responseReceived", (p) => {
		const row = state.byId.get(p.requestId);
		if (!row) return;
		row.status = p.response?.status ?? null;
		row.mime = p.response?.mimeType ?? null;
	});
	await cdp.send("Network.enable", {});
	state.on = true;
	return state;
}

export function listNetwork(key, { filter, onlyFailures = false, limit = 50 } = {}) {
	const state = nets.get(key);
	if (!state) return [];
	let rows = state.rows;
	if (filter) rows = rows.filter((r) => (r.url ?? "").includes(filter));
	if (onlyFailures) rows = rows.filter((r) => !r.status || r.status >= 400);
	return rows.slice(-limit).map((r) => ({
		id: r.id,
		method: r.method,
		status: r.status,
		mime: r.mime,
		url: (r.url ?? "").slice(0, 300),
		postData: r.postData,
	}));
}

export async function responseBody(cdp, requestId) {
	const r = await cdp.send("Network.getResponseBody", { requestId });
	const body = r.base64Encoded ? Buffer.from(r.body ?? "", "base64").toString("utf8") : (r.body ?? "");
	return { body: body.slice(0, 20000), truncated: body.length > 20000 };
}

export async function stopNetwork(cdp, key) {
	const state = nets.get(key);
	if (!state) return false;
	try {
		await cdp.send("Network.disable", {});
	} catch {
		/* ignore */
	}
	state.on = false;
	return true;
}

export function clearNetwork(key) {
	const state = nets.get(key);
	if (!state) return false;
	state.rows = [];
	state.byId.clear();
	return true;
}

// ---------------- 等待原语 ----------------

/**
 * 轮询直到条件成立。三种条件可组合，全部满足才算成立：
 *   selector —— 选择器能匹配到元素
 *   js —— 表达式为真值
 * 超时返回 { ok:false, reason }，不抛异常（等待失败是常见结果，调用方要能判断）。
 */
export async function waitFor(cdp, { selector, js, sessionId, timeoutMs = 15000, intervalMs = 250 } = {}) {
	const t0 = Date.now();
	const sel = selector ? JSON.stringify(selector) : null;
	let lastValue = null;
	while (Date.now() - t0 < timeoutMs) {
		let ok = true;
		let detail = {};
		if (sel) {
			const n = await cdp
				.send("Runtime.evaluate", { expression: `document.querySelectorAll(${sel}).length`, returnByValue: true }, sessionId)
				.then((r) => Number(r.result?.value ?? 0))
				.catch(() => 0);
			detail.matched = n;
			if (n <= 0) ok = false;
		}
		if (ok && js) {
			const v = await cdp
				.send("Runtime.evaluate", { expression: `Boolean(${js})`, returnByValue: true }, sessionId)
				.then((r) => r.result?.value)
				.catch(() => undefined);
			lastValue = v;
			detail.truthy = v;
			if (!v) ok = false;
		}
		if (ok) return { ok: true, elapsedMs: Date.now() - t0, ...detail };
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return { ok: false, elapsedMs: Date.now() - t0, reason: "timeout", last: lastValue };
}

/** 把元素滚到视野内并算出它的视口中心坐标（真实点击要用）。 */
export async function centerOf(cdp, selector, { index = 0, sessionId } = {}) {
	const js = `(() => {
		const els = document.querySelectorAll(${JSON.stringify(selector)});
		if (!els.length) return null;
		const el = els[${index}];
		if (!el) return null;
		el.scrollIntoView({ block: "center", inline: "center" });
		const r = el.getBoundingClientRect();
		return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, matched: els.length, w: r.width, h: r.height });
	})()`;
	const raw = await evalIn(cdp, js, { sessionId });
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ---------------- 标签页 / 窗口管理 ----------------

/** 新开**标签页**（不是窗口；要窗口用 Target.createTarget({newWindow:true})）。 */
export async function openTab(cdp, url) {
	const r = await cdp.send("Target.createTarget", { url });
	return { targetId: String(r.targetId ?? "") };
}

export async function closeTarget(cdp, targetId) {
	await cdp.send("Target.closeTarget", { targetId });
	return true;
}

/** 把某个 target 提到前台（新窗口默认在后台，播放器可能因此不初始化——这条就是解药）。 */
export async function activateTarget(cdp, targetId) {
	await cdp.send("Target.activateTarget", { targetId });
	return true;
}

export async function bringToFront(cdp) {
	await cdp.send("Page.bringToFront", {});
	return true;
}

// ---------------- 视频（同源 iframe 也钻进去） ----------------

const VIDEO_WALK_JS = `(() => {
	const out = [];
	const walk = (doc, path) => {
		let vids = [];
		try { vids = Array.from(doc.querySelectorAll('video')); } catch (e) {}
		vids.forEach((v, i) => {
			out.push({
				path: path, index: i,
				src: String(v.currentSrc || v.src || '').slice(0, 200),
				currentTime: Number(v.currentTime || 0),
				duration: Number(v.duration || 0),
				paused: Boolean(v.paused), ended: Boolean(v.ended),
				readyState: Number(v.readyState || 0),
				muted: Boolean(v.muted), volume: Number(v.volume || 0),
				rate: Number(v.playbackRate || 1),
			});
		});
		let frames = [];
		try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) {}
		frames.forEach((f, i) => {
			let cd = null;
			try { cd = f.contentDocument; } catch (e) { cd = null; }
			if (cd) walk(cd, path.concat(i));
		});
	};
	walk(document, []);
	return JSON.stringify(out);
})()`;

export async function collectVideos(cdp, { sessionId } = {}) {
	const raw = await evalIn(cdp, VIDEO_WALK_JS, { sessionId, awaitPromise: false });
	try {
		return JSON.parse(String(raw ?? "[]"));
	} catch {
		return [];
	}
}

/**
 * 控制某个视频。`path` 是 iframe 索引链（同源才能进），`index` 是该文档里的第几个 video。
 * action: info | play | pause | seek | rate | mute | unmute
 */
export async function controlVideo(cdp, { path = [], index = 0, action = "info", value, sessionId } = {}) {
	const act = String(action);
	const valueJs = value === undefined ? "undefined" : JSON.stringify(value);
	const js = `(() => {
		let doc = document;
		for (const i of ${JSON.stringify(path)}) {
			let f = null;
			try { f = doc.querySelectorAll('iframe')[i]; } catch (e) {}
			if (!f || !f.contentDocument) return JSON.stringify({ error: "iframe 不可访问: " + i });
			doc = f.contentDocument;
		}
		const v = doc.querySelectorAll('video')[${Number(index) || 0}];
		if (!v) return JSON.stringify({ error: "没有 video 元素" });
		const act = ${JSON.stringify(act)};
		const val = ${valueJs};
		if (act === "play") { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
		else if (act === "pause") v.pause();
		else if (act === "seek") v.currentTime = Number(val);
		else if (act === "rate") v.playbackRate = Number(val);
		else if (act === "mute") { v.muted = true; v.volume = 0; }
		else if (act === "unmute") { v.muted = false; if (!v.volume) v.volume = 1; }
		return JSON.stringify({
			ok: true, action: act,
			currentTime: v.currentTime, duration: v.duration,
			paused: v.paused, ended: v.ended, muted: v.muted, rate: v.playbackRate,
		});
	})()`;
	const raw = await evalIn(cdp, js, { sessionId, awaitPromise: false });
	let o;
	try {
		o = JSON.parse(String(raw ?? "{}"));
	} catch {
		o = { error: "返回值无法解析" };
	}
	if (o.error) throw new Error(o.error);
	return o;
}

/** 递归列出同源 iframe（跨域的要走 edge_attach / frames()）。 */
export async function listFrames(cdp, { sessionId } = {}) {
	const js = `(() => {
		const out = [];
		const walk = (doc, path) => {
			let frames = [];
			try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) {}
			frames.forEach((f, i) => {
				let cd = null, err = null;
				try { cd = f.contentDocument; } catch (e) { err = String(e).slice(0, 80); }
				out.push({
					path: path.concat(i), src: String(f.src || "").slice(0, 300),
					id: f.id || "", name: f.name || "", accessible: Boolean(cd), error: err,
				});
				if (cd) walk(cd, path.concat(i));
			});
		};
		walk(document, []);
		return JSON.stringify(out);
	})()`;
	const raw = await evalIn(cdp, js, { sessionId });
	try {
		return JSON.parse(String(raw ?? "[]"));
	} catch {
		return [];
	}
}

/**
 * 在同源 iframe 里求值。表达式里用 `doc` 指代那个 iframe 的 document，
 * 例如：`doc.querySelectorAll('video').length`、`doc.body.innerText.slice(0,200)`。
 */
export async function evalInFrame(cdp, { path = [], expression }) {
	const js = `(() => {
		let doc = document;
		for (const i of ${JSON.stringify(path)}) {
			let f = null;
			try { f = doc.querySelectorAll('iframe')[i]; } catch (e) {}
			if (!f || !f.contentDocument) throw new Error("iframe 不可访问: " + i);
			doc = f.contentDocument;
		}
		const fn = new Function('doc', 'return (' + ${JSON.stringify(String(expression))} + ');');
		const v = fn(doc);
		return JSON.stringify(v === undefined ? null : v);
	})()`;
	const raw = await evalIn(cdp, js);
	try {
		return JSON.parse(String(raw ?? "null"));
	} catch {
		return String(raw);
	}
}

// ---------------- Cookie ----------------

export async function getCookies(cdp, { urls, includeValues = true } = {}) {
	const r = urls && urls.length ? await cdp.send("Network.getCookies", { urls }) : await cdp.send("Network.getAllCookies", {});
	return (r.cookies ?? []).map((c) => ({
		name: c.name,
		domain: c.domain,
		path: c.path,
		secure: Boolean(c.secure),
		httpOnly: Boolean(c.httpOnly),
		expires: c.expires,
		...(includeValues ? { value: c.value } : {}),
	}));
}

export async function setCookie(cdp, cookie) {
	const r = await cdp.send("Network.setCookie", cookie);
	return Boolean(r.success);
}

export async function clearCookies(cdp) {
	await cdp.send("Network.clearBrowserCookies", {});
	return true;
}

// ---------------- 下载 ----------------

const fsPromises = await import("node:fs/promises");
const osMod = await import("node:os");

/**
 * 通过浏览器自己的下载通道把 URL 存到本地（保留登录态；这一点 fetch 做不到）。
 * 做法：先把下载行为指向目标目录 → 新开一个 target 触发下载 → 轮询目录直到 .crdownload 消失。
 */
export async function download(cdp, { url, savePath, timeoutMs = 60000 }) {
	// 始终下到一个全新的临时目录：如果直接下到 savePath 所在的目录，目录里原有的文件会污染判定
	// （踩过：例子里挑中了一个 0 字节的无关文件，结果"复制成功但文件是空的"）。
	const dir = await fsPromises.mkdtemp(join(osMod.tmpdir(), "edge-dl-"));
	const before = new Set(await fsPromises.readdir(dir).catch(() => []));
	await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
	const { targetId } = await cdp.send("Target.createTarget", { url });
	const t0 = Date.now();
	let found = null;
	while (Date.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, 700));
		const now = await fsPromises.readdir(dir).catch(() => []);
		const fresh = now.filter((f) => !before.has(f));
		if (!fresh.length) continue;
		const partial = fresh.some((f) => f.endsWith(".crdownload"));
		if (partial) continue;
		const sizes = [];
		for (const f of fresh) {
			const st = await fsPromises.stat(join(dir, f)).catch(() => null);
			if (st) sizes.push({ file: join(dir, f), size: st.size });
		}
		if (sizes.length) {
			sizes.sort((a, b) => b.size - a.size);
			found = sizes[0];
			break;
		}
	}
	try {
		await cdp.send("Target.closeTarget", { targetId });
	} catch {
		/* ignore */
	}
	if (!found) return { ok: false, reason: "timeout", dir };
	const finalPath = savePath ?? found.file;
	if (savePath) {
		await fsPromises.copyFile(found.file, savePath);
	}
	const st = await fsPromises.stat(finalPath).catch(() => null);
	return { ok: true, path: finalPath, size: st ? st.size : found.size, dir };
}

// ---------------- 播放守护（刷课核心） ----------------

const guards = new Map();

/**
 * 后台守护：每 everyMs 检查一遍 N 个页面里的视频，
 * 暂停就续播、`currentTime` 连续 stallTicks 次不前进就重载、可选 maxMinutes 自动停。
 *
 * 这是把「agent 反复调用」变成「插件自己盯」的那一步——刷课一个视频 40 分钟，
 * 靠外部循环调用要几百次，靠这个定时器只要 start 一次。
 */
export function startGuard(port, timeoutMs, key, { targets = [], everyMs = 4000, autoReload = true, stallTicks = 3, maxMinutes = 0 } = {}) {
	stopGuard(key);
	const state = {
		key,
		targets: targets.filter(Boolean),
		everyMs,
		autoReload,
		stallTicks,
		maxMinutes,
		startedAt: Date.now(),
		running: true,
		ticks: 0,
		stats: { plays: 0, reloads: 0, stalls: 0, errors: 0 },
		last: new Map(),
		log: [],
		timer: null,
	};
	const push = (msg) => {
		state.log.push({ at: new Date().toTimeString().slice(0, 8), msg });
		if (state.log.length > 200) state.log.shift();
	};

	const tick = async () => {
		if (!state.running) return;
		state.ticks += 1;
		if (state.maxMinutes && Date.now() - state.startedAt > state.maxMinutes * 60000) {
			stopGuard(key);
			push(`达到 maxMinutes=${state.maxMinutes}，自动停止`);
			return;
		}
		for (const t of state.targets) {
			try {
				const list = await pages(port);
				const page = list.find((p) => (p.url ?? "").includes(t));
				if (!page) {
					state.stats.errors += 1;
					push(`找不到页面 ${t}`);
					continue;
				}
				await withPage(port, timeoutMs, { urlMatch: t }, async (cdp) => {
					const vids = await collectVideos(cdp, {});
					if (!vids.length) return;
					const v = vids[0];
					const prev = state.last.get(t) ?? { currentTime: v.currentTime, stall: 0 };
					const progressed = v.currentTime > prev.currentTime + 0.05;
					const stall = progressed ? 0 : prev.stall + 1;
					state.last.set(t, { currentTime: v.currentTime, stall });
					const done = v.duration > 0 && v.currentTime >= v.duration - 1.5;
					if (done) return;
					if (v.paused) {
						await controlVideo(cdp, { path: [], index: 0, action: "play" }).catch(() => {});
						state.stats.plays += 1;
						push(`续播 ${t} @ ${Math.round(v.currentTime)}s / ${Math.round(v.duration)}s`);
					}
					if (!progressed && stall >= state.stallTicks) {
						state.stats.stalls += 1;
						if (state.autoReload) {
							await cdp.send("Page.reload", {}).catch(() => {});
							state.stats.reloads += 1;
							state.last.set(t, { currentTime: 0, stall: 0 });
							push(`停滞 ${stall} 次，重载 ${t}`);
						}
					}
				});
			} catch (e) {
				state.stats.errors += 1;
				push(`出错 ${t}: ${String(e?.message ?? e).slice(0, 120)}`);
			}
		}
	};

	state.timer = setInterval(() => {
		tick().catch(() => {});
	}, everyMs);
	if (state.timer.unref) state.timer.unref();
	guards.set(key, state);
	tick().catch(() => {});
	return state;
}

export function stopGuard(key) {
	const s = guards.get(key);
	if (!s) return false;
	s.running = false;
	if (s.timer) clearInterval(s.timer);
	return true;
}

export function guardStatus(key) {
	const s = guards.get(key);
	if (!s) return { running: false };
	return {
		running: s.running,
		targets: s.targets,
		everyMs: s.everyMs,
		ticks: s.ticks,
		elapsedSec: Math.round((Date.now() - s.startedAt) / 1000),
		stats: s.stats,
		progress: s.targets.map((t) => ({ target: t, ...(s.last.get(t) ?? {}) })),
		log: s.log.slice(-20),
	};
}

export function listGuards() {
	return [...guards.keys()];
}

