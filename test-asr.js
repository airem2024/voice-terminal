// test-asr.js — ASR 闭环自测:TTS 合成一句(用 config.json 里的音色)→ 24k→16k 重采样 → Paraformer 识别 → 对比
const fs = require('fs');
const path = require('path');
const { QwenTTS } = require('./tts');
const { recognizePcm16k, resample24to16 } = require('./asr');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TEXT = process.argv[2] || '帮我看看今天下午有什么安排?';

(async () => {
  console.log('合成测试音频:', TEXT);
  const t = await new QwenTTS({ voice: cfg.voice, envPath: cfg.dashscopeEnvFile }).synth(TEXT);
  console.log(`  ${t.seconds.toFixed(2)}s 音频,合成 ${t.tTotal}ms`);
  const pcm16 = resample24to16(t.pcm);
  console.log('开始识别(实时节奏喂入)…');
  const t0 = Date.now();
  const r = await recognizePcm16k(pcm16);
  console.log(`识别结果: ${r.text}`);
  console.log(`  耗时 ${Date.now() - t0}ms(含实时喂入 ${t.seconds.toFixed(1)}s),中间结果 ${r.partials.length} 次`);
  const norm = (s) => s.replace(/[,。?!、,.?! ]/g, '');
  const a = norm(TEXT), b = norm(r.text);
  const hit = b && (a.includes(b) || b.includes(a) || overlap(a, b) > 0.7);
  function overlap(x, y) { let n = 0; for (const c of new Set(x)) if (y.includes(c)) n++; return n / new Set(x).size; }
  console.log(hit ? '✅ 与原文吻合' : '⚠️ 与原文差异较大,人工看一眼');
  process.exit(hit ? 0 : 2);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
