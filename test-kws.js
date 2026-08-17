// 模型目录跟网关走同一份配置(config.json 的 wakeWord.dir),别在这儿再写一次路径
const sherpa = require('sherpa-onnx-node');
const fs = require('fs');
const path = require('path');
const _cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { return {}; } })();
const _w = _cfg.wakeWord || {};
const DIR = _w.dir || path.join(require('os').homedir(), 'kws-model');
const M = path.join(DIR, _w.model || 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01');
const B = `${M}/%s-${_w.ckpt || 'epoch-12-avg-2-chunk-16-left-64'}.onnx`;
const kws = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: B.replace('%s', 'encoder'),
      decoder: B.replace('%s', 'decoder'),
      joiner: B.replace('%s', 'joiner'),
    },
    tokens: `${M}/tokens.txt`, numThreads: 1, provider: 'cpu', debug: 0,
  },
  maxActivePaths: 4, keywordsScore: 1.0, keywordsThreshold: 0.25, numTrailingBlanks: 1,
  keywordsFile: path.join(DIR, _w.keywords || 'keywords.txt'),
});
for (const f of process.argv.slice(2)) {
  const w = sherpa.readWave(f);            // {samples: Float32Array, sampleRate}
  const st = kws.createStream();
  const step = Math.floor(w.sampleRate / 10);
  const hits = [];
  for (let i = 0; i < w.samples.length; i += step) {
    st.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples.subarray(i, i + step) });
    while (kws.isReady(st)) { kws.decode(st); const r = kws.getResult(st); if (r && r.keyword) hits.push([(i + step) / w.sampleRate, r.keyword]); }
  }
  st.acceptWaveform({ sampleRate: w.sampleRate, samples: new Float32Array(w.sampleRate * 0.5) });
  while (kws.isReady(st)) { kws.decode(st); const r = kws.getResult(st); if (r && r.keyword) hits.push([w.samples.length / w.sampleRate, r.keyword]); }
  console.log(f.split('/').pop().padEnd(22), (w.samples.length / w.sampleRate).toFixed(1) + 's',
    hits.length ? hits.map(([t, k]) => `[${t.toFixed(1)}s ${k}]`).join(' ') : '—— 没检出');
}
