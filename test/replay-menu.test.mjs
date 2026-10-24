/**
 * 喇叭按钮右键菜单「播放上一次」自测。
 *
 * 覆盖两个回归点：
 *   1) 菜单必须挂在 document.body 顶层（position:fixed + 极高 z-index）。
 *      插件按钮在聊天输入栏里，那条栏通常带 backdrop-filter/transform，
 *      会给 fixed 后代创建"包含块 + 层叠上下文"——菜单若留在栏内，
 *      zIndex 再大也会被 DSH 自己的界面盖住（用户实测：菜单下半截被遮）。
 *   2) 菜单里只有一个可点项，没有多余的「取消」按钮
 *      （点外面 / Esc / 滚动 都能关，取消项是多余的）。
 *
 * 运行：node test/replay-menu.test.mjs
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
			effects[i] = { fn, deps, pending: changed };
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
				entry.fn();
			}
		}
	};
}

// ---------- 极简 DOM 桩 ----------
/** 支持 style.cssText = "a:1;b:2"（解析成独立属性，跟浏览器一致）。 */
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
		dispatch(type, event) {
			for (const fn of (this._listeners[type] || []).slice()) fn(event);
		},
		getBoundingClientRect() {
			return { left: 0, top: 0, right: 140, bottom: 40, width: 140, height: 40 };
		}
	};
}

function createDocumentStub() {
	const body = createElementStub("body");
	return {
		body,
		createElement: (tag) => createElementStub(tag),
		querySelectorAll: () => [],
		addEventListener: () => {},
		removeEventListener: () => {}
	};
}

// ---------- 加载 client.js，拿到输入框右侧的工具栏组件 ----------
async function loadInputRight(reactStub, documentStub) {
	const src = await readFile(CLIENT_SRC, "utf8");
	let captured = null;
	const windowStub = {
		fetch: async () => ({ ok: true, json: async () => ({}) }),
		setTimeout: () => 0,
		clearTimeout: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		innerWidth: 1280,
		innerHeight: 800,
		speechSynthesis: null,
		__ModuleLoader__: { load(spec) { captured = spec; } }
	};
	const fn = new Function(
		"window", "console", "navigator", "setTimeout", "clearTimeout", "URL", "document",
		src
	);
	fn(windowStub, console, { mediaDevices: { getUserMedia: () => Promise.resolve({}) } }, () => 0, () => {}, URL, documentStub);
	assert.ok(captured && typeof captured.factory === "function", "client.js 应通过 __ModuleLoader__.load 注册 factory");
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
	assert.equal(typeof registered["conversation.input.right"], "function", "应注册 conversation.input.right 组件");
	return registered["conversation.input.right"];
}

/** 在元素树里找带 title 含「右键播放上一次」的喇叭按钮。 */
function findSpeakerButton(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if (node.type === "button" && typeof node.props?.title === "string"
		&& node.props.title.includes("右键播放上一次")) {
		out.push(node);
	}
	for (const child of node.children || []) findSpeakerButton(child, out);
	return out;
}

// ---------- 用例 ----------
const reactStub = createReactStub();
const documentStub = createDocumentStub();
const InputRight = await loadInputRight(reactStub, documentStub);

const props = {
	useSession: (selector) => selector({ id: "s1", running: false }),
	useInput: (selector) => selector({ text: "" }),
	useCurrentModel: () => null,
	inputActions: { setDraft() {}, submit() {} },
	sessionId: "s1"
};

/** React 桩不会自动调用函数组件，这里手动把外层组件解包成宿主元素树。 */
function resolve(el) {
	let node = el;
	while (node && typeof node === "object" && typeof node.type === "function") {
		node = node.type(node.props);
	}
	return node;
}

function render() {
	reactStub.beginRender();
	const root = resolve(InputRight(props));
	reactStub.runEffects();
	return root;
}

// 首渲染
render();
assert.equal(documentStub.body.children.length, 0, "未右键时不该往 body 里塞菜单");

// 模拟在喇叭按钮上右键
const tree = render();
const [speakerBtn] = findSpeakerButton(tree);
assert.ok(speakerBtn, "应渲染出喇叭按钮");
speakerBtn.props.onContextMenu({
	preventDefault() {},
	clientX: 640,
	clientY: 780
});

// 右键后重新渲染 + 跑 effect
render();

const menus = documentStub.body.children.filter((c) => c.getAttribute("data-replay-menu") !== undefined);
assert.equal(menus.length, 1, "右键后应往 body 顶层挂出且只挂一个菜单");
const menu = menus[0];

// 1) 固定定位 + 极高 z-index：逃出输入栏的层叠上下文，不会被 DSH 界面盖住
assert.match(String(menu.style.position), /fixed/, "菜单应 position:fixed");
const z = Number(String(menu.style["z-index"]));
assert.ok(Number.isFinite(z) && z >= 2147483000, `菜单 z-index 应足够高（实际 ${menu.style.zIndex}）`);
assert.equal(menu.style.left, "640px", "菜单应定位在右键位置");
assert.equal(menu.style.top, "780px", "菜单应定位在右键位置");

// 2) 只有一个可点项，没有多余的「取消」
assert.equal(menu.children.length, 1, "菜单应只有一个条目（取消按钮是多余的）");
const item = menu.children[0];
assert.equal(item.tagName, "BUTTON", "菜单项应是按钮");
assert.match(item.textContent, /播放上一次/, "菜单项应是「播放上一次」");
assert.doesNotMatch(item.textContent, /取消/, "菜单里不该再有「取消」");

console.log("✓ 右键菜单挂在 body 顶层（fixed + 极高 z-index），不会被 DSH 界面遮住");
console.log("✓ 菜单只有「播放上一次」一项，没有多余的「取消」");
