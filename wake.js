// wake.js — 服务端唤醒词唤醒词(《唤醒词与姿态计划》方案 C)
//
// 板端 WakeNet 那句"你好小智"是乐鑫训练死的、改不了(定制要付费),MultiNet 塞得下但常开吃 CPU、
// 不值得赌刚修好的卡顿。所以唤醒词整个搬到服务端:板子常态上传,这里边听边等她的名字。
//
// 引擎是 **sherpa-onnx 的关键词检测**,不是计划书原写的 openWakeWord —— 后者没有中文预训练词、
// 必须自己训,而训练要拖几十 GB 负样本数据集,这台机器磁盘只剩 11GB。sherpa-onnx 反而**零训练**:
// 建模单元是拼音,关键词写一行文本就能加(现在还能在控制台里改,见 setKeyword)。
//
// 上行音频本来就是 16kHz(codec.js 的 UP_RATE),和模型训练采样率天生一致,零重采样。
// 实测(0815):单线程 RTF 0.064(占单核 6.4%)、内存 90MB、8 条正样本命中 7、
// 8 条日常+近音陷阱("你好小智""洗洗睡吧"和把名字嵌进日常句的陷阱)0 误报、75 秒连续真实语音也是 0 误报。
//
// ⚠️两条调参坑(实测撞出来的,别再踩):
//  1. 构造参数里的 keywordsScore/keywordsThreshold **不生效** —— 扫 5 组参数结果一模一样。
//     必须写进 keywords.txt 的**每词参数**(`:score #threshold`)才认。
//  2. boost **不是越高越准**:4.0 时 7/8,升到 5.0/6.0 反而掉一条,8.0 又回来 —— 非单调。
//     它是解码时给关键词路径加分,给太多会让 beam search 提前收敛到错路径。
//  3. 多线程是负优化:threads=2 的总 CPU 是单线程的 3 倍(并行开销)。常开一律 1。
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  dir: path.join(require('os').homedir(), 'kws-model'),  // 配 config.json 的 wakeWord.dir 覆盖
  model: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
  ckpt: 'epoch-12-avg-2-chunk-16-left-64',
  keywords: 'keywords.txt',
  resetSec: 300,   // 静默这么久就重建一次 stream,免得长期待机累积状态
  boost: 4.0,      // 每词参数(写进 keywords.txt 才生效,见文件头第 1 条);4.0 是实测最优,非单调
  threshold: 0.05,
};

// ---- 中文 → 建模单元 ----------------------------------------------------
// 这个模型的建模单元是「声母 + 带调韵母」,不是汉字。规则**复刻** sherpa_onnx/utils.py 的
// text2token ppinyin 分支:pypinyin 的 `to_initials(strict=False)` + `to_finals_tone(strict=False)`
// —— 也就是「从头贪婪切掉声母(y/w 也算声母)、剩下的连声调一起当韵母」。
// 验证过:拿模型自带 keywords_raw.txt 的 7 条(你好军哥/小爱同学/小艺小艺/林美丽/你好问问/
// 蛋哥蛋哥/小米小米)跑一遍,输出与它自带的 keywords.txt **逐字节一致**。
// ⚠️zh/ch/sh 必须排在 z/c/s/h 前面,否则「上」会被切成 s + hàng。
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
                  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];
let _pinyin = null;   // pinyin-pro 的字典 ~1MB,懒加载(和模型一样,没用到就别占)
let _tokSet = null;   // tokens.txt 的单元表,用来挡未登录音(写进去 KWS 会永不命中)

// 返回 { tokens: ['n','ǐ',...], bad: [不在 tokens.txt 里的单元] }
function text2tokens(text, tokensPath) {
  if (!_pinyin) _pinyin = require('pinyin-pro').pinyin;
  const py = _pinyin(String(text || ''), { type: 'array', toneType: 'symbol', nonZh: 'removed' });
  const tokens = [];
  for (const p of py) {
    const ini = INITIALS.find((i) => p.startsWith(i));
    const fin = ini ? p.slice(ini.length) : p;
    if (ini) tokens.push(ini);
    if (fin) tokens.push(fin);
  }
  const bad = tokensPath ? tokens.filter((t) => !loadTokSet(tokensPath).has(t)) : [];
  return { tokens, bad };
}

function loadTokSet(tokensPath) {
  if (!_tokSet) {
    _tokSet = new Set(fs.readFileSync(tokensPath, 'utf8').split('\n').map((l) => l.split(' ')[0]));
  }
  return _tokSet;
}

class WakeWord {
  // 模型 90MB,**懒加载** —— 用户 VPS 内存紧张,没开这个功能就一个字节都别占。
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.kws = null;
    this.stream = null;
    this.lastFeed = 0;
    this.keyword = '';      // keywords.txt 里 @ 后面那个显示名,日志用
  }

  // 模型目录下那几个固定路径,start/preview/setKeyword 共用一份算法
  _p() {
    const { dir, model, ckpt, keywords } = this.o;
    const md = path.join(dir, model);
    return {
      md,
      kwFile: path.join(dir, keywords),
      tokens: path.join(md, 'tokens.txt'),
      f: (kind) => path.join(md, `${kind}-${ckpt}.onnx`),
    };
  }

  // 返回 null = 一切正常(已就绪);返回字符串 = 起不来的原因(调用方打日志后当没开)
  start() {
    const { kwFile, tokens, f } = this._p();
    for (const p of [kwFile, f('encoder'), f('decoder'), f('joiner'), tokens]) {
      if (!fs.existsSync(p)) return `缺文件 ${p}`;
    }
    let sherpa;
    try { sherpa = require('sherpa-onnx-node'); }
    catch (e) { return 'sherpa-onnx-node 没装:' + e.message; }
    try {
      this.kws = new sherpa.KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: f('encoder'), decoder: f('decoder'), joiner: f('joiner') },
          tokens,
          numThreads: 1,          // ⚠️别改大,见文件头第 3 条
          provider: 'cpu', debug: 0,
        },
        maxActivePaths: 4,
        // 这三个**不生效**(实测),真正起作用的是 keywords.txt 里的每词参数。留着是为了对齐官方示例签名。
        keywordsScore: 1.0, keywordsThreshold: 0.25, numTrailingBlanks: 1,
        keywordsFile: kwFile,
      });
    } catch (e) { return '模型加载失败:' + e.message; }
    const m = /@(\S+)/.exec(fs.readFileSync(kwFile, 'utf8'));
    this.keyword = m ? m[1] : '(未命名)';
    this._newStream();
    return null;
  }

  _newStream() { this.stream = this.kws.createStream(); this.lastReset = Date.now(); }

  // 16bit PCM 的能量,只用来判断"这一帧是不是安静的"(重建 stream 挑时机用)
  _rms(buf) {
    const n = buf.length >> 1;
    if (!n) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i << 1); s += v * v; }
    return Math.sqrt(s / n);
  }

  // 喂一帧上行 PCM(int16 LE Buffer,16kHz —— 就是 codec.decodeUp() 的原样输出)。
  // 检出返回关键词名,否则返回 ''。
  feed(buf) {
    if (!this.kws || !buf || !buf.length) return '';
    const now = Date.now();
    // 定期重建 stream。⚠️判据是"距上次**重建**",不是"距上次 feed" —— 方案 C 下板子常态上传、
    // **每帧都在 feed**,按 feed 计时的话永远不会触发,等于没有保护(第一版就写错了)。
    // 实测代价:不重建的话待机内存约 +1MB/15 分钟(≈96MB/天),不是泄漏但会慢慢堆。
    // 挑安静的一帧下手,免得正好在她说唤醒词的中间把解码状态丢了 —— 待机时安静帧遍地都是,
    // 到点后基本下一帧就能重建。
    if (now - this.lastReset > this.o.resetSec * 1000 && this._rms(buf) < 200) this._newStream();
    this.lastFeed = now;
    const n = buf.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = buf.readInt16LE(i << 1) / 32768;
    this.stream.acceptWaveform({ sampleRate: 16000, samples: f32 });
    let hit = '';
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const r = this.kws.getResult(this.stream);
      if (r && r.keyword) hit = r.keyword;
    }
    // 检出后必须 reset,否则同一句话会连着报好几次(解码器还停在命中状态)
    if (hit) this.kws.reset(this.stream);
    return hit;
  }

  // 一轮对话结束、回待命时调:丢掉这轮说话攒下的解码状态,别让它污染下一次唤醒判定
  reset() { if (this.kws && this.stream) this.kws.reset(this.stream); }

  // ---- 控制台改唤醒语用的三件套 ------------------------------------------
  // 读当前 keywords.txt。格式:`<单元 空格分隔> :boost #threshold @显示名`
  read() {
    const { kwFile } = this._p();
    let line = '';
    try {
      // 只认第一条非空行 —— 引擎支持多关键词,但这里是"她的名字",多一个就多一道误唤醒
      line = (fs.readFileSync(kwFile, 'utf8').split('\n').find((l) => l.trim()) || '').trim();
    } catch (e) { return { text: '', tokens: [], boost: this.o.boost, threshold: this.o.threshold, error: e.message }; }
    const at = line.indexOf('@');
    const head = (at >= 0 ? line.slice(0, at) : line).trim();
    return {
      text: at >= 0 ? line.slice(at + 1).trim() : '',
      tokens: head.replace(/[:#]\S*/g, '').trim().split(/\s+/).filter(Boolean),
      boost: Number((/:(\S+)/.exec(head) || [])[1]) || this.o.boost,
      threshold: Number((/#(\S+)/.exec(head) || [])[1]) || this.o.threshold,
      running: !!this.kws,
    };
  }

  // 只转换、不落盘(控制台边打字边预览)。tokens.txt 缺失时 bad 为空,不当致命错
  preview(text) {
    const { tokens } = this._p();
    try { return text2tokens(text, fs.existsSync(tokens) ? tokens : null); }
    catch (e) { return { tokens: [], bad: [], error: e.message }; }
  }

  // 写 keywords.txt 并重建引擎。tokens 传空 = 按 text 自动转;传了就按传的来
  // (多音字/人名必须能手改 —— 比如「乐」自动转出 lè,名字里常念 yuè,得手改)。
  // ⚠️重建会**再加载一次 90MB 模型**,旧的靠 GC 回收(napi finalizer),不是立刻还给系统。
  // 唤醒语不是常改的东西,别拿它当滑块连着拖 —— 日志里打了 RSS,涨太多就重启网关。
  setKeyword(text, tokens) {
    const t = String(text || '').trim();
    if (!t) throw new Error('唤醒语不能为空');
    if (t.length > 12) throw new Error('唤醒语太长(最多 12 字),越长越难念准');
    let units = String(tokens || '').trim().split(/\s+/).filter(Boolean);
    if (!units.length) {
      const r = this.preview(t);
      if (r.error) throw new Error('转拼音失败:' + r.error);
      units = r.tokens;
    }
    if (!units.length) throw new Error('转不出拼音 —— 这个引擎只认中文,英文/数字请换成汉字');
    // 未登录音写进去 = KWS 永不命中,且不会报错(最难查的那种坏)。挡在这里。
    const { tokens: tokPath, kwFile } = this._p();
    if (fs.existsSync(tokPath)) {
      const set = loadTokSet(tokPath);
      const miss = units.filter((u) => !set.has(u));
      if (miss.length) throw new Error('模型不认识这些音:' + miss.join(' ') + ' —— 换个字或手改拼音');
    }
    // 4 要写成 "4.0" —— 只为跟模型自带的 keywords.txt 一个风格,`:4` 引擎也认(stof)
    const fmt = (n) => (Number.isInteger(n) ? Number(n).toFixed(1) : String(n));
    const line = `${units.join(' ')} :${fmt(this.o.boost)} #${this.o.threshold} @${t}\n`;
    const tmp = kwFile + '.tmp';
    fs.writeFileSync(tmp, line, 'utf8');
    fs.renameSync(tmp, kwFile);   // 原子写:别让引擎重载时读到写了一半的文件
    const wasRunning = !!this.kws;
    if (wasRunning) {
      this.kws = null; this.stream = null;   // 先撒手,给 GC 一个回收旧引擎的机会
      const err = this.start();
      if (err) throw new Error('写好了,但重载失败:' + err + '(改回去或重启网关)');
    } else {
      this.keyword = t;   // 没跑就只更新显示名,等 setWake(true) 时再真加载
    }
    return { text: t, tokens: units, reloaded: wasRunning };
  }
}

module.exports = { WakeWord, text2tokens };
