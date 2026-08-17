// test-wake.js — 服务端唤醒词的**全链路**离线验证
//
// 关键在"全链路"三个字:之前所有 KWS 测试喂的都是无损 wav,而板子上行是 **Opus 有损压缩**的。
// 这里按板子的真实做法走一遍 —— 16k PCM → Opus 编码(60ms 帧) → codec.decodeUp() → wake.feed()。
// 压缩掉的那部分频谱会不会让唤醒词认不出来,只有这么测才知道。
//
// 用法: node test-wake.js <16kHz的.wav> ...
const fs = require('fs');
const OpusScript = require('opusscript');
const { Codec } = require('./board/codec');
const { WakeWord } = require('./wake');

const FRAME = 960;                    // 60ms @ 16kHz,和板子一帧一致
const enc = new OpusScript(16000, 1, OpusScript.Application.AUDIO);
const codec = new Codec();

const w = new WakeWord(process.env.WAKE_DIR ? { dir: process.env.WAKE_DIR } : {});
const err = w.start();
if (err) { console.error('起不来:', err); process.exit(1); }
console.log(`唤醒词「${w.keyword}」\n`);

let pass = 0, fail = 0;
for (const f of process.argv.slice(2)) {
  const raw = fs.readFileSync(f);
  const pcm = raw.subarray(44);       // 跳过 wav 头(这些文件都是标准 44 字节头)
  const hits = [];
  for (let i = 0; i + FRAME * 2 <= pcm.length; i += FRAME * 2) {
    const pkt = enc.encode(pcm.subarray(i, i + FRAME * 2), FRAME);   // ← 板子做的事
    const back = codec.decodeUp(pkt);                                // ← 网关做的事
    if (!back) continue;
    const kw = w.feed(back);
    if (kw) hits.push(((i / 2 + FRAME) / 16000).toFixed(1) + 's');
  }
  // 补 0.5s 静音把最后一帧冲出来。**这不是作弊** —— 真实场景里用户说完唤醒词总要停一下,
  // 静音帧照常一帧帧进来;而 wav 文件是说完就戛然而止的。漏了这步召回会假摔到 3/8(踩过)。
  const sil = Buffer.alloc(FRAME * 2);
  for (let k = 0; k < 8; k++) { const kw = w.feed(sil); if (kw) hits.push('尾'); }
  const name = f.split('/').pop();
  const want = name.startsWith('p');   // p* = 该唤醒, n* = 不该唤醒
  const got = hits.length > 0;
  const ok = want === got;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(10)} ${want ? '该唤醒' : '不该唤醒'} → ` +
              (got ? `唤醒 @${hits.join(',')}` : '没唤醒'));
  w.reset();                           // 每条独立,别让上一条的解码状态漏过来
}
console.log(`\n对 ${pass} 条,错 ${fail} 条`);
