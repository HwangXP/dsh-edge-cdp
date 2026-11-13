// dsh-edge-cdp 自测：直接打真实 Edge（CDP），逐项验证 lib/cdp.js 的能力。
//
// 用法：
//   node scripts/selftest.mjs                 # 全部用例
//   node scripts/selftest.mjs frames mouse    # 只跑名字含这些词的用例
//
// 前置：Edge 已通过 edge_launch 启动（端口 9222），且当前页是 pkg-tmp/ooptif_test.html。
// 一条用例失败不会中断其他用例；退出码 = 失败数（0 = 全绿）。

import {
	CDP,
	pages,
	pickPage,
	withPage,
	frames,
	evalIn,
	centerOf,
	mouseClick,
	mouseMove,
	pressKey,
	typeText,
	watchDialogs,
	dialogState,
	handleDialog,
	startNetwork,
	listNetwork,
	responseBody,
	waitFor,
	httpJson,
	openTab,
	closeTarget,
	activateTarget,
	collectVideos,
	controlVideo,
	listFrames,
	evalInFrame,
	getCookies,
	setCookie,
	startGuard,
	stopGuard,
	guardStatus,
	download,
} from "../lib/cdp.js";
import { stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.EDGE_PORT ?? 9222);
const TIMEOUT = 15000;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
	pass += 1;
	console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
}

function bad(name, err) {
	fail += 1;
	failures.push({ name, err: String(err?.message ?? err) });
	console.log(`  ✗ ${name} — ${String(err?.message ?? err).slice(0, 200)}`);
}

async function test(name, fn) {
	try {
		const detail = await fn();
		ok(name, detail);
	} catch (err) {
		bad(name, err);
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

const filter = process.argv.slice(2);

function wanted(name) {
	if (!filter.length) return true;
	return filter.some((f) => name.toLowerCase().includes(f.toLowerCase()));
}

const suite = [];
const add = (name, fn) => suite.push({ name, fn });

// ---------------- 用例 ----------------

add("status", async () => {
	assert(await httpJson(PORT, "/json/version"), "调试端口不可用");
	return "调试端口在线";
});

add("pages + pickPage", async () => {
	const list = await pages(PORT);
	assert(list.length > 0, "没有页面");
	const first = pickPage(list, {});
	assert(first.webSocketDebuggerUrl, "pickPage 没返回 ws");
	let threw = false;
	try {
		pickPage(list, { urlMatch: "__no_such_url__" });
	} catch {
		threw = true;
	}
	assert(threw, "urlMatch 未命中时应当报错");
	return `${list.length} 个页面`;
});

add("evalIn 顶层文档", async () => {
	const r = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		return await evalIn(cdp, "JSON.stringify({title: document.title, h1: document.querySelector('#h1')?.textContent})");
	});
	const o = JSON.parse(r);
	assert(o.h1 && o.h1.includes("selftest"), "读不到 #h1");
	return o.title;
});

add("frames 列出跨域 iframe", async () => {
	const list = await withPage(PORT, TIMEOUT, {}, async (cdp) => await frames(cdp));
	assert(list.length >= 2, `只找到 ${list.length} 个 iframe target（应 ≥2）`);
	assert(list.some((f) => f.sessionId), "没有拿到任何 sessionId");
	return `${list.length} 个跨域 iframe`;
});

add("attach 后在跨域 iframe 内 eval", async () => {
	const out = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		const list = await frames(cdp);
		const f = list.find((x) => x.sessionId && /example\.(com|org)/.test(x.url));
		assert(f, "没有可用 sessionId 的 iframe");
		const r = await evalIn(cdp, "JSON.stringify({href: location.href, len: document.body.innerHTML.length})", {
			sessionId: f.sessionId,
		});
		return JSON.parse(r);
	});
	assert(out.href.startsWith("http"), `iframe 内的 href 不对: ${out.href}`);
	return `${out.href.slice(0, 40)} (${out.len} 字节 DOM)`;
});

add("centerOf 算元素中心", async () => {
	const c = await withPage(PORT, TIMEOUT, {}, async (cdp) => await centerOf(cdp, "#btn"));
	assert(c && c.x > 0 && c.y > 0, "没拿到坐标");
	return `#btn @ (${Math.round(c.x)}, ${Math.round(c.y)})`;
});

add("真实鼠标点击（Input.dispatchMouseEvent）", async () => {
	const n = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await evalIn(cdp, "window.__clicked = 0");
		const c = await centerOf(cdp, "#btn");
		assert(c, "定位失败");
		await mouseClick(cdp, c.x, c.y, { steps: 4 });
		await new Promise((r) => setTimeout(r, 300));
		return await evalIn(cdp, "String(window.__clicked || 0)");
	});
	assert(Number(n) === 1, `点击计数应为 1，实际 ${n}`);
	return "onclick 被真实点击触发";
});

add("真实键盘输入（insertText + Enter）", async () => {
	const v = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await evalIn(cdp, "document.querySelector('#inp').focus(); document.querySelector('#inp').value = '';");
		await typeText(cdp, "hello 中文");
		await pressKey(cdp, "Enter");
		await new Promise((r) => setTimeout(r, 200));
		return await evalIn(cdp, "document.querySelector('#inp').value");
	});
	assert(v === "hello 中文", `输入框内容不对: ${JSON.stringify(v)}`);
	return "文本 + Enter 都生效";
});

add("对话框捕获与确认", async () => {
	const msg = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		watchDialogs(cdp, "test-dialog");
		await cdp.send("Page.enable");
		// 不要 await alert：它会把渲染进程挂住，我们靠事件拿消息再 handle
		await evalIn(cdp, "setTimeout(() => alert('selftest-dialog'), 50); 'scheduled'");
		let got = null;
		for (let i = 0; i < 40; i += 1) {
			await new Promise((r) => setTimeout(r, 100));
			const st = dialogState("test-dialog");
			if (st.last) {
				got = st.last;
				break;
			}
		}
		assert(got, "没有收到 Page.javascriptDialogOpening");
		await handleDialog(cdp, { accept: true });
		return got.message;
	});
	assert(msg.includes("selftest-dialog"), `对话框消息不对: ${msg}`);
	return "捕获并已确认";
});

add("网络捕获 + 取响应体", async () => {
	const rows = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await startNetwork(cdp, "test-net");
		await evalIn(cdp, "fetch('https://example.com/__net_probe__').then(r => r.text()).catch(e => String(e))");
		await new Promise((r) => setTimeout(r, 1500));
		return listNetwork("test-net", { filter: "__net_probe__", limit: 5 });
	});
	assert(rows.length > 0, "没抓到这个请求");
	const row = rows[rows.length - 1];
	return `${row.method} ${row.status} ${row.url.slice(-20)}`;
});

add("waitFor 等选择器出现", async () => {
	const r = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await evalIn(cdp, "document.querySelector('#late').innerHTML = ''");
		await evalIn(cdp, "setTimeout(() => { const d=document.createElement('div'); d.id='late-child'; d.textContent='x'; document.querySelector('#late').appendChild(d); }, 700); 'ok'");
		return await waitFor(cdp, { selector: "#late-child", timeoutMs: 5000 });
	});
	assert(r.ok, `等待失败: ${JSON.stringify(r)}`);
	return `${r.elapsedMs} ms 命中`;
});

add("waitFor 超时返回 ok:false 而不是抛异常", async () => {
	const r = await withPage(PORT, TIMEOUT, {}, async (cdp) => await waitFor(cdp, { selector: "#never-appears", timeoutMs: 800, intervalMs: 100 }));
	assert(r.ok === false, "超时应当返回 ok:false");
	return `${r.elapsedMs} ms 超时`;
});

// ---------------- 0.3.0 用例 ----------------

add("tab open / list / activate / close", async () => {
	const r = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		const { targetId } = await openTab(cdp, "about:blank");
		await new Promise((r2) => setTimeout(r2, 700));
		const list = await pages(PORT);
		const found = list.some((p) => p.id === targetId);
		await activateTarget(cdp, targetId);
		await closeTarget(cdp, targetId);
		return { targetId, found, total: list.length };
	});
	assert(r.found, "新开的标签页没出现在 /json 里");
	return `${r.targetId.slice(0, 8)} · 当时共 ${r.total} 个页面`;
});

add("video list 找到 <video>", async () => {
	const vids = await withPage(PORT, TIMEOUT, {}, async (cdp) => await collectVideos(cdp, {}));
	assert(vids.length >= 1, `没找到 video（${vids.length}）`);
	return `${vids.length} 个 · duration=${Math.round(vids[0].duration)}s`;
});

add("video mute / unmute / rate", async () => {
	const r = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await controlVideo(cdp, { index: 0, action: "mute" });
		const m = await collectVideos(cdp, {});
		await controlVideo(cdp, { index: 0, action: "unmute" });
		const u = await collectVideos(cdp, {});
		await controlVideo(cdp, { index: 0, action: "rate", value: 1.5 });
		const r2 = await collectVideos(cdp, {});
		await controlVideo(cdp, { index: 0, action: "rate", value: 1 });
		return { muted: m[0].muted, unmuted: u[0].muted, rate: r2[0].rate };
	});
	assert(r.muted === true && r.unmuted === false, "静音切换不生效");
	assert(Math.abs(r.rate - 1.5) < 0.01, `倍速不对: ${r.rate}`);
	return "mute / unmute / rate 都生效";
});

add("video play 后 currentTime 前进", async () => {
	const ct = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await controlVideo(cdp, { index: 0, action: "seek", value: 0 });
		await controlVideo(cdp, { index: 0, action: "play" });
		let cur = 0;
		for (let i = 0; i < 20; i += 1) {
			await new Promise((r) => setTimeout(r, 500));
			const v = await collectVideos(cdp, {});
			cur = v[0]?.currentTime ?? 0;
			if (cur > 1.2) break;
		}
		return cur;
	});
	assert(ct > 1.2, `播放没前进: currentTime=${ct}`);
	return `${ct.toFixed(1)}s`;
});

add("frames list 找到同源 iframe", async () => {
	const list = await withPage(PORT, TIMEOUT, {}, async (cdp) => await listFrames(cdp));
	assert(list.length >= 1, `没找到 iframe（${list.length}）`);
	assert(list.some((f) => f.accessible), "没有可读的同源 iframe");
	return `${list.length} 个（可读 ${list.filter((f) => f.accessible).length}）`;
});

add("frames eval 在同源 iframe 内", async () => {
	const v = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		const list = await listFrames(cdp);
		const f = list.find((x) => x.accessible);
		assert(f, "没有可读 iframe");
		return await evalInFrame(cdp, { path: f.path, expression: "doc.getElementById('inner-p').textContent" });
	});
	assert(String(v).includes("hello inner"), `读到: ${v}`);
	return String(v);
});

add("keep_playing 能把暂停的视频续上", async () => {
	await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await controlVideo(cdp, { index: 0, action: "seek", value: 0 });
		await controlVideo(cdp, { index: 0, action: "pause" });
	});
	startGuard(PORT, TIMEOUT, "selftest", { targets: ["ooptif_test"], everyMs: 1200, stallTicks: 8 });
	let ct = 0;
	for (let i = 0; i < 15; i += 1) {
		await new Promise((r) => setTimeout(r, 1000));
		ct = await withPage(PORT, TIMEOUT, {}, async (cdp) => (await collectVideos(cdp, {}))[0]?.currentTime ?? 0);
		if (ct > 2) break;
	}
	const st = guardStatus("selftest");
	stopGuard("selftest");
	await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		await controlVideo(cdp, { index: 0, action: "pause" }).catch(() => {});
	});
	assert(st.stats.plays >= 1, "守护没有执行续播");
	assert(ct > 2, `续播后没前进: ${ct}`);
	return `plays=${st.stats.plays} · currentTime=${ct.toFixed(1)}s`;
});

add("cookies set / get", async () => {
	const r = await withPage(PORT, TIMEOUT, {}, async (cdp) => {
		const okSet = await setCookie(cdp, { name: "__selftest", value: "1", url: "https://example.com", path: "/" });
		const list = await getCookies(cdp, { urls: ["https://example.com"] });
		return { okSet, hit: Boolean(list.find((c) => c.name === "__selftest")), total: list.length };
	});
	assert(r.okSet && r.hit, "写进去的 cookie 没读回来");
	return `example.com 下共 ${r.total} 条`;
});

add("download 存到本地文件", async () => {
	// 起一个本地服务，带 Content-Disposition: attachment —— 浏览器才会走"下载"而不是内联渲染
	const { createServer } = await import("node:http");
	const body = "edge-cdp download selftest ".repeat(80);
	const server = createServer((req, res) => {
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": 'attachment; filename="selftest.bin"',
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const target = join(tmpdir(), `edge-dl-selftest-${Date.now()}.bin`);
	try {
		const r = await withPage(PORT, TIMEOUT, {}, async (cdp) =>
			await download(cdp, { url: `http://127.0.0.1:${port}/file`, savePath: target, timeoutMs: 30000 }),
		);
		assert(r.ok, `下载失败: ${r.reason ?? ""}`);
		const st = await fsStat(target);
		assert(st.size === Buffer.byteLength(body), `大小不对: ${st.size} vs ${Buffer.byteLength(body)}`);
		return `${st.size} 字节`;
	} finally {
		server.close();
	}
});

// ---------------- 主流程 ----------------

console.log(`dsh-edge-cdp selftest · port ${PORT}`);
for (const { name, fn } of suite) {
	if (!wanted(name)) continue;
	await test(name, fn);
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
if (fail) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
}
process.exit(fail);
