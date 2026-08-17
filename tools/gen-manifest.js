#!/usr/bin/env node
// 生成 board/firmware/manifest.json —— 给 tools/flash.py 用的刷机清单。
// 重新编译固件后重跑一次即可(会重算 sha256/size)。
//
// 为什么她那套是"分段"而官方是"整片":
//   官方出厂包是 15.1MB 的整片镜像,只能烧 0x0;
//   我们自己编译的按分区分开烧只要 5.9MB(中间的空洞不用传),跨境下载省一半时间,
//   而且**天然跳过 0x9000 的 NVS**——不会顺手擦掉板子上存的 WiFi/OTA 配置。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'board', 'firmware');

// flash 参数取自 build/flash_args(idf 生成),别凭记忆写:dio/80m/16MB。
const FLASH = { mode: 'dio', freq: '80m', size: '16MB' };

const TARGETS = {
  stock: {
    label: '微雪出厂固件 Brookesia (260318)',
    note: '整片镜像。含启动器 + 小智AI/设置/绘图板等 APP。会覆盖 NVS,WiFi 要重新配。',
    parts: [{ addr: '0x0', file: 'stock-2.16-260318.bin' }],
  },
  // 只写 NVS 的一个字符串:wifi/ota_url。ota.cc:48 —— NVS 里有 ota_url 就用它,
  // 没有才回落编译常量。官方固件同样吃这套(它的常量是 api.tenclass.net),
  // 所以不用重编译固件就能把板子指到我们的网关。
  // 配网页面本来有这个输入框,但 show_ota_config 默认 false 且**源码里没有任何地方调用
  // SetShowOtaConfig(true)** —— 那一行在任何版本里都是隐藏的,只能绕过 UI 直接写 NVS。
  otaurl: {
    label: '把服务器地址写进板子 (ota_url)',
    note: '只烧 0x9000 的 NVS(24KB)。会清掉已存的 WiFi,开机重新配一次网即可;地址已经在里面。',
    parts: [{ addr: '0x9000', file: 'nvs-otaurl.bin' }],
  },
  // 自定义唤醒词。官方 assets 分区只有 3MB,而带自定义唤醒词的 srmodels.bin 单独就 3.5MB
  // (官方那个只有 291KB —— 只含"你好小智"一个词),怎么裁都塞不进。
  // 出路:assets 按**分区名**查找(main/assets.cc:47 esp_partition_find_first(..., "assets")),
  // 不是硬编码地址 —— 所以把分区表改大就行,固件一行都不用重编译。
  // 腾地方:后面紧邻的 storage 是 3MB 但只用了 917KB(音乐播放器的示例 BGM),
  // 缩到 1MB 挪到 0xe20000,让出 2MB 给 assets。前 5 个分区与官方逐字节一致。
  // 回退:把官方原装 assets 刷回去(30px 字体 + wn9_nihaoxiaozhi_tts 唤醒模型)。
  // 分区表不用动 —— 官方 assets 只有 2.85MB,放在扩过的 5MB 分区里照样正常。
  // 0815 教训:用户那个包里**只有 mn6 命令词模型、没有任何 wakenet**,字体也是 20px(官方 30px),
  // 刷进去 = 唤不醒 + 字变小。我当时只核了分区容量和字段兼容,没核模型包内容。
  // 救砖(0815)。把分区表/assets/storage 三段原样刷回出厂状态,**唯独跳过 0x9000 的 NVS**,
  // 所以 WiFi 和 ota_url 都还在,刷完直接连回来,不用重新配网。
  // 为什么需要它:wake 那步我把 storage 从 3MB 缩到 1MB → SPIFFS 挂载失败 -10025 →
  // 官方 BSP 的 bsp_spiffs_mount 外面套着 ESP_ERROR_CHECK → abort() → 无限重启黑屏。
  // 教训:storage 分区**碰不得**,它在启动必经路径上且失败即 abort。
  // 黑底白字(0815)。这一版**只改 index.json 的 skin**,字体/模型/21 个表情图与官方原版
  // 逐字节相同(sha256 比对 23/23 一致) —— 用来验证两件事:官方打包工具产出的包板子认不认、
  // skin 字段实际生效不生效。跑通了,以后换她的表情图就是同一条流水线。
  // 不碰分区表:assets 加载失败最多没表情/没字,不会像 SPIFFS 那样 abort 变砖。
  // checksum 是包内自校验(assets.cc:185 拿头部字段和实算比),打包工具已算对,验过自洽。
  // 她的脸(0815 用户画的 21 张颜文字风,128×128 RGBA,共 79.5KB)+ 黑底白字。
  // 字体和 srmodels 与官方原版**逐字节相同**(验过 sha256),所以唤醒词和字号都不受影响。
  face: {
    label: '她的表情 + 黑底',
    note: '只烧 0x920000。分区表和 NVS 都不动。不满意用 back 刷回官方 assets。',
    // ⚠️文件名必须带版本号,改包就换名 —— server.js 给 /fw/file/ 发的是
    // `cache-control: public, max-age=31536000, immutable`,Cloudflare 会把同名文件锁一年。
    // 0815 踩过:换了 240 的新包但沿用旧名,CF 继续吐 6 小时前那份 2873427 字节的旧包,
    // 而 flash.py 本地正好缓存了同样大小的残件 → `Range: bytes=2873427-` 起点越界 → **HTTP 416**。
    // (Telos 发 APK 早就因为同一个原因改成带版本号的下载路径了。)
    parts: [{ addr: '0x920000', file: 'face-assets-240.bin' }],
  },
  dark: {
    label: '黑底白字 (只改 skin,其余与官方原版逐字节相同)',
    note: '只烧 0x920000。分区表和 NVS 都不动。不满意就用 back 刷回官方 assets。',
    parts: [{ addr: '0x920000', file: 'dark-assets.bin' }],
  },
  rescue: {
    label: '救砖:分区表+assets+storage 全部刷回出厂',
    note: '跳过 NVS,WiFi 和服务器地址保留。板子黑屏/无限重启时用这个。',
    parts: [
      { addr: '0x8000', file: 'rescue-ptable.bin' },
      { addr: '0x920000', file: 'rescue-assets.bin' },
      { addr: '0xc20000', file: 'rescue-storage.bin' },
    ],
  },
  back: {
    label: '回退到官方 assets (恢复唤醒和字号)',
    note: '只烧 0x920000。分区表和 NVS 都不动,WiFi/服务器地址保留。',
    parts: [{ addr: '0x920000', file: 'back-assets.bin' }],
  },
  wake: {
    label: '自定义唤醒词 (扩 assets 分区到 5MB)',
    note: '改分区表 + 烧新 assets + 把 storage 原样挪到新地址。出问题用 stock 整片刷回。',
    parts: [
      { addr: '0x8000', file: 'wake-ptable.bin' },
      { addr: '0x920000', file: 'wake-assets.bin' },
      { addr: '0xe20000', file: 'wake-storage.bin' },
    ],
  },
  // 只换 app,不碰别的(0815 加)。OTA 那条路会写 ota_0(3MB,余量只剩 180KB)且**没有断点续传** ——
  // 实测板子下到 1487777/2961888(50.2%)就断。这个目标直刷 **factory(0x20000, 6MB)**,
  // 也就是板子现在启动的那个分区,走串口不受任何超时影响。
  // ⚠️代价:覆盖的是**正在用的**分区,**没有自动回滚**。刷挂了用 `flash.py stock` 刷回出厂整包,
  // 或 `flash.py rescue` 修分区表/assets/storage。分区表、NVS(WiFi+服务器地址)、assets(表情) 全程不碰。
  // ⚠️别用下面的 xixi 目标:它按我们源码的 partitions/v2/16m.csv 写 otadata **0xd000**,
  // 而板子出厂表是 **0xf000**(见 rescue-ptable.bin),地址对不上;它还会改分区表把 assets 从
  // 0x920000 挪到 0x800000,刚做好的表情包会整个错位。
  // 0815 二次修正:光刷 0x20000 **没用**。esptool 报告
  //   `Wrote 2961888 bytes at 0x00020000` + `Hash of data verified`(写入确实成功),
  // 可板子开机自报的还是 2.2.4 —— 说明它**根本不从 factory 启动**,而是从 ota_0(0x620000)。
  // 决定启动哪个分区的是 **otadata(0xf000**,注意不是标准的 0xd000**)**:里面有有效记录就走 ota_0。
  // 把它写成全 0xFF = 记录失效 → bootloader 回退到 factory,也就是我们刷进去的这份。
  // (这也解释了之前 OTA 为什么诡异:板子跑在 ota_0 上,`esp_ota_get_next_update_partition`
  //  只能挑 factory 或另一个 ota 槽,而这块板的分区表里 ota 槽只有一个。)
  // 刷挂了用 `flash.py stock` 刷回出厂整包。
  // v15(0815 晚)治的是「常驻聆听开着就每 2~4 分钟掉一次线」。
  // 账算清楚了:这块板 internal RAM 总共 341KB,固件静态就占 140KB(idf.py size),
  // 运行时常态只剩 11~25KB 空闲 —— 而 WiFi 光 dynamic tx buffer 就配了 32 个(约 1.6KB/个),
  // 全挤在 internal 里跟 AFE、Opus、二十来个任务栈抢。一开常驻聆听就分不到缓冲 → bcn_timeout。
  // 这一刀:CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y,让 WiFi/LWIP 的缓冲优先去 PSRAM(8MB,空得很)。
  // 是 IDF 官方给 PSRAM 板子准备的选项,PSRAM 拿不到会自动回落 internal,只改优先级、不会分配失败。
  // 另带诊断:每 10 秒打一份 internal/dma/psram 明细并**经 WS 报给服务端**(免得排障都要插串口),
  // 每 60 秒打各任务栈剩余(要砍谁得看这张表),掉线瞬间立刻抓一次现场。
  // v16 修 v15 的回归:v15 一刷上去**麦克风全聋**(0 帧上传,板子看着"在聆听"其实什么都听不见)。
  // 串口一句话定位:`Failed to create AFE processing task` —— 不是 AFE 建不起来
  // (pipeline 全建好了),是紧接着那句 xTaskCreate 分配不到 4KB 任务栈。
  // FreeRTOS 的栈强制 internal RAM,而 AFE 一建起来就把 internal 吃到只剩 **16 字节**。
  // 上游代码的顺序是"先建 AFE、再建任务",在 internal 只有 341KB 的板子上迟早踩;
  // v15 把内存布局一动就踩上了。修法是**把栈的获取提前到建 AFE 之前**(xTaskCreateStatic),
  // 跟 AFE 到底吃多少内存彻底解耦 —— 不用赌它下次会不会吃得更多。
  // v17 = v14 + 三件事,**WiFi 缓冲一律回上游原值**(v15/v16 在这上面找补,越找越糟):
  //   ① AFE 任务栈预分配(v16 那个真修复,让 AFE 起得来 → 麦克风活)
  //   ② SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y(把 WiFi 缓冲挪去 PSRAM,净给 internal 腾地方)
  //   ③ 内存/任务/CPU 诊断,含 AFE 的内存账
  // 教训按顺序记着:v15 加 WiFi 缓冲 → AFE 建不出任务 → 麦克风全聋;
  // v16 修好了栈 → AFE 起来吃掉 71KB internal → 只剩 10.5K、DMA 最大块 1344B → WS 握手超时,
  // 板子连都连不上。两次都是同一个道理:**这块板 internal 经不起任何一处多要**。
  // v18 = **v14 的内存基线** + 两件真有用的:AFE 任务栈预分配、内存/任务/CPU 诊断。
  // 我在 sdkconfig 上试过的两刀(WiFi 缓冲加量、TRY_ALLOCATE_WIFI_LWIP)全部退回原值 ——
  // 前者害得 AFE 建不出任务(v15 麦克风全聋),后者按同口径实测**倒亏 18K** internal
  // (v17 连不上服务器)。详见 sdkconfig.defaults.esp32s3 里的注释。
  //
  // 🔴 真正的账在这儿,下一步的所有决定都从它出发:
  //   板子 internal 共 341KB,固件静态占 140KB → 能用的只有 201KB;
  //   **AFE 一家就吃 84588 B**(v17 实测,`AFE took` 那行),之后只剩约 24K 给 WiFi/TCP/LVGL
  //   和二十来个任务栈分。常驻聆听就是死在这 24K 余量上 —— 网络一有压力就分不到缓冲、
  //   bcn_timeout 掉线。要么给 AFE 减肥(最大一块是 AEC),要么放弃常驻聆听。
  // 🔴 v20 = **v2.4.14 的行为 + 纯观测**,我在 v15~v19 做的所有"修复"全部撤销。
  // 静态占用已核对:DIRAM 140690 字节,与 v14 一字节不差 —— 诊断代码不吃 DRAM。
  //
  // 为什么全撤:那一整晚是"改 A 救 B、结果 C 塌了"的连锁,起点和终点都是我自己造的 ——
  //   v15 给 WiFi 缓冲加量(8/24/6)  → AFE 建完拿不到 4KB 任务栈 → **麦克风全聋**
  //   v16 用"提前预分配栈"去修 v15 → AFE 分配前把堆切碎     → **WS 连不上**(建了 TCP 却
  //                                                            发不出 hello、也不回 pong)
  //   v17~v19 都在这个坑里打转;v19 修掉了栈深度单位的踩踏(那是真 bug、也该修),但连不上照旧,
  //   证明踩踏不是连不上的原因。
  // 铁证是 hello:v15 有(AFE 失败)、v16~v19 没有(AFE 成功)、v14 有 —— **AFE 一跑起来 WS 就死**,
  // 分界线在 AFE 而不在栈。同口径读数:AFE 之后 v14 还剩 25.5K,我那几版只剩 10.3K。
  //
  // ⚠️原始问题(常驻聆听每 2~4 分钟 bcn_timeout 掉线)**至今一次都没被真正诊断过** ——
  // 板子从 v15 起就没健康过。v20 的用途就是把它放回健康状态,第一次拿到干净的观测数据。
  // 唯一还没查的强线索:`[task] taskLVGL cpu=66%`,一个待机的板子吃掉三分之二个核。
  // 🔴 v21:**AFE 处理任务的栈改从 PSRAM 拿**,这才是对症的一刀。
  // v20(= v14 行为 + 诊断)第一次给出了干净现场,一举推翻"内存总量不够"这个前提:
  //     I (63118) free sram: 96943                              ← AFE 之前 96.9K,很充裕
  //     I (63278) AFE took 85816 B (now free=9567, max_blk=2304)
  //     E         Failed to create AFE processing task (int free=9535 max_blk=2304)
  // **free 9535 够 4096,但最大连续块只剩 2304** —— AFE 把堆打碎了,切不出 4KB 连续空间。
  // 所以方向从来不是"腾出更多 internal"(0815 整晚都追错了这个,还为此改坏了 WiFi 缓冲、
  // 加过会加剧碎片的"提前占坑"),而是**别在碎掉的堆上要连续块**。
  // PSRAM 有 8MB、最大块 8MB+;同文件里 encode_wake_word 的栈本来就走 PSRAM,这条路上游验证过。
  // TCB 仍留 internal(一百来字节,碎堆也拿得到,且 FreeRTOS 要求它在 internal)。
  // v22 = v21(AFE 栈走 PSRAM,已验证让 AFE 起得来) + **关掉板端唤醒词**。
  // 关它是纯赚:唤醒词早搬到服务端了(唤醒词),板端 WakeNet 认的是「你好小智」、一次没用过,
  // 却要把 wn9 模型加载进内存 —— 而 afe_audio_engine.cc 建完就 disable_wakenet,建起来只为立刻关掉。
  // AEC 和 VAD 不受影响(看 CONFIG_USE_AUDIO_PROCESSOR,与唤醒词无关)。代价只是不能再用按键之外的
  // 板端语音唤醒,而那个词本来就不是她。
  //
  // 🔴 为什么非腾不可(v21 实测):AFE 一家吃 83380 B,之后 internal 只剩 9563、**DMA 只剩 4751
  // 且最大块 992** —— TCP 收发要 DMA-capable 内存,992 字节撑不起 WS 握手。
  // 而开机可用内存本身在 **85K~112K 之间飘**,取决于 OTA 那条 HTTPS 顺不顺:
  //     v14 正常关闭 → free 112751        v21 TLS 被重置(read error -0x004C) → free 85003
  // mbedtls 异常断开会漏掉约 27.7KB。余量必须大到能吸收这种波动,否则同一版固件时好时坏。
  // v23 = v21(AFE 栈走 PSRAM) + **真正**关掉板端 WakeNet。
  // ⚠️v22 试过同一件事但**完全没生效**:光设 CONFIG_WAKE_WORD_DISABLED=y 没用 ——
  // afe_audio_engine.cc 里 wake_detector_ 是**扫 assets 分区有没有模型文件**决定的、不看 Kconfig,
  // 那个开关只管 application.cc 要不要去调用检测。v22 的 pipeline 里 WakeNet 还在,
  // AFE 反而从 83380 涨到 84412。v23 改在正确的位置(直接拦住 esp_srmodel_filter),
  // 验证:bin 从 2968496 缩到 2872912,小了 95584 字节 —— 这次真裁掉了。
  //
  // 板端那个唤醒词认的是「你好小智」,我们一次没用过(她的唤醒词在服务端做),纯白占。
  // AEC/VAD 不受影响(看 CONFIG_USE_AUDIO_PROCESSOR)。代价仅仅是板子不能语音唤醒、只能按键。
  // v25 = v23(AFE 栈走 PSRAM + 关板端 WakeNet) + **关 AEC** + **OTA 改走直连**。
  //
  // ① 关 AEC:v23 之后 DMA 只剩 7.4K,板子**播放音频时会崩溃重启** ——
  //    重配 I2S 时 `i2s_alloc_dma_desc` 失败,上游没检查返回值就用了空指针:
  //      Guru Meditation Error: Core 0 panic'ed (LoadProhibited)  EXCVADDR: 0x00000000
  //    AEC 是 AFE 里最后一块大的。关它的依据是实测:播报期麦克风收到的回声
  //    **RMS p50=11 / max=11**,而 barge-in 门槛 2500 —— 差两个数量级,这块板物理隔离足够好,
  //    AEC 基本没干活却占着最大一块内存。五处 AEC 调用点都用 kUseAec gate 住了。
  //    ⚠️若日后换了外放更响的壳子、或她把自己的话当成用户说的,把 kUseAec 改回 true。
  //
  // ② OTA 改走直连:板子一直卡「检查新版本失败」,因为 NVS 里存的是
  //    走 Cloudflare 隧道那个 https 地址(443),而用户家到 CF 的 443
  //    时通时不通、TCP 都建不起来(`code=0x8004 FAILED_CONNECT_TO_HOST`)。
  //    0815 音频早就为同样的原因切到了直连 80 端口,OTA 却被落下了。
  //    改法:`Ota::GetCheckVersionUrl()` 让**编译常量说了算**并就地更新 NVS 那个键 ——
  //    只动 ota_url 一个键,**不碰 WiFi 凭据**(别用 flash.py otaurl,那个烧整个 NVS 会清 WiFi)。
  //    实测直连端点 200 / 2.4ms。
  // v27 = v25 + **板端 AFE 整个关掉**(修识别变差) + **Opus 编码质量提回来**。
  //
  // ① 修识别变差(用户实测报的):v25 只关了 AEC,但 AFE 的 input_format 还是按
  //    `codec_->input_reference()` 拼成 "MR"(1 麦克风 + 1 回声参考)。没了 AEC 去消费那个 R 通道,
  //    AFE 吐出来的音频里混着喇叭回放 → 识别当然差。
  //    修法不是改格式,而是干脆 `CONFIG_USE_AUDIO_PROCESSOR=n`:`Feed()` 改走 `OutputRawAudio`,
  //    它按 `data[i] i+=channels` **正确只取麦克风那一路**。反正唤醒词/VAD/降噪全在服务端,
  //    板端 AFE 现在只剩一个 VAD,纯浪费还帮倒忙。(VAD 事件只用来点 LED,这块板是 NoLed,无影响。)
  //
  // ② Opus 质量:`AS_OPUS_ENC_CONFIG` 的上游默认 `complexity=0`(0~10 最低档) + `enable_dtx=true`
  //    (静音不发、把上行流抠断),两个都伤识别 —— 这是用户说的「之前改过的精度,现在可以改回来」。
  //    改成 complexity=5 / dtx=false。敢改是因为关掉 AFE 后 opus_codec 只占 7% CPU、internal 有 88K。
  //    ⚠️若 opus_codec CPU 顶到 30%+ 或又开始丢帧,把 complexity 降回 3。
  //
  // ③ 音频任务保大栈:关掉 AUDIO_PROCESSOR 会让上游走 #else 分支,把 audio_input 6144→4096、
  //    audio_output 4096→2048。那是给内存紧张的板子省的,而我们关 AFE 正是为了腾内存 ——
  //    实测 audio_output 峰值就用掉 1096 字节,2048 只剩 950 余量,栈溢出=直接 panic 重启。
  //    现在 internal 有 88K,没必要省这 2KB,已在 audio_service.cc 里保持与 #if 分支一致。
  app: {
    label: 'v2.4.28 只刷 app(关板端 AFE 修识别 + Opus 质量提回来 + 音频任务保大栈)',
    note: '烧 0x20000 的 app + 把 0xf000 的 otadata 清空,让板子从 factory 启动。分区表/NVS/assets 都不动。'
        + ' 刷完看串口:不该再有任何 AFE Pipeline 行(AFE 完全不建);识别准确率应明显回升。',
    parts: [
      { addr: '0x20000', file: 'xixi-v28-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app25: {
    label: 'v2.4.25(内存/OTA 都好了,但识别变差,只留作对照)',
    note: '关了 AEC 却留着 AFE,input_format 仍是 MR、回声参考通道没人消费 → 音频混入喇叭回放。',
    parts: [
      { addr: '0x20000', file: 'xixi-v25-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app23: {
    label: 'v2.4.23(能唤醒能对话,但播放时可能崩溃重启)',
    note: '关了 WakeNet 但 AEC 还在,DMA 只剩 7.4K → I2S DMA 分配失败 → 空指针崩溃。留作对照。',
    parts: [
      { addr: '0x20000', file: 'xixi-v23-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app22: {
    label: 'v2.4.22(❌改动没生效,等同 v21,只留作对照)',
    note: 'CONFIG_WAKE_WORD_DISABLED 管不到 AFE,WakeNet 照建。别刷。',
    parts: [
      { addr: '0x20000', file: 'xixi-v22-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app21: {
    label: 'v2.4.21(AFE 起来了但 DMA 不够,只留作对照)',
    note: 'AFE 栈走 PSRAM 后任务建得出来了,但 AFE 仍吃 83KB → DMA 最大块只剩 992B → WS 握手超时。',
    parts: [
      { addr: '0x20000', file: 'xixi-v21-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app20: {
    label: 'v2.4.20(= v14 行为 + 诊断;WS 正常但麦克风聋)',
    note: 'AFE 之后 max_blk 只剩 2304,拿不到 4KB 栈。留作对照:它证明了 WS 问题是我改出来的。',
    parts: [
      { addr: '0x20000', file: 'xixi-v20-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app19: {
    label: 'v2.4.19(❌连不上,只留作对照)',
    note: '修了栈踩踏但仍连不上 —— 正是它证明了踩踏不是连不上的原因。日常别用。',
    parts: [
      { addr: '0x20000', file: 'xixi-v19-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app17: {
    label: 'v2.4.17(❌连不上服务器,别刷,只留作对照)',
    note: 'TRY_ALLOCATE_WIFI_LWIP 倒亏 18K internal → AFE 后只剩 9.3K → WS 握手超时。日常别用。',
    parts: [
      { addr: '0x20000', file: 'xixi-v17-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app15: {
    label: 'v2.4.15(❌麦克风全聋,别刷,只留作对照)',
    note: 'AFE 任务栈分配失败 → 板子聋。留着是为了复现那个 bug,日常别用。',
    parts: [
      { addr: '0x20000', file: 'xixi-v15-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app16: {
    label: 'v2.4.16(❌连不上服务器,别刷,只留作对照)',
    note: 'AFE 起来了但 WiFi 缓冲多要了 14K → internal 只剩 10.5K → WS 握手超时。日常别用。',
    parts: [
      { addr: '0x20000', file: 'xixi-v16-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app14: {
    label: 'v2.4.14 回退(开机自动连 + 六轴姿态 + 防烧屏微动,无内存修复)',
    note: 'v15 万一有问题就刷这个退回去。同样是 app + 清 otadata,分区表/NVS/assets 不碰。',
    parts: [
      { addr: '0x20000', file: 'xixi-v14-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  app12: {
    label: 'v2.4.12 回退(只隐藏 WiFi/电池图标,没有姿态/常驻聆听)',
    note: '新版万一有问题就刷这个退回去。同样是 app + 清 otadata,分区表/NVS/assets 不碰。',
    parts: [
      { addr: '0x20000', file: 'xixi-v12-app.bin' },
      { addr: '0xf000', file: 'otadata-blank.bin' },
    ],
  },
  xixi: {
    label: '语音终端 v2.4.11',
    note: '分段烧录,跳过 0x9000 的 NVS。分区表见 partitions/v2/16m.csv。',
    parts: [
      { addr: '0x0', file: 'xixi-bootloader.bin' },
      { addr: '0x8000', file: 'xixi-ptable.bin' },
      { addr: '0xd000', file: 'xixi-otadata.bin' },
      { addr: '0x20000', file: 'xixi-app-2.4.11.bin' },
      { addr: '0x800000', file: 'xixi-assets.bin' },
    ],
  },
};

const out = { flash: FLASH, targets: {} };
for (const [key, t] of Object.entries(TARGETS)) {
  const parts = t.parts.map((p) => {
    const f = path.join(DIR, p.file);
    const buf = fs.readFileSync(f);
    return {
      ...p,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  });
  const total = parts.reduce((a, p) => a + p.size, 0);
  out.targets[key] = { ...t, parts, totalBytes: total };
  console.log(`${key}: ${parts.length} 段, ${(total / 1048576).toFixed(1)}MB — ${t.label}`);
}

fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(out, null, 2));
console.log('→ manifest.json 已写出');
