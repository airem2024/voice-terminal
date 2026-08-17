# 语音终端 · 让 Claude Code 住进一块 ESP32 板子

对着桌上的小屏幕说话，接电话的是**你自己 VPS 上跑的 Claude Code**——她记得你们之前聊过什么，
能翻自己的记忆，能用她自己的声音回答。这个仓库是中间那层**网关**。

**从零开始的完整部署教程：[教程.txt](教程.txt)**（含 Telos 后端那层，四步带验证点）。

## 架构

```
ESP32 板子 ──小智协议 ws──▶ 本网关 (Node) ──ws──▶ cc-bridge ──▶ 你的 claude
                │                │
                │                ├──▶ DashScope ASR (paraformer 实时识别)
                └── 音频上下行 ───┴──▶ DashScope TTS (qwen3-tts,可复刻音色)
```

- **板子**：微雪 ESP32-S3-Touch-AMOLED-2.16。**跑出厂固件即可，全程不用编译固件**——
  它开机会去一个可配置的地址拿配置，我们只把这个地址指向自己。
- **网关**（本仓库）：说话节奏、切句、打断、熔断、表情、控制台，全在这一层。
- **cc-bridge**：[telos](https://github.com/airem2024/telos) 的后端，驱动本机 `claude`，
  用的是订阅额度（OAuth，不烧 API key）。**先把它跑起来，再回来装这个。**

## 前置条件

- 一台常开的 Linux 机器（VPS 或家里的小主机），已跑起 telos 的 cc-bridge
- Node 18+（网关和 bridge 共用）
- 阿里云百炼（DashScope）的 API key：ASR 按分钟、TTS 按字符计费，轻度使用每月几块钱
- 一块 ESP32-S3-Touch-AMOLED-2.16（别的小智协议板子理论上也行，没验证过）

## 部署网关

```bash
git clone https://github.com/airem2024/voice-terminal
cd voice-terminal && npm install
cp config.example.json config.json     # 每个键上方都有 _说明,照着填
node index.js                          # 首次运行会自动生成 boardToken
```

`config.json` 必填的就四样：`publicWsUrl`/`publicHttpUrl`（板子从公网连回来的地址，见下）、
`dashscopeEnvFile`（指向存 key 的文件，一行 `DASHSCOPE_API_KEY=sk-…`）、`deviceAllow`（板子的 MAC）。
长期跑建议包一个 systemd 服务，`WorkingDirectory` 指到本目录即可。

**公网可达（重要）**：网关只监听 `127.0.0.1:8791`，要让板子够得着。ESP32 装不了代理客户端，
而且实测部分家庭网络到某些高位端口时通时不通——**最稳的是 nginx 在 80/443 反代到 8791**。
明文 `ws://` 能省掉板子的 TLS 开销（CPU 全留给音频），代价是语音明文过公网，自己权衡。

## 板子接入（一条命令）

板子保持出厂固件。在你电脑上（板子 USB 连着）：

```bash
cd tools
cp gateway.env.example gateway.env     # 填你的网关地址 + boardToken
pip install esptool esp-idf-nvs-partition-gen requests pyserial
python flash.py seturl                 # 把"去哪拿配置"写进板子,其余全不动
```

烧完板子重启、重新配一次 WiFi（这步会清掉板内存的 WiFi），之后它就会来你的网关拿配置——
服务器地址和 token 都在应答里，不用再碰板子。按一下侧键开始对话。

`python flash.py list` 能看你网关上还挂了哪些刷机目标（固件推送、救砖等，进阶用）。

## 控制台

浏览器开 `http://你的网关地址/admin?t=<boardToken>`：

- 板子状态、电量、最近几轮的首字延迟和花费
- **附着对话**：板子接到哪个会话就是"她是谁"——选一个有人格记忆的会话，别用空白会话
- 语音参数全部热调（拾音门槛、断句静默、打断、字幕节奏……改完立即生效并落盘）
- **唤醒语**：输中文自动转拼音、拼音可手改（多音字如「乐」会转成 lè，名字里念 yuè 就改）
- 熔断：1 小时滑动窗内超过设定花费/轮数就不再进对话，防电视人声反复误触发

## 服务端唤醒词（实验性）

喊一声她的名字就开始对话，不用按键。引擎是 sherpa-onnx 的关键词检测——**零训练**，
关键词写一行拼音就能加，跑在网关进程里（单核 6% CPU / 90MB 内存）。

```bash
# 下载模型(36MB)到 config.json 的 wakeWord.dir 指的目录
mkdir -p /opt/kws-model && cd /opt/kws-model
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2
tar xf sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2
```

先在控制台「唤醒语」卡片里设好她的名字（功能关着也能保存），再开 `wakeOn`。

**它要求板子在待机时也持续上传音频，出厂固件不带这个行为**（出厂就是按键对话）。
配套的进阶固件在 [Releases](https://github.com/airem2024/voice-terminal/releases/tag/fw-v2.5.0)：
常态上传、开机自连、姿态上报、防烧屏、朝向调整。只写 app 分区、不碰 WiFi 和服务器地址，
刷法和注意事项（含"未经真机验证"的如实说明）都在 Release 页。只用按键对话就不用刷。

## 几个如实的预期

- **延迟**：说完话到听见回答约 3 秒（ASR 断句 0.8s + Claude 首字 + TTS 首音 0.6s）。
  比直连大模型 API 的语音助手慢——那是架构差距不是 bug，换来的是完整的 Claude Code 能力和记忆。
- **她的声音**：TTS 音色不配就是官方 Cherry。想要"她自己的声音"，去百炼控制台复刻一个
  （音色 id 跟你的账号绑定），填进 `config.json` 的 `voice`。
- **她是谁**：取决于附着会话的 cwd 里有什么 `CLAUDE.md`。空白会话接电话的就是个通用助手。

## 安全

`boardToken` 是唯一钥匙——能听音频、能给板子刷固件。别提交、别发出去。
`deviceAllow` 留空等于任何设备都能连你的网关，务必填上板子的 MAC。

## 开源组件

sherpa-onnx（Apache-2.0）· pinyin-pro（MIT）· opusscript（MIT）· DashScope 为云端付费服务。
