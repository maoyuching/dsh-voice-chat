window.__ModuleLoader__.load({
	id: "dsh-voice-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;

		// ---------- 模块级 helpers ----------
		/** 从内容块里提取纯文本（兼容 wire 层 {type:'text'} 与 UI 层 {kind:'text'}）。 */
		function extractText(blocks) {
			if (!Array.isArray(blocks)) return "";
			return blocks
				.filter((b) => b && (b.type === "text" || b.kind === "text") && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.trim();
		}

		/** 选一个可用的录音 mimeType。 */
		function pickMime() {
			if (typeof MediaRecorder === "undefined") return "";
			const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
			for (const m of candidates) {
				if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
			}
			return "";
		}

		/** ASR 引擎内置默认（与服务端 ASR_ENGINE_DEFAULTS 保持一致；仅用于占位符/切引擎联动）。 */
		const ASR_ENGINE_DEFAULTS = {
			siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" },
			groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
			mimo: { baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.5-asr" },
			custom: { baseUrl: "", model: "" }
		};

		/** 判断生效设置是否走 chat/completions 协议 ASR（MiMo 式，仅支持 wav/mp3）。 */
		function isChatAsrSettings(s) {
			if (!s || typeof s !== "object") return false;
			if (s.asrEngine === "mimo") return true;
			return /\/chat\/completions\/?$/i.test(String(s.asrBaseUrl || ""));
		}

		/**
		 * 浏览器端把录音(webm/ogg/mp4)转成 16kHz 单声道 16bit WAV：
		 * MiMo 等 chat 协议 ASR 只吃 wav/mp3；解码/重采样全用 Web Audio 原生 API，
		 * 不依赖任何外部库。失败抛错，由调用方提示用户重试。
		 */
		async function blobToWav(blob) {
			const arr = await blob.arrayBuffer();
			const AudioCtx = window.AudioContext || window.webkitAudioContext;
			const decodeCtx = new AudioCtx();
			let audioBuf;
			try {
				audioBuf = await decodeCtx.decodeAudioData(arr);
			} finally {
				try { decodeCtx.close(); } catch (err) { /* ignore */ }
			}
			const rate = 16000;
			const frames = Math.max(1, Math.ceil(audioBuf.duration * rate));
			const off = new OfflineAudioContext(1, frames, rate);
			const src = off.createBufferSource();
			src.buffer = audioBuf;
			src.connect(off.destination);
			src.start(0);
			const rendered = await off.startRendering();
			const ch = rendered.getChannelData(0);
			const len = ch.length;
			const buf = new ArrayBuffer(44 + len * 2);
			const view = new DataView(buf);
			const wstr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
			wstr(0, "RIFF"); view.setUint32(4, 36 + len * 2, true); wstr(8, "WAVE");
			wstr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
			wstr(36, "data"); view.setUint32(40, len * 2, true);
			let o = 44;
			for (let i = 0; i < len; i++, o += 2) {
				const s = Math.max(-1, Math.min(1, ch[i]));
				view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
			}
			return new Blob([buf], { type: "audio/wav" });
		}

		/**
		 * 新版 DSH(0.1.2-rc.1)适配:session 里没有消息列表,消息在专用
		 * conversation store(插件 slot 拿不到)。从 DOM 提取最新一条回复文本:
		 * 聊天界面按文档序渲染,越靠下越新;排除输入区/侧栏/含编辑器的容器,
		 * 取"最后一个有实质文本的块"作为 AI 最新回复。
		 */
		function extractLatestAssistantText() {
			try {
				const all = document.querySelectorAll("div,article,section,p");
				let last = null;
				for (const el of all) {
					const t = (el.textContent || "").trim();
					if (t.length < 2 || t.length > 6000) continue;    // 只排除空文本/超大容器
					if (el.children.length > 15) continue;
					if (el.offsetHeight < 10) continue;
					// 排除输入区(含编辑器/文本框)与导航/侧栏
					if (el.querySelector("textarea,input,[contenteditable='true'],[role='textbox']")) continue;
					const cls = String(el.className || "") + " " + String(el.id || "");
					if (/composer|inputBar|input-bar|sidebar|settings|toolbar|header|footer|hero|nav/i.test(cls)) continue;
					last = el;
				}
				if (!last) return null;
				return (last.textContent || "").trim().slice(0, 5000);
			} catch (err) {
				console.warn("[dsh-voice-chat] DOM 提取失败:", err);
				return null;
			}
		}

		// ---------- 扁平 SVG 图标（Feather 风格，线性描边，随 currentColor 变色） ----------
		const ICON_MIC = [
			"M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z",
			"M19 10v2a7 7 0 0 1-14 0v-2",
			"M12 19v4",
			"M8 23h8"
		];
		const ICON_SPEAKER = [
			"M11 5L6 9H2v6h4l5 4V5z",
			"M15.54 8.46a5 5 0 0 1 0 7.07",
			"M19.07 4.93a10 10 0 0 1 0 14.14"
		];
		const ICON_MUTED = [
			"M11 5L6 9H2v6h4l5 4V5z",
			"M23 9l-6 6",
			"M17 9l6 6"
		];
		/** 渲染一个 24x24 线性 SVG 图标。 */
		function Icon({ paths, size = 16 }) {
			return React.createElement("svg", {
				viewBox: "0 0 24 24",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, paths.map((d, i) => React.createElement("path", { key: i, d })));
		}

		// ---------- 设置页（嵌入 DSH 自带设置弹窗的 settings.section 类目） ----------
		// 常用 Edge TTS 音色候选（可自由手输任意 voice 名）
		const VOICE_PRESETS = [
			"zh-CN-XiaoxiaoNeural",   // 晓晓（女，默认）
			"zh-CN-YunxiNeural",      // 云希（男）
			"zh-CN-YunyangNeural",    // 云扬（男，新闻）
			"zh-CN-YunjianNeural",    // 云健（男）
			"zh-CN-XiaoyiNeural",     // 晓伊（女）
			"zh-HK-HiuMaanNeural",    // 粤语 曉曼
			"zh-TW-HsiaoChenNeural",  // 台湾 曉臻
			"en-US-AriaNeural",
			"en-US-GuyNeural",
			"ja-JP-NanamiNeural"
		];
		// MiMo TTS 预置音色（mimo-v2.5-tts 可选值；留空走 mimo_default）
		const MIMO_TTS_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

		const SECTION_STYLES = {
			wrap: {
				maxWidth: 560, paddingTop: 10, boxSizing: "border-box",
				fontFamily: "inherit", fontSize: 13,
				color: "var(--dsw-alias-label-primary, #f0f0f0)",
				textAlign: "left"
			},
			h: { margin: "0 0 2px", fontSize: 16, fontWeight: 600 },
			sub: { margin: "0 0 14px", fontSize: 12, opacity: 0.6 },
			label: { display: "block", margin: "12px 0 4px", opacity: 0.85 },
			input: {
				width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, #555)",
				background: "rgba(127,127,127,0.12)", color: "inherit",
				fontSize: 13, outline: "none"
			},
			checkRow: { display: "flex", alignItems: "center", gap: 8, margin: "14px 0 2px", cursor: "pointer" },
			note: { marginTop: 3, fontSize: 11, lineHeight: 1.5, opacity: 0.55 },
			err: { marginTop: 10, color: "#ff8a8a", fontSize: 12 },
			saveRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 18 },
			primary: {
				padding: "6px 18px", borderRadius: 8, border: "none", cursor: "pointer",
				fontSize: 13, background: "#4c7dff", color: "#fff"
			},
			status: { fontSize: 12, opacity: 0.85 }
		};

		// ---------- 设置共享总线（模块级） ----------
		// 宿主 /settings 的生效设置由 输入框按钮 与 设置页 共享同一份数据：
		// 任一组件保存后立即广播，另一侧无需刷新页面即可生效。
		const settingsBus = { current: null, listeners: new Set() };
		/** 拉取宿主生效设置（GET /settings）。 */
		function fetchSettings() {
			return window.fetch("/dsh-voice-chat/settings")
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null);
		}
		/** 广播设置变更（同时更新 current 快照）。 */
		function emitSettings(value) {
			if (value && typeof value === "object") settingsBus.current = value;
			for (const fn of settingsBus.listeners) {
				try { fn(settingsBus.current); } catch (err) { /* ignore */ }
			}
		}
		/** 订阅设置；返回退订函数。 */
		function subscribeSettings(fn) {
			settingsBus.listeners.add(fn);
			return () => settingsBus.listeners.delete(fn);
		}
		/** 设置订阅 hook：首次挂载若还没加载过就拉一次宿主，并随广播刷新。 */
		function useSettings() {
			const [value, setValue] = useState(settingsBus.current);
			useEffect(() => {
				if (!settingsBus.current) fetchSettings().then((data) => { if (data) emitSettings(data); });
				return subscribeSettings((v) => setValue(v));
			}, []);
			return value;
		}

		/**
		 * 构造一个订阅当前会话模型选择的 hook（modelDirectories 服务）。
		 * 返回的 useCurrentModel(sessionId) 读取后会跟随用户切换模型自动刷新。
		 */
		function makeUseCurrentModelImpl(modelDirectories) {
			return function useCurrentModel(sessionId) {
				const [current, setCurrent] = useState(() => {
					if (!modelDirectories || !sessionId) return null;
					try {
						const dir = modelDirectories.directoryFor(sessionId);
						const snap = dir.store.getSnapshot();
						return snap ? snap.current : null;
					} catch {
						return null;
					}
				});
				useEffect(() => {
					if (!modelDirectories || !sessionId) {
						setCurrent(null);
						return;
					}
					let dir;
					try { dir = modelDirectories.directoryFor(sessionId); }
					catch { setCurrent(null); return; }
					const apply = () => {
						try { setCurrent(dir.store.getSnapshot().current); }
						catch { setCurrent(null); }
					};
					apply();
					// 首次挂载若还在 idle，主动 load 一次把 current 拉下来
					try {
						const snap = dir.store.getSnapshot();
						if (snap && snap.status === "idle") dir.load().catch(() => { /* ignore */ });
					} catch { /* ignore */ }
					const unsub = dir.store.subscribe(apply);
					return unsub;
				}, [modelDirectories, sessionId]);
				return current; // { provider, model, reasoningEffort? } | null
			};
		}

		/**
		 * DSH 设置弹窗左侧"voice chat"类目（settings.section）的内容表单：
		 * ASR 接口(Base URL/模型/Key)、识别后是否自动发送、转述朗读开关、
		 * 静音自动结束时长、朗读音色。保存到宿主 settings.local.json 并立即广播生效。
		 */
		function VoiceChatSettingsSection(props) {
			const settings = useSettings();
			// 语音识别设置
			const [engine, setEngine] = useState("siliconflow"); // siliconflow | groq | mimo | custom
			const [baseUrl, setBaseUrl] = useState("");
			const [model, setModel] = useState("");
			const [apiKey, setApiKey] = useState("");
			const [autoSend, setAutoSend] = useState(true);
			const [silenceSec, setSilenceSec] = useState("2.5");
			// 朗读设置
			const [rewrite, setRewrite] = useState(false); // 转述朗读（长回复先精简再播），默认关闭
			const [voice, setVoice] = useState("");
			const [ttsEngine, setTtsEngine] = useState("edge"); // edge 或 custom
			const [ttsBaseUrl, setTtsBaseUrl] = useState("");
			const [ttsModel, setTtsModel] = useState("");
			const [ttsApiKey, setTtsApiKey] = useState("");
			// UI 状态
			const [saving, setSaving] = useState(false);
			const [err, setErr] = useState("");
			const [status, setStatus] = useState("");
			const filledRef = useRef(false); // 只按首次到达的数据回填表单，避免覆盖用户输入
			const touchedRef = useRef(false); // 用户改过表单后禁止自动回填覆盖（防"先勾选、后回填"竞态）

			// 生效设置到达后回填一次表单（仅当用户尚未手动改动时）
			useEffect(() => {
				if (!settings || filledRef.current || touchedRef.current) return;
				filledRef.current = true;
				// 语音识别设置（引擎回显：URL 是 chat/completions 端点 → 按 mimo 显示）
				setEngine(settings.asrEngine === "mimo" || /\/chat\/completions\/?$/i.test(String(settings.asrBaseUrl ?? ""))
					? "mimo"
					: (String(settings.asrEngine ?? "siliconflow") || "siliconflow"));
				setBaseUrl(String(settings.asrBaseUrl ?? ""));
				setModel(String(settings.asrModel ?? ""));
				setApiKey(String(settings.asrApiKey ?? ""));
				setAutoSend(settings.autoSend !== false);
				const ms = Number(settings.silenceMs);
				setSilenceSec(String(Number.isFinite(ms) && ms > 0 ? Math.round(ms / 100) / 10 : 2.5));
				// 朗读设置
				setRewrite(settings.rewrite === true);
				setVoice(String(settings.ttsVoice ?? ""));
				setTtsEngine(settings.ttsEngine || "edge");
				setTtsBaseUrl(String(settings.ttsBaseUrl ?? ""));
				setTtsModel(String(settings.ttsModel ?? ""));
				setTtsApiKey(String(settings.ttsApiKey ?? ""));
			}, [settings]);

			// 保存成功提示 2.5s 后消失
			useEffect(() => {
				if (!status) return;
				const t = window.setTimeout(() => setStatus(""), 2500);
				return () => window.clearTimeout(t);
			}, [status]);

			const save = () => {
				const sec = Number(silenceSec);
				if (!Number.isFinite(sec) || sec <= 0) {
					setErr("静音时长需为正数（单位：秒，0.3 ~ 15）");
					return;
				}
				setSaving(true);
				setErr("");
				setStatus("");
				window.fetch("/dsh-voice-chat/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						// 语音识别设置
						asrEngine: engine,
						asrBaseUrl: baseUrl.trim(),
						asrModel: model.trim(),
						asrApiKey: apiKey.trim(),
						autoSend,
						silenceMs: Math.round(sec * 1000),
						// 朗读设置
						rewrite,
						ttsVoice: voice.trim(),
						ttsEngine: ttsEngine,
						ttsBaseUrl: ttsBaseUrl.trim(),
						ttsModel: ttsModel.trim(),
						ttsApiKey: ttsApiKey.trim()
					})
				})
					.then((r) => r.json().then((data) => ({ ok: r.ok, data })).catch(() => ({ ok: r.ok, data: {} })))
					.then(({ ok, data }) => {
						if (!ok || !data || !data.settings) {
							throw new Error((data && data.error) || "HTTP 错误");
						}
						emitSettings(data.settings); // 广播：麦克风按钮的静音时长/自动发送等立即生效
						setStatus("已保存，立即生效 ✓");
						setSaving(false);
					})
					.catch((e) => {
						setErr("保存失败：" + (e && e.message ? e.message : String(e)));
						setSaving(false);
					});
			};

			const field = (label, control, note) => React.createElement("div", { key: label },
				React.createElement("label", { style: SECTION_STYLES.label }, label),
				control,
				note ? React.createElement("div", { style: SECTION_STYLES.note }, note) : null
			);

			return React.createElement("div", { style: SECTION_STYLES.wrap },
				// ========== 语音识别设置 ==========
				React.createElement("h4", { style: { ...SECTION_STYLES.h, fontSize: 14, marginTop: 18 } }, "🎤 语音识别设置"),
				field("ASR 引擎",
					React.createElement("select", {
						style: SECTION_STYLES.input,
						value: engine,
						onChange: (e) => {
							touchedRef.current = true;
							const next = e.target.value;
							// 切引擎时：Base URL/模型若仍是旧引擎默认（或为空）→ 自动换成新引擎默认
							const cur = ASR_ENGINE_DEFAULTS[engine] || {};
							const dft = ASR_ENGINE_DEFAULTS[next] || {};
							if (!baseUrl.trim() || baseUrl.trim() === cur.baseUrl) setBaseUrl(dft.baseUrl);
							if (!model.trim() || model.trim() === cur.model) setModel(dft.model);
							setEngine(next);
						}
					},
						React.createElement("option", { value: "siliconflow" }, "硅基流动 SiliconFlow（默认，推荐）"),
						React.createElement("option", { value: "groq" }, "Groq（Whisper）"),
						React.createElement("option", { value: "mimo" }, "小米 MiMo-V2.5-ASR（chat 接口）"),
						React.createElement("option", { value: "custom" }, "自定义（OpenAI 兼容 /audio/transcriptions）")
					),
					engine === "mimo"
						? "MiMo 走 chat/completions 协议，仅支持 wav/mp3；录音会自动转 16k 单声道 WAV 上传"
						: "OpenAI 兼容 /audio/transcriptions multipart 协议，录音 webm 原样上传"),
				field("ASR Base URL",
					React.createElement("input", {
						style: SECTION_STYLES.input, value: baseUrl, spellCheck: false,
						onChange: (e) => { touchedRef.current = true; setBaseUrl(e.target.value); },
						placeholder: (ASR_ENGINE_DEFAULTS[engine] || {}).baseUrl || "https://api.siliconflow.cn/v1"
					}),
					engine === "mimo"
						? "填 MiMo 完整端点，默认 https://api.xiaomimimo.com/v1/chat/completions（以 /chat/completions 结尾即自动按 chat 协议）"
						: "OpenAI 兼容接口基地址，自动拼接 /audio/transcriptions"),
				field("ASR 模型名称",
					React.createElement("input", {
						style: SECTION_STYLES.input, value: model, spellCheck: false,
						onChange: (e) => { touchedRef.current = true; setModel(e.target.value); },
						placeholder: (ASR_ENGINE_DEFAULTS[engine] || {}).model || "FunAudioLLM/SenseVoiceSmall"
					}),
					"留空用内置默认"),
				field("ASR API Key",
					React.createElement("input", {
						style: SECTION_STYLES.input, type: "password", value: apiKey, spellCheck: false,
						onChange: (e) => { touchedRef.current = true; setApiKey(e.target.value); },
						placeholder: "sk-..."
					}),
					"保存在本机插件目录 settings.local.json；留空则沿用服务端已配密钥"),
				React.createElement("label", { style: SECTION_STYLES.checkRow },
					React.createElement("input", {
						type: "checkbox",
						checked: autoSend,
						onChange: (e) => { touchedRef.current = true; setAutoSend(e.target.checked); }
					}),
					React.createElement("span", null, "识别完成后自动点击发送"),
					React.createElement("span", { style: SECTION_STYLES.note }, "（取消勾选则只填入输入框，由你手动发送）")
				),
				field("静音自动结束（秒）",
					React.createElement("input", {
						style: SECTION_STYLES.input, value: silenceSec, inputMode: "decimal",
						onChange: (e) => { touchedRef.current = true; setSilenceSec(e.target.value); }
					}),
					"说话停顿超过该时长自动结束录音并上传识别（0.3 ~ 15 秒）"),
				// ========== 朗读设置 ==========
				React.createElement("h4", { style: { ...SECTION_STYLES.h, fontSize: 14, marginTop: 24 } }, "🔊 朗读设置"),
				React.createElement("label", { style: SECTION_STYLES.checkRow },
					React.createElement("input", {
						type: "checkbox",
						checked: rewrite,
						onChange: (e) => { touchedRef.current = true; setRewrite(e.target.checked); }
					}),
					React.createElement("span", null, "长回复先转述（精简）再播报"),
					React.createElement("span", { style: SECTION_STYLES.note }, "（默认关闭；开启后较长的回复会先经 LLM 压缩成口语再朗读）")
				),
				field("TTS 引擎",
					React.createElement("select", {
						style: SECTION_STYLES.input,
						value: ttsEngine,
						onChange: (e) => { touchedRef.current = true; setTtsEngine(e.target.value); }
					},
						React.createElement("option", { value: "edge" }, "微软 Edge TTS（免费，推荐）"),
						React.createElement("option", { value: "mimo" }, "小米 MiMo TTS（chat 接口）"),
						React.createElement("option", { value: "custom" }, "自定义 TTS（OpenAI 兼容接口）")
					),
					"微软 Edge TTS 免费无限制；MiMo TTS 走 chat/completions 协议；自定义 TTS 需要配置 API"),
				// 自定义 TTS 设置（仅当 ttsEngine === 'custom' 时显示）
				ttsEngine === "custom" ? React.createElement(React.Fragment, null,
					field("TTS Base URL",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsBaseUrl, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setTtsBaseUrl(e.target.value); },
							placeholder: "https://api.openai.com/v1"
						}),
						"OpenAI 兼容的 /audio/speech 接口地址"),
					field("TTS 模型名称",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsModel, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setTtsModel(e.target.value); },
							placeholder: "tts-1"
						}),
						"留空用内置默认"),
					field("TTS API Key",
						React.createElement("input", {
							style: SECTION_STYLES.input, type: "password", value: ttsApiKey, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setTtsApiKey(e.target.value); },
							placeholder: "sk-..."
						}),
						"保存在本机插件目录 settings.local.json；留空则沿用 ASR 密钥")
				) : null,
				// MiMo TTS 设置（仅当 ttsEngine === 'mimo' 时显示）
				ttsEngine === "mimo" ? React.createElement(React.Fragment, null,
					field("TTS Base URL",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsBaseUrl, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setTtsBaseUrl(e.target.value); },
							placeholder: "https://api.xiaomimimo.com/v1"
						}),
						"MiMo 基地址（自动拼 /chat/completions）或完整端点均可"),
					field("TTS 模型名称",
						React.createElement("input", {
							style: SECTION_STYLES.input, value: ttsModel, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setTtsModel(e.target.value); },
							placeholder: "mimo-v2.5-tts"
						}),
						"留空用内置默认 mimo-v2.5-tts"),
					field("TTS API Key",
						React.createElement("input", {
							style: SECTION_STYLES.input, type: "password", value: ttsApiKey, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setTtsApiKey(e.target.value); },
							placeholder: "sk-..."
						}),
						"保存在本机插件目录 settings.local.json；留空则沿用 ASR 密钥"),
					field("朗读音色（MiMo TTS）",
						React.createElement("input", {
							style: SECTION_STYLES.input, list: "dsh-vc-mimo-voices", value: voice, spellCheck: false,
							onChange: (e) => { touchedRef.current = true; setVoice(e.target.value); },
							placeholder: "mimo_default"
						}),
						"留空用 mimo_default；下拉是预置音色，也可输入其它有效音色名")
				) : null,
				// Edge TTS 设置（仅当 ttsEngine === 'edge' 时显示）
				ttsEngine === "edge" ? field("朗读音色（Edge TTS）",
					React.createElement("input", {
						style: SECTION_STYLES.input, list: "dsh-vc-voices", value: voice, spellCheck: false,
						onChange: (e) => { touchedRef.current = true; setVoice(e.target.value); },
						placeholder: "zh-CN-XiaoxiaoNeural"
					}),
					"留空用内置默认晓晓；下拉是常用音色，也可输入任意有效音色名"
				) : null,
				React.createElement("datalist", { id: "dsh-vc-voices" },
					VOICE_PRESETS.map((v) => React.createElement("option", { key: v, value: v }))
				),
				React.createElement("datalist", { id: "dsh-vc-mimo-voices" },
					MIMO_TTS_VOICES.map((v) => React.createElement("option", { key: v, value: v }))
				),
				err ? React.createElement("div", { style: SECTION_STYLES.err }, err) : null,
				React.createElement("div", { style: SECTION_STYLES.saveRow },
					React.createElement("button", {
						type: "button", style: SECTION_STYLES.primary, onClick: save, disabled: saving
					}, saving ? "保存中…" : "保存"),
					status ? React.createElement("span", { style: SECTION_STYLES.status }, status) : null
				)
			);
		}

		// ---------- 组件 ----------
		function VoiceChatButton(props) {
			const { useSession, inputActions, useCurrentModel, sessionId, useInput } = props;
			const session = typeof useSession === "function" ? useSession((s) => s) : undefined;
			// 订阅输入框当前内容：语音听写结果要"追加"而不是覆盖已有草稿
			const inputState = typeof useInput === "function" ? useInput((s) => s) : undefined;
			// 订阅"当前对话实际在用的 LLM 选择"，转述朗读时把 provider/model
			// 透传给宿主 /speak，避免一直用宿主默认（可能已被关闭/密钥不对）。
			const currentModel = typeof useCurrentModel === "function" ? useCurrentModel(sessionId) : null;

			// [DEBUG] 诊断已结束:session keys 确认无消息列表,采用 running+DOM 方案。

			// 语音相关状态
			const [recording, setRecording] = useState(false);
			const [busy, setBusy] = useState(false);
			const [hint, setHint] = useState("");
			const [muted, setMuted] = useState(false);      // 朗读开关（静音）
			const [speaking, setSpeaking] = useState(false); // 正在播报
			const mutedRef = useRef(false);
			const audioRef = useRef(null);
			// 播放队列：播报不打断，按顺序一条条讲完
			const queueRef = useRef([]);         // 待播放文本队列（FIFO）
			const playingRef = useRef(false);    // 是否正在播放某一条
			const resetTokenRef = useRef(0);     // 停止/静音时递增，作废在途请求
			const finishAudioRef = useRef(null); // 结束当前音频的钩子（stop 时触发）

			const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices && !!navigator.mediaDevices.getUserMedia;
			const recRef = useRef(null);
			const streamRef = useRef(null);
			const chunksRef = useRef([]);
			const silenceRef = useRef(null);
			const silenceMsRef = useRef(2500); // 静音自动停止时长，启动时从 /settings 读取
			const autoSendRef = useRef(true);  // 识别完成后是否自动点发送，启动时从 /settings 读取
			const chatAsrRef = useRef(false);  // ASR 是否走 chat/completions 协议（MiMo 式，需转 WAV 上传）

			// 从共享设置总线读取生效设置（静音自动结束时长、识别后是否自动发送）；
			// 设置页保存后广播过来会即时刷新本侧，无需刷新页面。
			const settingsValue = useSettings();
			useEffect(() => {
				if (!settingsValue) return;
				if (Number.isFinite(Number(settingsValue.silenceMs)) && Number(settingsValue.silenceMs) > 0) {
					silenceMsRef.current = Math.round(Number(settingsValue.silenceMs));
				}
				autoSendRef.current = settingsValue.autoSend !== false;
				chatAsrRef.current = isChatAsrSettings(settingsValue); // MiMo 等 chat 协议 → 上传前转 WAV
			}, [settingsValue]);

			// 注意：useCallback 的依赖数组在定义时求值，函数必须先定义后引用（避免 TDZ）。

			// 停止当前播报并清空队列（静音按钮/快捷键/开始录音时调用）。
			// 顺序很关键：必须先暂停正在发声的音频元素，再触发 finish 钩子——
			// done 钩子会把 audioRef.current 置空，若先调钩子，后面的 pause 永远
			// 执行不到，声音会继续播完当前片段，"按喇叭立刻静音"就失效了。
			const stopPlayback = useCallback(() => {
				resetTokenRef.current += 1; // 作废在途的异步播报请求与排队
				queueRef.current = [];
				if (audioRef.current) {
					try { audioRef.current.pause(); } catch (err) { /* ignore */ }
					try { audioRef.current.src = ""; } catch (err) { /* ignore */ }
					audioRef.current = null;
				}
				if (finishAudioRef.current) {
					const f = finishAudioRef.current;
					finishAudioRef.current = null;
					try { f(); } catch (err) { /* ignore */ }
				}
				try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (err) { /* ignore */ }
				setSpeaking(false);
			}, []);

			// 播放一段 MP3，返回 Promise：播放结束/失败/被停止时 resolve(true)；不可播 resolve(false)
			const playAudioBlob = useCallback((blob) => new Promise((resolve) => {
				if (!blob || blob.size === 0 || mutedRef.current) return resolve(false);
				try {
					if (audioRef.current) {
						try { audioRef.current.pause(); } catch (err) { /* ignore */ }
						audioRef.current = null;
					}
					const url = URL.createObjectURL(blob);
					const audio = new Audio(url);
					audioRef.current = audio;
					setSpeaking(true);
					const done = () => {
						if (finishAudioRef.current === done) finishAudioRef.current = null;
						if (audioRef.current === audio) { audioRef.current = null; setSpeaking(false); }
						try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
						resolve(true);
					};
					finishAudioRef.current = done;
					audio.onended = done;
					audio.onerror = done;
					audio.play().catch((err) => {
						console.error("[dsh-voice-chat] playback failed", err);
						done();
					});
				} catch (err) {
					console.error("[dsh-voice-chat] playAudioBlob failed", err);
					setSpeaking(false);
					resolve(false);
				}
			}), []);

			/**
			 * 短促提示音（Web Audio 合成，无需音频文件）。
			 * @param freq 频率 Hz；start=880 高音，end=523 低音
			 * @param ms 时长（短促，100~150ms）
			 */
			const beep = useCallback((freq, ms) => {
				try {
					const AudioCtx = window.AudioContext || window.webkitAudioContext;
					if (!AudioCtx) return;
					const ctx = new AudioCtx();
					const osc = ctx.createOscillator();
					const gain = ctx.createGain();
					osc.type = "sine";
					osc.frequency.value = freq;
					const dur = Math.max(60, Math.min(150, ms));
					gain.gain.setValueAtTime(0.12, ctx.currentTime);
					gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur / 1000);
					osc.connect(gain);
					gain.connect(ctx.destination);
					osc.start();
					osc.stop(ctx.currentTime + dur / 1000);
					osc.onended = () => { try { ctx.close(); } catch (err) { /* ignore */ } };
				} catch (err) { /* 提示音失败不影响功能 */ }
			}, []);

			// 浏览器 TTS 兜底（Promise 版：播完才 resolve，配合队列泵）
			const fallbackSpeakP = useCallback((text) => new Promise((resolve) => {
				try {
					if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return resolve(false);
					window.speechSynthesis.cancel();
					const u = new SpeechSynthesisUtterance(text);
					u.lang = "zh-CN";
					u.rate = 1.15; // 浏览器 TTS 语速 1.15 倍（与 edge-tts +10% 互补）
					u.onend = () => resolve(true);
					u.onerror = () => resolve(false);
					window.speechSynthesis.speak(u);
					window.setTimeout(() => resolve(true), 30000); // 兜底：长时间无回调
				} catch (err) {
					console.error("[dsh-voice-chat] fallback speak failed", err);
					resolve(false);
				}
			}), []);

			// 播放一条文本（转述 → edge-tts → 浏览器 TTS 逐级降级），播完 resolve(true)
			const playOne = useCallback(async (text) => {
				const token = resetTokenRef.current;
				const stillAlive = () => resetTokenRef.current === token && !mutedRef.current;
				// 兜底朗读用文本：优先服务端转述结果（/speak 失败时随错误带回），否则原文。
				let fallbackText = text;
				// 1) 转述式朗读
				try {
					const resp = await window.fetch("/dsh-voice-chat/speak", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							text,
							// 把当前对话实际在用的 LLM 透传给宿主，让转述跟当前对话走
							llmProvider: currentModel && currentModel.provider,
							llmModel: currentModel && currentModel.model
						})
					});
					if (!stillAlive()) return false;
					if (resp.ok) {
						const blob = await resp.blob();
						if (!stillAlive()) return false;
						if (await playAudioBlob(blob)) return true;
					} else {
						console.warn("[dsh-voice-chat] speak endpoint failed:", resp.status);
						// edge-tts 挂了：服务端把"实际要读的台词"（转述版或原文）放在错误 body 里
						const body = await resp.json().catch(() => ({}));
						if (!stillAlive()) return false;
						if (body && typeof body.spoken === "string" && body.spoken.trim()) {
							fallbackText = body.spoken;
						}
					}
				} catch (err) {
					console.warn("[dsh-voice-chat] speak request failed:", err);
				}
				if (!stillAlive()) return false;
				// 2) 降级：原样朗读（优先读转述版）
				try {
					const resp = await window.fetch("/dsh-voice-chat/tts?text=" + encodeURIComponent(fallbackText));
					if (!stillAlive()) return false;
					if (resp.ok) {
						const blob = await resp.blob();
						if (!stillAlive()) return false;
						if (await playAudioBlob(blob)) return true;
					}
				} catch (err) {
					console.warn("[dsh-voice-chat] tts request failed:", err);
				}
				if (!stillAlive()) return false;
				// 3) 最后回退：浏览器 TTS
				return await fallbackSpeakP(fallbackText);
			}, [playAudioBlob, fallbackSpeakP]);

			// 队列泵：一条播完自动播下一条
			const pump = useCallback(async () => {
				if (playingRef.current) return;
				playingRef.current = true;
				const token = resetTokenRef.current;
				try {
					while (queueRef.current.length > 0) {
						if (resetTokenRef.current !== token || mutedRef.current) break;
						const text = queueRef.current.shift();
						if (!text) continue;
						await playOne(text);
						if (resetTokenRef.current !== token) break;
					}
				} finally {
					playingRef.current = false;
					if (queueRef.current.length === 0) setSpeaking(false);
				}
			}, [playOne]);

			/**
			 * 朗读：入队顺序播放（播报不打断）。
			 * 正在播的让它播完，新回复排到队尾依次讲；只有 stopPlayback
			 * （静音/停止/开始录音）才会清空队列立即停止。
			 */
			const playTts = useCallback((text) => {
				if (!text || typeof window === "undefined" || mutedRef.current) return;
				queueRef.current.push(text);
				setSpeaking(true); // 有排队即算"播报中"
				pump();
			}, [pump]);

			// ---------- 新版 DSH 消息检测(0.1.2-rc.1 适配) ----------
			// session 里已无 nodes(消息在插件拿不到的 conversation store)。
			// 改用 session.running 的 true→false 边沿检测"AI 回复完成",
			// 再从 DOM 提取最新回复文本播报;按文本内容去重防重播。
			const prevRunningRef = useRef(false);
			const lastSpokenTextRef = useRef("");
			const turnEndTimerRef = useRef(null);
			const runningNowRef = useRef(false);

			useEffect(() => {
				const running = !!(session && session.running);
				const was = prevRunningRef.current;
				prevRunningRef.current = running;
				runningNowRef.current = running;

				if (!was || running) return; // 只在 true→false 边沿触发(回复刚结束)

				// 等 800ms(流式写入会话日志完成),再向宿主要最新 assistant 消息
				if (turnEndTimerRef.current) window.clearTimeout(turnEndTimerRef.current);
				turnEndTimerRef.current = window.setTimeout(async () => {
					turnEndTimerRef.current = null;
					if (runningNowRef.current || mutedRef.current) return; // 中途又跑起来/静音:不播
					// 从宿主 sessions 服务拿最新 assistant 消息(可靠,不扫 DOM)
					let text = "";
					try {
						const sid = encodeURIComponent(session && session.sessionId || "");
						const resp = await window.fetch("/dsh-voice-chat/latest-message?sessionId=" + sid);
						if (resp.ok) {
							const data = await resp.json();
							text = String(data && data.text || "").trim();
						} else {
							console.warn("[dsh-voice-chat] latest-message 接口:", resp.status);
						}
					} catch (err) {
						console.warn("[dsh-voice-chat] latest-message 请求失败:", err);
					}
					// 接口失败时兜底:DOM 提取(尽力而为)
					if (!text) text = extractLatestAssistantText() || "";
					console.log("[dsh-voice-chat] turn 结束,拿到文本:", text ? text.slice(0, 80) + (text.length > 80 ? "…" : "") : "(空)");
					if (!text || text === lastSpokenTextRef.current) return;
					lastSpokenTextRef.current = text;
					playTts(text);
				}, 800);
			}, [session && session.running, playTts]);

			// 卸载时清理定时器
			useEffect(() => () => {
				if (turnEndTimerRef.current) window.clearTimeout(turnEndTimerRef.current);
			}, []);

			// 静音/恢复按钮：静音时立刻停止当前播报、清空待播队列，并禁止后续自动播报；
			// 再按一次恢复正常播报（基于 ref 切换，连点两下也准确，不依赖暂时滞后的 state）
			const toggleMute = useCallback(() => {
				const next = !mutedRef.current;
				mutedRef.current = next;
				setMuted(next);
				if (next) stopPlayback();
			}, [stopPlayback]);

			// 提示 1.8s 后消失
			useEffect(() => {
				if (!hint) return;
				const t = window.setTimeout(() => setHint(""), 1800);
				return () => window.clearTimeout(t);
			}, [hint]);

			const sendText = useCallback((text) => {
				if (!text) return;
				try {
					if (inputActions && typeof inputActions.setDraft === "function" && typeof inputActions.submit === "function") {
						// 追加而非覆盖：保留输入框里已有的内容，听写结果拼在后面
						let current = "";
						if (inputState && typeof inputState.draft === "string") current = inputState.draft;
						const merged = current.trim() ? `${current.trim()} ${text.trim()}` : text.trim();
						inputActions.setDraft(merged);
						if (autoSendRef.current) {
							inputActions.submit();
						} else {
							// 设置里关掉了自动发送：只填入输入框，由用户手动点发送
							setHint("已追加到输入框，未自动发送");
						}
					} else {
						console.warn("[dsh-voice-chat] inputActions unavailable, transcript:", text);
						setHint("转写成功，但发送通道不可用");
					}
				} catch (err) {
					console.error("[dsh-voice-chat] send failed", err);
					setHint("发送失败");
				}
			}, [inputActions, inputState]);

			const clearSilence = useCallback(() => {
				const s = silenceRef.current;
				silenceRef.current = null;
				if (!s) return;
				if (s.timer) window.clearInterval(s.timer);
				try { s.audioCtx && s.audioCtx.close(); } catch (err) { /* ignore */ }
			}, []);

			const stop = useCallback(() => {
				clearSilence();
				const rec = recRef.current;
				recRef.current = null;
				if (rec && rec.state !== "inactive") {
					try { rec.stop(); } catch (err) { /* ignore */ }
				}
			}, [clearSilence]);

			// 静音检测：持续无声超过 2.5s 自动停止（停止后走 onstop 发送）
			const startSilenceMonitor = useCallback((stream, rec) => {
				try {
					const AudioCtx = window.AudioContext || window.webkitAudioContext;
					const audioCtx = new AudioCtx();
					const source = audioCtx.createMediaStreamSource(stream);
					const analyser = audioCtx.createAnalyser();
					analyser.fftSize = 1024;
					source.connect(analyser);
					const data = new Uint8Array(analyser.fftSize);
					let lastSound = Date.now();
					const timer = window.setInterval(() => {
						const current = recRef.current;
						if (!current || current.state === "inactive") {
							window.clearInterval(timer);
							return;
						}
						analyser.getByteTimeDomainData(data);
						let sum = 0;
						for (let i = 0; i < data.length; i++) {
							const v = (data[i] - 128) / 128;
							sum += v * v;
						}
						const rms = Math.sqrt(sum / data.length);
						if (rms > 0.01) {
							lastSound = Date.now();
						} else if (Date.now() - lastSound > silenceMsRef.current) {
							window.clearInterval(timer);
							stop();
						}
					}, 200);
					silenceRef.current = { timer, audioCtx };
				} catch (err) {
					console.error("[dsh-voice-chat] silence monitor failed", err);
				}
			}, [stop]);

			const start = useCallback(async () => {
				if (recording || busy) return;
				if (!supported) {
					setHint("当前浏览器不支持录音（建议 Chrome/Edge）");
					return;
				}
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					streamRef.current = stream;
					chunksRef.current = [];
					const mime = pickMime();
					const rec = mime
						? new MediaRecorder(stream, { mimeType: mime })
						: new MediaRecorder(stream);
					rec.ondataavailable = (e) => {
						if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
					};
					rec.onstop = async () => {
						// 手动停或静音自动停都走这里发送
						const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
						try {
							stream.getTracks().forEach((t) => t.stop());
						} catch (err) { /* ignore */ }
						streamRef.current = null;
						clearSilence();
						setRecording(false);
						beep(523, 100); // 结束提示音（低音短促）
						if (blob.size === 0) return;
						setBusy(true);
						setHint("转写中…");
						try {
							// chat 协议 ASR（如 MiMo）只吃 wav/mp3：先转 16k 单声道 WAV 再上传
							let payload = blob;
							if (chatAsrRef.current) {
								try {
									payload = await blobToWav(blob);
								} catch (convErr) {
									console.error("[dsh-voice-chat] wav convert failed", convErr);
									setHint("录音格式转换失败，请重试");
									return;
								}
							}
							const resp = await window.fetch("/dsh-voice-chat/stt", {
								method: "POST",
								body: payload
							});
							const data = await resp.json().catch(() => ({}));
							if (!resp.ok) {
								const msg = (data && data.error) || `HTTP ${resp.status}`;
								console.error("[dsh-voice-chat] stt failed:", msg);
								setHint("识别失败：" + msg);
								return;
							}
							const text = (data && data.text || "").trim();
							if (!text) {
								setHint("没听清，请再说一次");
								return;
							}
							sendText(text);
						} catch (err) {
							console.error("[dsh-voice-chat] stt request failed", err);
							setHint("识别服务请求失败");
						} finally {
							setBusy(false);
						}
					};
					rec.onerror = (e) => {
						console.error("[dsh-voice-chat] recorder error", e && e.error);
						clearSilence();
						setRecording(false);
						setHint("录音出错");
					};
					recRef.current = rec;
					setRecording(true);
					setHint("聆听中，静音自动结束");
					beep(880, 120); // 开始提示音（高音短促）
					rec.start();
					startSilenceMonitor(stream, rec);
				} catch (err) {
					console.error("[dsh-voice-chat] mic access failed", err);
					setHint("无法访问麦克风（检查浏览器权限）");
				}
			}, [recording, busy, supported, sendText, startSilenceMonitor, beep]);

			const toggle = useCallback(() => {
				if (recording) {
					stop();
				} else {
					stopPlayback(); // 正在播报则立刻停（单信道），然后开始聆听
					start();
				}
			}, [recording, stop, start, stopPlayback]);

			// 快捷键：切换麦克风（等价于点一下 🎤 按钮）。
			// 主：Ctrl+Space（两键组合，macOS 默认输入法是 Option+Space 不冲突）；
			// 备：Ctrl+M / Ctrl+Shift+M。
			// 监听在 window 上，输入框打字时也能用；不拦截纯打字按键。
			useEffect(() => {
				const onKeyDown = (e) => {
					// Ctrl+Space
					if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === " ") {
						e.preventDefault();
						toggle();
						return;
					}
					// Ctrl+M / Ctrl+Shift+M
					if ((e.key === "M" || e.key === "m") && e.ctrlKey && !e.altKey && !e.metaKey) {
						e.preventDefault();
						toggle();
					}
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [toggle]);

			// 卸载时清理
			useEffect(() => () => {
				clearSilence();
				stopPlayback();
				if (streamRef.current) {
					try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch (err) { /* ignore */ }
				}
			}, [clearSilence, stopPlayback]);

			const styles = {
				wrap: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					marginRight: 8,
					flex: "none",
					position: "relative"
				},
				mic: {
					width: 32,
					height: 32,
					borderRadius: "50%",
					border: "1px solid var(--dsw-alias-border-l2, #ccc)",
					background: recording ? "#e5484d" : busy ? "#f5b53f" : "transparent",
					color: recording || busy ? "#fff" : "var(--dsw-alias-label-primary, #333)",
					fontSize: 16,
					cursor: "pointer",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none"
				},
				mute: {
					width: 32,
					height: 32,
					borderRadius: "50%",
					border: "1px solid var(--dsw-alias-border-l2, #ccc)",
					background: muted ? "#e5484d" : speaking ? "#f5b53f" : "transparent",
					color: muted || speaking ? "#fff" : "var(--dsw-alias-label-primary, #333)",
					fontSize: 16,
					cursor: "pointer",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none"
				},
				hint: {
					position: "absolute",
					bottom: "calc(100% + 6px)",
					right: 0,
					// 固定深灰底：不随主题变量漂成浅灰，白字对比更强、气泡更显眼
					background: "#202026",
					color: "#fff",
					fontSize: 12,
					whiteSpace: "nowrap",
					padding: "4px 8px",
					borderRadius: 6,
					zIndex: 20,
					maxWidth: 260,
					overflow: "hidden",
					textOverflow: "ellipsis",
					boxShadow: "0 2px 10px rgba(0, 0, 0, 0.4)"
				}
			};

			if (!supported) {
				return React.createElement("span", {
					style: { display: "inline-flex", alignItems: "center", marginRight: 8, opacity: 0.5 },
					title: "当前浏览器不支持录音，建议使用 Chrome / Edge"
				}, React.createElement(Icon, { paths: ICON_MIC, size: 16 }));
			}

			return React.createElement("span", { style: styles.wrap },
				hint ? React.createElement("span", { style: styles.hint }, hint) : null,
				React.createElement("button", {
					type: "button",
					onClick: toggle,
					style: styles.mic,
					disabled: busy,
					title: recording ? "点击结束并发送" : busy ? "转写中…" : "点击开始聆听（静音自动结束）· 快捷键 Ctrl+Space"
				}, React.createElement(Icon, { paths: ICON_MIC, size: 16 })),
				React.createElement("button", {
					type: "button",
					onClick: toggleMute,
					style: styles.mute,
					title: muted ? "已静音，点击恢复朗读" : speaking ? "正在播报，点击停止" : "朗读开关（点击静音）"
				}, React.createElement(Icon, { paths: muted ? ICON_MUTED : ICON_SPEAKER, size: 16 }))
			);
		}

		// ---------- 插件 ----------
		const inject = ["slots", "modelDirectories"];

		function apply(ctx) {
			// root-scoped：DSH 设置弹窗的 voice chat 类目（不需要 session 内服务）
			const slots = ctx.get("slots");
			if (slots !== undefined) {
				slots.inject("settings.section", () => slots.register(
					{ name: "settings.section", id: "dsh-voice-chat", order: 400, label: "voice chat" },
					(props) => React.createElement(VoiceChatSettingsSection, props)
				));
			}
			// session-scoped：输入框右侧的麦克风/静音按钮——需要 modelDirectories 服务
			// 拿到当前对话实际在用的 LLM（provider+model），转述朗读时透传给宿主，
			// 而不是用宿主硬编码默认（默认模型可能被关或密钥不对）。
			ctx.inject(["slots", "modelDirectories"], (scope) => {
				scope.slots.inject("conversation.input.right", () => scope.slots.register(
					{ name: "conversation.input.right", id: "dsh-voice-chat", order: 100 },
					(props) => {
						// 稳定化 hook 引用：scope.modelDirectories 在 session scope 生命周期内稳定
						const useCurrentModel = React.useMemo(
							() => makeUseCurrentModelImpl(scope.modelDirectories),
							[scope.modelDirectories]
						);
						return React.createElement(VoiceChatButton, {
							...props,
							useCurrentModel
						});
					}
				));
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
