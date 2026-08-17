// harness.js — 假板子:文字进、流式出;--tts 时同时走 TTS 流水线出 wav。
// 板子没到之前,整条链路靠它开发验收。
// 用法:
//   node harness.js --once "你好"                发一句,流式打印回复+延迟分解,退出
//   node harness.js --once "你好" --tts out.wav  同时把回复按切句流水线合成为语音
//   node harness.js                              交互模式;/sid <id> 换附着对话;/new 下一句新建;/quit 退出
// 附着对话记在 state.json(种子=「TTFT测试(可删)」,开发期沙盒对话)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const TelosClient = require('./telos-client');
const { QwenTTS, SentenceChunker, writeWav } = require('./tts');

const STATE_PATH = path.join(__dirname, 'state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

const args = process.argv.slice(2);
function argOf(name) { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : ''; }
const once = argOf('--once');
const ttsOut = argOf('--tts');
const state = loadState();
if (argOf('--sid')) { state.sessionId = argOf('--sid'); saveState(state); }

const client = new TelosClient();
client.on('log', (s) => console.error('[log]', s));
client.on('mood', (m) => {
  if (m.sessionId === state.sessionId && m.mood && m.mood.label) console.error(`[mood] ${m.mood.label}${m.mood.note ? ' · ' + m.mood.note : ''}`);
});
client.on('wake', (m) => console.error(`[主动开口] ${(m.text || '').slice(0, 160)}`));
client.on('turn_start', () => console.error('[状态] 在想…'));
client.on('delta', (s) => process.stdout.write(s));

async function ask(text) {
  const tAsk = Date.now();
  // --tts:边收 delta 边切句,句子按序进合成队列(串行链,保证音频顺序)
  let tc = null;
  if (ttsOut) {
    tc = { chunker: new SentenceChunker(), tts: new QwenTTS(), chain: Promise.resolve(), parts: [], n: 0, tFirstAudio: 0 };
    tc.queue = (sent) => {
      const idx = ++tc.n;
      tc.chain = tc.chain.then(async () => {
        const t0 = Date.now();
        const r = await tc.tts.synth(sent);
        if (!tc.tFirstAudio) tc.tFirstAudio = t0 + r.tFirst;
        tc.parts.push(r.pcm);
        console.error(`[tts] 句${idx}「${sent.slice(0, 16)}${sent.length > 16 ? '…' : ''}」首分片=${r.tFirst}ms 音频=${r.seconds.toFixed(2)}s`);
      }).catch((e) => console.error('[tts err]', e.message));
    };
    tc.onDelta = (s) => { for (const sent of tc.chunker.feed(s)) tc.queue(sent); };
    client.on('delta', tc.onDelta);
  }

  try {
    const r = await client.say(text, state.sessionId || '');
    if (!state.sessionId && r.sessionId) {
      state.sessionId = r.sessionId; saveState(state);
      console.error('[log] 新对话已附着:', r.sessionId);
    }
    process.stdout.write('\n');
    console.error(`[延迟] turn_start=${r.timings.start}ms 首delta=${r.timings.firstDelta}ms 总=${r.timings.total}ms cost=$${r.cost}`);
    if (tc) {
      for (const sent of tc.chunker.flush()) tc.queue(sent);
      await tc.chain;
      if (tc.parts.length) {
        const pcm = Buffer.concat(tc.parts);
        writeWav(ttsOut, pcm);
        console.error(`[tts] 模拟首音(说完→出声)=${tc.tFirstAudio ? tc.tFirstAudio - tAsk : -1}ms 共${tc.n}句 ${(pcm.length / 48000).toFixed(2)}s → ${ttsOut}`);
      } else console.error('[tts] 本轮没有可合成的句子');
    }
    return r;
  } finally {
    if (tc) client.removeListener('delta', tc.onDelta);
  }
}

client.on('ready', async () => {
  console.error('[log] 已连接 telos(headless),附着对话:', state.sessionId || '(新建)');
  if (once) {
    try { await ask(once); process.exit(0); }
    catch (e) { console.error('[err]', e.message); process.exit(1); }
  }
});
client.connect();

if (!once) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('> ');
  rl.prompt();
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return rl.prompt();
    if (s === '/quit') process.exit(0);
    if (s === '/new') { state.sessionId = ''; saveState(state); console.error('[log] 下一句将新建对话'); return rl.prompt(); }
    if (s.startsWith('/sid ')) { state.sessionId = s.slice(5).trim(); saveState(state); console.error('[log] 附着:', state.sessionId); return rl.prompt(); }
    try { await ask(s); } catch (e) { console.error('[err]', e.message); }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}
