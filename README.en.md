# dsh-voice-chat

<p align="center"><a href="README.md">中文</a> | <b>English</b></p>

A Doubao-style voice chat plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: click 🎤 and talk — the AI's reply is read back to you aloud.

> 📖 Full user manual: [MANUAL.md](MANUAL.md) (install / usage / configuration / FAQ / internals).

## Features

- **Voice input**: click 🎤 to start listening (ding) → speak → auto-stops after 2.5s of silence (dong) → transcribed and sent;
- **Voice output**: AI replies are synthesized with TTS and read aloud at +10% speed; a **condensed reading** option (off by default) can rewrite longer replies into a short spoken summary in the assistant's own voice (≤ original length, no tangents, no code/tables) before speaking — **the rewrite follows the LLM actually selected in the current conversation** (no hardcoded default, so it never fails on a disabled default model or wrong key);
- **TTS engine choice**: supports **Microsoft Edge TTS** (free, recommended) and **custom TTS** (OpenAI-compatible API, e.g., OpenAI/DeepSeek), switchable in settings;
- **Single-channel playback**: a new reply preempts the previous one; interrupt anytime via hotkey or button — only one voice at a time;
- **No duplicate playback**: which replies were already spoken is remembered per session, so re-entering a session does not replay them;
- **Mute toggle** 🔊: while playing (button highlighted), click to **mute immediately** — stops the current audio and clears the whole queue; click again to resume auto-readout;
- **Settings UI**: all settings live inside **DSH's built-in settings dialog** (gear icon bottom-left → "voice chat" section on the left): 🎤 **Voice Recognition Settings** (ASR endpoint, auto-send, silence duration), 🔊 **Readout Settings** (TTS engine choice, condensed reading toggle, voice, custom TTS API config); saved to `settings.local.json` in the plugin dir (gitignored), applied immediately — no restart needed;
- **Hotkeys**: `Alt+S` toggles the mic (alternates `Ctrl+M` / `Ctrl+Shift+M`).

## Requirements

- **DeepSeek Harness (dsh)**: installed and running the Web GUI (`dsh web`);
- **Node.js ≥ 22** (host and browser half; the edge-tts client runs on `ws`, no extra runtime needed);
- **Browser**: Chrome / Edge (recording needs `MediaRecorder` support);
- **ASR key**: required for speech-to-text (SiliconFlow recommended; OpenAI-compatible endpoints work).

## Install

```bash
# Option 1 (recommended — published to npm):
dsh plugin --profile web add dsh-voice-chat

# Option 2 (local development):
dsh plugin --profile web add D:/Code/dsh-voice-chat

# Then restart dsh web
```

> Note: the plugin ships an inline edge-tts client (Microsoft Edge's free read-aloud service) — **no speech-synthesis API key is needed**; only speech-to-text (ASR) requires a key.

## Configuration (editing the config file)

Override `config` by id in the profile's `~/.dsh/profiles/web/cordis.patch.yml` (all keys optional; defaults apply when absent):

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    # Voice Recognition Settings
    asrEngine: siliconflow          # siliconflow | groq | mimo | custom (speech-to-text)
    asrApiKey: sk-xxxx              # ASR key (or env var DSH_VOICE_ASR_KEY)
    asrBaseUrl: https://api.siliconflow.cn/v1   # for mimo use full endpoint https://api.xiaomimimo.com/v1/chat/completions
    asrModel: FunAudioLLM/SenseVoiceSmall       # for mimo use mimo-v2.5-asr
    llmModel: deepseek-v4-flash     # rewrite model (lowest-priority fallback): by default follows the LLM selected in the current conversation / main UI; only used when even agentDefaultModel is missing
    silenceMs: 2500                 # ms of silence before recording auto-stops
    # Readout Settings
    rewrite: true                   # rewrite long replies with LLM before reading (default off; toggle in settings)
    ttsEngine: edge                 # TTS engine: edge (Microsoft Edge TTS, free) | mimo (Xiaomi MiMo TTS) | custom (OpenAI-compatible API)
    voice: zh-CN-XiaoxiaoNeural     # edge-tts voice id (also selectable in the settings panel)
    ttsBaseUrl: https://api.openai.com/v1  # custom TTS API endpoint (required when ttsEngine=custom)
    ttsModel: tts-1                 # custom TTS model name (leave empty for built-in default)
    ttsApiKey: sk-xxxx              # custom TTS API key (leave empty to use ASR key)
    rate: '+10%'                    # speaking rate ('+15%' faster, '+0%' normal)
    shortTextChars: 50              # replies shorter than this are read verbatim, never rewritten
```

Restart `dsh web` after editing.

### ⚙️ Settings UI (inside DSH's built-in settings dialog — highest priority)

No config file needed: open DSH's settings dialog (gear icon, bottom-left) → "**voice chat**" on the left → edit:

**🎤 Voice Recognition Settings**
- ASR Base URL / model name / API key
- Auto-send after transcription toggle
- Silence auto-stop duration (seconds)

**🔊 Readout Settings**
- Condensed reading toggle (off by default)
- TTS engine choice (Microsoft Edge TTS free / custom TTS OpenAI-compatible API)
- Edge TTS voice
- Custom TTS Base URL / model name / API key

Saving writes to `settings.local.json` in the plugin root and takes effect immediately. Priority: **settings dialog > per-line config in cordis.patch.yml > env vars > defaults**; leaving a field empty falls back to the next layer.

## Structure

- `package.json` — `dsh.bundle.patch` makes `dsh plugin add` register it as a profile layer; `dsh.client` + `exports["./client"]` load the browser bundle in the Web UI;
- `cordis.patch.yml` — inserts the `dsh-voice-chat` line + config example;
- `lib/index.js` — host half: routes `/stt` (ASR), `/tts` (edge-tts), `/speak` (rewrite + synthesize), `/config`, `GET|POST /settings` (settings panel persistence);
- `lib/edge-tts.js` — inline edge-tts protocol client (Microsoft Edge free read-aloud service); the only runtime dependency is `ws`;
- `lib/client.js` — browser half: mic/mute buttons, silence detection, single-channel playback, hotkeys, beeps; also injects the "voice chat" settings section into DSH's settings dialog;
- `settings.local.json` — overrides saved from the settings dialog (generated at runtime, never committed).