# dsh-voice-chat

<p align="center"><a href="README.md">中文</a> | <b>English</b></p>

A Doubao-style voice chat plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: click 🎤 and talk — the AI's reply is read back to you aloud.

> 📖 Full user manual: [MANUAL.md](MANUAL.md) (install / usage / configuration / FAQ / internals).

## Features

- **Voice input**: click 🎤 to start listening (ding) → speak → auto-stops after 2.5s of silence (dong) → transcribed and sent;
- **Voice output**: AI replies are synthesized with TTS and read aloud at +10% speed; a **condensed reading** option (off by default) can rewrite longer replies into a short spoken summary before speaking — **the rewrite follows the LLM actually selected in the current conversation**;
- **ASR engines**: supports **SiliconFlow** (SenseVoice, free tier), **Groq** (Whisper), **Xiaomi MiMo** (chat/completions protocol), and **custom OpenAI-compatible** endpoints — switchable in settings;
- **TTS engines**: supports **Edge TTS** (Microsoft, free), **Xiaomi MiMo TTS** (chat/completions protocol with built-in Chinese voices), and **custom TTS** (OpenAI-compatible API);
- **Single-channel playback**: a new reply preempts the previous one; interrupt anytime via hotkey or button — only one voice at a time;
- **No duplicate playback**: which replies were already spoken is remembered per session, so re-entering a session does not replay them;
- **Mute toggle** 🔊: while playing, click to mute immediately; click again to resume;
- **Settings UI**: all settings live inside **DSH's built-in settings dialog** (gear icon → "voice chat" section), applied immediately — no restart needed;
- **Hotkeys**: `Ctrl+Shift+Space` toggles the mic (alternates `Ctrl+M` / `Ctrl+Shift+M`).

## Requirements

- **DeepSeek Harness (dsh)**: installed and running the Web GUI (`dsh web`);
- **Node.js ≥ 22** (host and browser half; the edge-tts client runs on `ws`, no extra runtime needed);
- **Browser**: Chrome / Edge (recording needs `MediaRecorder` support);
- **ASR key**: required for speech-to-text (SiliconFlow offers a free tier; MiMo charges per usage).

## Install

```bash
# Option 1 (recommended — published to npm):
dsh plugin --profile web add dsh-voice-chat

# Then restart dsh web
```

> Note: the plugin ships an inline edge-tts client (Microsoft Edge's free read-aloud service) — **no TTS API key is needed for Edge TTS**; MiMo TTS / custom TTS require their own keys.

## Configuration

### ⚙️ Settings panel (recommended, highest priority)

Open DSH's settings dialog (gear icon, bottom-left) → "**voice chat**" on the left → edit:

**🎤 Voice Recognition Settings**
- ASR engine (SiliconFlow / Groq / MiMo / custom)
- Base URL / model name / API key
- Auto-send after transcription
- Silence auto-stop duration (seconds)

**🔊 Readout Settings**
- TTS engine (Edge TTS / MiMo TTS / custom TTS)
- Per-engine Base URL / model name / API key / voice
- Condensed reading toggle (off by default)

Saving writes to `settings.local.json` and takes effect immediately.

### 📄 Config file (lower priority)

Override `config` by id in the profile's `~/.dsh/profiles/web/cordis.patch.yml` (all keys optional; defaults apply when absent):

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    asrEngine: siliconflow          # siliconflow | groq | mimo | custom
    asrApiKey: sk-xxxx              # ASR key (or env var DSH_VOICE_ASR_KEY)
    asrBaseUrl: https://api.siliconflow.cn/v1
    asrModel: FunAudioLLM/SenseVoiceSmall
    llmModel: deepseek-v4-flash     # rewrite model (fallback, follows current conversation)
    silenceMs: 2500
    rewrite: false                  # condensed reading (default off; toggle in settings)
    ttsEngine: edge                 # edge | mimo | custom
    voice: zh-CN-XiaoxiaoNeural
    ttsBaseUrl: https://api.openai.com/v1
    ttsModel: tts-1
    ttsApiKey: sk-xxxx
    rate: '+10%'
    shortTextChars: 50
```

Restart `dsh web` after editing. Priority: **settings panel > cordis.patch.yml > env vars > defaults**.

## Structure

- `lib/index.js` — host half: routes `/stt` (ASR, dual-protocol: OpenAI multipart + MiMo chat/completions), `/tts` (Edge/MiMo/custom TTS), `/speak` (rewrite + synthesize), `/settings` (settings panel persistence);
- `lib/client.js` — browser half: mic/mute buttons, silence detection, single-channel playback, hotkeys (Ctrl+Shift+Space), auto WAV conversion for chat-protocol ASR; injects the "voice chat" settings section into DSH's settings dialog;
- `lib/edge-tts.js` — inline edge-tts protocol client (Microsoft Edge free read-aloud); the only runtime dependency is `ws`;
- `cordis.patch.yml` — inserts the `dsh-voice-chat` line + config example;
- `settings.local.json` — overrides saved from the settings dialog (generated at runtime, never committed).
