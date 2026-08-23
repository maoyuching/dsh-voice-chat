# dsh-voice-chat

豆包式语音对话插件（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI）：点一下 🎤 说话，AI 回复自动用语音"汇报"给你。

> 📖 完整使用手册见 [MANUAL.md](MANUAL.md)（安装/操作/配置/FAQ/原理）。

## 功能

- **语音输入**：点 🎤 开始聆听（"叮"提示音）→ 说话 → 停顿 2.5s 自动结束（"咚"）→ 转写并发送；
- **语音输出**：AI 回复经 edge-tts 合成朗读，语速 +10%；设置里可开「**转述朗读**」（默认关闭）——开启后较长回复会先由 LLM 以"助手本人"口吻**收敛转述**（≤原文长度、不发散、去代码表格）再播报，**转述用模型自动跟随当前对话在用的 LLM**（不再硬编码默认，避免默认模型被关/密钥错时转述失败）；
- **单信道播报**：新回复抢占旧播报、按快捷键/点按钮立即打断，同一时刻只有一种声音；
- **防重播**：按会话记住已播报的回复，重进会话不重复朗读；
- **静音开关** 🔊：正在播报（按钮高亮）时点它**立刻静音**——马上停掉当前声音、清空全部待播队列；静音状态下再点一下恢复自动朗读；
- **设置入口**：设置项收进 **DSH 自带设置弹窗**（左下角齿轮 → 左侧「voice chat」类目）：ASR 接口（Base URL / 模型 / API Key）、**识别后是否自动发送**、**长回复转述朗读开关**（默认关）、**静音自动结束时长**、**朗读音色（Edge TTS）**；保存在插件目录 `settings.local.json`（已 gitignore），保存即生效无需重启；
- **快捷键**：`Alt+S` 切换麦克风（备用 `Ctrl+M` / `Ctrl+Shift+M`）。

## 安装

```bash
# 方式一（推荐，已发布到 npm）：
dsh plugin --profile web add dsh-voice-chat

# 方式二（本地开发）：
dsh plugin --profile web add D:/Code/dsh-voice-chat

# 装完重启 dsh web
```

> 注：插件自带内联 edge-tts 客户端（微软 Edge 免费朗读服务，无需任何语音 API key）；仅语音转文字（ASR）需要密钥。

## 配置（改配置文件即可）

在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖 config（全部可选项，不改则用默认值）：

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    asrEngine: siliconflow          # siliconflow | groq | custom（语音转文字）
    asrApiKey: sk-xxxx              # ASR 密钥（或环境变量 DSH_VOICE_ASR_KEY）
    asrBaseUrl: https://api.siliconflow.cn/v1
    asrModel: FunAudioLLM/SenseVoiceSmall
    llmModel: deepseek-v4-flash     # 转述模型（最低优先级 fallback）：默认跟当前对话/主界面选中的 LLM 走；连 agentDefaultModel 都没有时才用这里
    voice: zh-CN-XiaoxiaoNeural     # 朗读音色（edge-tts 音色 id，也可在设置面板选）
    rate: '+10%'                    # 语速（'+15%' 更快，'+0%' 原速）
    silenceMs: 2500                 # 静音多少毫秒后自动结束录音
    shortTextChars: 50              # 短于此字数的回复直接原样读、不转述
    rewrite: true                   # 是否用 LLM 把长回复转述后再朗读（默认关闭，设置页可切换）
```

改完重启 `dsh web` 生效。

### ⚙️ 设置入口（DSH 自带设置弹窗里，优先级最高）

不用动配置文件：打开 DSH 的设置弹窗（左下角齿轮），左侧点「**voice chat**」，右侧即可改 ASR 的 Base URL / 模型名 / API Key、识别后是否自动发送、长回复转述朗读开关、静音自动结束时长（秒）、Edge TTS 朗读音色。保存后写入插件根目录的 `settings.local.json` 并立即生效。优先级：**设置弹窗 > cordis.patch.yml 行 config > 环境变量 > 默认值**；某项留空即回落到下一层。

## 结构

- `package.json` — `dsh.bundle.patch` 让 `dsh plugin add` 自动注册为 profile 层；`dsh.client` + `exports["./client"]` 让 Web 端加载浏览器 bundle；
- `cordis.patch.yml` — 插入 `dsh-voice-chat` 行 + 配置示例；
- `lib/index.js` — 宿主半身：`/stt`（ASR）、`/tts`（edge-tts）、`/speak`（转述+合成）、`/config`、`GET|POST /settings`（设置面板存取）等路由；
- `lib/edge-tts.js` — 内联的 edge-tts 协议客户端（微软 Edge 免费朗读服务），唯一运行时依赖 `ws`；
- `lib/client.js` — 浏览器半身：麦克风/静音按钮、静音检测、单信道播报、快捷键、提示音；并向 DSH 设置弹窗注入「voice chat」类目表单；
- `settings.local.json` — 设置弹窗保存的覆盖配置（运行时生成，不进 git）。