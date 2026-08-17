// test-board.js — 模拟板子走完全链路(需网关 index.js 已在跑):
//   hello 握手 → 唤醒词 → 流式上传一句话(Opus 16k) → 收 stt/emotion/tts 事件与音频帧 → 落 received.wav
// 测试语音用 config.json 里配的音色 TTS 合成(24k→16k 重采样→Opus),自产自收。
const fs = require('fs');
const path = require('path');
const OpusScript = require('opusscript');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const { QwenTTS, writeWav } = require('./tts');
const { resample24to16 } = require('./asr');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SAY = process.argv[2] || '请用一句话回答,你现在能听到我说话吗?';
const t0 = Date.now();
const T = () => String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5) + 's';

(async () => {
  console.log(T(), '合成测试语音:', SAY);
  const synth = await new QwenTTS({ voice: cfg.voice, envPath: cfg.dashscopeEnvFile }).synth(SAY);
  const pcm16 = resample24to16(synth.pcm);
  const enc = new OpusScript(16000, 1, OpusScript.Application.AUDIO);
  const frames = [];
  for (let off = 0; off + 1920 <= pcm16.length; off += 1920) frames.push(enc.encode(pcm16.slice(off, off + 1920), 960));
  console.log(T(), `上行准备完毕:${frames.length} 帧(${(frames.length * 0.06).toFixed(1)}s)`);

  const dec = new OpusScript(24000, 1, OpusScript.Application.AUDIO);
  const rx = [];
  let ttsStopped = false;

  const ws = new WebSocket('ws://127.0.0.1:' + (cfg.boardPort || 8791), {
    // Device-Id 必须是白名单里的 MAC(config.json 的 deviceAllow),否则网关按未知设备拒掉
    headers: { Authorization: 'Bearer ' + cfg.boardToken, 'Device-Id': (cfg.deviceAllow || [])[0] || '', 'Client-Id': 'mock-board-1' },
  });
  ws.on('error', (e) => { console.error(T(), 'ws error:', e.message); process.exit(1); });
  ws.on('open', () => {
    console.log(T(), '已连接网关,发 hello');
    ws.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket',
      audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
  });
  ws.on('message', async (data, isBinary) => {
    if (isBinary) { try { rx.push(dec.decode(data)); } catch (e) {} return; }
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (m.type === 'hello') {
      console.log(T(), '服务端 hello,下行', m.audio_params.sample_rate + 'Hz;开始说话');
      ws.send(JSON.stringify({ type: 'listen', state: 'detect', text: '唤醒词' }));
      ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
      for (const f of frames) { ws.send(f, { binary: true }); await new Promise((r) => setTimeout(r, 55)); }
      ws.send(JSON.stringify({ type: 'listen', state: 'stop' }));
      console.log(T(), '说完(listen stop),等她…');
    } else if (m.type === 'stt') console.log(T(), '[字幕·我]', m.text);
    else if (m.type === 'llm') console.log(T(), '[表情]', m.emotion);
    else if (m.type === 'tts') {
      console.log(T(), '[tts]', m.state, m.text ? '「' + m.text.slice(0, 24) + '…」' : '');
      if (m.state === 'start' && !rxFirstAt) rxFirstAt = Date.now();
      if (m.state === 'stop' && rx.length) {
        if (ttsStopped) return; ttsStopped = true;
        const pcm = Buffer.concat(rx);
        writeWav(path.join(__dirname, 'received.wav'), pcm);
        console.log(T(), `✅ 收到 ${rx.length} 帧 / ${(pcm.length / 48000).toFixed(1)}s 音频 → received.wav`);
        console.log(T(), `首帧到达=${((rxAudioAt - t0) / 1000).toFixed(1)}s(相对开始)`);
        process.exit(0);
      }
    }
  });
  let rxFirstAt = 0, rxAudioAt = 0;
  ws.on('message', (d, isBin) => { if (isBin && !rxAudioAt) rxAudioAt = Date.now(); });
  setTimeout(() => { console.error(T(), '超时'); process.exit(1); }, 150000);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
