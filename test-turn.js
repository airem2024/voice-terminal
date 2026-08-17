// test-turn.js — 回合状态机假事件测试(不碰网络/telos/DashScope)
// 跑法:node test-turn.js;全部断言过 → exit 0
const assert = require('assert');
const EventEmitter = require('events');
const { Orchestrator } = require('./core/turn');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeTelos extends EventEmitter {
  constructor() { super(); this.delayMs = 200; this.deltas = ['好呀,', '我在。', '今天也要加油哦。']; }
  say(text) {
    return new Promise((resolve) => {
      setTimeout(() => this.emit('turn_start', 't1'), 40);
      this.deltas.forEach((d, i) => setTimeout(() => this.emit('delta', d), 60 + i * 30));
      setTimeout(() => resolve({ sessionId: 's1', text: this.deltas.join(''), cost: 0.01, timings: { start: 40, firstDelta: 60, total: this.delayMs } }), this.delayMs);
    });
  }
}
class FakeTTS {
  async synth(sent) { await sleep(20); return { pcm: Buffer.alloc(sent.length * 96), seconds: sent.length * 0.002, tFirst: 5, tTotal: 20 }; }
}

async function main() {
  const telos = new FakeTelos();
  const tts = new FakeTTS();
  const o = new Orchestrator({ telos, tts, opts: { thinkTimeoutMs: 5000, speakTailMs: 10 } });
  const log = [];
  const t0 = Date.now();
  const rec = (k) => (v) => log.push([Date.now() - t0, k, typeof v === 'object' ? (v.sentence || v.state || '') : String(v || '')]);
  ['state', 'face', 'subtitle', 'audio_flush', 'thinking_cue', 'filler', 'reply', 'log'].forEach((k) => o.on(k, rec(k)));
  // 流式化后一句话会发多条 audio(分片 + 句尾 end),sentence 只在**句首那条**带一次,
  // 所以断言只收有 sentence 的,别把中间分片的空值也收进来。
  const audio = []; o.on('audio', (a) => { if (a.sentence) { audio.push(a.sentence); log.push([Date.now() - t0, 'audio', a.sentence]); } });
  const states = []; o.on('state', (s) => states.push(s));

  // ---- S1 正常回合:唤醒 → 说话 → 想 → 说 → 回 idle ----
  o.onWake();
  assert.strictEqual(o.state, 'listening', 'S1 唤醒后应为 listening');
  o.onUtterance('你好呀');
  await sleep(500);
  assert.strictEqual(o.state, 'idle', 'S1 结束应回 idle');
  assert(states.includes('thinking') && states.includes('speaking'), 'S1 应经过 thinking 和 speaking');
  assert(audio.length >= 2, 'S1 应有多句音频,实际 ' + audio.length);
  console.log('S1 正常回合 ✅ 音频句:', audio.join(' / '));

  // ---- S2 排队:想的时候又说话,只留最新、自动接力 ----
  audio.length = 0;
  const replies = []; o.on('reply', (r) => replies.push(r.text));
  o.onWake(); o.onUtterance('第一件事');
  await sleep(80);                       // 正在 thinking
  o.onUtterance('先别管了,说说第二件事'); // 应排队
  assert.strictEqual(o.state, 'thinking', 'S2 排队时仍在 thinking');
  await sleep(900);
  assert.strictEqual(o.state, 'idle', 'S2 两轮跑完应回 idle');
  assert.strictEqual(replies.length, 2, 'S2 应有两次 reply,实际 ' + replies.length);
  console.log('S2 忙时排队(只留最新) ✅');

  // ---- S3 打断:说话中唤醒 → 停播不掐 turn → 新话接力 ----
  telos.delayMs = 350; // 慢回合,保证打断时 telos 仍 in-flight
  audio.length = 0;
  let flushed = 0; o.on('audio_flush', () => flushed++);
  o.onWake(); o.onUtterance('讲个长一点的');
  await sleep(150);                      // 已进 speaking(首句合成完)
  assert.strictEqual(o.state, 'speaking', 'S3 此刻应在 speaking');
  const nBefore = audio.length;
  o.onWake();                            // 打断
  assert(flushed >= 1, 'S3 打断应触发 audio_flush');
  assert.strictEqual(o.state, 'listening', 'S3 打断后应为 listening');
  o.onUtterance('换个话题');
  await sleep(900);
  assert.strictEqual(audio.filter((s, i) => i >= nBefore && ['好呀,', '我在。'].includes(s)).length <= 3, true);
  assert.strictEqual(o.state, 'idle', 'S3 新回合跑完应回 idle');
  console.log('S3 打断=停播不掐turn,新话接力 ✅');

  // ---- S4 没听清:空转写 → 回 idle ----
  o.onWake(); o.onUtterance('   ');
  assert.strictEqual(o.state, 'idle', 'S4 没听清应回 idle');
  console.log('S4 没听清回落 ✅');

  // ---- S5 主动开口(idle):wake_message 直接念 ----
  audio.length = 0;
  telos.emit('wake', { sessionId: 's1', text: '睡前记得喝水哦。还有明天有个快递。' });
  await sleep(300);
  assert(audio.length >= 1, 'S5 应念出主动消息,实际 ' + audio.length);
  assert.strictEqual(o.state, 'idle', 'S5 念完回 idle');
  console.log('S5 主动开口(idle) ✅ :', audio.join(' / '));

  // ---- S6 主动开口(忙):攒着,回 idle 再念 ----
  telos.delayMs = 250; audio.length = 0;
  o.onWake(); o.onUtterance('随便聊聊');
  await sleep(80);                       // thinking 中
  telos.emit('wake', { sessionId: 's1', text: '这条要等你忙完才念。' });
  assert.strictEqual(o.pendingWake && true, true, 'S6 忙时 wake 应挂起');
  await sleep(1000);
  assert(audio.includes('这条要等你忙完才念。'), 'S6 回 idle 后应念出挂起的 wake');
  assert.strictEqual(o.state, 'idle', 'S6 最终回 idle');
  console.log('S6 主动开口(忙时攒着) ✅');

  // ---- S7 想太久:承诺填充语 → 迟到的回答 idle 时补念(0813 拍板) ----
  {
    class SlowTelos extends EventEmitter { // 慢回合:没有任何 delta,答案整个迟到(长工具链的真实形状)
      say() { return new Promise((res) => {
        setTimeout(() => this.emit('turn_start', 't7'), 20);
        setTimeout(() => res({ sessionId: 's7', text: '答案是四十二。', cost: 0.01, timings: { start: 20, firstDelta: -1, total: 500 } }), 500);
      }); }
    }
    const o2 = new Orchestrator({ telos: new SlowTelos(), tts, opts: { thinkTimeoutMs: 120, speakTailMs: 10 } });
    const audio2 = []; o2.on('audio', (a) => { if (a.sentence) audio2.push(a.sentence); });
    const fillers2 = []; o2.on('filler', (t) => fillers2.push(t));
    o2.onWake(); o2.onUtterance('这个问题很难');
    await sleep(250);
    assert(fillers2.length === 1 && fillers2[0].includes('我还在想'), 'S7 应有承诺填充语,实际 ' + JSON.stringify(fillers2));
    assert(!fillers2[0].includes('她'), 'S7 兜底语必须第一人称(板子=她本人)');
    assert.strictEqual(o2.state, 'idle', 'S7 超时后应回 idle');
    await sleep(700);
    assert(audio2.some((s) => s.includes('想好了')), 'S7 应补念引子,实际 ' + JSON.stringify(audio2));
    assert(audio2.some((s) => s.includes('四十二')), 'S7 应补念正文,实际 ' + JSON.stringify(audio2));
    assert.strictEqual(o2.state, 'idle', 'S7 念完回 idle');
    console.log('S7 想太久→迟到补念 ✅ :', audio2.join(' / '));
  }

  console.log('\n全部 7 个场景通过。事件条数:', log.length);
}

main().then(() => process.exit(0)).catch((e) => { console.error('❌', e.message); process.exit(1); });
