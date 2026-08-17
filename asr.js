// asr.js — DashScope Paraformer 实时语音识别(WS 直连,不用 SDK)
// 协议:通用 DashScope WS(run-task → task-started → 二进制音频 → result-generated → finish-task → task-finished)
// 文本路径 payload.output.sentence.text,句子终结标志 sentence.sentence_end
// 板子上行 16kHz 单声道 PCM;推荐 100ms 一包(3200 字节)
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const MODEL = 'paraformer-realtime-v2';

// key 按这个顺序找:环境变量 DASHSCOPE_API_KEY → 传进来的 envPath → 环境变量 DASHSCOPE_ENV_FILE
// → config.json 的 dashscopeEnvFile。别把 key 写进代码或 config.json 本身 —— 它按调用量计费。
// **自己会读 config.json** 是有意的:这文件的函数被好几个测试脚本直接调,少传一个参数就该
// 报错的话,那些脚本会莫名其妙全挂(改这段时踩过)。
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

// 一次识别会话(一句话):start → sendAudio×N → finish → 'final'
class AsrStream extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.key = opts.key || loadKey(opts.envPath);
    this.model = opts.model || MODEL;
    this.sampleRate = opts.sampleRate || 16000;
    // 断句静音阈值:DashScope 默认 800ms,用户实测"说完话后不够快速识别"。
    // 500ms 是折中——再低会把说话中的换气当成句尾切开。
    // 0815 从 500 调回 800:500ms 太急,用户句中稍一停顿就被判成说完了 ——
    // 实测被腰斩成"从周从周五的晚上。""他这边。""...好几个小时了。结。"。
    // 省下的 300ms 延迟远不值这个代价。要再调走 config.json 的 endSilenceMs。
    this.endSilenceMs = opts.endSilenceMs || 800;
    this.taskId = crypto.randomBytes(16).toString('hex');
    this.ready = false;
    this.queue = [];
    this.sentences = [];
    this.lastPartial = '';
    this.ws = null;
  }
  start() {
    const ws = this.ws = new WebSocket(WS_URL, { headers: { Authorization: 'Bearer ' + this.key } });
    ws.on('open', () => ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition',
        model: this.model,
        parameters: {
          format: 'pcm', sample_rate: this.sampleRate,
          max_sentence_silence: this.endSilenceMs,   // 不设 = 吃默认 800ms,白等
        },
        input: {},
      },
    })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      const ev = m.header && m.header.event;
      if (ev === 'task-started') {
        this.ready = true;
        for (const b of this.queue) ws.send(b);
        this.queue.length = 0;
        this.emit('ready');
      } else if (ev === 'result-generated') {
        const s = m.payload && m.payload.output && m.payload.output.sentence;
        if (!s || typeof s.text !== 'string') return;
        this.lastPartial = s.text;
        this.emit('partial', s.text);
        if (s.sentence_end) { this.sentences.push(s.text); this.emit('sentence', s.text); }
      } else if (ev === 'task-finished') {
        this.emit('final', this.text());
        try { ws.close(); } catch (e) {}
      } else if (ev === 'task-failed') {
        this.emit('error', new Error('ASR task-failed: ' + ((m.header && m.header.error_message) || raw.toString().slice(0, 200))));
        try { ws.close(); } catch (e) {}
      }
    });
    ws.on('error', (e) => this.emit('error', e));
    return this;
  }
  sendAudio(buf) { if (this.ready) { try { this.ws.send(buf); } catch (e) {} } else this.queue.push(buf); }
  finish() {
    const done = () => this.ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' }, payload: { input: {} } }));
    if (this.ready) done(); else this.once('ready', done);
  }
  text() { return (this.sentences.join('') || this.lastPartial).trim(); }
}

// 24kHz→16kHz 线性重采样(TTS 产物喂测试用;板子本来就是 16k,不走这个)
function resample24to16(pcm24) {
  const src = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length >> 1);
  const n = Math.floor(src.length / 1.5);
  const out = new Int16Array(n);
  for (let j = 0; j < n; j++) {
    const pos = j * 1.5, i = Math.floor(pos), f = pos - i;
    out[j] = src[i] * (1 - f) + (src[i + 1] || src[i]) * f;
  }
  return Buffer.from(out.buffer);
}

// 整段 16k PCM → 文本(按 100ms/3200B 节奏喂,paceMs 可调)
function recognizePcm16k(pcm, opts = {}) {
  return new Promise((resolve, reject) => {
    const asr = new AsrStream(opts).start();
    const partials = [];
    asr.on('partial', (t) => partials.push(t));
    asr.on('final', (t) => resolve({ text: t, partials }));
    asr.on('error', reject);
    asr.on('ready', async () => {
      for (let off = 0; off < pcm.length; off += 3200) {
        asr.sendAudio(pcm.slice(off, off + 3200));
        await new Promise((r) => setTimeout(r, opts.paceMs != null ? opts.paceMs : 100));
      }
      asr.finish();
    });
    setTimeout(() => reject(new Error('ASR 超时')), opts.timeoutMs || 60000);
  });
}

module.exports = { AsrStream, recognizePcm16k, resample24to16 };
