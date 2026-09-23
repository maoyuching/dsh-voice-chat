/**
 * 朗读链路一键诊断：读 settings.local.json 里的生效配置，逐个引擎实际打一次
 * 合成请求，报出到底是"配置缺失"、"密钥不对"还是"网络/服务不通"。
 * 运行：node test/diagnose-tts.mjs
 * 会真的调用你配置的 TTS 接口（产生少量费用/请求），输出里的密钥已打码。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacySettings } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(HERE, "..", "settings.local.json");
const TTS_DEFAULTS = {
	mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", voice: "mimo_default" },
	custom: { baseUrl: "", model: "tts-1", voice: "alloy" },
	edge: { baseUrl: "", model: "", voice: "zh-CN-XiaoxiaoNeural" }
};

const mask = (s) => (s ? `${String(s).slice(0, 6)}…${String(s).slice(-4)}（${String(s).length} 字符）` : "(空)");
const slot = (saved, engine) => {
	const s = saved.tts && typeof saved.tts === "object" ? saved.tts[engine] : null;
	return s && typeof s === "object" ? s : {};
};
const pick = (v, dft) => (typeof v === "string" && v.trim() ? v.trim() : dft);
const TEXT = "这是一条语音合成测试";

let raw = {};
try {
	raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
} catch {
	console.log(`（未找到 ${SETTINGS_FILE}，按默认值诊断）`);
}
const saved = migrateLegacySettings(raw);
const active = saved.ttsEngine || "edge";

console.log("=== 生效配置 ===");
console.log(`TTS 引擎: ${active}`);
for (const engine of ["edge", "mimo", "custom"]) {
	const s = slot(saved, engine);
	console.log(`  [${engine}] baseUrl=${pick(s.baseUrl, TTS_DEFAULTS[engine].baseUrl) || "(空)"} model=${pick(s.model, TTS_DEFAULTS[engine].model) || "(空)"} voice=${pick(s.voice, TTS_DEFAULTS[engine].voice) || "(空)"} apiKey=${mask(pick(s.apiKey, ""))}`);
}
console.log(`ASR 引擎: ${saved.asrEngine || "siliconflow"}`);

const out = (name, buf) => {
	const file = path.join(process.env.TEMP || ".", name);
	return writeFile(file, buf).then(() => file);
};

// ---------- 1) Edge TTS ----------
console.log("\n=== 1. Edge TTS（微软免费）===");
try {
	const { synthesizeSpeech } = await import("../lib/edge-tts.js");
	const edgeVoice = pick(slot(saved, "edge").voice, "zh-CN-XiaoxiaoNeural");
	const t0 = Date.now();
	const audio = await synthesizeSpeech({ text: TEXT, voice: edgeVoice, rate: "+10%", pitch: "+0Hz" });
	console.log(`  ✓ 合成成功 ${audio.length} 字节 / ${Date.now() - t0}ms → ${await out("dsh-tts-edge.mp3", audio)}`);
} catch (err) {
	console.log(`  ✗ 失败: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------- 2) MiMo TTS ----------
console.log("\n=== 2. MiMo TTS（chat/completions）===");
{
	const s = slot(saved, "mimo");
	const baseUrl = pick(s.baseUrl, TTS_DEFAULTS.mimo.baseUrl);
	const apiKey = pick(s.apiKey, "");
	if (!apiKey) {
		console.log("  ✗ 未配置 API Key");
	} else {
		const endpoint = /\/chat\/completions\/?$/i.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
		console.log(`  端点: ${endpoint}`);
		try {
			const t0 = Date.now();
			const resp = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", "api-key": apiKey, Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({
					model: pick(s.model, TTS_DEFAULTS.mimo.model),
					messages: [
						{ role: "user", content: "请把 assistant 消息里的文本合成语音" },
						{ role: "assistant", content: TEXT }
					],
					audio: { format: "mp3", voice: pick(s.voice, TTS_DEFAULTS.mimo.voice) }
				})
			});
			const body = await resp.json().catch(() => ({}));
			if (!resp.ok) {
				console.log(`  ✗ HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 400)}`);
			} else {
				const data = body?.choices?.[0]?.message?.audio?.data;
				if (typeof data === "string" && data) {
					const audio = Buffer.from(data, "base64");
					console.log(`  ✓ 合成成功 ${audio.length} 字节 / ${Date.now() - t0}ms → ${await out("dsh-tts-mimo.mp3", audio)}`);
				} else {
					console.log(`  ✗ 响应里没有音频数据: ${JSON.stringify(body).slice(0, 400)}`);
				}
			}
		} catch (err) {
			console.log(`  ✗ 请求失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ---------- 3) 自定义 TTS ----------
console.log("\n=== 3. 自定义 TTS（OpenAI 兼容 /audio/speech）===");
{
	const s = slot(saved, "custom");
	const baseUrl = pick(s.baseUrl, TTS_DEFAULTS.custom.baseUrl);
	const apiKey = pick(s.apiKey, "");
	if (!baseUrl) {
		console.log("  ✗ 未配置 Base URL");
	} else {
		const endpoint = `${baseUrl.replace(/\/+$/, "")}/audio/speech`;
		console.log(`  端点: ${endpoint}`);
		try {
			const t0 = Date.now();
			const headers = { "Content-Type": "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const resp = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: pick(s.model, TTS_DEFAULTS.custom.model), input: TEXT, voice: pick(s.voice, TTS_DEFAULTS.custom.voice) })
			});
			if (!resp.ok) {
				const detail = await resp.text().catch(() => "");
				console.log(`  ✗ HTTP ${resp.status}: ${detail.slice(0, 400)}`);
			} else {
				const audio = Buffer.from(await resp.arrayBuffer());
				console.log(`  ✓ 合成成功 ${audio.length} 字节 / ${Date.now() - t0}ms → ${await out("dsh-tts-custom.mp3", audio)}`);
			}
		} catch (err) {
			console.log(`  ✗ 请求失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// ---------- 4) 本地服务端口探测（自定义/ASR 常用） ----------
console.log("\n=== 4. 本地端口连通性 ===");
for (const [label, url] of [
	["自定义 TTS", pick(slot(saved, "custom").baseUrl, "")],
	["自定义 ASR", typeof saved.asr?.custom?.baseUrl === "string" ? saved.asr.custom.baseUrl : ""]
]) {
	if (!url) continue;
	const probe = url.replace(/\/+$/, "") + "/models";
	try {
		const resp = await fetch(probe, { method: "GET", signal: AbortSignal.timeout(4000) });
		console.log(`  ${label} ${probe} → HTTP ${resp.status}`);
	} catch (err) {
		console.log(`  ${label} ${probe} → 连不上: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------- 5) 宿主路由实测（浏览器实际调的就是这两个） ----------
// 用真实的 settings.local.json 跑一遍插件的 /tts 与 /speak 处理函数：
// 报 200 说明整条链路通；报 4xx/5xx 就是朗读不生效的直接原因。
console.log("\n=== 5. 宿主路由实测（/tts、/speak）===");
try {
	const { apply } = await import("../lib/index.js");
	const routes = new Map();
	const httpCtx = {
		webServer: { register(entry) { routes.set(entry.path, entry.handler); return () => routes.delete(entry.path); } },
		effect(fn) { return fn(); },
		get() { return undefined; },
		llm: {
			async *stream() {
				yield { type: "text-delta", text: "这是转述后的测试文本" };
				yield { type: "finish", reason: { kind: "stop" } };
			}
		},
		sessions: {}
	};
	apply({ inject(deps, fn) { fn(httpCtx); } }, {});
	const call = async (routePath, req) => {
		const captured = {};
		const res = {
			writeHead(status) { captured.status = status; },
			end(body) { captured.body = body; }
		};
		await routes.get(routePath)(req, res);
		return captured;
	};
	const getReq = (url) => ({ method: "GET", url });
	const postReq = (url, payload) => ({
		method: "POST", url,
		async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload), "utf8"); }
	});
	for (const [label, routePath, req] of [
		["GET /tts", "/dsh-voice-chat/tts", getReq("/dsh-voice-chat/tts?text=" + encodeURIComponent(TEXT))],
		["POST /speak", "/dsh-voice-chat/speak", postReq("/dsh-voice-chat/speak", { text: TEXT })]
	]) {
		const { status, body } = await call(routePath, req);
		if (status === 200 && Buffer.isBuffer(body)) {
			console.log(`  ${label} → 200，音频 ${body.length} 字节 → ${await out(`dsh-tts-route-${label.includes("speak") ? "speak" : "tts"}.mp3`, body)}`);
		} else {
			let detail = body;
			try { detail = JSON.parse(String(body)).error; } catch { /* 原样显示 */ }
			console.log(`  ${label} → ${status}：${String(detail).slice(0, 300)}`);
		}
	}
} catch (err) {
	console.log(`  ✗ 路由实测异常: ${err instanceof Error ? err.message : String(err)}`);
}
