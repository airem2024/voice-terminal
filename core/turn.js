// core/turn.js — 回合编排器:整个网关唯一有状态的地方(《架构》三)
// 状态:idle → listening → thinking → speaking → idle
// 三条架构裁决(定死):
//  1. 打断 = 停播,不掐 telos turn(回合完整落历史,用户的下一句正常进对话)
//  2. 忙时新语音只排最新一条(服务端无 per-session 队列,编排器自己串行)
//  3. 她主动开口(wake_message)只在 idle 时念;忙时转角标,回 idle 再念
// 对外事件:state / face / audio{pcm,sentence,seconds} / subtitle / audio_flush /
//          thinking_cue / filler / reply / session / log
const EventEmitter = require('events');
const { SentenceChunker } = require('../tts');

const ST = { IDLE: 'idle', LISTEN: 'listening', THINK: 'thinking', SPEAK: 'speaking' };

// 填充语文案集中放这(index.js 启动预热要引用同一份,别改字面——缓存文件名是文本的 md5)
// ⚠️铁律:板子=她本人,不是转述她的设备。兜底语用她的音色放出来,一律第一人称,
// 绝不能出现"她还在想"这种旁白视角(0813 用户纠正)。
const FILLERS = {
  slow: '我还在想,想好了叫你。',
  error: '出了点状况,过会儿再叫我',
};
const LATE_PREFIX = '想好了。'; // 迟到回答的引子(和正文拼一起走正常切句,首句即它)
const TTS_LANES = 3;           // 合成流水线宽度:同时最多几句在合成(见 _speakSentence)
const TTS_RATE = 24000;        // 下行采样率(和 tts.js 的 SAMPLE_RATE 一致)

// 一句话的音频分片流:合成一边到、播放一边取。
// 0814 用户"发送语音还是会卡顿、慢":老写法 `await synth()` 等**整句合成完**才发第一个字节,
// 一句十来个字就白等 1.5-2s——可 SSE 首片 0.62-0.71s 就到了(tts.js 顶部注释早写着,
// synth 也一直留着 onChunk 回调,是我没接)。这个类把"已经到的分片"和"后续实时分片"接成
// 一条可等待的序列,所以流水线提前开跑的句子轮到它时能立刻续上,不丢已到的片。
class PcmStream {
  constructor() { this.chunks = []; this.done = false; this.waiters = []; }
  push(c) { this.chunks.push(c); this._wake(); }
  finish() { this.done = true; this._wake(); }
  _wake() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  async *read() {
    let i = 0;
    for (;;) {
      while (i < this.chunks.length) yield this.chunks[i++];
      if (this.done) return;
      await new Promise((r) => this.waiters.push(r));
    }
  }
}

// 念出来之前的语音化清洗(0813 自检):
// 1) mood 泄漏兜底——server 拦 mood 是在**累积文本**里找完整 '[mood]',标记跨 delta 时
//    '⁣[mood' 前缀已经先流出来了(assistant_text 干净、delta 不干净)。U+2063 隐形字符只做
//    mood sentinel 用,从它起一律截断;裸 '[mood' 同样截。
// 2) markdown/URL 去噪——delta 是原始 markdown,星号井号和 https:// 不该被念出来。
function sanitizeSpeech(s) {
  return String(s)
    .replace(/⁣[\s\S]*$/, '')
    .replace(/\[mood\b[\s\S]*$/, '')
    // 3) RP 场景标记行(0815 实证):她每条回复开头都是 `2026-08-15 14:59，客厅` 独占一行,
    //    切句器会把它当一句正常合成 —— 板子于是每次开口先念一串日期数字,又慢又含混。
    //    那是给文字界面看的元信息,不是她要说的话。整行删掉(删完只剩标点的句子会被
    //    _speakSentence 的"无实词"检查滤掉,不会发出空音频)。
    .replace(/^[ \t]*\d{4}-\d{2}-\d{2}[ \t　]+\d{1,2}:\d{2}[^\n]*/gm, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '，代码略。')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '，链接略，')
    .trim();
}

// ================= 板子消息格式(0815) =================
// 板子发过去的曾经是**光秃秃一句 ASR 文本**:模型既不知道此刻几点,也分不清这句是用户
// 对着板子说的、还是在 App 里打的。
// 时间为什么在这儿自己算,而不是靠 Telos 那边:bridge 的 moodTail() 确实会注入
// `系统·当前时间`,但①板子附着的会话**没开情绪** → moodTail 第一行就 return '',
// 一个字都没注入;②就算开了也不能靠 —— 它走的 clockNow() 用**全局** currentTz,而板子这条
// 连接按协议红线**不发 tz**(发了会污染 App 的全局时区),服务器自身又是 UTC(已 timedatectl 确认,
// 且铁律不许改系统时区)→ 报出来差整整 8 小时,比没有更糟。
const BOARD_TZ = 'Asia/Shanghai';

// 与 Telos server.js 的 clockNow() **同格式**(`2026-08-15 21:30 星期六 Asia/Shanghai`):
// 板子和 App 是同一个她,两边的时间不该长成两个样、还要她自己换算。
function boardClock(tz) {
  const d = new Date(), z = tz || BOARD_TZ, opt = { timeZone: z };
  try {
    const ymd = d.toLocaleDateString('en-CA', opt);
    const hm = d.toLocaleTimeString('en-GB', { ...opt, hour: '2-digit', minute: '2-digit' });
    const wk = d.toLocaleDateString('zh-CN', { ...opt, weekday: 'long' });
    return `${ymd} ${hm} ${wk} ${z}`;
  } catch (e) {   // 时区名写错也不能让整条消息发不出去 —— 宁可时间难看,不可她听不见用户说话
    const ymd = d.toLocaleDateString('en-CA');
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${ymd} ${hm} ${d.toLocaleDateString('zh-CN', { weekday: 'long' })} UTC`;
  }
}

class Orchestrator extends EventEmitter {
  constructor({ telos, tts, opts = {} }) {
    super();
    this.telos = telos;
    this.tts = tts;
    this.opts = { thinkTimeoutMs: 75000, speakTailMs: 300, ...opts };
    this.state = ST.IDLE;
    this.sessionId = this.opts.sessionId || '';
    this.voiceMode = this.opts.voiceMode || 'always'; // 'always' | 'mute'
    this.tz = this.opts.tz || BOARD_TZ;
    this.cur = null;         // 当前回合 {aborted, chunker, chain, speakSec, tFirstAudio}
    this.pendingText = null; // 裁决2:忙时只留最新一句
    this.pendingWake = null; // 裁决3:忙时攒着的主动唤醒
    // 攒着的板端事件(姿态变化等),下一条消息发出时并进标识行、然后清空。
    // P3 姿态接进来时只管往这儿 push,发送侧不用再动 —— 用户定的"和用户的话一起发过去"。
    this.pendingEvents = [];
    telos.on('wake', (m) => this._onWakeMessage(m));
  }

  // 组装真正发给模型的那条消息:标识行 + 换行 + 用户的原话。
  // 标识行**自解释**(写清是什么、谁报的),所以人格文件一个字都不用改。
  // 铁律:用户的话原样放第二行 —— 绝不把系统信息塞进她自己的句子里。
  _boardMsg(text, events) {
    const segs = ['系统·板子', boardClock(this.tz), ...(events || [])];
    const head = segs.join('｜') + (events && events.length ? '（非用户发言，板子自报）' : '（非用户发言）');
    return text ? head + '\n' + text : head;
  }

  _face(state, extra) { this.emit('face', Object.assign({ state }, extra || {})); }

  // 表情标记:只认**回复最开头**的 `[face:xxx]`(放末尾就太晚了 —— 话都说完了才切脸)。
  // 流式下这个标记会被切成好几个 delta(`[fa` + `ce:ha` + `ppy]`),所以开头先缓冲到能判定为止。
  // 两条硬约束:①一旦确定开头不是标记就**立刻放行且永不再拦**,免得把正文吞掉;
  // ②缓冲上限 24 字符,模型没写标记时最多延迟这么点就放行。
  _flushFace(cur) {
    if (cur.faceDone) return '';
    cur.faceDone = true;
    const h = cur.headBuf || ''; cur.headBuf = '';
    return h;
  }

  _takeFace(cur, s) {
    if (cur.faceDone) return s;
    cur.headBuf = (cur.headBuf || '') + s;
    const h = cur.headBuf;
    const m = /^\s*\[face:([a-z_]{2,16})\]\s*/i.exec(h);
    if (m) {
      cur.faceDone = true; cur.headBuf = '';
      this.emit('face_tag', m[1].toLowerCase());
      return h.slice(m[0].length);
    }
    // 还可能是没收全的标记前缀,继续等;否则判定为正文,放行
    if (h.length < 24 && /^\s*(\[(f(a(c(e(:[a-z_]*)?)?)?)?)?)?$/i.test(h)) return '';
    cur.faceDone = true; cur.headBuf = '';
    return h;
  }
  _setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }

  // ================= 板子输入 =================

  // 唤醒词(listen state:detect)
  onWake() {
    if (this.state === ST.SPEAK) this.onAbort();          // 说话中唤醒 = 打断
    if (this.state === ST.IDLE || this.state === ST.LISTEN) { this._setState(ST.LISTEN); this._face('listen'); }
    // thinking 中唤醒:表情保持"在想",接下来的话进 pending(见 onUtterance)
  }

  // ASR 定稿文本(listen stop 之后)
  onUtterance(text) {
    text = (text || '').trim();
    if (!text) { // 没听清:小动作示意,回 idle
      if (this.state === ST.LISTEN) { this._setState(ST.IDLE); this._face('idle', { blip: 'unheard' }); }
      return;
    }
    if (this.cur) { // 裁决2:老回合还没收尾(在想/在说/打断后收尾中),新话只留最新
      if (this.pendingText) this.emit('log', '顶掉了上一条排队语音');
      this.pendingText = text;
      if (this.state === ST.SPEAK) this.onAbort();
      else this._face('think', { ack: true });            // 轻应答:听到了,想完就轮到你
      return;
    }
    this._startTurn(text);
  }

  // 板端事件(姿态变化 / 被晃)。用户 0815 定的两条:
  //  ①**一变就先打断**,不管模型有没有出结果 —— 她正说着话你把板子拿起来了,
  //    这件事比她那句话更要紧,让她说完再反应就晚了;
  //  ②若此刻用户**也正好说了话**,两者**合并成一条消息**发,不拆成两轮。
  // ②的做法就是这个宽限窗口:先把事件攒进 pendingEvents,等一会儿 ——
  // 这期间只要有话进来,_startTurn 会自然把事件一起带走(合并);
  // 到点还没人说话,才单独为这件事起一个回合。
  onBoardEvent(desc, graceMs = 1500) {
    this.pendingEvents.push(desc);
    if (this.state === ST.SPEAK) this.onAbort();
    clearTimeout(this._evtTimer);
    this._evtTimer = setTimeout(() => {
      this._evtTimer = null;
      if (!this.pendingEvents.length) return;    // 已经被某句话带走了,不用再发
      if (this.cur || this.pendingText) return;  // 正忙着,让接下来那一轮带走
      this._startTurn('');                       // 只有姿态、没有话:单独发这一条
    }, graceMs);
  }

  // 板子打断(abort):裁决1 —— 只停播,telos turn 继续跑完落历史
  onAbort() {
    const cur = this.cur;
    if (cur) cur.aborted = true;
    this.emit('audio_flush');                             // 板端清播放缓冲
    if (this.state === ST.SPEAK) { this._setState(ST.LISTEN); this._face('listen'); }
    // 打断后必须立刻收尾,别再等老回合"估算播完"(0814 实测:用户说完话,板上聆听中干等了
    // 117 秒才开口)。_endSpeaking 的定时器是按整段音频时长排的,排定后不会因为 aborted 重算,
    // 新的话就一直压在 pendingText 里——这才是"又卡在聆听中"的真身,和固件无关。
    if (cur && cur.endTimer) { clearTimeout(cur.endTimer); cur.endTimer = null; this._finishTurn(cur, "被打断"); }
  }

  // ================= 回合 =================

  async _startTurn(text) {
    // 标识行在**这里**组装、不在 ASR 定稿处 —— 忙时新话会压在 pendingText 里排队,
    // 那时候盖的时间戳是"听到的时刻",等真发出去可能已经过了几十秒(长回合甚至几分钟)。
    // 攒着的板端事件也在这一刻并进来、随即清空,免得下一轮把同一件事再报一遍。
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const payload = this._boardMsg(text, events);
    this.emit('log', '发给模型:' + JSON.stringify(payload));
    this._setState(ST.THINK);
    const cur = this.cur = { aborted: false, timedOut: false, chunker: new SentenceChunker(), chain: Promise.resolve(), jobs: [], speakSec: 0, tFirstAudio: 0, nSent: 0 };
    const onStart = () => { if (this.cur === cur) { this._face('think'); this.emit('thinking_cue'); } };
    const onDelta = (s) => {
      if (this.cur !== cur || this.voiceMode !== 'always') return;
      s = this._takeFace(cur, s);   // 剥掉开头的 [face:xxx],别让它被念出来
      if (!s) return;
      for (const sent of cur.chunker.feed(s)) this._speakSentence(cur, sent);
    };
    this.telos.once('turn_start', onStart);
    this.telos.on('delta', onDelta);
    const thinkTimer = setTimeout(() => {
      if (this.cur === cur && this.state === ST.THINK) { cur.aborted = true; cur.timedOut = true; this._fail(cur, FILLERS.slow); }
    }, this.opts.thinkTimeoutMs);
    try {
      const r = await this.telos.say(payload, this.sessionId);
      if (!this.sessionId && r.sessionId) { this.sessionId = r.sessionId; this.emit('session', r.sessionId); }
      if (this.cur === cur && this.voiceMode === 'always') {
        // 收尾前把还压在 headBuf 里的开头残留放出来 —— 否则很短的回复(或以 '[' 开头
        // 但不是 face 标记的回复)会被那点缓冲整个吞掉,一个字都念不出来。
        const head = this._flushFace(cur);
        if (head) for (const sent of cur.chunker.feed(head)) this._speakSentence(cur, sent);
        for (const sent of cur.chunker.flush()) this._speakSentence(cur, sent);
      }
      // 想太久超时(填充语已承诺"想好了我叫你"):迟到的回答复用主动开口通道——idle 就念,忙就攒着。
      // 只限 timedOut;被用户打断(aborted 而非 timedOut)的迟到内容不念,打断=不想听了。
      if (cur.timedOut && this.voiceMode === 'always' && (r.text || '').trim()) {
        this._onWakeMessage({ sessionId: this.sessionId, text: LATE_PREFIX + r.text });
      }
      this.emit('reply', r);                              // 文本层(字幕历史/日志),静音模式也有
      // 一个字都没拿到 = 出事了(0814 事故:模型 1M 变体撞 out-of-credits,桥重试三次全空)。
      // 老写法这时静悄悄收场,板上只响过思考音,用户以为是板子坏了——必须出声说一句。
      if (!cur.aborted && !cur.nSent && !(r.text || '').trim()) { this._fail(cur, FILLERS.error); return; }
      await cur.chain;
      this._endSpeaking(cur);
    } catch (e) {
      // superseded 在网关组合里到不了这(只有 cur==null 时才会新 say),但真到了也得清 cur,
      // 否则 cur 悬死、后续语音全进 pendingText 永不 drain
      if (e.message === 'superseded') { if (this.cur === cur) { this.cur = null; this._drain(); } }
      else if (this.cur === cur) this._fail(cur, FILLERS.error);
      this.emit('log', 'turn 失败: ' + e.message);
    } finally {
      clearTimeout(thinkTimer);
      this.telos.removeListener('delta', onDelta);
      this.telos.removeListener('turn_start', onStart);
    }
  }

  _speakSentence(cur, raw) {
    const sent = sanitizeSpeech(raw);
    if (!/[\p{L}\p{N}]/u.test(sent)) return;  // 清洗后没实词(mood 残片/纯符号)就不合成
    cur.nSent++;
    // 合成流水线(0814 用户:"语音还是不够流畅"):老写法等前一句播完才去合成下一句,
    // 每句之间白白空出一次 TTS 往返(~0.7s)。改成提前开跑、输出仍按 chain 保序;
    // 同时最多 TTS_LANES 句在合成(第 N 句等第 N-LANES 句合完再启动),免得长回答一次打爆 DashScope。
    const prev = cur.jobs.length >= TTS_LANES ? cur.jobs[cur.jobs.length - TTS_LANES] : null;
    const st = new PcmStream();
    const job = (prev ? prev.catch(() => {}) : Promise.resolve())
      .then(() => this.tts.synth(sent, (c) => st.push(c)))          // ← 边合成边喂,不再等整句
      .then((r) => { st.finish(); return r; },
            (e) => { st.finish(); this.emit('log', 'tts 失败: ' + e.message); return null; });
    cur.jobs.push(job);
    // 播放仍按 chain 严格保序:轮到这句才开始取它的分片,后面的句子就算先合成好也得等。
    cur.chain = cur.chain.then(async () => {
      if (cur.aborted || this.cur !== cur) return;
      let sawAudio = false;
      for await (const c of st.read()) {
        if (cur.aborted || this.cur !== cur) return;
        const first = !sawAudio;
        if (first) {
          sawAudio = true;
          if (this.state === ST.THINK) { this._setState(ST.SPEAK); this._face('speak'); }
          if (!cur.tFirstAudio) cur.tFirstAudio = Date.now();
          this.emit('subtitle', sent);
        }
        const sec = c.length / (TTS_RATE * 2);
        cur.speakSec += sec;
        this.emit('audio', { pcm: c, sentence: first ? sent : null, seconds: sec });
      }
      const r = await job;
      // 回落:一个分片都没流出来但整句 pcm 是好的(TTS 实现不给 onChunk / 测试桩),按老路整句发,
      // 别因为流式化就把声音弄丢了。
      if (!sawAudio && r && r.pcm && r.pcm.length && !cur.aborted && this.cur === cur) {
        sawAudio = true;
        if (this.state === ST.THINK) { this._setState(ST.SPEAK); this._face('speak'); }
        if (!cur.tFirstAudio) cur.tFirstAudio = Date.now();
        this.emit('subtitle', sent);
        cur.speakSec += r.seconds;
        this.emit('audio', { pcm: r.pcm, sentence: sent, seconds: r.seconds });
      }
      // 该句收尾:让编码器把不足一帧的余量补齐封尾(合成失败没出过声就别发,
      // 否则 index.js 会被这条空事件误置成 speaking)
      if (sawAudio && !cur.aborted && this.cur === cur) this.emit('audio', { pcm: null, end: true, seconds: 0 });
    }).catch((e) => this.emit('log', 'tts 播放失败: ' + e.message));
  }

  // 合成链走完 ≠ 播完:按累计音频时长估播完时刻(真板接入后可换成缓冲反馈)
  _endSpeaking(cur) {
    const waitMs = (cur.aborted || !cur.tFirstAudio) ? 0
      : Math.max(0, cur.tFirstAudio + cur.speakSec * 1000 + this.opts.speakTailMs - Date.now());
    // 0815 用户"说着话还卡,卡了之后直接返回待命":板子回待命的路不止一条,不装表就只能猜。
    // 这条报的是"按音频总时长估的收尾时刻"——**估短了就会在她还在说的时候把回合收掉**。
    this.emit('log', `收尾定时:音频共 ${cur.speakSec.toFixed(1)}s,${(waitMs / 1000).toFixed(1)}s 后转待命`);
    cur.endTimer = setTimeout(() => { cur.endTimer = null; this._finishTurn(cur, '估算播完'); }, waitMs);
  }

  _finishTurn(cur, why) {
    if (this.cur !== cur) return;
    this.cur = null;
    if (this.state !== ST.LISTEN) {
      this.emit('log', `回合收尾 → 待命(${why || '未标注'})`);
      this._setState(ST.IDLE); this._face('idle');
    } // 打断后停在 listening
    this._drain();
  }

  _fail(cur, fillerText) {
    if (this.cur !== cur) return;
    this.cur = null;
    this.emit('log', `回合失败 → 待命(${cur.timedOut ? '想太久超时' : '出错/空回复'})`);
    this._face('confused');
    if (this.voiceMode === 'always') this.emit('filler', fillerText); // 预生成填充语,由外层播
    this._setState(ST.IDLE);
    setTimeout(() => { if (this.state === ST.IDLE && !this.cur) this._face('idle'); }, 1500);
    this._drain();
  }

  _drain() {
    if (this.pendingText) { const t = this.pendingText; this.pendingText = null; this._startTurn(t); return; }
    if (this.pendingWake) { const m = this.pendingWake; this.pendingWake = null; this._onWakeMessage(m); }
  }

  // ================= 她主动开口 =================

  _onWakeMessage(m) {
    // 只念附着对话的;未附着(sessionId 还空着)一律不念——wake_message 是全量广播,
    // 别的对话到点唤醒(心跳/日记/守夜)全会飘过来,老写法在未附着时会照单全念(0813 自检)
    if (!this.sessionId || m.sessionId !== this.sessionId) return;
    if (this.state !== ST.IDLE || this.cur) { this.pendingWake = m; this._face(this.state, { badge: 'wake' }); return; }
    const text = (m.text || '').trim();
    if (!text || this.voiceMode !== 'always') return;
    const cur = this.cur = { aborted: false, chunker: new SentenceChunker(), chain: Promise.resolve(), jobs: [], speakSec: 0, tFirstAudio: 0, nSent: 0 };
    this._setState(ST.SPEAK); this._face('speak');
    const sents = cur.chunker.feed(text).concat(cur.chunker.flush());
    for (const sent of sents) this._speakSentence(cur, sent);
    cur.chain.then(() => this._endSpeaking(cur));
  }
}

module.exports = { Orchestrator, ST, FILLERS, sanitizeSpeech };
