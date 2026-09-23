/**
 * dsh-voice-chat 设置层自测：ASR/TTS 各引擎的配置必须彼此隔离（不串味），
 * 旧版扁平配置要能无损迁移。运行：node test/settings.test.mjs
 */
import assert from "node:assert/strict";
import {
	buildPublicSlots,
	migrateLegacySettings,
	mergeSettings,
	resolveAsrConfig,
	resolveTtsConfig,
	resolveTtsEngine,
	sanitizeSettings
} from "../lib/index.js";

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`FAIL  ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

// 用户实际遇到的旧配置：MiMo 的凭据被"自定义 TTS"覆盖、音色残留在另一引擎
const LEGACY_USER_FILE = {
	asrBaseUrl: "http://127.0.0.1:52625/v1",
	asrModel: "whisper-v3",
	asrApiKey: "flm",
	ttsVoice: "Mia",
	autoSend: false,
	silenceMs: 2000,
	rewrite: true,
	ttsEngine: "edge",
	ttsBaseUrl: "http://127.0.0.1:52992/v1",
	ttsModel: "kokoro-82m-zh",
	ttsApiKey: "sk-custom",
	asrEngine: "custom"
};

console.log("旧版扁平配置 → 按引擎分槽迁移");
test("ASR 凭据归到选中的 custom 引擎", () => {
	const m = migrateLegacySettings(LEGACY_USER_FILE);
	assert.deepEqual(m.asr.custom, {
		baseUrl: "http://127.0.0.1:52625/v1",
		model: "whisper-v3",
		apiKey: "flm"
	});
	assert.equal(m.asr.mimo, undefined);
	assert.equal(m.asr.siliconflow, undefined);
});

test("TTS 本地凭据归 custom、MiMo 音色 Mia 归 mimo（关键修复）", () => {
	const m = migrateLegacySettings(LEGACY_USER_FILE);
	assert.deepEqual(m.tts.custom, {
		baseUrl: "http://127.0.0.1:52992/v1",
		model: "kokoro-82m-zh",
		apiKey: "sk-custom"
	});
	assert.equal(m.tts.mimo.voice, "Mia");
	assert.equal(m.tts.edge, undefined, "Edge 不该被 custom 的 URL/密钥污染");
});

test("Edge 音色（Neural）归 edge，不被 MiMo 音色覆盖", () => {
	const m = migrateLegacySettings({ ttsEngine: "edge", ttsVoice: "zh-CN-YunxiNeural", ttsBaseUrl: "https://x/v1", ttsApiKey: "k" });
	assert.equal(m.tts.edge.voice, "zh-CN-YunxiNeural");
	assert.equal(m.tts.custom.apiKey, "k");
});

test("迁移幂等：已迁移的结构再迁移不变", () => {
	const once = migrateLegacySettings(LEGACY_USER_FILE);
	const twice = migrateLegacySettings(once);
	assert.deepEqual(twice.tts, once.tts);
	assert.deepEqual(twice.asr, once.asr);
});

test("ASR 的 chat/completions 端点归 mimo", () => {
	const m = migrateLegacySettings({ asrEngine: "siliconflow", asrBaseUrl: "https://api.xiaomimimo.com/v1/chat/completions", asrApiKey: "k" });
	assert.equal(m.asr.mimo.apiKey, "k");
	assert.equal(m.asr.siliconflow, undefined);
});

console.log("\n切换引擎互不覆盖（本次 bug 的核心）");
test("先配 MiMo、再配自定义 TTS，两边各留各的", () => {
	let saved = {};
	saved = mergeSettings(saved, sanitizeSettings({
		ttsEngine: "mimo",
		tts: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" } }
	}));
	saved = mergeSettings(saved, sanitizeSettings({
		ttsEngine: "custom",
		tts: { custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" } }
	}));
	assert.equal(saved.ttsEngine, "custom");
	assert.deepEqual(saved.tts.mimo, { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" });
	assert.deepEqual(saved.tts.custom, { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" });
	// 各引擎解析出的也是各自的值
	const cfg = {};
	assert.equal(resolveTtsConfig(cfg, saved, "mimo", "zh-CN-XiaoxiaoNeural").apiKey, "mimo-key");
	assert.equal(resolveTtsConfig(cfg, saved, "custom", "zh-CN-XiaoxiaoNeural").apiKey, "custom-key");
	assert.equal(resolveTtsConfig(cfg, saved, "custom", "zh-CN-XiaoxiaoNeural").baseUrl, "http://127.0.0.1:52992/v1");
});

test("改 MiMo 的密钥不会动 ASR 或自定义 TTS", () => {
	let saved = mergeSettings({}, sanitizeSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: "http://127.0.0.1:52625/v1", model: "whisper-v3", apiKey: "flm" } },
		tts: { custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key" } }
	}));
	const before = JSON.parse(JSON.stringify(saved));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { mimo: { apiKey: "mimo-key2" } } }));
	assert.equal(saved.tts.mimo.apiKey, "mimo-key2");
	assert.deepEqual(saved.asr, before.asr);
	assert.deepEqual(saved.tts.custom, before.tts.custom);
	// 自定义 TTS 自己的 key 不受影响
	assert.equal(resolveTtsConfig({}, saved, "custom", "").apiKey, "custom-key");
});

test("三个 TTS 引擎的音色互相独立", () => {
	let saved = mergeSettings({}, sanitizeSettings({ tts: { edge: { voice: "zh-CN-YunxiNeural" } } }));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { mimo: { voice: "茉莉" } } }));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { custom: { voice: "Mia" } } }));
	assert.equal(resolveTtsConfig({}, saved, "edge", "zh-CN-XiaoxiaoNeural").voice, "zh-CN-YunxiNeural");
	assert.equal(resolveTtsConfig({}, saved, "mimo", "").voice, "茉莉");
	assert.equal(resolveTtsConfig({}, saved, "custom", "").voice, "Mia");
});

test("清空某引擎的字段只影响它自己", () => {
	let saved = mergeSettings({}, sanitizeSettings({
		tts: { mimo: { baseUrl: "https://a", apiKey: "k1" }, custom: { baseUrl: "https://b", apiKey: "k2" } }
	}));
	saved = mergeSettings(saved, sanitizeSettings({ tts: { mimo: { apiKey: "" } } }));
	assert.equal(saved.tts.mimo.apiKey, "");
	assert.equal(saved.tts.custom.apiKey, "k2");
});

console.log("\n旧版客户端（扁平键）兼容");
test("扁平键只落到当前选中的引擎槽里", () => {
	const saved = mergeSettings({ ttsEngine: "mimo" }, sanitizeSettings({
		ttsEngine: "mimo", ttsBaseUrl: "https://api.xiaomimimo.com/v1", ttsModel: "mimo-v2.5-tts", ttsApiKey: "old-key", ttsVoice: "冰糖"
	}));
	assert.deepEqual(saved.tts.mimo, { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "old-key", voice: "冰糖" });
	assert.equal(saved.tts.custom, undefined);
});

test("Edge 不接收旧版的 URL/模型/密钥（只收音色）", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		ttsEngine: "edge", ttsBaseUrl: "http://127.0.0.1:52992/v1", ttsModel: "kokoro", ttsApiKey: "k", ttsVoice: "zh-CN-XiaoxiaoNeural"
	}));
	assert.deepEqual(saved.tts.edge, { voice: "zh-CN-XiaoxiaoNeural" });
	assert.equal(saved.tts.custom, undefined);
});

test("保存结果里不再保留旧版扁平键", () => {
	const saved = mergeSettings(LEGACY_USER_FILE, sanitizeSettings({ silenceMs: 3000 }));
	for (const key of ["asrBaseUrl", "asrModel", "asrApiKey", "ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"]) {
		assert.equal(key in saved, false, `${key} 应被清理`);
	}
});

test("老客户端只改静音时长也不会丢配置", () => {
	const saved = mergeSettings(LEGACY_USER_FILE, sanitizeSettings({ silenceMs: 3000 }));
	assert.equal(saved.silenceMs, 3000);
	assert.equal(saved.asr.custom.apiKey, "flm");
	assert.equal(saved.tts.custom.model, "kokoro-82m-zh");
	assert.equal(saved.tts.mimo.voice, "Mia");
});

console.log("\n回显 / 解析");
test("回显槽按引擎各给一份，缺省补内置默认", () => {
	const saved = migrateLegacySettings(LEGACY_USER_FILE);
	const slots = buildPublicSlots({}, saved, "zh-CN-XiaoxiaoNeural");
	assert.equal(slots.tts.edge.voice, "zh-CN-XiaoxiaoNeural");
	assert.equal(slots.tts.mimo.model, "mimo-v2.5-tts");
	assert.equal(slots.tts.custom.model, "kokoro-82m-zh");
	assert.equal(slots.tts.custom.baseUrl, "http://127.0.0.1:52992/v1");
	assert.equal(slots.tts.mimo.baseUrl, "https://api.xiaomimimo.com/v1", "MiMo 留空应回落到厂商默认端点，而不是被自定义 TTS 的 URL 顶掉");
	assert.equal(slots.asr.siliconflow.model, "FunAudioLLM/SenseVoiceSmall");
	assert.equal(slots.asr.custom.apiKey, "flm");
});

test("MiMo TTS 不填 Base URL 也能用（内置厂商端点；回归：朗读接口 400 无声）", () => {
	const saved = mergeSettings({}, sanitizeSettings({ ttsEngine: "mimo", tts: { mimo: { apiKey: "k" } } }));
	const cfg = resolveTtsConfig({}, saved, "mimo", "");
	assert.equal(cfg.baseUrl, "https://api.xiaomimimo.com/v1", "留空应回落到厂商默认端点");
	assert.equal(cfg.model, "mimo-v2.5-tts");
	assert.equal(cfg.apiKey, "k");
	// 自定义 TTS 没有厂商默认端点：仍必须显式填写，报错才明确
	assert.equal(resolveTtsConfig({}, saved, "custom", "").baseUrl, "");
});

test("行 config 支持按引擎隔离配置，也能被设置面板覆盖", () => {
	const config = { ttsEngine: "mimo", tts: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "cfg-key" } } };
	const empty = {};
	assert.equal(resolveTtsConfig(config, empty, "mimo", "").apiKey, "cfg-key");
	assert.equal(resolveTtsConfig(config, empty, "custom", "").baseUrl, "", "config 里 mimo 的配置不能漏给 custom");
	const saved = mergeSettings({}, sanitizeSettings({ tts: { mimo: { apiKey: "panel-key" } } }));
	assert.equal(resolveTtsConfig(config, saved, "mimo", "").apiKey, "panel-key");
	assert.equal(resolveTtsEngine(config, {}), "mimo");
	assert.equal(resolveTtsEngine(config, { ttsEngine: "custom" }), "custom");
});

test("旧式扁平 config 键仍可用（作用于当前引擎）", () => {
	const config = { ttsEngine: "custom", ttsBaseUrl: "https://api.openai.com/v1", ttsApiKey: "sk-flat" };
	assert.equal(resolveTtsConfig(config, {}, "custom", "").baseUrl, "https://api.openai.com/v1");
	assert.equal(resolveTtsConfig(config, {}, "custom", "").apiKey, "sk-flat");
});

test("非法引擎名/非法字段被丢弃", () => {
	const saved = mergeSettings({}, sanitizeSettings({ ttsEngine: "gemini", tts: { gemini: { apiKey: "x" }, mimo: { bogus: "y", apiKey: "k" } }, asrEngine: "foo" }));
	assert.equal(saved.ttsEngine, "edge");
	assert.equal(saved.asrEngine, "siliconflow");
	assert.equal(saved.tts.gemini, undefined);
	assert.deepEqual(saved.tts.mimo, { apiKey: "k" });
});

test("ASR 解析：各引擎只读自己的槽", () => {
	const saved = mergeSettings({}, sanitizeSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: "http://127.0.0.1:52625/v1", model: "whisper-v3", apiKey: "flm" }, groq: { apiKey: "gsk-x" } }
	}));
	assert.equal(resolveAsrConfig({}, saved).engine, "custom");
	assert.equal(resolveAsrConfig({}, saved).apiKey, "flm");
	const groqSaved = { ...saved, asrEngine: "groq" };
	assert.equal(resolveAsrConfig({}, groqSaved).apiKey, "gsk-x");
	assert.equal(resolveAsrConfig({}, groqSaved).baseUrl, "https://api.groq.com/openai/v1");
});

console.log(`\n${passed} 项通过${process.exitCode ? "（存在失败）" : ""}`);
