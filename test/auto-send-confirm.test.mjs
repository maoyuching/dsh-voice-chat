/**
 * 「识别完自动发送」确认条自测（端到端）。
 *
 * 需求：勾了自动发送后，识别完成先把文字**放进输入框**，再弹一条
 * **不遮挡正文**的确认条，5 秒倒计时结束后自动发送；5 秒内点「取消」
 * 则不发送，文字留在输入框里让用户自己改。
 *
 * 覆盖：
 *   1) 不会「填完就立刻发」（旧行为）——确认条期间 submit 一次都不该调；
 *   2) 文字确实先进了输入框（setDraft）；
 *   3) 点「取消」→ 不发送，条子消失，文字还在输入框；
 *   4) 倒计时走完 5 秒 → 自动发送一次；
 *   5) 倒计时期间用户自己发了 → 不再自动发第二次。
 *
 * 运行：node test/auto-send-confirm.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.join(HERE, "..", "lib", "client.js");

// ---------- 极简 React 桩 ----------
function createReactStub() {
	const states = [];
	const refs = [];
	const effects = [];
	let cursor = 0;
	const createElement = (type, props, ...children) => ({
		type,
		props: props || {},
		children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
	});
	const React = {
		Fragment: Symbol("Fragment"),
		createElement,
		useState(init) {
			const i = cursor++;
			if (!(i in states)) states[i] = typeof init === "function" ? init() : init;
			const set = (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; };
			return [states[i], set];
		},
		useRef(init) {
			const i = cursor++;
			if (!(i in refs)) refs[i] = { current: init };
			return refs[i];
		},
		useEffect(fn, deps) {
			const i = cursor++;
			const prev = effects[i];
			const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length
				|| deps.some((d, k) => d !== prev.deps[k]);
			// 依赖变了 → 先跑上一次的清理（React 的真实语义：旧 effect 先清理再重跑）
			if (changed && prev && typeof prev.cleanup === "function") {
				try { prev.cleanup(); } catch (err) { /* ignore */ }
			}
			effects[i] = { fn, deps, pending: changed, cleanup: null };
		},
		useCallback(fn) { return fn; },
		useMemo(fn) { return fn(); }
	};
	return {
		React,
		beginRender() { cursor = 0; },
		runEffects() {
			for (const entry of effects) {
				if (!entry || !entry.pending) continue;
				entry.pending = false;
				const cleanup = entry.fn();
				entry.cleanup = typeof cleanup === "function" ? cleanup : null;
			}
		}
	};
}

// ---------- 极简 DOM 桩 ----------
function createStyleStub() {
	const style = {};
	Object.defineProperty(style, "cssText", {
		set(v) {
			for (const part of String(v).split(";")) {
				const idx = part.indexOf(":");
				if (idx < 0) continue;
				style[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
			}
		},
		get() { return ""; },
		enumerable: false,
		configurable: true
	});
	return style;
}

function createElementStub(tag) {
	return {
		tagName: String(tag).toUpperCase(),
		style: createStyleStub(),
		children: [],
		parentNode: null,
		textContent: "",
		disabled: false,
		title: "",
		_listeners: {},
		setAttribute(name, value) { this[name] = value; },
		getAttribute(name) { return this[name]; },
		appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
		removeChild(child) {
			const i = this.children.indexOf(child);
			if (i >= 0) this.children.splice(i, 1);
			child.parentNode = null;
			return child;
		},
		addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
		removeEventListener(type, fn) {
			const arr = this._listeners[type] || [];
			const i = arr.indexOf(fn);
			if (i >= 0) arr.splice(i, 1);
		},
		getBoundingClientRect() {
			return { left: 0, top: 0, right: 140, bottom: 40, width: 140, height: 40 };
		}
	};
}

function createDocumentStub() {
	return {
		body: createElementStub("body"),
		createElement: (tag) => createElementStub(tag),
		querySelectorAll: () => [],
		addEventListener: () => {},
		removeEventListener: () => {}
	};
}

// ---------- 可控时钟（假定时器） ----------
function createClock() {
	let now = 0;
	let seq = 0;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(fn, ms) {
			const id = ++seq;
			timers.set(id, { fn, due: now + (ms || 0), step: null });
			return id;
		},
		clearTimeout(id) { timers.delete(id); },
		setInterval(fn, ms) {
			const id = ++seq;
			timers.set(id, { fn, due: now + (ms || 0), step: Math.max(1, ms || 1) });
			return id;
		},
		clearInterval(id) { timers.delete(id); },
		requestAnimationFrame() { return 0; },   // 滑条动画不影响被测逻辑
		cancelAnimationFrame() {},
		/** 把时间往前推 ms，并按到期顺序执行定时器。 */
		advance(ms) {
			const target = now + ms;
			let guard = 0;
			while (guard++ < 100000) {
				let bestId = null;
				let bestDue = Infinity;
				for (const [id, t] of timers) {
					if (t.due <= target && t.due < bestDue) { bestDue = t.due; bestId = id; }
				}
				if (bestId === null) break;
				const best = timers.get(bestId);
				now = bestDue;
				if (best.step) best.due = now + best.step;
				else timers.delete(bestId);
				best.fn();
			}
			now = target;
		}
	};
}

// ---------- 假 MediaRecorder ----------
function createMediaRecorderClass(record) {
	return class FakeMediaRecorder {
		constructor(stream, opts) {
			this.stream = stream;
			this.mimeType = (opts && opts.mimeType) || "audio/webm";
			this.state = "inactive";
			this.ondataavailable = null;
			this.onstop = null;
			this.onerror = null;
			record.instance = this;
		}
		start() { this.state = "recording"; }
		stop() {
			this.state = "inactive";
			// 先吐一段音频数据（真实浏览器停止时会先发 ondataavailable）
			if (typeof this.ondataavailable === "function") {
				this.ondataavailable({ data: new Blob(["fake-audio"], { type: this.mimeType }) });
			}
			if (typeof this.onstop === "function") this.onstop();
		}
		static isTypeSupported() { return true; }
	};
}

// ---------- 元素树工具 ----------
function walk(node, visit) {
	if (!node || typeof node !== "object") return;
	visit(node);
	for (const child of node.children || []) walk(child, visit);
}
function textOf(node) {
	if (typeof node === "string") return node;
	if (!node || typeof node !== "object") return "";
	return (node.children || []).map(textOf).join("");
}
function findByText(tree, needle) {
	let found = null;
	walk(tree, (node) => {
		if (!found && textOf(node).includes(needle)) found = node;
	});
	return found;
}
/** 按文字找按钮（父 span 的 text 也含按钮文字，所以要按类型筛）。 */
function findButtonByText(tree, needle) {
	let found = null;
	walk(tree, (node) => {
		if (!found && node.type === "button" && textOf(node).includes(needle)) found = node;
	});
	return found;
}
/** 按 title 找按钮（麦克风按钮的 title 会随录音状态变化）。 */
function findButtonByTitle(tree, needle) {
	let found = null;
	walk(tree, (node) => {
		if (!found && node.type === "button" && typeof node.props?.title === "string"
			&& node.props.title.includes(needle)) found = node;
	});
	return found;
}

// ---------- 加载插件客户端 ----------
async function loadInputRight(reactStub, documentStub, clock, fetchImpl) {
	const src = await readFile(CLIENT_SRC, "utf8");
	let captured = null;
	const recorderRecord = {};
	const FakeMediaRecorder = createMediaRecorderClass(recorderRecord);
	const windowStub = {
		fetch: fetchImpl,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		requestAnimationFrame: clock.requestAnimationFrame,
		cancelAnimationFrame: clock.cancelAnimationFrame,
		addEventListener: () => {},
		removeEventListener: () => {},
		innerWidth: 1280,
		innerHeight: 800,
		speechSynthesis: null,
		__ModuleLoader__: { load(spec) { captured = spec; } }
	};
	const fn = new Function(
		"window", "console", "navigator", "setTimeout", "clearTimeout", "URL", "document", "MediaRecorder",
		src
	);
	// 测试环境没有 AudioContext，静音监听必然报错——这是预期噪声，吞掉它
	const quietConsole = {
		log: (...a) => console.log(...a),
		warn: (...a) => console.warn(...a),
		error: (...a) => {
			if (String(a[0] ?? "").includes("silence monitor failed")) return;
			console.error(...a);
		}
	};
	fn(
		windowStub, quietConsole,
		{ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		clock.setTimeout, clock.clearTimeout, URL, documentStub, FakeMediaRecorder
	);
	assert.ok(captured && typeof captured.factory === "function", "client.js 应注册 factory");
	const requireStub = (name) => {
		if (name === "react") return reactStub.React;
		throw new Error("unexpected require: " + name);
	};
	const exportsObj = captured.factory(requireStub);
	const registered = {};
	const fakeSlots = {
		inject(name, fn) { return fn(); },
		register(meta, component) { registered[meta.name] = component; return () => {}; }
	};
	exportsObj.apply({
		get: (name) => (name === "slots" ? fakeSlots : undefined),
		inject: (deps, fn) => fn({ slots: fakeSlots, modelDirectories: null })
	});
	return { InputRight: registered["conversation.input.right"], recorderRecord };
}

// ---------- 用例 ----------
const reactStub = createReactStub();
const documentStub = createDocumentStub();
const clock = createClock();
const realNow = Date.now;
Date.now = () => clock.now();

// 宿主输入框状态：{ draft: "当前输入框里的文字" }
const inputState = { draft: "" };
const sent = [];
const setDraftCalls = [];

const fetchImpl = async (url) => {
	if (String(url).includes("/dsh-voice-chat/stt")) {
		return { ok: true, status: 200, json: async () => ({ text: "今天天气不错" }) };
	}
	return { ok: true, status: 200, json: async () => ({}) };
};

const { InputRight } = await loadInputRight(reactStub, documentStub, clock, fetchImpl);

const props = {
	useSession: (selector) => selector({ id: "s1", running: false }),
	useInput: () => inputState,
	useCurrentModel: () => null,
	inputActions: {
		setDraft(value) { setDraftCalls.push(value); inputState.draft = value; },
		submit() { sent.push(inputState.draft); }
	},
	sessionId: "s1"
};

function resolve(el) {
	let node = el;
	while (node && typeof node === "object" && typeof node.type === "function") node = node.type(node.props);
	return node;
}
function render() {
	reactStub.beginRender();
	const root = resolve(InputRight(props));
	reactStub.runEffects();
	return root;
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

let tree = render();

/** 走一遍：点麦克风 → 开始录音 → 再点一次停止 → 触发转写。 */
async function dictate() {
	inputState.draft = "";   // 每次从空输入框开始（听写结果是与已有内容拼接的）
	tree = render();
	const micBtn = findButtonByTitle(tree, "点击开始聆听");
	assert.ok(micBtn, "应渲染出麦克风按钮");
	micBtn.props.onClick();
	await flush();
	tree = render();
	// 再点一次 = 手动结束录音（触发 onstop → 转写）
	const micBtn2 = findButtonByTitle(tree, "点击结束并发送");
	assert.ok(micBtn2, "录音中时按钮应变成「点击结束并发送」");
	micBtn2.props.onClick();
	await flush();
	await flush();
	tree = render();
}

await dictate();

await test("识别完成后：文字先放进输入框，但不立刻发送", () => {
	assert.deepEqual(setDraftCalls, ["今天天气不错"], "应先把转写结果填进输入框");
	assert.equal(sent.length, 0, "确认条期间不能自动发送（旧行为是立刻发）");
	assert.equal(inputState.draft, "今天天气不错", "输入框里应有转写内容");
});

await test("确认条出现了：待发送内容直接摆在条子上 + 倒计时 + 「取消」", () => {
	assert.ok(findByText(tree, "今天天气不错"), "条子上应直接显示待发送内容（不用在条子和输入框之间来回看）");
	assert.ok(findByText(tree, "秒后发送"), "应显示倒计时");
	const cancel = findButtonByText(tree, "取消");
	assert.ok(cancel, "应有「取消」按钮");
	assert.equal(cancel.type, "button");
});

await test("点「取消」→ 不发送，文字留在输入框", () => {
	const before = sent.length;
	findButtonByText(tree, "取消").props.onClick();
	tree = render();
	assert.equal(sent.length, before, "取消后不能发送");
	assert.equal(inputState.draft, "今天天气不错", "取消后文字应留在输入框里（还能改）");
	assert.equal(findByText(tree, "秒后发送"), null, "取消后确认条应消失");
});

await test("倒计时走完 5 秒 → 自动发送一次", async () => {
	const before = sent.length;
	await dictate();
	assert.equal(sent.length, before, "还没到时间，不该发");
	clock.advance(4999);
	assert.equal(sent.length, before, "还差 1ms，不该发");
	clock.advance(2);
	assert.equal(sent.length, before + 1, `到点应自动发送一次（sent=${sent.length} before=${before}）`);
	assert.equal(sent[sent.length - 1], "今天天气不错");
	tree = render();
	assert.equal(findByText(tree, "秒后发送"), null, "发送后确认条应消失");
});

await test("倒计时期间用户自己发了 → 不会再自动发第二次", async () => {
	const before = sent.length;
	await dictate();
	// 模拟用户手动发送：输入框被清空
	inputState.draft = "";
	tree = render();
	clock.advance(6000);
	assert.equal(sent.length, before, "用户已自己发送，不该再自动发一次");
});

Date.now = realNow;
console.log(`\n${passed} 项通过${process.exitCode ? "（存在失败）" : ""}`);
