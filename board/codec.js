// board/codec.js — Opus 编解码(小智协议 v1:上行 16kHz 解码,下行 24kHz 编码,60ms 帧)
// opusscript 纯 JS,单路语音 CPU 足够;真吃紧再换 @discordjs/opus(原生绑定)
const OpusScript = require('opusscript');

const FRAME_MS = 60;
const UP_RATE = 16000, DOWN_RATE = 24000;

class Codec {
  constructor() {
    this.up = new OpusScript(UP_RATE, 1, OpusScript.Application.AUDIO);
    this.down = new OpusScript(DOWN_RATE, 1, OpusScript.Application.AUDIO);
    this.upSamples = UP_RATE * FRAME_MS / 1000;      // 960
    this.downSamples = DOWN_RATE * FRAME_MS / 1000;  // 1440
    this.downBytes = this.downSamples * 2;
    this._rem = Buffer.alloc(0);                     // 下行 PCM 不足一帧的余量
  }
  // 板子上行 Opus 包 → 16k PCM(坏包返回 null,丢帧不崩)
  decodeUp(pkt) { try { return this.up.decode(pkt); } catch (e) { return null; } }
  // 24k PCM(任意长度)→ Opus 帧数组;flush 时余量补零封尾帧
  encodeDown(pcm, flush = false) {
    let buf = Buffer.concat([this._rem, pcm || Buffer.alloc(0)]);
    const frames = [];
    while (buf.length >= this.downBytes) {
      frames.push(this.down.encode(buf.slice(0, this.downBytes), this.downSamples));
      buf = buf.slice(this.downBytes);
    }
    if (flush && buf.length) {
      const pad = Buffer.alloc(this.downBytes); buf.copy(pad);
      frames.push(this.down.encode(pad, this.downSamples));
      buf = Buffer.alloc(0);
    }
    this._rem = buf;
    return frames;
  }
}

module.exports = { Codec, FRAME_MS, UP_RATE, DOWN_RATE };
