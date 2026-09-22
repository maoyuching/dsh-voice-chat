/**
 * 宿主路由端到端冒烟测试：真的走一遍 apply() 注册的 /settings 路由
 * （GET 回显按引擎分槽、POST 保存只动当前引擎的槽、其它引擎原样保留）。
 * 会写一次插件目录里的 settings.local.json，跑完自动还原。
 * 运行：node test/host-smoke.mjs
 */
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(HERE, "..", "settings.local.json");
const pkgVersion = JSON.parse(await readFile(path.join(HERE, "..", "package.json"), "utf8")).version;
// 先把现有设置挪走，让断言只看"默认值 + 本测试写入的值"，跑完还原
const original = await readFile(SETTINGS_FILE, "utf8").catch(() => null);
await rm(SETTINGS_FILE, { force: true });

let passed = 0;
function check(name, fn) {
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

/** 假 res：收集状态码与 JSON body。 */
function fakeRes() {
	const captured = {};
	return {
		captured,
		writeHead(status, headers) { captured.status = status; captured.headers = headers; },
		end(body) { captured.body = body; }
	};
}
/** 假 req：GET 或 POST(body 为字符串)。 */
function fakeReq(method, url, body) {
	const req = { method, url };
	if (body !== undefined) {
		req[Symbol.asyncIterator] = async function* () {
			yield Buffer.from(body, "utf8");
		};
	}
	return req;
}

const routes = new Map();
const httpCtx = {
	webServer: {
		register(entry) {
			routes.set(entry.path, entry.handler);
			return () => routes.delete(entry.path);
		}
	},
	effect(fn) { return fn(); },
	get() { return undefined; },
	llm: { stream() { throw new Error("not used in smoke test"); } },
	sessions: {}
};
const ctx = {
	inject(deps, fn) { fn(httpCtx); }
};

apply(ctx, {}); // 不传行 config，全部走默认链 + settings.local.json
assert.ok(routes.has("/dsh-voice-chat/settings"), "应注册 /settings 路由");
assert.ok(routes.has("/dsh-voice-chat/stt"), "应注册 /stt 路由");
assert.ok(routes.has("/dsh-voice-chat/tts"), "应注册 /tts 路由");
assert.ok(routes.has("/dsh-voice-chat/speak"), "应注册 /speak 路由");

async function getSettings() {
	const res = fakeRes();
	await routes.get("/dsh-voice-chat/settings")(fakeReq("GET", "/dsh-voice-chat/settings"), res);
	assert.equal(res.captured.status, 200, "GET /settings 应返回 200");
	return JSON.parse(res.captured.body);
}
async function postSettings(payload) {
	const res = fakeRes();
	await routes.get("/dsh-voice-chat/settings")(
		fakeReq("POST", "/dsh-voice-chat/settings", JSON.stringify(payload)), res
	);
	assert.equal(res.captured.status, 200, "POST /settings 应返回 200");
	return JSON.parse(res.captured.body);
}

try {
	console.log("GET /settings（回显按引擎分槽）");
	const first = await getSettings();
	check("带 version / 引擎选择 / 全局项", () => {
		assert.equal(first.version, pkgVersion);
		assert.ok(["edge", "mimo", "custom"].includes(first.ttsEngine));
		assert.ok(first.asrConfig && first.ttsConfig, "应回显 asrConfig/ttsConfig");
	});
	check("ttsConfig 三个引擎各一份，字段齐全", () => {
		for (const engine of ["edge", "mimo", "custom"]) {
			assert.ok(first.ttsConfig[engine], `ttsConfig.${engine} 应存在`);
			assert.ok("voice" in first.ttsConfig[engine]);
		}
		assert.equal(first.ttsConfig.mimo.model, "mimo-v2.5-tts");
		assert.equal(first.ttsConfig.custom.model, "tts-1");
		assert.equal(first.ttsConfig.custom.voice, "alloy");
		assert.equal(first.ttsConfig.edge.voice.length > 0, true, "Edge 音色应兜底内置晓晓");
	});
	check("asrConfig 四个引擎各一份", () => {
		for (const engine of ["siliconflow", "groq", "mimo", "custom"]) {
			assert.ok(first.asrConfig[engine], `asrConfig.${engine} 应存在`);
		}
		assert.equal(first.asrConfig.siliconflow.model, "FunAudioLLM/SenseVoiceSmall");
	});

	console.log("\nPOST /settings（只改当前引擎的槽）");
	await postSettings({
		asrEngine: "custom",
		asr: { custom: { baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "asr-key" } },
		ttsEngine: "mimo",
		tts: { mimo: { baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts", apiKey: "mimo-key", voice: "冰糖" } },
		silenceMs: 2000,
		rewrite: true
	});
	const second = await getSettings();
	check("MiMo TTS 槽写入成功", () => {
		assert.equal(second.ttsConfig.mimo.apiKey, "mimo-key");
		assert.equal(second.ttsConfig.mimo.voice, "冰糖");
	});
	check("切换引擎后再保存 custom，不会覆盖 MiMo", () => {
		assert.equal(second.ttsConfig.mimo.apiKey, "mimo-key");
	});
	await postSettings({
		asrEngine: "custom",
		ttsEngine: "custom",
		tts: { custom: { baseUrl: "http://127.0.0.1:52992/v1", model: "kokoro-82m-zh", apiKey: "custom-key", voice: "Mia" } }
	});
	const third = await getSettings();
	check("自定义 TTS 与 MiMo TTS 互不覆盖", () => {
		assert.equal(third.ttsConfig.custom.apiKey, "custom-key");
		assert.equal(third.ttsConfig.custom.voice, "Mia");
		assert.equal(third.ttsConfig.mimo.apiKey, "mimo-key", "MiMo 的密钥必须原样保留");
		assert.equal(third.ttsConfig.mimo.voice, "冰糖", "MiMo 的音色必须原样保留");
		assert.equal(third.ttsConfig.edge.voice, first.ttsConfig.edge.voice, "Edge 音色不受影响");
	});
	const onDisk = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
	check("落盘文件里只有 asr/tts 分槽，没有旧的扁平键", () => {
		assert.ok(onDisk.asr && onDisk.tts);
		for (const key of ["asrBaseUrl", "asrModel", "asrApiKey", "ttsBaseUrl", "ttsModel", "ttsApiKey", "ttsVoice"]) {
			assert.equal(key in onDisk, false, `${key} 应已被清理`);
		}
		assert.equal(onDisk.tts.mimo.apiKey, "mimo-key");
		assert.equal(onDisk.tts.custom.apiKey, "custom-key");
	});
	await postSettings({
		ttsEngine: "mimo", ttsVoice: "茉莉", ttsBaseUrl: "https://api.xiaomimimo.com/v1", ttsModel: "mimo-v2.5-tts", ttsApiKey: "legacy-key"
	});
	const fourth = await getSettings();
	check("旧客户端扁平键只落当前引擎（MiMo），不影响自定义 TTS", () => {
		assert.equal(fourth.ttsConfig.mimo.apiKey, "legacy-key");
		assert.equal(fourth.ttsConfig.mimo.voice, "茉莉");
		assert.equal(fourth.ttsConfig.custom.apiKey, "custom-key", "自定义 TTS 应保持不变");
	});
} finally {
	if (original === null) await rm(SETTINGS_FILE, { force: true });
	else await writeFile(SETTINGS_FILE, original, "utf8");
}

console.log(`\n${passed} 项通过${process.exitCode ? "（存在失败）" : ""}（settings.local.json 已还原）`);
