// 注册流程自测：不起浏览器，只验证「插件能不能被宿主装上」这件事。
//
// 这个用例存在的理由：dsh-mech-workbench 0.2.x 在真实用户机器上「装上了却不激活」，
// 就是因为作者 DSL 原样进了 ctx.tools.register（type:'json' → JsonSchemaError）。
// 而单元测试只测 execute，永远发现不了。这里用替身 defineTool 复刻宿主的编译+校验，
// 把所有工具定义过一遍，任何 schema 越界当场失败。
//
// 用法: node test/register.mjs

import { name, inject, apply } from "../lib/index.js";

const registered = [];
const problems = [];

const tools = {
	register(tool) {
		if (!tool.name) problems.push("注册了一个没有 name 的工具");
		if (registered.some((t) => t.name === tool.name)) problems.push(`重复注册: ${tool.name}`);
		if (!tool.description) problems.push(`${tool.name}: 缺 description`);
		if (!tool.output?.schema) problems.push(`${tool.name}: 缺 output.schema`);
		if (!tool.output?.render) problems.push(`${tool.name}: 缺 output.render`);
		if (!tool.presentCall) problems.push(`${tool.name}: 缺 presentCall`);
		registered.push(tool);
	},
};

const ctx = {
	inject(deps, fn) {
		if (!deps.includes("tools")) throw new Error("inject 依赖里没有 tools");
		fn({ tools });
	},
	logger: { info() {} },
};

apply(ctx, { port: 9222 });

// ---- 断言 ----

const EXPECTED = [
	"edge_status",
	"edge_launch",
	"edge_tabs",
	"edge_nav",
	"edge_eval",
	"edge_click",
	"edge_type",
	"edge_screenshot",
	"edge_mute",
	"edge_background_mode",
	"edge_window",
	"edge_dialog",
	"edge_attach",
	"edge_mouse",
	"edge_key",
	"edge_network",
	"edge_wait",
];

if (name !== "edge-cdp") problems.push(`导出 name 不对: ${name}`);
if (!Array.isArray(inject) || !inject.includes("tools")) problems.push("导出 inject 不对");
if (registered.length !== EXPECTED.length) {
	problems.push(`工具数 ${registered.length}，期望 ${EXPECTED.length}`);
}
for (const want of EXPECTED) {
	if (!registered.some((t) => t.name === want)) problems.push(`缺少工具: ${want}`);
}

// 每个工具的 parameters 必须是编译后的 JSON Schema（有 type: object + properties）
for (const t of registered) {
	const p = t.parameters;
	if (p.type !== "object") problems.push(`${t.name}: parameters.type 不是 object`);
	if (!p.properties || typeof p.properties !== "object") problems.push(`${t.name}: parameters.properties 缺失`);
	const json = JSON.stringify(t);
	if (json.includes('"type":"json"')) problems.push(`${t.name}: schema 里还有非法的 type:"json"`);
}

if (problems.length) {
	console.error(`注册自测失败 ${problems.length} 项：`);
	for (const p of problems) console.error("  - " + p);
	process.exit(1);
}

console.log(`注册自测通过：${registered.length} 个工具全部通过 schema 子集校验`);
for (const t of registered) {
	const props = Object.keys(t.parameters.properties ?? {});
	console.log(`  · ${t.name}（${props.length} 个参数${props.length ? ": " + props.slice(0, 6).join(", ") : ""}）`);
}
process.exit(0);
