# dsh-voice-chat 使用手册

> DeepSeek Harness 语音对话插件 —— 点一下 🎤 说话，AI 回复用语音"汇报"给你。
> 版本 0.1.0 · 更新于 2026-08-15

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
- **听**：AI 的回复不会逐字朗读，而是先由 LLM 以"助手本人"的口吻**简短转述**（挑重点、不发散、不超过原文长度），再用语音播报出来。

整条链路（录音 → 转文字 → AI 回复 → 转述 → 朗读）全部打通，**TTS 免费、无限制**。

---

## 二、功能特性

| 功能 | 说明 |
|---|---|
| 🎤 语音输入 | 点按开始聆听（"叮"提示音）→ 说话 → 静音 2.5s 自动结束（"咚"）→ 转写发送 |
| 🗣️ 转述朗读 | （默认关闭）开启后：较长回复先经 LLM 收敛转述（≤原文、去代码表格、像真人汇报），再 edge-tts 朗读；**转述模型自动跟随当前对话实际在用的 LLM**（默认模型被关/密钥错时也不会失败） |
| 🔊 静音开关 | 正在播报时点击**立即停止**；静音后不再自动朗读 |
| ⏪ 单信道播报 | 新回复抢占旧播报；快捷键/录音可打断，同一时刻只有一种声音 |
| 🔁 防重播 | 按会话记住已播报的回复，**重新进入会话不会重复朗读** |
| ⌨️ 快捷键 | `Alt+S` 切换麦克风（备用 `Ctrl+M` / `Ctrl+Shift+M`），打字时也能用 |
| ⚙️ 全配置化 | 音色/语速/静音时长/转述开关等全部可改配置文件，无需改代码 |
| 🔋 零外部密钥 | 转述复用 harness 自带的 LLM，只需 ASR 一个密钥 |

---

## 三、环境要求

- **DeepSeek Harness**（dsh）已安装并运行 Web GUI（`dsh web`）；
- **浏览器**：Chrome / Edge（Chromium 内核，需要 `MediaRecorder` 录音能力）；
- **网络**：可访问硅基流动（ASR）与微软 Edge（TTS）服务；
- **ASR 密钥**：一个硅基流动（SiliconFlow）API Key（免费注册，有免费模型额度）。

---

## 四、安装

```bash
# 方式一（推荐，已发布到 npm）：
dsh plugin --profile web add dsh-voice-chat

# 方式二（本地开发，指定源码路径）：
dsh plugin --profile web add D:\Code\dsh-voice-chat

# 重启 dsh web 使插件生效
# （停止当前 dsh web 进程，再重新运行 dsh web）
```

安装成功后：
- 插件会自动注册为 profile 层（`~/.dsh/profiles/web/package.json` 的 `bundles` 里出现 `dsh-voice-chat`）；
- 浏览器刷新页面后，输入框右侧出现 🎤 和 🔊 两个按钮。

---

## 五、快速上手（5 分钟）

1. **刷新页面**（Ctrl+Shift+R），确认输入框右侧出现 🎤 按钮；
2. 配置 ASR 密钥（见[配置指南](#七配置指南)第 1 步）；
3. **点一下 🎤** → 听到"叮" → 开始说话；
4. 说完停顿约 2.5 秒 → 听到"咚" → 语音自动转文字并发送；
5. AI 回复到达后，**自动语音播报**（简短汇报版）。

> 💡 想更快？直接用快捷键 **Alt+S**（左手拇指+无名指）代替点按钮。

---

## 六、操作手册

### 6.1 按钮

| 按钮 | 空闲态 | 点击后 | 说明 |
|---|---|---|---|
| 🎤 麦克风 | 灰色 | 变红 ● 聆听中 | 再点一次=结束并发送 |
| 🔊 朗读开关 | 灰色 | 播报中橙色高亮 / 静音红色 🔇 | 播报中点它=**立刻静音**（停声+清空队列）；再点一次=恢复自动朗读 |
| ⚙️ 设置入口 | 左下角设置按钮 | 打开 DSH 设置弹窗 | 左侧「voice chat」类目：配置识别接口（Base URL/模型/API Key）、识别后是否自动发送、转述朗读开关、静音自动结束时长、朗读音色；保存即生效 |

### 6.2 语音交互流程

```
点 🎤/按 Alt+S → 叮 → [聆听中…] → 说话 → 停顿 2.5s（设置→voice chat 可改）
→ 咚 → 转写中… → 文字填入输入框并自动发送（设置→voice chat 可改为只填不发送）
→ AI 回复 → 语音播报（设置里开启"转述朗读"时：先 LLM 精简 ≤150字、助手口吻 再播，默认关）
→ 中途可点 🔊 停止 / 按 Alt+S 打断并重新说话
```

### 6.3 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt+S` | 切换麦克风（主，键位紧邻、单手好按） |
| `Ctrl+M` / `Ctrl+Shift+M` | 切换麦克风（备用） |

### 6.4 状态提示

- **提示音**：开始"叮"（880Hz）、结束"咚"（523Hz），短促轻柔；
- **悬浮提示**：录音/转写/报错等状态会短暂显示在按钮上方；
- **按钮颜色**：聆听红、转写黄、播报橙、静音红。

---

## 七、配置指南

> 💡 **懒人方式**：不用改配置文件——打开 **DSH 设置弹窗**（左下角齿轮），左侧点「**voice chat**」，在右侧表单里设置 ASR 接口（Base URL/模型/API Key）、是否自动发送、转述朗读开关、静音时长和朗读音色——保存写入插件目录 `settings.local.json` 并立即生效。优先级：**设置弹窗 > 下面这份 cordis 配置 > 环境变量 > 默认值**。

所有配置写在 **profile 配置文件** `~/.dsh/profiles/web/cordis.patch.yml` 里（按 id 覆盖）：

```yaml
- id: dsh-voice-chat
  name: 'dsh-voice-chat'
  config:
    asrEngine: siliconflow            # ASR 引擎：siliconflow | groq | custom
    asrApiKey: sk-你的密钥             # ASR 密钥（或环境变量 DSH_VOICE_ASR_KEY）
    asrBaseUrl: https://api.siliconflow.cn/v1
    asrModel: FunAudioLLM/SenseVoiceSmall
    llmModel: deepseek-v4-flash       # 转述模型（最低优先级 fallback）：默认跟当前对话/主界面选中的 LLM（agentDefaultModel）走；实在没有才用这里
    voice: zh-CN-XiaoxiaoNeural       # 朗读音色（edge-tts 音色，见下方列表）
    rate: '+10%'                      # 语速（'+15%' 更快，'+0%' 原速）
    silenceMs: 2500                   # 静音多少毫秒后自动结束录音
    shortTextChars: 50                # 短于此字数的回复直接原样读、不转述
    rewrite: true                     # 是否 LLM 转述后再朗读（默认关闭，设置页可切换）
```

改完**重启 `dsh web`** 生效。

### 常用音色速查（edge-tts）

| 音色 | 特点 |
|---|---|
| `zh-CN-XiaoxiaoNeural` | 晓晓·温柔女声（默认） |
| `zh-CN-YunxiNeural` | 云希·青年男声 |
| `zh-CN-YunyangNeural` | 云扬·新闻男声 |
| `zh-CN-liaoning-XiaobeiNeural` | 东北话 |
| `zh-HK-HiuMaanNeural` | 粤语 |
| `en-US-AriaNeural` | 美式英语女声 |

---

## 八、工作原理（面向程序员）

插件分**宿主半身**（Node）与**浏览器半身**（React bundle），通过四条 HTTP 路由协作：

```
浏览器半身（lib/client.js）              宿主半身（lib/index.js）
┌──────────────────────────┐    ┌─────────────────────────────────────┐
│ 🎤 按钮 / Alt+S 快捷键     │    │ POST /dsh-voice-chat/stt  语音→文字    │
│ MediaRecorder 录音        │───▶│  （硅基流动 ASR）                     │
│ 静音检测（AnalyserNode）   │    │ POST /dsh-voice-chat/speak 文字→语音    │
│ 单信道播报（代次机制）      │◀───│  ① LLM 转述（跟当前对话实际模型）    │
│ sessionStorage 防重播      │    │  ② edge-tts 合成 MP3                 │
│ 🔊 静音 / 🔔 提示音        │    │ GET  /dsh-voice-chat/config 暴露配置   │
└──────────────────────────┘    └─────────────────────────────────────┘
```

- **浏览器端**用 `window.__ModuleLoader__.load` 打包，通过 `dsh.client` + `exports["./client"]` 自动挂载；
- **转述**用 harness 自带 LLM 服务（`ctx.llm.stream`）；客户端把当前对话实际在用的 provider+model 一起透传过来，所以**转述始终跟当前对话走同一个 LLM**；关闭了思考（`reasoningEffort: "off"`）保证输出稳定；
- **单信道**用"播报代次"计数器，异步请求返回时代次不符即丢弃，杜绝声音重叠。

---

## 九、常见问题排查（FAQ）

| 问题 | 原因 | 解决 |
|---|---|---|
| 播报听到的是**原文一字一句** | ① 回复 ≤50 字（设计如此）② 转述失败降级 | 长回复仍原文→看日志 `%TEMP%\dsh-web-restart*.log` 中 `rewrite` 字样 |
| 完全没声音 | ① 浏览器不支持/权限被拒 ② 静音 🔇 状态 | 检查按钮是否 🔇；F12 控制台看 `[dsh-voice-chat]` 报错 |
| 按 🎤 没反应 | 麦克风权限未授权 | 地址栏左侧点"麦克风"允许访问 |
| 重进会话又播报 | 跨浏览器/清了 sessionStorage | 正常：防重播按浏览器会话记忆 |
| 识别不准/失败 | ASR 密钥错误或网络 | 检查 `asrApiKey`；硅基流动后台看额度 |
| 想听精简转述版 | 默认原样朗读（转述开关默认关） | 设置 → voice chat 勾选「长回复先转述（精简）再播报」，或配置 `rewrite: true` |

**排错口令**：一切问题先看两个地方——浏览器 F12 控制台（`[dsh-voice-chat]` 前缀）与宿主日志（`%TEMP%\dsh-web-restart*.log` 里的 `speak:`/`rewrite` 记录）。

---

## 十、安全提示

- **ASR 密钥**以明文存在 `cordis.patch.yml` 中，请勿将该文件推送到公共仓库；更稳妥的做法是改用环境变量 `DSH_VOICE_ASR_KEY`；
- 转述复用 harness 自身 LLM，计费与 agent 对话同一账单（每次转述约几百 token）；
- 插件拥有与 agent 相同的权限，安装前请确认来源可信。

---

## 十一、更新与卸载

```bash
# 更新（源码有改动时重新执行）
dsh plugin --profile web add D:\Code\project1employee\dsh-voice-chat

# 卸载
dsh plugin --profile web remove dsh-voice-chat
# 然后重启 dsh web
```

---

*用 DSH，造自己的工具。祝使用愉快 🎤🎉*
