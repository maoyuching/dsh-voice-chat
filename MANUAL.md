# dsh-voice-chat 使用手册

> DeepSeek Harness 语音对话插件 —— 点一下 🎤 说话，AI 回复用语音"汇报"给你。
> 版本 0.3.1 · 更新于 2026-09-05

---

## 目录

1. [插件简介](#一插件简介)
2. [功能特性](#二功能特性)
3. [环境要求](#三环境要求)
4. [安装](#四安装)
5. [快速上手（5 分钟）](#五快速上手5-分钟)
6. [操作手册](#六操作手册)
7. [配置指南](#七配置指南)
8. [工作原理（面向程序员）](#八工作原理面向程序员)
9. [常见问题排查（FAQ）](#九常见问题排查faq)
10. [安全提示](#十安全提示)
11. [更新与卸载](#十一更新与卸载)

---

## 一、插件简介

`dsh-voice-chat` 是一个运行在 DeepSeek Harness（DSH）Web GUI 上的**豆包式语音对话插件**。它给聊天输入框旁边加了一个麦克风按钮：

- **说**：点一下 🎤 开始聆听，说完停顿片刻自动结束，语音转成文字发给 AI；
- **听**：AI 的回复用 TTS 合成语音播报出来（支持 Edge TTS 免费朗读 / MiMo TTS 中文音色 / 自定义 TTS）；
- **可选转述**：开启「转述朗读」后，较长回复会先由 LLM 以"助手本人"的口吻简短转述，再播报。

---

## 二、功能特性

| 功能 | 说明 |
|---|---|
| 🎤 语音输入 | 点按开始聆听（"叮"提示音）→ 说话 → 静音 2.5s 自动结束（"咚"）→ 转写发送 |
| 🗣️ 转述朗读 | （默认关闭）开启后：较长回复先经 LLM 收敛转述（≤原文、去代码表格），再 TTS 朗读；转述模型自动跟随当前对话 LLM |
| 🔊 TTS 引擎 | 支持 **Edge TTS**（微软免费）、**MiMo TTS**（小米，内置中文音色）、**自定义 TTS**（OpenAI 兼容） |
| 🎤 ASR 引擎 | 支持 **SiliconFlow**（免费）、**Groq**（Whisper）、**MiMo**（小米，chat/completions 协议）、**自定义**（OpenAI 兼容） |
| 🔇 静音开关 | 正在播报时点击**立即停止**；静音后不再自动朗读 |
| ⏪ 单信道播报 | 新回复抢占旧播报；快捷键/录音可打断，同一时刻只有一种声音 |
| 🔁 防重播 | 按会话记住已播报的回复，重新进入会话不会重复朗读 |
| ⌨️ 快捷键 | `Ctrl+Shift+Space` 切换麦克风（备用 `Ctrl+M` / `Ctrl+Shift+M`），打字时也能用 |
| ⚙️ 设置面板 | DSH 自带设置弹窗里直接改，保存即生效，无需重启 |
| 🔄 录音转码 | MiMo 等 chat 协议 ASR 只支持 wav/mp3，浏览器录音（webm）自动转 16kHz 单声道 WAV |

---

## 三、环境要求

- **DeepSeek Harness**（dsh）已安装并运行 Web GUI（`dsh web`）；
- **Node.js ≥ 22**；
- **浏览器**：Chrome / Edge（需要 `MediaRecorder` 录音能力）；
- **ASR 密钥**：SiliconFlow 注册即有免费额度；MiMo 按用量计费（约 0.5 元/小时）；
- **TTS**：Edge TTS 免费无需密钥；MiMo TTS / 自定义 TTS 需要对应密钥。

---

## 四、安装

```bash
# 推荐（已发布到 npm）：
dsh plugin --profile web add dsh-voice-chat

# 重启 dsh web 使插件生效
```

安装成功后：
- 插件会自动注册为 profile 层（`~/.dsh/profiles/web/package.json` 的 `bundles` 里出现 `dsh-voice-chat`）；
- 浏览器刷新页面后，输入框右侧出现 🎤 和 🔊 两个按钮。

---

## 五、快速上手（5 分钟）

1. **刷新页面**（Ctrl+Shift+R），确认输入框右侧出现 🎤 按钮；
2. 配置 ASR 密钥（见[配置指南](#七配置指南)）；
3. **点一下 🎤** → 听到"叮" → 开始说话；
4. 说完停顿约 2.5 秒 → 听到"咚" → 语音自动转文字并发送；
5. AI 回复到达后，**自动语音播报**。

> 💡 想更快？直接用快捷键 **Ctrl+Shift+Space** 代替点按钮。

---

## 六、操作手册

### 6.1 按钮

| 按钮 | 空闲态 | 点击后 | 说明 |
|---|---|---|---|
| 🎤 麦克风 | 灰色 | 变红 ● 聆听中 | 再点一次=结束并发送 |
| 🔊 朗读开关 | 灰色 | 播报中橙色高亮 / 静音红色 🔇 | 播报中点它=立刻静音；再点一次=恢复自动朗读 |
| ⚙️ 设置入口 | 左下角设置按钮 | 打开 DSH 设置弹窗 | 左侧「voice chat」类目：ASR/TTS 引擎选择、API 配置、音色等；保存即生效 |

### 6.2 语音交互流程

```
点 🎤/按 Ctrl+Shift+Space → 叮 → [聆听中…] → 说话 → 停顿 2.5s（设置可改）
→ 咚 → 转写中… → 文字填入输入框并自动发送（可改为只填不发送）
→ AI 回复 → 语音播报（开启"转述朗读"时：先 LLM 精简、助手口吻 再播，默认关）
→ 中途可点 🔊 停止 / 按 Ctrl+Shift+Space 打断并重新说话
```

### 6.3 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Shift+Space` | 切换麦克风（主） |
| `Ctrl+M` / `Ctrl+Shift+M` | 切换麦克风（备用） |

### 6.4 状态提示

- **提示音**：开始"叮"（880Hz）、结束"咚"（523Hz），短促轻柔；
- **悬浮提示**：录音/转写/报错等状态会短暂显示在按钮上方；
- **按钮颜色**：聆听红、转写黄、播报橙、静音红。

---

## 七、配置指南

### ⚙️ 设置面板（推荐，优先级最高）

打开 DSH 设置弹窗（左下角齿轮），左侧点「**voice chat**」，右侧即可改：

**🎤 语音识别设置**
- ASR 引擎（SiliconFlow / Groq / MiMo / 自定义）
- Base URL / 模型名 / API Key
- 识别后是否自动发送
- 静音自动结束时长（秒）

**🔊 朗读设置**
- TTS 引擎（Edge TTS / MiMo TTS / 自定义 TTS）
- 各引擎对应的 Base URL / 模型名 / API Key / 音色
- 长回复转述朗读开关（默认关闭）

保存后立即生效，无需重启。

### 📄 配置文件（低优先级）

在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖 config：

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    # 语音识别设置
    asrEngine: siliconflow            # ASR 引擎：siliconflow | groq | mimo | custom
    asrApiKey: sk-你的密钥             # ASR 密钥（或环境变量 DSH_VOICE_ASR_KEY）
    asrBaseUrl: https://api.siliconflow.cn/v1
    asrModel: FunAudioLLM/SenseVoiceSmall
    llmModel: deepseek-v4-flash       # 转述模型（fallback，正常跟随当前对话）
    silenceMs: 2500                   # 静音多少毫秒后自动结束录音
    # 朗读设置
    rewrite: false                    # 转述朗读开关（默认关闭，设置页可切换）
    ttsEngine: edge                   # TTS 引擎：edge | mimo | custom
    voice: zh-CN-XiaoxiaoNeural       # 朗读音色
    ttsBaseUrl: https://api.openai.com/v1
    ttsModel: tts-1
    ttsApiKey: sk-你的密钥
    rate: '+10%'
    shortTextChars: 50
```

改完**重启 `dsh web`** 生效。优先级：**设置面板 > cordis.patch.yml > 环境变量 > 默认值**。

### 常用音色速查（Edge TTS）

| 音色 | 特点 |
|---|---|
| `zh-CN-XiaoxiaoNeural` | 晓晓·温柔女声（默认） |
| `zh-CN-YunxiNeural` | 云希·青年男声 |
| `zh-CN-YunyangNeural` | 云扬·新闻男声 |
| `zh-CN-liaoning-XiaobeiNeural` | 东北话 |
| `zh-HK-HiuMaanNeural` | 粤语 |
| `en-US-AriaNeural` | 美式英语女声 |

### MiMo TTS 预置音色

| 音色 | 说明 |
|---|---|
| `mimo_default` | 默认音色（留空即用） |
| `冰糖` | 中文女声 |
| `茉莉` | 中文女声 |
| `苏打` | 中文男声 |
| `白桦` | 中文男声 |
| `Mia` | 英文女声 |
| `Chloe` | 英文女声 |
| `Milo` | 英文男声 |
| `Dean` | 英文男声 |

---

## 八、工作原理（面向程序员）

插件分**宿主半身**（Node）与**浏览器半身**（React bundle），通过 HTTP 路由协作：

```
浏览器半身（lib/client.js）              宿主半身（lib/index.js）
┌──────────────────────────┐    ┌─────────────────────────────────────┐
│ 🎤 按钮 / Ctrl+Shift+Space    │    │ POST /dsh-voice-chat/stt  语音→文字    │
│ MediaRecorder 录音        │───▶│  （siliconflow / groq / mimo ASR）    │
│ blobToWav 自动转码        │    │ POST /dsh-voice-chat/tts   文字→语音    │
│ 静音检测（AnalyserNode）   │    │ POST /dsh-voice-chat/speak 文字→语音    │
│ 单信道播报（代次机制）      │◀───│  ① LLM 转述（跟当前对话实际模型）    │
│ sessionStorage 防重播      │    │  ② edge-tts / MiMo TTS 合成音频       │
│ 🔊 静音 / 🔔 提示音        │    │ GET  /dsh-voice-chat/settings 暴露配置  │
└──────────────────────────┘    └─────────────────────────────────────┘
```

**ASR 双协议**：URL 以 `/chat/completions` 结尾 → MiMo 式 chat 协议（音频 base64 data URL 在 messages.content.input_audio，仅支持 wav/mp3）；否则走 OpenAI 标准 `/audio/transcriptions` multipart 协议（webm 原样上传）。

**浏览器端 WAV 转码**：MiMo 等 chat 协议 ASR 只接受 wav/mp3，但浏览器录音产出 webm/ogg/mp4。`blobToWav` 利用 Web Audio API（`decodeAudioData` → `OfflineAudioContext` 重采样 16kHz 单声道 → 手写 PCM16 WAV 头）完成转码，不依赖 ffmpeg。

- **转述**用 harness 自带 LLM 服务（`ctx.llm.stream`）；客户端透传当前对话 provider+model，所以转述始终跟当前对话走同一个 LLM；
- **单信道**用"播报代次"计数器，异步请求返回时代次不符即丢弃，杜绝声音重叠。

---

## 九、常见问题排查（FAQ）

| 问题 | 原因 | 解决 |
|---|---|---|
| 播报听到的是**原文一字一句** | ① 回复 ≤50 字（设计如此）② 转述开关默认关闭 | 设置 → voice chat 勾选「长回复先转述」 |
| 完全没声音 | ① 浏览器不支持/权限被拒 ② 静音 🔇 状态 | 检查按钮是否 🔇；F12 控制台看 `[dsh-voice-chat]` 报错 |
| 按 🎤 没反应 | 麦克风权限未授权 | 地址栏左侧点"麦克风"允许访问 |
| 重进会话又播报 | 跨浏览器/清了 sessionStorage | 正常：防重播按浏览器会话记忆 |
| ASR 识别失败（400/502） | ① 密钥错误 ② MiMo ASR URL 填错（需完整 chat/completions 端点）③ 音频格式不支持 | MiMo 用户确认 URL 以 `/chat/completions` 结尾；检查密钥 |
| 识别失败"录音格式转换失败" | blobToWav 转码出错（极少见） | 刷新页面重试；检查 F12 控制台 |

**排错口令**：一切问题先看两个地方——浏览器 F12 控制台（`[dsh-voice-chat]` 前缀）与宿主日志（`%TEMP%\dsh-web-restart*.log`）。

---

## 十、安全提示

- **ASR/TTS 密钥**存在 `settings.local.json`（设置面板保存）或 `cordis.patch.yml` 中，请勿将这些文件推送到公共仓库；更稳妥的做法是改用环境变量（`DSH_VOICE_ASR_KEY` 等）；
- 转述复用 harness 自身 LLM，计费与 agent 对话同一账单（每次转述约几百 token）；
- 插件拥有与 agent 相同的权限，安装前请确认来源可信。

---

## 十一、更新与卸载

```bash
# 更新
dsh plugin --profile web add dsh-voice-chat

# 卸载
dsh plugin --profile web remove dsh-voice-chat
# 然后重启 dsh web
```

---

*用 DSH，造自己的工具。祝使用愉快 🎤🎉*
