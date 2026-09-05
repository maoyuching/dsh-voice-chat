# dsh-voice-chat

<p align="center"><b>中文</b> | <a href="README.en.md">English</a></p>

豆包式语音对话插件（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI）：点一下 🎤 说话，AI 回复自动用语音"汇报"给你。

> 📖 完整使用手册见 [MANUAL.md](MANUAL.md)（安装/操作/配置/FAQ/原理）。

## 功能

- **语音输入**：点 🎤 开始聆听（"叮"提示音）→ 说话 → 停顿 2.5s 自动结束（"咚"）→ 转写并发送；
- **语音输出**：AI 回复经 TTS 合成朗读，语速 +10%；设置里可开「**转述朗读**」（默认关闭）——开启后较长回复会先由 LLM 以"助手本人"口吻**收敛转述**（≤原文长度、不发散、去代码表格）再播报，**转述用模型自动跟随当前对话在用的 LLM**；
- **ASR 引擎**：支持 **SiliconFlow**（SenseVoice，国内免费）、**Groq**（Whisper）、**小米 MiMo**（chat/completions 协议）、**自定义 OpenAI 兼容**端点，在设置页面切换；
- **TTS 引擎**：支持 **Edge TTS**（微软免费）、**小米 MiMo TTS**（chat/completions 协议，内置多款中文音色）、**自定义 TTS**（OpenAI 兼容接口）；
- **单信道播报**：新回复抢占旧播报、按快捷键/点按钮立即打断，同一时刻只有一种声音；
- **防重播**：按会话记住已播报的回复，重进会话不重复朗读；
- **静音开关** 🔊：正在播报时点它立刻静音，再点恢复自动朗读；
- **设置入口**：DSH 自带设置弹窗（左下角齿轮 → 左侧「voice chat」类目），保存即生效无需重启；
- **快捷键**：`Ctrl+Shift+Space` 切换麦克风（备用 `Ctrl+M` / `Ctrl+Shift+M`）。

## 环境要求

- **DeepSeek Harness（dsh）**：已安装并运行 Web GUI（`dsh web`）；
- **Node.js ≥ 22**（宿主与浏览器端均需要；edge-tts 客户端基于 `ws`，无需额外运行时）；
- **浏览器**：Chrome / Edge（录音需要 `MediaRecorder` 支持）；
- **ASR 密钥**：语音转文字需要（SiliconFlow 注册即有免费额度；MiMo 按用量计费）。

## 安装

```bash
# 方式一（推荐，已发布到 npm）：
dsh plugin --profile web add dsh-voice-chat

# 装完重启 dsh web
```

> 注：插件自带内联 edge-tts 客户端（微软 Edge 免费朗读服务，无需任何 API key）；Edge TTS 无需额外密钥，MiMo TTS / 自定义 TTS 则需配置对应密钥。

## 配置

### ⚙️ 设置面板（推荐，优先级最高）

打开 DSH 设置弹窗（左下角齿轮），左侧点「**voice chat**」，右侧即可改：

**🎤 语音识别设置**
- ASR 引擎选择（SiliconFlow / Groq / MiMo / 自定义）
- Base URL / 模型名 / API Key
- 识别后是否自动发送
- 静音自动结束时长（秒）

**🔊 朗读设置**
- TTS 引擎选择（Edge TTS / MiMo TTS / 自定义 TTS）
- 各引擎对应的 Base URL / 模型名 / API Key / 音色
- 长回复转述朗读开关（默认关闭）

保存后立即生效，无需重启。

### 📄 配置文件（低优先级）

在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖 config（全部可选项，不改则用默认值）：

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    asrEngine: siliconflow          # siliconflow | groq | mimo | custom
    asrApiKey: sk-xxxx              # ASR 密钥（或环境变量 DSH_VOICE_ASR_KEY）
    asrBaseUrl: https://api.siliconflow.cn/v1
    asrModel: FunAudioLLM/SenseVoiceSmall
    llmModel: deepseek-v4-flash     # 转述模型（fallback，正常跟随当前对话）
    silenceMs: 2500
    rewrite: false                  # 转述朗读开关（默认关闭，设置页可切换）
    ttsEngine: edge                 # edge | mimo | custom
    voice: zh-CN-XiaoxiaoNeural
    ttsBaseUrl: https://api.openai.com/v1
    ttsModel: tts-1
    ttsApiKey: sk-xxxx
    rate: '+10%'
    shortTextChars: 50
```

改完重启 `dsh web` 生效。优先级：**设置面板 > cordis.patch.yml > 环境变量 > 默认值**。

## 结构

- `lib/index.js` — 宿主半身：`/stt`（ASR，支持 OpenAI multipart 与 MiMo chat/completions 双协议）、`/tts`（Edge/MiMo/自定义 TTS）、`/speak`（转述+合成）、`/settings`（设置面板存取）等路由；
- `lib/client.js` — 浏览器半身：麦克风/静音按钮、静音检测、单信道播报、快捷键（Ctrl+Shift+Space）、录音自动转 WAV（供 MiMo 等 chat 协议 ASR）；并向 DSH 设置弹窗注入「voice chat」类目表单；
- `lib/edge-tts.js` — 内联的 edge-tts 协议客户端（微软 Edge 免费朗读服务），唯一运行时依赖 `ws`；
- `cordis.patch.yml` — 插入 `dsh-voice-chat` 行 + 配置示例；
- `settings.local.json` — 设置面板保存的覆盖配置（运行时生成，不进 git）。
