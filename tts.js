// tts.js — DashScope SSE 流式 TTS + 切句器 + PCM 组装
// 关键事实(均实测,见《方案》13.3):
//  - 复刻音色必须用 model qwen3-tts-vc-2026-01-22(qwen3-tts-flash 会 400)
//  - SSE 首音 0.62-0.71s 且与句长无关;X-DashScope-SSE: enable
//  - 分片是 base64,预期 24kHz 16bit 单声道 PCM(若来的是 RIFF wav,剥 44 字节头)
// 板端 Opus 编码不在这里(那是 board/codec.js 的事);本文件产出统一为 PCM Buffer。
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL_HOST = 'dashscope.aliyuncs.com';
const URL_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = 'qwen3-tts-vc-2026-01-22';
// 音色 id 在 config.json 的 `voice` 里配。复刻音色是**跟账号绑的**,写死在代码里对别人没用;
// 不配就退到官方公开音色,能出声、只是不是她的声音。
const VOICE = 'Cherry';
const SAMPLE_RATE = 24000;

// key 按这个顺序找:环境变量 DASHSCOPE_API_KEY → 传进来的 envPath → 环境变量 DASHSCOPE_ENV_FILE
// → config.json 的 dashscopeEnvFile。别把 key 写进代码或 config.json 本身 —— 它按调用量计费。
// **自己会读 config.json** 是有意的:这文件被几个测试脚本直接 new,少传一个参数就该报错的话,
// 那些脚本会莫名其妙全挂(改这段时踩过)。
function cfgVal(key) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))[key] || ''; }
  catch (e) { return ''; }
}
function loadKey(envPath) {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY.trim();
  const p = envPath || process.env.DASHSCOPE_ENV_FILE || cfgVal('dashscopeEnvFile');
  if (!p) throw new Error('缺 DASHSCOPE_API_KEY:设这个环境变量,或在 config.json 里配 dashscopeEnvFile 指向存 key 的文件');
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.startsWith('DASHSCOPE_API_KEY')) return line.split('=', 2)[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('文件里没有 DASHSCOPE_API_KEY= 那一行:' + p);
}

// ---- 切句器:delta 流进,句子出 ----
// 首句短优先(尽快出首音);其后按硬标点封句;超长在软标点强切。
const HARD = /[。！？!?；;\n]/;
const SOFT = /[，,、：:]/;
// 封句后把紧跟的连发标点/收尾引号并进本句("真的吗?!""好。」")。只含收尾引号、不含开头引号,
// 免得吃进下一句的开头。0813 自检:老的"碎片回炉"遇到孤标点(如 "?!" 切出的 "!")会原样塞回
// buf 再撞同一个硬标点 → 切句器整轮卡死,后文全堆到 flush 一次吐出。
const TAIL = /[。！？!?；;，,、：:…～~）)】\]」』"'\s]/;
const WORD = /[\p{L}\p{N}]/u;
class SentenceChunker {
  constructor(opts = {}) {
    this.buf = '';
    this.first = true;
    this.firstSoftMin = opts.firstSoftMin || 6;   // 首句攒够这么多字就允许在软标点切
    this.maxLen = opts.maxLen || 60;              // 超长强切
  }
  feed(s) {
    this.buf += s;
    const out = [];
    for (;;) {
      const cut = this._findCut();
      if (cut < 0) break;
      let end = cut + 1;
      while (end < this.buf.length && TAIL.test(this.buf[end])) end++;
      const sent = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (WORD.test(sent)) { out.push(sent); this.first = false; } // 纯标点/空碎片直接丢
    }
    return out;
  }
  _findCut() {
    // 硬标点太远时不无条件优先——一次性喂进大块文本(attach 重放/flush)时要让 maxLen 强切兜底
    const h = this.buf.search(HARD);
    if (h >= 0 && h <= this.maxLen) return h;
    // 🔴0815 删掉「首句软切」(用户:「"那种人真的无语了"怎么会在"那种人"那里断句呢」)。
    // 它原本在首句攒够 6 字后就在第一个逗号处切开,想让首音早点出来。**但那个前提是错的** ——
    // 实测 DashScope 首片延迟和文本长度几乎无关(4字 922ms / 17字 390ms / 27字 594ms / 33字 623ms,
    // 更长的反而更快,瓶颈是网络往返不是合成)。于是它一秒没省下,却把
    // "碰到那种人，真的无语了" 从逗号劈成两半:各自独立合成、各自起调收调,中间还夹一次封尾补零,
    // 听感就是一顿一顿的。**"卡"的一大来源不是音频断续,是句子被切碎。**
    // 现在只按硬标点(。！？；换行)断句,逗号一律不切;超长仍由下面的 maxLen 兜底。
    if (this.buf.length > this.maxLen) {
      for (let i = this.maxLen; i > 10; i--) if (SOFT.test(this.buf[i])) return i;
      return this.maxLen;
    }
    return -1;
  }
  flush() {
    const rest = this.buf.trim(); this.buf = ''; this.first = true;
    return rest ? [rest] : [];
  }
}

// ---- SSE 合成:一句文本 → PCM Buffer(分片经 onChunk 流式给出) ----
class QwenTTS {
  constructor(opts = {}) {
    this.key = opts.key || loadKey(opts.envPath);
    this.voice = opts.voice || cfgVal('voice') || VOICE;   // 没配就退到官方公开音色,能出声
    this.model = opts.model || MODEL;
  }
  // 0816:DashScope 会瞬时限流(`Throttling.RateQuota`,HTTP 429) —— 一晚上撞了 15 次,
  // 表现是用户说完话**她那边一声不吭**(以为板子坏了,其实是这一句没合成出来)。
  // 原来遇到非 200 直接 reject、连一次重试都没有。
  // ✅重发是安全的:429/5xx 都在**响应头**阶段就失败,一个 chunk 都还没吐给 onChunk,
  //   不会让她把半句话说两遍(这是能重试的前提,别挪到流中间去重试)。
  // 退避只给 300ms + 900ms 两次:这是实时语音,宁可少等也别让她卡在那儿 ——
  //   最坏多等 1.2 秒,总好过整句话没声音。
  async synth(text, onChunk) {
    const delays = [300, 900];
    for (let i = 0; ; i++) {
      try {
        return await this._synthOnce(text, onChunk);
      } catch (e) {
        const transient = /TTS HTTP (429|5\d\d)/.test(e.message || '');
        if (!transient || i >= delays.length) throw e;
        if (this.onRetry) this.onRetry(i + 1, e.message);
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }

  _synthOnce(text, onChunk) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: this.model, input: { text, voice: this.voice, language_type: 'Chinese' } });
      const t0 = Date.now();
      let tFirst = 0;
      const parts = [];
      let sseBuf = '';
      let headerStripped = false;
      const req = https.request({
        host: URL_HOST, path: URL_PATH, method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.key,
          'Content-Type': 'application/json',
          'X-DashScope-SSE': 'enable',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let e = ''; res.on('data', (d) => e += d);
          res.on('end', () => reject(new Error(`TTS HTTP ${res.statusCode}: ${e.slice(0, 200)}`)));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (d) => {
          sseBuf += d;
          let nl;
          while ((nl = sseBuf.indexOf('\n')) >= 0) {
            const line = sseBuf.slice(0, nl).trim(); sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            let j; try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            const b64 = j && j.output && j.output.audio && j.output.audio.data;
            if (!b64) continue;
            let chunk = Buffer.from(b64, 'base64');
            if (!headerStripped) {
              headerStripped = true;
              if (chunk.slice(0, 4).toString('ascii') === 'RIFF') chunk = chunk.slice(44); // wav 头剥掉,后续裸 PCM
            }
            if (!chunk.length) continue;
            if (!tFirst) tFirst = Date.now() - t0;
            parts.push(chunk);
            if (onChunk) onChunk(chunk);
          }
        });
        res.on('end', () => {
          const pcm = Buffer.concat(parts);
          if (!pcm.length) return reject(new Error('TTS 无音频分片: ' + text.slice(0, 30)));
          resolve({ pcm, tFirst, tTotal: Date.now() - t0, seconds: pcm.length / (SAMPLE_RATE * 2) });
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(new Error('TTS 超时')); });
      req.end(body);
    });
  }
}

// ---- WAV 落盘(24kHz 16bit mono) ----
function writeWav(file, pcm, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

module.exports = { QwenTTS, SentenceChunker, writeWav, SAMPLE_RATE };

// 独立运行:node tts.js "文本" [out.wav]
if (require.main === module) {
  const text = process.argv[2] || '你好,这是语音终端的合成测试。';
  const out = process.argv[3] || 'tts-test.wav';
  new QwenTTS().synth(text).then((r) => {
    writeWav(out, r.pcm);
    console.log(`首分片=${r.tFirst}ms 总=${r.tTotal}ms 音频=${r.seconds.toFixed(2)}s → ${out}`);
  }).catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
