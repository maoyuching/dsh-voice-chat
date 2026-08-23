/**
 * dsh-voice-chat —— 宿主半身。
 *
 * 提供 HTTP 路由 POST /dsh-voice-chat/stt：接收浏览器 MediaRecorder 录下的
 * 音频（webm/opus），转调 OpenAI 兼容 ASR 接口（默认硅基流动 SiliconFlow，
 * 国内可直连且 SenseVoiceSmall 免费；也可切 Groq / 自定义端点），返回
 * { text }。浏览器端拿到文字后经 inputActions 发送给会话。
 *
 * 配置优先级：⚙️ 设置面板（settings.local.json，浏览器里可改）>
 *   行 config（cordis.patch.yml 里覆盖）> 环境变量 > 默认值。
 *   - config.asrApiKey / env DSH_VOICE_ASR_KEY    ASR 密钥
 *   - config.asrEngine / env DSH_VOICE_ASR_ENGINE siliconflow | groq | custom
 *   - config.asrBaseUrl / env DSH_VOICE_ASR_BASE_URL (custom 必填)
 *   - config.asrModel   / env DSH_VOICE_ASR_MODEL
 *   - config.llmApiKey  / env DSH_VOICE_LLM_KEY   转述模型密钥（缺省用 ASR 密钥）
 *   - config.llmBaseUrl / env DSH_VOICE_LLM_BASE_URL
 *   - config.llmModel   / env DSH_VOICE_LLM_MODEL 默认 deepseek-v4-flash
 *     （仅在客户端未透传"当前对话实际模型"时作为转述朗读的 fallback；默认跟当前对话走）
 *
 * 路由：
 *   POST /dsh-voice-chat/stt    音频 → 文字
 *   GET  /dsh-voice-chat/tts    文字 → MP3（原样朗读）
 *   POST /dsh-voice-chat/speak  文字 → LLM 口语化转述 → MP3（语音助手式汇报）
 *   GET  /dsh-voice-chat/settings 读取当前生效设置（含密钥，仅本机自用）
 *   POST /dsh-voice-chat/settings 保存设置面板改动（落盘 settings.local.json）
 *
 * @module dsh-voice-chat
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 解析 ASR 配置。 */
function resolveAsrConfig(config) {
	const cfg = config ?? {};
	const engine = cfg.asrEngine ?? process.env.DSH_VOICE_ASR_ENGINE ?? "siliconflow";
	const apiKey = cfg.asrApiKey ?? process.env.DSH_VOICE_ASR_KEY ?? "";
	if (engine === "groq") {
		return {
			engine,
			baseUrl: cfg.asrBaseUrl ?? process.env.DSH_VOICE_ASR_BASE_URL ?? "https://api.groq.com/openai/v1",
			model: cfg.asrModel ?? process.env.DSH_VOICE_ASR_MODEL ?? "whisper-large-v3-turbo",
			apiKey
		};
	}
	if (engine === "custom") {
		return {
			engine,
			baseUrl: cfg.asrBaseUrl ?? process.env.DSH_VOICE_ASR_BASE_URL ?? "",
			model: cfg.asrModel ?? process.env.DSH_VOICE_ASR_MODEL ?? "",
			apiKey
		};
	}
	return {
		engine: "siliconflow",
		baseUrl: cfg.asrBaseUrl ?? process.env.DSH_VOICE_ASR_BASE_URL ?? "https://api.siliconflow.cn/v1",
		model: cfg.asrModel ?? process.env.DSH_VOICE_ASR_MODEL ?? "FunAudioLLM/SenseVoiceSmall",
		apiKey
	};
}

/**
 * 解析"转述模型"配置：仅在客户端未透传"当前对话实际模型"时作为 fallback。
 * 默认 deepseek-v4-flash（agent 同款）；用 cordis 行 config.llmModel 或环境变量
 * DSH_VOICE_LLM_MODEL 可覆盖。正常情况下转述跟随当前对话走的模型走，不走这里。
 */
function resolveLlmModel(config) {
	const cfg = config ?? {};
	return typeof cfg.llmModel === "string" && cfg.llmModel.trim()
		? cfg.llmModel.trim()
		: (process.env.DSH_VOICE_LLM_MODEL?.trim() || "deepseek-v4-flash");
}

/**
 * 解析"语音播放/交互"配置：音色、语速、静音时长、短文阈值、转述开关。
 * 全部可经 cordis.patch.yml 的 voice-chat 行 config 覆盖（默认值见下）。
 */
function resolveVoiceConfig(config) {
	const cfg = config ?? {};
	const num = (v, fallback) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
	};
	return {
		voice: typeof cfg.voice === "string" && cfg.voice.trim() ? cfg.voice.trim() : "zh-CN-XiaoxiaoNeural",
		rate: typeof cfg.rate === "string" && cfg.rate.trim() ? cfg.rate.trim() : "+10%",
		silenceMs: num(cfg.silenceMs, 2500),
		shortTextChars: num(cfg.shortTextChars, 50),
		// 转述朗读默认关闭：只在 cordis/设置 里显式配置 true 时才开启
		rewrite: cfg.rewrite === true
	};
}

// ---------- 设置面板：settings.local.json 持久化 ----------
// 浏览器端 ⚙️ 弹窗改的设置落盘在插件根目录 settings.local.json（不进 git）。
// 只保存"显式设置过"的键：留空/未设置的项继续回落到 行 config > 环境变量 > 内置默认。
const SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "settings.local.json");

/** 读取本地保存的设置；文件不存在/损坏返回空对象（全部走默认链）。 */
async function loadSavedSettings() {
	try {
		const raw = await readFile(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * 归一化一次设置补丁：只保留显式提供的键。
 * silenceMs 夹在 300~15000ms（非法值视为未设置）；autoSend/rewrite 强转布尔；
 * 字符串字段 trim 后保存（空串=清除覆盖，回落默认）。
 */
function sanitizeSettings(input) {
	const src = input && typeof input === "object" ? input : {};
	const out = {};
	if ("asrBaseUrl" in src) out.asrBaseUrl = String(src.asrBaseUrl ?? "").trim();
	if ("asrModel" in src) out.asrModel = String(src.asrModel ?? "").trim();
	if ("asrApiKey" in src) out.asrApiKey = String(src.asrApiKey ?? "").trim();
	if ("ttsVoice" in src) out.ttsVoice = String(src.ttsVoice ?? "").trim();
	if ("autoSend" in src) out.autoSend = src.autoSend !== false && src.autoSend !== "false";
	if ("rewrite" in src) out.rewrite = src.rewrite !== false && src.rewrite !== "false";
	if ("silenceMs" in src) {
		const n = Math.round(Number(src.silenceMs));
		out.silenceMs = Number.isFinite(n) ? Math.min(15000, Math.max(300, n)) : null;
	}
	return out;
}

/** 转述提示词：AI 助手本人的口吻，简短汇报；只许压缩收敛，禁止发散扩写。 */
const SPEAK_SYSTEM_PROMPT = "你就是刚才回复用户的那位 AI 助手本人，现在要用你自己的口吻，" +
	"把你刚写的那段回复向用户做一次简短的口头汇报：长话短说、挑重点，先讲结论再讲要点；" +
	"语气口语化、自然、不啰嗦、不要客套话和开场白；" +
	"不要出现代码、表格、链接、markdown 符号，必要时用一句话概括其要点；" +
	"只允许对原文做压缩和概括，禁止添加原文里没有的信息，禁止发散和扩写；" +
	"输出必须比原文更短或等长，绝不允许比原文还长；" +
	"如果原文本身很短（比如'明白了''好的，我来处理'这类），直接原样说出来即可，不要改写；" +
	"只输出汇报文本本身，不超过 150 字。";

/**
 * 用 harness 自带的 LLM 服务做口语化转述（复用 agent 同一个模型/密钥）。
 * 失败抛错，由调用方降级为原文朗读。
 * @param httpCtx - 注入了 webServer 与 llm 服务的上下文。
 * @param text - 待转述的 AI 回复原文。
 * @param provider - harness provider id（如 "deepseek-official"），由客户端透传当前对话实际在用的。
 * @param model - harness 模型名（deepseek-v4-flash / deepseek-v4-pro / 自定义 ...）。
 */
async function rewriteWithHarness(httpCtx, text, provider, model) {
	const llm = httpCtx.llm;
	if (llm === undefined) throw new Error("harness llm 服务不可用");
	/** 单次转述调用：按给定选项发起流并收敛出文本；错误以抛错形式上抛。 */
	const runOnce = async (extra) => {
		const stream = llm.stream({
			provider,
			model,
			system: SPEAK_SYSTEM_PROMPT,
			messages: [
				{ role: "user", content: [{ type: "text", text: text.slice(0, 6000) }] }
			],
			maxTokens: 2000,
			...extra
		});
		let out = "";
		for await (const chunk of stream) {
			if (chunk.type === "text-delta") {
				out += chunk.text;
			} else if (chunk.type === "finish") {
				const reason = chunk.reason;
				// 错误/中止结束块带真实失败信息，必须抛出来（否则会被当成"成功但空"而静默读原文）
				if (reason.kind === "error" || reason.kind === "aborted") {
					const failure = reason.failure;
					let detail = "";
					if (failure) {
						detail = typeof failure === "string" ? failure
							: (failure.message ?? failure.code ?? JSON.stringify(failure));
					}
					throw new Error(`harness llm 转述失败(${reason.kind}): ${String(detail)}`.trim());
				}
				if (reason.kind !== "stop" && reason.kind !== "tool-calls" && reason.kind !== "max-tokens") {
					throw new Error("harness llm 意外结束: " + JSON.stringify(reason));
				}
			}
		}
		if (out.trim() === "") throw new Error("harness llm 转述返回为空");
		return out.trim();
	};
	// 优先尝试关闭思考（deepseek 官方推理模型：不思考、直接回答，又快又稳）；
	// 但 pi-ai 等兼容 AI 代理的模型不支持 reasoningEffort 参数，报错时去掉该参数重试一次。
	try {
		return await runOnce({ reasoningEffort: "off" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/reasoning effort/i.test(message)) throw error;
		console.warn(`[dsh-voice-chat] rewrite: ${provider}/${model} 不支持 reasoningEffort=off，去掉该参数重试`);
		return await runOnce({});
	}
}

/** 调 OpenAI 兼容 /audio/transcriptions 转写。 */
async function transcribe(audioBuffer, asr) {
	if (!asr.apiKey) {
		const err = new Error("未配置 ASR 密钥：请打开 DSH 设置 → voice chat 填写 API Key（或设 DSH_VOICE_ASR_KEY）");
		err.status = 400;
		throw err;
	}
	const form = new FormData();
	form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), "recording.webm");
	form.append("model", asr.model);
	const resp = await fetch(`${asr.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${asr.apiKey}` },
		body: form
	});
	const body = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		const detail = typeof body === "object" && body !== null ? (body.error?.message ?? JSON.stringify(body)) : String(body);
		const err = new Error(`ASR 接口错误 ${resp.status}: ${detail}`);
		err.status = 502;
		throw err;
	}
	const text = typeof body === "object" && body !== null ? body.text ?? "" : "";
	return String(text ?? "").trim();
}

/** 收集请求体（node:http IncomingMessage）。 */
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks);
}

function json(res, status, payload) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

/**
 * 朗读前清洗文本：去掉 markdown / emoji / 特殊装饰符号，压缩重复标点。
 * 保留基本句读（。！？，；：等）用于 edge-tts 断句换气，只去掉"噪音符号"。
 */
function cleanForTts(raw) {
	let t = String(raw ?? "");
	// 代码块整体删除；行内代码去掉反引号、保留内容
	t = t.replace(/```[\s\S]*?```/g, " ");
	t = t.replace(/`([^`]*)`/g, "$1");
	// markdown 链接 [文字](url) → 文字
	t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	// 表格：先整行删分隔行（整行只含 |:- 和空白）、再去行首尾竖线，再处理剩余竖线
	t = t.replace(/^\s*\|?[\s|:-]+\|?\s*$/gm, "");
	t = t.replace(/^\s*\|/gm, "");
	t = t.replace(/\|\s*$/gm, "");
	// markdown 排版符号统一换成空格：# * _ | > ~
	t = t.replace(/[#*_|>~]/g, " ");
	// 列表符（行首 - + / 数字.、）删除，保留行内容
	t = t.replace(/(^|\n)\s*[-+]\s+/g, "$1");
	t = t.replace(/(^|\n)\s*\d+[.、)]\s+/g, "$1");
	// emoji / 装饰符号（表情、符号区、箭头几何、国旗、肤色修饰、变体选择符）
	t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}]/gu, "");
	// 常见杂项符号单字 → 空格
	t = t.replace(/[→←↑↓⇒⇔•·★☆✓✔✗⚠°±×÷√≈≠≤≥]/g, " ");
	// 压缩重复标点：！！！→！，。。。→。，？？？→？
	t = t.replace(/([。！？，；：、.!!?？])\1+/g, "$1");
	// 清理多余空白
	t = t.replace(/[ \t]{2,}/g, " ");
	return t.trim();
}

export function apply(ctx, config) {
	const defaultRewriteModel = resolveLlmModel(config); // 仅在客户端未透传当前对话模型时作 fallback
	const vc = resolveVoiceConfig(config);    // 音色/语速/静音时长/短文阈值/转述开关（行 config 层默认值）
	// ---------- 设置面板覆盖层 ----------
	let savedSettingsPromise = null;
	const ensureSaved = () => {
		if (!savedSettingsPromise) savedSettingsPromise = loadSavedSettings();
		return savedSettingsPromise;
	};
	// 生效 ASR 配置 = 设置面板 > 行 config/env 默认（引擎判定仍按行 config 的 asrEngine）。
	const liveAsr = (saved) => {
		const base = resolveAsrConfig(config);
		return {
			engine: base.engine,
			baseUrl: (typeof saved.asrBaseUrl === "string" && saved.asrBaseUrl) || base.baseUrl,
			model: (typeof saved.asrModel === "string" && saved.asrModel) || base.model,
			apiKey: (typeof saved.asrApiKey === "string" && saved.asrApiKey) || base.apiKey
		};
	};
	const liveSilenceMs = (saved) =>
		Number.isFinite(Number(saved.silenceMs)) && Number(saved.silenceMs) > 0
			? Math.round(Number(saved.silenceMs))
			: vc.silenceMs;
	const liveVoice = (saved) => (typeof saved.ttsVoice === "string" && saved.ttsVoice ? saved.ttsVoice : vc.voice);
	const liveAutoSend = (saved) => saved.autoSend !== false; // 默认自动发送
	const liveRewrite = (saved) => saved.rewrite === true;    // 转述朗读默认关闭（显式 true 才开启）
	// 对外暴露的完整生效设置（弹窗回显用；本机自用工具，密钥原样返回）。
	const publicSettings = (saved) => {
		const asr = liveAsr(saved);
		return {
			asrEngine: asr.engine,
			asrBaseUrl: asr.baseUrl,
			asrModel: asr.model,
			asrApiKey: asr.apiKey,
			autoSend: liveAutoSend(saved),
			silenceMs: liveSilenceMs(saved),
			ttsVoice: liveVoice(saved),
			rewrite: liveRewrite(saved)
		};
	};
	// 行激活顺序问题：webServer/llm 可能尚未就绪，必须用 ctx.inject 等服务出现
	// （参照官方客户端包的宿主半身写法，如 dsh-client-ui-theme）。
	// agentDefaultModel 服务（DSH 主界面模型选择器同步的"默认模型"）可选注入：
	// 每次 /speak 时读取当前会话正在用的 provider/model 作为转述模型兜底。
	ctx.inject(["webServer", "llm", "agentDefaultModel"], (httpCtx) => {
		// 解析转述用模型：客户端透传（当前会话实际模型） > 主界面当前选中默认模型 > 配置链
		const resolveRewriteSelection = (payload) => {
			const cp = (typeof payload.llmProvider === "string" && payload.llmProvider.trim()) || "";
			const cm = (typeof payload.llmModel === "string" && payload.llmModel.trim()) || "";
			if (cp && cm) return { provider: cp, model: cm, source: "client" };
			try {
				const adm = httpCtx.get("agentDefaultModel");
				const sel = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
				if (sel && typeof sel.provider === "string" && sel.provider && typeof sel.model === "string" && sel.model) {
					return { provider: sel.provider, model: sel.model, source: "agent-default-model" };
				}
			} catch (err) { /* 服务不可用时忽略，走配置链 */ }
			return { provider: "deepseek-official", model: defaultRewriteModel, source: "config" };
		};
		httpCtx.effect(() => {
			const disposers = [];
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/config",
				handler: async (req, res) => {
					// 把非敏感的运行时配置暴露给浏览器端（静音时长等，已并入面板覆盖层）
					const saved = await ensureSaved();
					json(res, 200, {
						voice: liveVoice(saved),
						rate: vc.rate,
						silenceMs: liveSilenceMs(saved),
						shortTextChars: vc.shortTextChars,
						rewrite: liveRewrite(saved)
					});
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/settings",
				handler: async (req, res) => {
					if (req.method === "GET") {
						const saved = await ensureSaved();
						json(res, 200, publicSettings(saved));
						return;
					}
					if (req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const raw = Buffer.from(await readBody(req)).toString("utf8");
						let payload = {};
						try { payload = JSON.parse(raw || "{}"); } catch { /* 视为空补丁 */ }
						const patch = sanitizeSettings(payload);
						const merged = { ...(await ensureSaved()), ...patch };
						await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, "\t") + "\n", "utf8");
						savedSettingsPromise = Promise.resolve(merged); // 立即生效，无需重启
						json(res, 200, { ok: true, settings: publicSettings(merged) });
					} catch (error) {
						json(res, 500, { error: "保存设置失败：" + (error instanceof Error ? error.message : String(error)) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/stt",
				handler: async (req, res) => {
					if (req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const audio = await readBody(req);
						if (audio.length === 0) {
							json(res, 400, { error: "empty audio body" });
							return;
						}
						const saved = await ensureSaved();
						const text = await transcribe(audio, liveAsr(saved));
						json(res, 200, { text });
					} catch (error) {
						const status = error && typeof error === "object" && error.status ? error.status : 500;
						json(res, status, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/tts",
				handler: async (req, res) => {
					if (req.method !== "GET") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					try {
						const url = new URL(req.url ?? "/", "http://dsh-voice-chat");
						const text = (url.searchParams.get("text") ?? "").trim().slice(0, 2000);
						if (!text) {
							json(res, 400, { error: "empty text" });
							return;
						}
						const saved = await ensureSaved();
						const voice = url.searchParams.get("voice") ?? liveVoice(saved);
						// 朗读前清洗：去掉 markdown/emoji/特殊符号，压缩重复标点
						const clean = cleanForTts(text);
						// 内联的 edge-tts 客户端：微软 Edge 朗读服务，免费（即原 dsh-voice 的合成能力）
						const { synthesizeSpeech } = await import("./edge-tts.js");
						const audio = await synthesizeSpeech({ text: clean || text, voice, rate: vc.rate, pitch: "+0Hz" });
						res.writeHead(200, {
							"Content-Type": "audio/mpeg",
							"Content-Length": audio.length,
							"Cache-Control": "no-store"
						});
						res.end(audio);
					} catch (error) {
						json(res, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}));
			disposers.push(httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-voice-chat/speak",
				handler: async (req, res) => {
					if (req.method !== "POST") {
						json(res, 405, { error: "method not allowed" });
						return;
					}
					let original = "";
					let spoken = "";
					try {
						const raw = Buffer.from(await readBody(req)).toString("utf8");
						let payload = {};
						try { payload = JSON.parse(raw || "{}"); } catch (err) { /* ignore */ }
						original = String(payload.text ?? "").trim();
						if (!original) {
							json(res, 400, { error: "empty text" });
							return;
						}
						const saved = await ensureSaved();
						const voice = typeof payload.voice === "string" && payload.voice ? payload.voice : liveVoice(saved);
						const { synthesizeSpeech } = await import("./edge-tts.js");
						// 1) 决定朗读台词：只许收敛，不许发散。
						//    - 转述开关关闭 → 直接原样读；
						//    - 原文很短（<= shortTextChars 字）：过程性短回复，直接原样读，不劳烦 LLM；
						//    - 原文较长：让转述模型压缩概括，但转述结果必须比原文短或等长，否则退回原文。
						// 转述模型：客户端从当前对话拿到的 provider/model 优先；客户端未透传则
						// 用 DSH 主界面当前选中的默认模型（agentDefaultModel，跟随用户在
						// 界面上的模型选择）；最后才退回 cordis/env 配置链。绝不硬编码
						// deepseek-official——环境里可能根本没配它的 key（如只用 pi-ai）。
						const rewriteSel = resolveRewriteSelection(payload);
						const rewriteProvider = rewriteSel.provider;
						const rewriteModel = rewriteSel.model;
						spoken = original.slice(0, 2000);
						if (liveRewrite(saved) && original.length > vc.shortTextChars) {
							try {
								// 优先用 harness 自带的 LLM（agent 同款模型）做转述
								console.log(`[dsh-voice-chat] speak: rewrite start (original=${original.length} chars, provider=${rewriteProvider}, model=${rewriteModel}, source=${rewriteSel.source})`);
								const rewritten = await rewriteWithHarness(httpCtx, original, rewriteProvider, rewriteModel);
								if (rewritten && rewritten.length <= original.length) {
									spoken = rewritten.slice(0, 2000);
									console.log(`[dsh-voice-chat] speak: rewrite ok (${original.length} -> ${rewritten.length} chars)`);
								} else if (rewritten) {
									console.warn(`[dsh-voice-chat] rewrite longer than original (${rewritten.length} > ${original.length}), keep raw`);
								} else {
									console.warn("[dsh-voice-chat] rewrite returned empty, keep raw");
								}
							} catch (error) {
								// 失败直接降级为原文朗读（不再走外部 LLM）
								console.warn("[dsh-voice-chat] harness rewrite failed, read raw:", error instanceof Error ? error.message : String(error));
							}
						} else {
							console.log(`[dsh-voice-chat] speak: raw read (length=${original.length}, rewrite=${liveRewrite(saved)}, threshold=${vc.shortTextChars})`);
						}
						// 2) 朗读前清洗：去掉 markdown/emoji/特殊符号，压缩重复标点（清洗后为空则退回原台词）
						const cleaned = cleanForTts(spoken);
						if (cleaned) spoken = cleaned;
						// 3) edge-tts 合成
						const audio = await synthesizeSpeech({ text: spoken, voice, rate: vc.rate, pitch: "+0Hz" });
						res.writeHead(200, {
							"Content-Type": "audio/mpeg",
							"Content-Length": audio.length,
							"Cache-Control": "no-store"
						});
						res.end(audio);
					} catch (error) {
						// edge-tts 失败时把"实际会朗读的台词"带回（转述成功→口语版；失败/关闭→原文），
						// 浏览器端兜底（浏览器 TTS）优先播它，而不是播没转述过的原文。
						json(res, 500, { error: error instanceof Error ? error.message : String(error), spoken });
					}
				}
			}));
			return () => {
				for (const dispose of disposers) {
					try { dispose(); } catch (err) { /* ignore */ }
				}
			};
		}, "dsh-voice-chat: config+stt+tts+speak routes");
	});
}
