// index.js — 语音终端网关总装(《架构》二)
// 板子(小智协议 :8791) ↔ 编排器 ↔ telos(:8790) + DashScope(ASR/TTS)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TelosClient = require('./telos-client');
const { QwenTTS } = require('./tts');
const { AsrStream } = require('./asr');
const { Orchestrator, FILLERS } = require('./core/turn');
const { BoardServer } = require('./board/server');
const { Codec, FRAME_MS } = require('./board/codec');
const { WakeWord } = require('./wake');

// 日志时间戳按 UTC+8 打(0815 用户要的)。系统时区仍是 UTC、不动——
// 心跳 cron(`0 3,8,13,22`)是按 UTC 换算成京时配的,改系统时区会把那些点全打乱。
// 用 let 而不是常量:cfg 要到下面才加载,加载完再覆盖(见 TZ_MIN = ... 那行)。
let TZ_MIN = 480;
const log = (...a) => console.log(new Date(Date.now() + TZ_MIN * 60000).toISOString().slice(11, 19), ...a);

// ---- 配置(gitignored;首启生成 boardToken) ----
const CFG_PATH = path.join(__dirname, 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) {}
if (!cfg.boardToken) {
  cfg = Object.assign({ boardPort: 8791, boardToken: crypto.randomBytes(16).toString('hex'), deviceAllow: [], voiceMode: 'always' }, cfg);
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  log('已生成 config.json(含 boardToken,刷板子固件时要用)');
}
TZ_MIN = Number(cfg.tzOffsetMin ?? 480);   // 配置里能改;同一个值也下发给板子(board/server.js)

const STATE_PATH = path.join(__dirname, 'state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
const saveState = () => { // 原子写(mood.json 裸 writeFileSync 是我们自己点过名的毛病,别重蹈)
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
};

// ---- 模块 ----
// 不配 cfg.model 就**不带 model**,让 bridge 回落到本对话记住的 pref(server.js 的 `_pref.model`,
// 那段注释直接点名了本网关)——板子和手机端因此永远同一个模型,用户在 App 里给这个对话选什么,
// 板子就跟着走。配了 cfg.model 则钉死不动摇(留给"就要板子单独用某个模型"的场合)。
const telos = new TelosClient({ model: cfg.model || '' });
// voice/dashscopeEnvFile 都在 config.json 里(见 config.example.json)——音色 id 跟账号绑,
// key 按量计费,两个都不该躺在代码里。不配 voice 就用官方公开音色,能出声但不是她的声音。
const tts = new QwenTTS({ voice: cfg.voice, envPath: cfg.dashscopeEnvFile });
// DashScope 瞬时限流(429)时 tts.js 会自己退避重试。这里只是让它现形 ——
// 0816 一晚上撞了 15 次、每次都是整句没声音,而日志里只有一行「tts 失败」,
// 看着像板子坏了。重试成功就不该再有人怀疑硬件。
tts.onRetry = (n, msg) => log(`[tts] 被限流,第 ${n} 次退避重试 — ${String(msg).slice(0, 80)}`);
// tz:板子报给模型的时间用哪个时区。服务器本身是 UTC 且铁律不许改系统时区,所以板子这边
// 自己带 —— 缺省 Asia/Shanghai(用户和板子都在这儿),搬家或出门带着它时改 config 即可。
const orch = new Orchestrator({ telos, tts, opts: { sessionId: state.sessionId || '', voiceMode: cfg.voiceMode, tz: cfg.tz } });
const board = new BoardServer(cfg);
const codec = new Codec();

telos.on('log', (s) => log('[telos]', s));
telos.on('ready', () => log('[telos] 已连接(headless)'));
board.on('log', (s) => log('[board]', s));
orch.on('log', (s) => log('[orch]', s));
orch.on('session', (sid) => { state.sessionId = sid; saveState(); log('[orch] 附着对话:', sid); });
orch.on('reply', (r) => log(`[orch] 回合完成 cost=$${r.cost} 首delta=${r.timings.firstDelta}ms`));

// ---- 下行播放泵:PCM 句子 → Opus 帧队列 → 按节奏下发 ----
// 配速铁律(0814 真板"数数案"):恒定快于实时会灌爆板端音频队列——长回答越播越乱
// (截断/跳段/最后加速)。正确节奏 = 开头允许领先 PREBUF 毫秒突发垫底,之后锁死实时。
const q = [];
let pumping = false, speaking = false;
let clock = 0;        // 发送时间轴:下一帧的应发时刻
let lastSpeakEnd = 0; // 最后一次停止播放的时刻(上行 VAD 的自听冷却基准)
// 允许领先实时的上限 = 板端垫底缓冲(稳态下板子解码队列里就堆着这么多音频)。
// 0815 查官方固件源码定死此值,不再靠猜:
//   audio_service.h:42  MAX_DECODE_PACKETS_IN_QUEUE = 2400 / OPUS_FRAME_DURATION_MS  → 40 帧 = **2400ms**
//   application.cc:531  PushPacketToDecodeQueue(packet)  ← wait 默认 false,**队列满就静默丢包**
//                       (返回 false,调用方连查都不查)
// 于是两头都是硬墙:超过 2400ms 的部分被板子直接丢弃 —— 这才是 0814"数数案"(长回答截断/跳段)
// 的真身,不是我当时以为的"灌爆队列越播越乱";而低于网络抖动幅度就会断音(用户说的"说话卡")。
// 之前 480→700 的调法治了跳段却加重了断音,两个病本是同一个源头。
// ⚠️0815 实测打脸:装上 bufferedAmount 仪表后,下行积压**全程 0B**(1084 帧无一积压)——
// 网络根本不堵,断音不是网络抖动造成的。而 1800ms=30 帧、距 40 帧硬上限只剩 10 帧余量,
// 板子解码慢一拍就丢包 → 用户立刻报"语音不清晰"(这才是真·数数案的复现条件)。
// **回到 700**(11.7 帧,余量 28 帧)。结论:队列上限是丢包的墙,但抗抖动不是我们的瓶颈,
// 别拿余量去换根本不存在的网络抖动。
let PREBUF = Number(cfg.prebufMs) || 700;
let _underrun = 0, _underrunMs = 0;  // 本轮欠载次数/总时长(卡顿的量化指标)
function stopSpeaking() {
  // 每轮播完报一次这轮听到的最大能量:没人插话那几轮 = AEC 残留水平(打断门槛的硬下限);
  // 有插话那轮 = 用户插话实际多响。之前诊断在 speaking 期间直接 return,这段是瞎的。
  if (_bargeSamples.length) {
    const s = _bargeSamples.sort((a, b) => a - b);
    const q = (r) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * r))]);
    // 窗口命中峰值 = 这轮里"最近12帧内最多有几帧过线"。用户插话那轮它应该逼近 12,
    // 没人说话那轮应该很低 —— 两者的距离就是打断门槛的可用区间,不必再猜。
    log(`[audio] 播报期RMS p50=${q(0.5)} p90=${q(0.9)} max=${q(1)} (${s.length}帧,门槛${BARGE_RMS})` +
        ` 窗口命中峰值=${_bargeHot}/${BARGE_WIN}(需${BARGE_HITS})`);
    _bargeSamples = [];
  }
  _bargePeak = 0; _bargeHot = 0; _bargeWin.length = 0;
  if (_underrun) { log(`[audio] 本轮欠载 ${_underrun} 次 共 ${_underrunMs}ms(垫底 ${PREBUF}ms)`); _underrun = 0; _underrunMs = 0; }
  board.reportLag();
  // clock 必须跟着归零(0815 用户"还是卡"):它只在 audio_flush/断连时清,停播时不清 ——
  // 于是下一轮第一帧撞上 `clock < now`,把**两轮之间的空闲时长**记成一次欠载。
  // 日志里那些 93210ms/66274ms/51635ms 全是空闲间隔,不是卡顿。等于每轮必报一次假阳性,
  // 真实的播放中断从来没被记录过 —— 我一直照着这份假数据调参数。
  clock = 0;
  _framePos = 0; _frameSent = 0;
  board.tts('stop'); speaking = false; lastSpeakEnd = Date.now();
  // 帧号清了,但没放完的块还在 —— 交给 drain 按最短显示时间接着放完再收工
  if (cues.length && !_drainTimer) _drainTimer = setTimeout(drainCues, Math.max(400, SUB_MIN_SHOW_MS));
}
// 字幕挂帧(0816):cues[i].at = 这句字幕该跟着第几帧出去。
// 两个计数器都只在回合结束/打断时归零 —— 中途清零会让还没发的 cue 错位。
const cues = [];
let _framePos = 0;    // 累计入队了多少帧
let _frameSent = 0;   // 累计发出去多少帧
function resetCues() {
  cues.length = 0; _framePos = 0; _frameSent = 0;
  if (_drainTimer) { clearTimeout(_drainTimer); _drainTimer = null; }
}
function pump() {
  if (pumping) return; pumping = true;
  (async () => {
    while (q.length) {
      const now = Date.now();
      // clock < now = 该发的时刻已经过了、音频却没供上 = **欠载**:板端缓冲放空、声音断一下。
      // 统计它就能把"卡顿"量化,区分两种病:欠载多=供不上(合成/网络跟不上);
      // 欠载 0 却still觉得慢=纯首字延迟,那是另一回事。
      if (clock < now) {
        if (clock) { _underrun++; _underrunMs += now - clock; }
        clock = now;                            // 断流后重置:重新获得突发额度
      }
      const ahead = clock - now;
      if (ahead > PREBUF) await new Promise((r) => setTimeout(r, ahead - PREBUF));
      // 字幕跟着**这一帧**走:挂在已发帧号上的都到点了,发完再发音频,字和声同时出门。
      while (cues.length && cues[0].at <= _frameSent) {
        const c = cues.shift();
        board.tts('sentence_start', c.text);
        if (c.face) faceBySentence(c.face);
      }
      board.sendAudio(q.shift());
      _frameSent++;
      clock += FRAME_MS;
    }
    pumping = false;
    // 🔴0815 三次修正:这里**绝对不能** clock = 0(前两版都栽在这)。
    // TTS 是按句合成的,句与句之间队列必然排空一次;清零 = 下一句进来时 `clock < now` 成立、
    // 重新拿到一整份 PREBUF 突发额度。一段话五六句就突发五六次,累积超前三四秒 ≈ 60 帧,
    // 而板子解码队列上限只有 40 帧(2400/60),`PushPacketToDecodeQueue` 的 wait=false 让溢出
    // **静默丢包**、调用方连返回值都不查 —— 听感就是"话被跳着很快说完"(用户 0815 实听)。
    // 实测:284 帧(17.0s 音频)16s 推完、224 帧(13.4s)12s 推完,快 6~12%,正是突发累积的量。
    // 走 CF 隧道时链路慢、把突发平滑掉了所以没暴露;直连后帧准时到达,当场显形。
    // clock 只在**回合真结束**时归零 —— 那件事 stopSpeaking() 已经做了(它才是新起点)。
    // 至于欠载统计:句间空档若真让 clock 落到 now 之后,板子那一刻确实断了音,记成欠载是**对的**。
    // 但**回合之间**的空闲(等用户说话/等模型思考)不算 —— 那段板子本来就该是静的。
    // 所以这里按 speaking 分流:还在说话 = 句间空档,时间轴保持连续(不清零,防突发累积);
    // 已经不说了 = 回合结束,清零好让下一轮第一帧不被记成假欠载(9019ms/7687ms 那两条就是它)。
    if (!speaking) clock = 0;
    if (speaking && !orch.cur) stopSpeaking();
  })();
}
// pcm 现在是**一句话里的一个分片**(turn.js 流式化后),不再是整句:
// 只有句尾那条(end=true)才 flush 补零封尾,中间分片留余量给下一片接上,免得每片都补零 = 咔哒声。
function enqueuePcm(pcm, sentence, end) {
  if (!speaking) { speaking = true; board.tts('start'); resetCues(); }
  // 🔴0816「配合不上语音」的真凶就在这一行原来的位置:字幕以前是**入队时**就发出去的,
  // 可这批音频还得排在队列后面等前面的播完 —— 于是字幕永远跑在声音前面,
  // 领先量正好等于队列里积压的时长(一段话说到后面能差好几秒)。
  // 调慢停留治不了这个:每块都提前跳,慢下来只是让最后一块多停会儿。
  // 改成把字幕**挂在它自己那一帧上**,pump 推到那帧时才发,字和声音就对上了。
  if (sentence) queueSubtitle(sentence, _framePos);
  for (const f of codec.encodeDown(pcm, !!end)) { q.push(f); _framePos++; }
  pump();
}
orch.on('audio', (a) => enqueuePcm(a.pcm, a.sentence, a.end));
orch.on('audio_flush', () => { q.length = 0; clock = 0; resetCues(); if (speaking) stopSpeaking(); });
// 板断连:清残留帧+作废识别会话(重连后旧积累别灌进对话)。
// **断在说话中途是有后果的**——队列里没播的音频全丢,板子那头声音戛然而止、屏幕回待命,
// 而回合还在 telos 那边跑完、落进历史。用户会看到"说着说着卡住然后回待命",所以这里必须报出来。
board.on('disconnect', () => {
  if (speaking || q.length) {
    log(`[board] ⚠️断在说话中途:丢弃未播音频 ${q.length} 帧(${(q.length * FRAME_MS / 1000).toFixed(1)}s)` +
        `${orch.cur ? ',回合仍在跑' : ''}`);
  }
  q.length = 0; clock = 0; speaking = false; boardListening = false; preRoll.length = 0;
  if (asr) { const old = asr; asr = null; try { old.finish(); } catch (e) {} }
});
orch.on('state', (s) => {
  log('[orch] 状态:', s);
  if (s === 'idle' && speaking && !q.length && !pumping) stopSpeaking();
  if (s === 'idle') awakeAt = Date.now();   // 一轮说完才开始算静默,别让思考+播报的时间吃掉激活期
});
// 看门狗:speaking 悬空就强制收尾(0815 用户"又卡说话中")。
// stopSpeaking 原本只有两条路——pump 发完、或状态转 idle——而 _finishTurn 在**打断后会停在
// listening、根本不发 idle**,那一路的 pump 又早跑完了,于是 speaking 永远是 true、
// 板上永远显示"说话中",只能重启。两条路都漏时由这里兜底。
// 🔴0815 撤掉「回合未结束但音频排空就收口」那条分支(用户:"说着话还卡,卡了之后直接返回待命")。
// 它本是为"她说到一半去调工具、十几秒不吭声"设计的,可它**分不清"去调工具了"和
// "正常说话中的一次停顿"** —— 模型出词有波动、某句 TTS 慢一点,队列空过 2 秒它就 stopSpeaking(),
// 而 stopSpeaking 会发 board.tts('stop'):板子当场结束说话状态、屏幕回待命,她的话就这么被掐断。
// 回合其实还在跑,后面的音频到了又 tts('start') —— 于是"说着说着卡一下、退回待命、再重新开口"。
// **调工具期间要能插话,现在由打断机制负责**(barge 判据已从"连续N帧"改成滑动窗口,正常说话就能触发),
// 不需要再拿一个定时器去猜她是不是说完了。这里只保留真正安全的那条:回合已经结束、speaking 却悬空。
setInterval(() => {
  const drained = speaking && !pumping && !q.length;
  if (!drained) return;
  if (!orch.cur) {
    log('[board] 看门狗:说话状态悬空,强制收尾');
    stopSpeaking();
  }
}, 1000).unref?.();
/* 撤下的中途收口(留档,别再加回来 —— 它掐断的是正常说话):
  if (!_drainedAt) { _drainedAt = Date.now(); return; }
  if (Date.now() - _drainedAt > 2000) {
    // 0815 用户"还是有概率卡聆听中":收口前必须确认这一轮**已经出过真实回复音频**。
    // thinking_cue 的思考音也走 enqueuePcm —— 它 1.5 秒播完、队列就空,老逻辑再等 2 秒
    // 就把"还在等模型首字"误判成"在调工具"(日志 14:23:46 thinking → 14:23:49 收口,
    // 那轮工具数为 0),tts('stop') 把板子踢回聆听中、表情变回待机,用户这时说的话
    // 又和随后到达的回复撞在一起 —— 就是她说的"表情变回待机然后说话输入不进去"。
    // cur.tFirstAudio 只由 turn.js 的**真实回复音频**置位,思考音/垫场音不经过它,正好当判据。
    // 不重置 _drainedAt:等首字期间每拍都在这返回,首字一到 q 就有货、drained 自然变 false。
    if (!orch.cur.tFirstAudio) return;
    log('[board] 音频排空但回合未结束(多半在调工具),先收口让她能说话');
    stopSpeaking();
    lastSpeakEnd = Date.now() - SELF_HEAR_MS + 300; // 喇叭早不响了,不必再等满自听冷却
    _drainedAt = 0;
  }
*/

// ---- 表情(M1:三态搭标准 llm emotion 的车;M2 换 custom 眼睛参数) ----
// 状态机基础表情:表达"在做什么"(听/想/说)。
const FACE_EMO = { idle: 'neutral', listen: 'winking', think: 'thinking', speak: 'happy', confused: 'confused' };
// 说话时按句子内容切脸(0815):板子有 21 张表情,原先只用到上面这 5 张,其余 16 张从没露过面。
// 规则只认**强信号**,匹配不到就保持当前表情 —— 宁可脸不动,也别每句话乱跳。
// 数组顺序即优先级(先命中的赢),所以具体的、语气重的放前面。
const EMO_RULES = [
  [/哈哈|笑死|太逗|好玩/, 'laughing'],
  [/呜呜|哭了|想哭/, 'crying'],
  [/抱歉|对不起|不好意思/, 'embarrassed'],
  [/难过|遗憾|可惜/, 'sad'],
  [/生气|讨厌|烦死|气死/, 'angry'],
  [/吓|不会吧|糟糕|完蛋/, 'shocked'],
  [/居然|竟然|哇|天呐|没想到|真的吗/, 'surprised'],
  [/喜欢|爱你|想你|抱抱|亲亲/, 'loving'],
  [/困|想睡|晚安|睡吧|早点休息/, 'sleepy'],
  [/厉害|好酷|牛|帅/, 'cool'],
  [/好吃|好香|馋/, 'delicious'],
  [/放心|包在我|当然|没问题/, 'confident'],
  [/舒服|放松|惬意/, 'relaxed'],
  [/傻|笨|呆/, 'silly'],
  [/奇怪|不明白|搞不懂|怎么会/, 'confused'],
  [/让我想想|我想想|琢磨/, 'thinking'],
  [/开心|高兴|太好了|真好/, 'happy'],
];
// 当前板上显示的脸。状态机和句子规则共用它去重,免得同一张脸被反复下发。
let _face = '';
function setFace(emo) { if (emo && emo !== _face) { _face = emo; board.emotion(emo); } }
function faceBySentence(s) {
  if (cfg.faceByText === false) return;
  for (const [re, emo] of EMO_RULES) if (re.test(s)) return setFace(emo);
}
orch.on('face', (f) => setFace(FACE_EMO[f.state]));
// 模型自己点的脸(她在回复开头写 [face:xxx],turn.js 已剥掉不会念出来)。
// 白名单挡一道:板子只认 index.json 里那 21 个名字,模型写错或自造会让板端查不到图。
const VALID_FACES = new Set(['neutral', 'happy', 'laughing', 'funny', 'sad', 'angry', 'crying',
  'loving', 'embarrassed', 'surprised', 'shocked', 'thinking', 'winking', 'cool', 'relaxed',
  'delicious', 'kissy', 'confident', 'sleepy', 'silly', 'confused']);
orch.on('face_tag', (e) => {
  if (!VALID_FACES.has(e)) return log('[face] 模型点了个不存在的表情,忽略:', e);
  log('[face] 模型自选:', e);
  setFace(e);
});

// ---- 零延迟兜底:思考音(预生成缓存)+ 出错填充语 ----
const CACHE_DIR = path.join(__dirname, 'cache');
try { fs.mkdirSync(CACHE_DIR); } catch (e) {}
async function phrasePcm(text, name) {
  const f = path.join(CACHE_DIR, name);
  try { return fs.readFileSync(f); } catch (e) {}
  const r = await tts.synth(text);
  fs.writeFileSync(f, r.pcm);
  return r.pcm;
}
// 思考音轮换(0815 用户要的):固定一句听多了很假。随机挑一条,且不连着重复上一条。
const THINKING_TEXTS = [
  '嗯……我想想。',
  '我看看啊。',
  '等我一下。',
  '嗯,让我理一下。',
  '这个啊……',
  '稍等哦。',
];
let _lastThink = -1;
function pickThinking() {
  if (THINKING_TEXTS.length < 2) return 0;
  let i;
  do { i = Math.floor(Math.random() * THINKING_TEXTS.length); } while (i === _lastThink);
  _lastThink = i;
  return i;
}
const BREAKER_TEXT = '额度有点紧,我先歇一会儿,过阵子再叫我。';
const fillerName = (t) => 'filler-' + crypto.createHash('md5').update(t).digest('hex').slice(0, 8) + '.pcm';
orch.on('thinking_cue', async () => {
  const i = pickThinking();
  try { const pcm = await phrasePcm(THINKING_TEXTS[i], `think-${i}.pcm`); if (orch.state === 'thinking') enqueuePcm(pcm); }
  catch (e) { log('[cue] 思考音失败:', e.message); }
});
orch.on('filler', async (t) => {
  try { enqueuePcm(await phrasePcm(t, fillerName(t))); }
  catch (e) { log('[cue] 填充语失败:', e.message); }
});
// 工具垫场(0815):她说到一半去查记忆/写记忆/搜索,一调十几秒,不吭声听着就是"话说了一半断掉"。
// 三道闸:①一轮只垫一次(调五个工具不会念五遍);②只在**正在说或刚说完**时垫 ——
// 开口第一件事就调工具的场景由 thinking_cue 管,两个都念会啰嗦;③config 里 toolCue:false 可关。
const TOOL_TEXT = '让我查一下。';
let _toolCueAt = 0;
telos.on('tool', () => {
  if (cfg.toolCue === false) return;
  if (Date.now() - _toolCueAt < 25000) return;
  if (!speaking && Date.now() - lastSpeakEnd > 3000) return;
  _toolCueAt = Date.now();
  phrasePcm(TOOL_TEXT, 'toolcue.pcm')
    .then((pcm) => { if (orch.cur) enqueuePcm(pcm); })
    .catch((e) => log('[cue] 工具垫场失败:', e.message));
});
// 启动预热:兜底语音全部落缓存。不预热的话首次触发要现合成,"思考音 1s 内"的验收就靠运气(0813 自检)
(async () => {
  try {
    for (let i = 0; i < THINKING_TEXTS.length; i++) await phrasePcm(THINKING_TEXTS[i], `think-${i}.pcm`);
    for (const t of Object.values(FILLERS)) await phrasePcm(t, fillerName(t));
    await phrasePcm(BREAKER_TEXT, 'breaker.pcm');
    await phrasePcm(TOOL_TEXT, 'toolcue.pcm');
    log('[cue] 兜底语音预热完成');
  } catch (e) { log('[cue] 预热失败(首次触发时再现合成):', e.message); }
})();

// ---- 熔断:滑动 1h 窗内回合数/成本双阈值(《架构》八——0813 自检发现计划写了代码没做) ----
// 场景:电视人声/回声反复误触发唤醒词 → 无人看管地烧额度。超限后语音不进对话,只在板上提示一次。
const spent = [];
let breakerNotifiedAt = 0;   // 上次念"额度紧"的时刻(念一次就够,别每句都念)
let MAX_TURNS_PER_HOUR = Number(cfg.maxTurnsPerHour) || 40;
// 0816 从 2 提到 6:$2 挡不住误触发,却挡得住用户正常说话 —— 每轮约 $0.12,
// 一小时聊十几句就到顶;而**重连后的第一轮**要重建整个上下文缓存,一次就 $1.86(实测),
// 相当于一次抖动直接吃掉全小时额度,后面每句都被静默丢掉(她看到的是"卡在聆听中")。
// 这个数是防跑飞的护栏、不是预算 —— 走的是订阅额度,不是 API 账单。
let MAX_COST_PER_HOUR = Number(cfg.maxCostPerHour) || 6;
orch.on('reply', (r) => spent.push({ at: Date.now(), cost: r.cost || 0 }));
function breakerCost() { return spent.reduce((a, b) => a + b.cost, 0); }
// 滑动窗口 → 最早那笔满 1 小时就自动松一格。告诉用户"还要等多久"比"歇一会儿"有用得多。
function breakerFreeInMs() {
  return spent.length ? Math.max(0, spent[0].at + 3600e3 - Date.now()) : 0;
}
function breakerTripped() {
  const now = Date.now();
  while (spent.length && now - spent[0].at > 3600e3) spent.shift();
  const hit = spent.length >= MAX_TURNS_PER_HOUR || breakerCost() >= MAX_COST_PER_HOUR;
  if (!hit) breakerNotifiedAt = 0;
  return hit;
}

// ---- 上行:板子 → ASR → 编排器 ----
// 真板实测(0814):官方固件的聆听是 auto 模式——它**不发 listen stop**,等服务端判停;
// 网关若干等 stop 就互相僵住(87s 后固件断线重连,残留识别积累成一大句灌进对话)。
// 所以:①网关自己判停(识别结果停止变化 ~900ms=说完)②断连/被顶掉的识别残留一律丢弃
//
// 0814 第二轮 ——「说完一轮又卡在聆听中」的确切机制:
//   固件收到 tts stop 后(auto 模式)把自己切回 Listening,等播放排空再发一条新的 listen start,
//   所以正常轮次能续上。但只要有一轮**没人说话**(我方 12s 空转定稿),板子的状态没变过、
//   不会再发第二条 listen start,而我方识别已经收工 → 板上"聆听中"亮着,人却真的聋了。
// 修法两条腿:
//   ① 板子在听 = 网关一直在听:本地能量 VAD 侦测到人声就自己开新一轮识别(前 PRE_ROLL 帧
//      回灌,别把话头吃掉)。副产品是唤醒一次后能连着聊,不必每句都叫名字。
//   ② 空转时反向发 listen stop 让板子回待机(v2 固件认这条;v1 固件当未知消息忽略,无害)。
//
// 名字一律纠正、绝不删除(0814 用户定的:"直接把那些名字删掉的行为不可取")——
// 叫名字是在叫她,ASR 把她的名字听成同音字是错字,该改对而不是把称呼抹掉。
// 表在 config.json 的 `nameFix` 里:`{"正确写法": ["听错1","听错2"]}`,不配就不动。
// **别写死在代码里** —— 0817 唤醒语可以在控制台改了,写死的正名表会把新名字改成上一任的。
const NAME_RULES = Object.entries(cfg.nameFix || {}).map(([to, from]) => {
  const list = (Array.isArray(from) ? from : String(from).split('|'))
    .filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return list.length ? { re: new RegExp('(' + list.join('|') + ')', 'g'), to } : null;
}).filter(Boolean);
const fixNames = (t) => NAME_RULES.reduce((s, r) => s.replace(r.re, r.to), String(t || ''));

let VAD_RMS = Number(cfg.vadRms) || 200;  // 人声能量门槛(16bit PCM 的 RMS;安静房间底噪一般 <200)。
                        // 0815 一路降:700 → 420 → 350 → 200。
                        // ①700 时板子回到待机表情后 AFE 增益变低,用户"停一会儿再说就说不进去",
                        //   实测那段 vadHits 恒为 0;②350 时开口爬升段实测 352/363 仍卡在门槛上;
                        //   ③200 是为了"稍微远一点也能收到"。实测静音底噪峰值 0~75,200 还有约 2.7 倍余量,
                        //   加上 VAD_HITS=3(连续 180ms 过线才算)滤掉偶发噪音,以及 SELF_HEAR_MS 冷却期
                        //   压根不判定,喇叭余音吃不进来。误触发(自问自答)多了就在 config.json 调 vadRms 往上顶。
let VAD_HITS = 3;     // 连续几帧过线才算"有人开口"(≈180ms,滤掉咔哒声)
let PRE_ROLL = 20;    // 自启时回灌最近几帧(≈1.2s),补回 VAD 判定期间说掉的字。
                        // 8 帧(0.5s)不够:要覆盖住整个 SELF_HEAR_MS 冷却窗,冷却期开的口才补得回来。
let SELF_HEAR_MS = 1200; // 刚播完的冷却:别让喇叭余音触发 VAD 变成自问自答
// 唤醒词命中后,preRoll 里只留最后这么几帧再喂给 ASR —— 前面装的**就是唤醒词本身**,不该进识别。
// 留 2 帧(120ms)是给 KWS 抢跑留的余量:它可能在末音节刚出来时就命中,那点尾巴留着让 ASR 自己吞,
// 顺便盖住唤醒词和后面正事之间的过渡,免得把她第一个字削掉半个。
let WAKE_KEEP = cfg.wakeKeep === undefined ? 2 : Number(cfg.wakeKeep);
// 插话打断(barge-in,0815 加)。默认开;万一它开始自己打断自己,config.json 里 bargeIn:false 一关就行。
let BARGE_IN = cfg.bargeIn !== false;
let BARGE_RMS = Number(cfg.bargeRms) || VAD_RMS * 2;  // 播报中的门槛(默认 400,平时 200)。
                        // 0815 从 3 倍降到 2 倍:用户实测 600 打不断。真正的下限取决于 AEC 残留有多大 ——
                        // 见 stopSpeaking 里打的「播报期峰值RMS」:没人说话那几轮的峰值就是残留水平,
                        // 门槛必须高过它,否则她会被自己的回声打断(自问自答)。
let BARGE_HITS = Number(cfg.bargeHits) || 6; // 最近 BARGE_WIN(12)帧里够这么多帧过线就算插话

// ---- 服务端唤醒词唤醒词(方案 C,见 wake.js 和《唤醒词与姿态计划》) ----
// **默认关**:开着它才改变现有行为,不开则下面所有分支都不进,链路和今天一模一样。
// 而且它现在开了也没用 —— 板子只在 Listening 期间上传,待命时服务端根本收不到音频。
// **要等 P0 固件让板子常态上传**,那之后 config.json 里 `wakeWord.enabled: true` 即可。
let wake = null;
// 开关是**扁平的** `cfg.wakeOn`,不是 `cfg.wakeWord.enabled` —— applyTunables 会做 `cfg[k]=val`,
// 用 wakeWord 当键名会把整个配置对象直接覆盖成 true,dir 什么的全丢(差点踩)。
function setWake(on) {
  if (on && !wake) {
    const w = new WakeWord(cfg.wakeWord || {});
    const err = w.start();
    if (err) { log('[wake] 启动失败,当没开:', err); return; }
    wake = w; awake = false;
    log(`[wake] 服务端唤醒词就绪:「${w.keyword}」`);
    // 板子若已经连着,立刻请它转入常驻聆听 —— 否则要等下次 hello(=下次重连)才生效,
    // 控制台上开了开关却半天没反应,那种"开了没用"最气人。
    board.listenPassive();
  } else if (!on && wake) {
    wake = null; awake = false;
    // sherpa 那边没提供释放接口,90MB 的模型会一直留在进程里,重启才真的还回去。
    log('[wake] 已关闭(模型仍占着内存,要彻底释放得重启网关)');
  }
}
// 唤醒后进入"激活",这段时间里说话不用再叫名字(本地 VAD 续听,和今天一样);
// 静默够久就退回"待命",待命时**只跑唤醒词、不起 ASR** —— 否则常态上传下随便谁说句话
// 都会开一路 DashScope 识别,按时长计费直接烧穿。
let awake = false;
let awakeAt = 0;
let AWAKE_HOLD_MS = Number(cfg.awakeHoldMs) || 45000;
function sleepBack(why) {
  if (!awake) return;
  awake = false;
  if (wake) wake.reset();     // 丢掉这轮说话攒的解码状态,别污染下次唤醒判定
  // 屏上收回"待命",但 keep=true —— **别停采音**,停了就再也听不见下一次唤醒
  board.listenIdle();
  log(`[wake] 回待命(${why}) —— 再说话要先叫「${wake ? wake.keyword : '名字'}」`);
}
if (cfg.wakeOn) setWake(true);   // 放在 awake/sleepBack 声明**之后**:setWake 会写 awake,提前调会撞 TDZ
// ---- 字幕分块 + 跟语音走(0816) ----------------------------------------------
//
// 之前分块和计时都在板子固件里,结果调一次要插 USB 刷一版,而且**板子根本不知道语音的时间轴** ——
// 它只能自己按字数猜该停多久,猜不准就成了用户说的"配合不上语音"。
// 现在挪到网关:这边手里有帧,知道每句话从第几帧开始播,把每一块挂到它该出现的那一帧上,
// 字和声就咬死了。顺带的好处是这些参数**只在网关**,控制台滑一下立刻生效,不用再碰固件。
let SUB_MAX_CHARS = cfg.subMaxChars === undefined ? 12 : Number(cfg.subMaxChars);
let SUB_MIN_SHOW_MS = cfg.subMinShowMs === undefined ? 1200 : Number(cfg.subMinShowMs);
// 估算用的语速。真实语速由 TTS 定,这里只用来把一句话内部的几块摊到时间轴上 ——
// 估偏一点没关系:**下一句的字幕会按它自己的帧号重新对齐**,误差不会累积过去。
const SUB_EST_MS_PER_CHAR = 250;

// 中文算一个、ASCII 算半个 —— 板子那行放得下多少是按**像素**算的,
// 一律按字符数会让中英混排要么撑出去要么剩一大截白。
function subWidth(str) {
  let w = 0;
  for (const ch of str) w += ch.charCodeAt(0) > 127 ? 1 : 0.5;
  return w;
}
const SUB_BREAKS = new Set(['，', '。', '！', '？', '；', '：', '、', '…', '—',
                            ',', '.', '!', '?', ';', ':', ' ']);
// 按标点 + 宽度切块:尽量把一块填满,但只在标点后面断,断不开才硬切。
// 「我在呢,今天天气不错。」放得下就是一整块,不会拆成两条碎的。
function splitSubtitle(text) {
  const cs = [...text];
  const out = [];
  let start = 0, i = 0, brk = 0;
  while (i < cs.length) {
    if (subWidth(cs.slice(start, i + 1).join('')) > SUB_MAX_CHARS && i > start) {
      const cut = brk > start ? brk : i;
      out.push(cs.slice(start, cut).join(''));
      start = cut; brk = start;
      continue;
    }
    if (SUB_BREAKS.has(cs[i])) brk = i + 1;
    i++;
  }
  if (start < cs.length) out.push(cs.slice(start).join(''));
  return out.filter((b) => b.trim());
}
// 把一句话的几块排到时间轴上。at = 该跟着第几帧出去。
// 两条约束:①按估算语速摊开,块跟着它对应的那段语音出现;
// ②相邻两块至少隔 SUB_MIN_SHOW_MS —— 短句也得留够看完的时间,不然又变成"没看完就跳"。
function queueSubtitle(text, atFrame) {
  const blocks = splitSubtitle(text);
  const minGap = Math.ceil(SUB_MIN_SHOW_MS / FRAME_MS);
  let pos = atFrame;
  blocks.forEach((b, i) => {
    const last = cues.length ? cues[cues.length - 1].at : -Infinity;
    // face 只挂在第一块上:表情要按**整句**判断,拿半句去猜会得出莫名其妙的脸
    cues.push({ at: Math.max(pos, last + minGap), text: b, face: i === 0 ? text : null });
    pos += Math.round((subWidth(b) * SUB_EST_MS_PER_CHAR) / FRAME_MS);
  });
}

// 音频推完了、但还有块没到点(块多且最短显示卡得紧时会发生)。
// 不兜住的话这些块会跟着回合结束一起被丢掉 —— 用户看到的就是最后一句话没显示完。
let _drainTimer = null;
function drainCues() {
  _drainTimer = null;
  if (!cues.length || speaking) return;   // speaking=true 说明新回合开始了,旧块让位
  const c = cues.shift();
  board.tts('sentence_start', c.text);
  if (c.face) faceBySentence(c.face);
  if (cues.length) _drainTimer = setTimeout(drainCues, Math.max(400, SUB_MIN_SHOW_MS));
}
// 板子固件自己也有一套分块+停留(v2.4.34 加的)。现在节奏归网关管了,**必须把板子那套关掉** ——
// 两边都排队的话,板子会按自己的停留把网关掐好点的块又押后一遍,同步立刻散架。
// 板子重刷固件后 NVS 回默认值,所以每次它连上来都要重发一次。
function pushSubtitleCfg(why) {
  const ok = board.mcpCall('self.screen.set_subtitle_speed', { ms_per_char: 0, hold_ms: 0 });
  log(`[字幕] ${ok ? '已让板子交出节奏' : '板子不在线,等它连上再说'}${why ? ' (' + why + ')' : ''}`);
}

// ---- 可调参数(控制台热改:立即生效 + 落 config.json,不用重启) ----
// 只收"改了当场生效"的项 —— voiceMode/model 那种要重建 orch/telos 对象的不放进来,
// 否则控制台上看着改了、实际没生效,比不能改更糟。
// min/max 不是装饰:控制台是手机上滑的,手滑把 vadRms 设成 0 会让它把底噪当人声、无限自问自答。
const TUNABLES = {
  vadRms:       { label: '拾音门槛', unit: 'RMS', min: 50, max: 2000, step: 10,
                  hint: '越低越灵敏。静音底噪实测 0~75', get: () => VAD_RMS, set: (v) => { VAD_RMS = v; } },
  vadHits:      { label: '开口确认', unit: '帧', min: 1, max: 10, step: 1,
                  hint: '连续几帧过线才算有人说话,1 帧=60ms', get: () => VAD_HITS, set: (v) => { VAD_HITS = v; } },
  preRoll:      { label: '话头回灌', unit: '帧', min: 0, max: 60, step: 1,
                  hint: '补回判定期间说掉的字,要盖住自听冷却', get: () => PRE_ROLL, set: (v) => { PRE_ROLL = v; } },
  selfHearMs:   { label: '自听冷却', unit: 'ms', min: 0, max: 4000, step: 50,
                  hint: '刚播完多久内不听,防喇叭余音自问自答', get: () => SELF_HEAR_MS, set: (v) => { SELF_HEAR_MS = v; } },
  endSilenceMs: { label: '断句静默', unit: 'ms', min: 200, max: 3000, step: 50,
                  hint: '停顿多久算说完。太短会把话腰斩(下一轮识别生效)',
                  get: () => Number(cfg.endSilenceMs) || 800, set: (v) => { cfg.endSilenceMs = v; } },
  wakeOn:       { label: '服务端唤醒词', type: 'bool',
                  // hint 支持函数:唤醒语能在控制台改,写死一句就会跟实际的对不上(见 adminState)
                  hint: () => `待命时听见「${(wake && wake.keyword) || '唤醒语'}」才起识别。要固件让板子常态上传才有用`,
                  get: () => !!wake, set: (v) => setWake(!!v) },
  maxCostPerHour: { label: '熔断额度', unit: '$/h', min: 1, max: 30, step: 1,
                  hint: '1 小时滑动窗内超过这个数就不再进对话。防的是电视人声反复误触发',
                  get: () => MAX_COST_PER_HOUR, set: (v) => { MAX_COST_PER_HOUR = v; } },
  maxTurnsPerHour: { label: '熔断轮数', unit: '轮/h', min: 5, max: 200, step: 5,
                  hint: '同上,按回合数算的那一道',
                  get: () => MAX_TURNS_PER_HOUR, set: (v) => { MAX_TURNS_PER_HOUR = v; } },
  subMaxChars:  { label: '字幕每块字数', unit: '字', min: 4, max: 30, step: 1,
                  hint: '一块最多几个字(中文算1、英文算半个)。调大=每块字多、停得久;调小=跳得勤',
                  get: () => SUB_MAX_CHARS, set: (v) => { SUB_MAX_CHARS = v; } },
  subMinShowMs: { label: '字幕最短显示', unit: 'ms', min: 0, max: 5000, step: 100,
                  hint: '一块至少留这么久再换下一块。字幕本来跟着语音走,这道下限保证短句也看得完',
                  get: () => SUB_MIN_SHOW_MS, set: (v) => { SUB_MIN_SHOW_MS = v; } },
  wakeKeep:     { label: '唤醒词切除', unit: '帧', min: 0, max: 20, step: 1,
                  hint: '唤醒后回灌只留最后几帧,前面那段唤醒词整个丢掉,不进识别',
                  get: () => WAKE_KEEP, set: (v) => { WAKE_KEEP = v; } },
  awakeHoldMs:  { label: '激活保持', unit: 'ms', min: 5000, max: 300000, step: 5000,
                  hint: '唤醒后多久没说话就退回待命(这期间说话不用再叫名字)',
                  get: () => AWAKE_HOLD_MS, set: (v) => { AWAKE_HOLD_MS = v; } },
  bargeIn:      { label: '插话打断', type: 'bool',
                  hint: '播报中听到人声就停口', get: () => BARGE_IN, set: (v) => { BARGE_IN = !!v; } },
  bargeRms:     { label: '打断门槛', unit: 'RMS', min: 100, max: 4000, step: 10,
                  hint: '必须高过 AEC 残留,否则它会被自己的回声打断', get: () => BARGE_RMS, set: (v) => { BARGE_RMS = v; } },
  bargeHits:    { label: '打断确认', unit: '帧', min: 1, max: 12, step: 1,
                  hint: '最近 12 帧(720ms)里有几帧过线就算插话。不要求连续——人说话有音节起伏',
                  get: () => BARGE_HITS, set: (v) => { BARGE_HITS = v; } },
  prebufMs:     { label: '播放垫底', unit: 'ms', min: 200, max: 2300, step: 50,
                  hint: '板端缓冲。板子队列硬上限 2400ms,超了直接丢包(截断跳段);太小则网络一抖就断音',
                  get: () => PREBUF, set: (v) => { PREBUF = v; } },
  faceByText:   { label: '表情跟着话走', type: 'bool',
                  hint: '按每句话的情绪切换 21 张脸;关掉就只跟听/想/说三态',
                  get: () => cfg.faceByText !== false, set: (v) => { cfg.faceByText = !!v; } },
  toolCue:      { label: '工具垫场', type: 'bool',
                  hint: '说到一半去查东西时垫一句「让我查一下」',
                  get: () => cfg.toolCue !== false, set: (v) => { cfg.toolCue = !!v; } },
};
function saveCfg() { // 原子写,跟 saveState 一个规矩
  const tmp = CFG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CFG_PATH);
}
function applyTunables(patch) {
  const applied = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const t = TUNABLES[k];
    if (!t) continue;                                   // 不认的键直接丢,别往 config 里塞垃圾
    let val;
    if (t.type === 'bool') val = !!v;
    else {
      val = Number(v);
      if (!Number.isFinite(val)) continue;              // NaN 会静默毒化参数,挡在这里
      val = Math.min(t.max, Math.max(t.min, val));      // 夹到量程内
    }
    t.set(val); cfg[k] = val; applied[k] = val;
  }
  if (Object.keys(applied).length) { saveCfg(); log('[admin] 已改:', JSON.stringify(applied)); }
  return applied;
}

function rms(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i << 1); sum += v * v; }
  return Math.sqrt(sum / n);
}

let asr = null;
let boardListening = false;      // 板子自报的聆听态(它在采音发流)
const preRoll = [];
let vadHits = 0;
let _rmsPeak = 0;       // 空闲期收到的最大帧能量,给 [audio] 诊断日志用(判断门槛定得对不对)
let _idleFrames = 0;    // 同上:真正走到 VAD 判断的帧数
let bargeHits = 0;      // 播报期间滑动窗口内过高门槛的帧数(插话打断用)
const BARGE_WIN = 12;   // 滑动窗口长度(帧),12×60ms=720ms;窗口内够 BARGE_HITS 帧过线即算插话
let _bargeWin = [];     // 最近 BARGE_WIN 帧是否过线(1/0)
let _bargeHot = 0;      // 本轮窗口内最高命中数 —— 用户插话时实际能到多少,直接定门槛用
let _bargeAt = 0;       // 最近一次插话打断的时刻(用来缩短紧随其后的自听冷却)
let _bargePeak = 0;     // 本轮播报期间听到的最大能量(诊断:AEC 残留 vs 真人插话)
let _bargeSamples = [];  // 播报期 RMS 全样本(算 p50/p90/max,判断回声基线与插话尖峰)
const astat = { frames: 0, bad: 0, fed: 0 };   // 上行观测:收到帧/解码失败/喂给ASR

// 唤醒词的**同音兜底**剥离。主力是在音频层丢帧(见 KWS 命中处),这里只兜住 KWS 抢跑漏下的尾音。
// 按同音放宽是必须的:ASR 对唤醒词那几个字的转写几乎不可能和字面一致(实测唤醒词的
// 定稿是「你好,谢谢。对不起妈。」),精确匹配等于没写。
// 三重判据,任一命中即认这个字:①字面相同 ②同音表(跨读音的,见下)③**无声调拼音相同**。
// 第三条是 0817 加的 —— 唤醒语在控制台可改了,写死字表只服务唤醒词一句,换成别的名字
// 剥离就悄悄失效(不报错、只是每次唤醒都多带一句名字进对话,最难发现的那种坏)。
// 宁可漏剥也别误吃正事 —— 剥错一个字,用户说的话就少一截,比多一句"你好"难受得多,
// 所以要求**逐字全中**才剥,中途对不上就整句不动。
// 表在 config.json 的 `homophone` 里({"字":"这些字都算同音"}),不配就只靠字面+拼音两条。
// 它只该收「拼音不同但听着像」的那种 —— 名字里的字不按标准音念时,拼音判据管不着。
// 跟 nameFix 一样是**跟人走的**,别写死在代码里。
const HOMOPHONE = cfg.homophone || {};
const GAPSET = new Set([...' \t\n,，。.、!！?？~～']);
const _pyCache = new Map();
function noTone(ch) {
  let v = _pyCache.get(ch);
  if (v === undefined) {
    try { v = require('pinyin-pro').pinyin(ch, { toneType: 'none', type: 'array', nonZh: 'removed' })[0] || ''; }
    catch (e) { v = ''; }       // 库没装也不能让识别链崩,退化成只按字面+同音表
    _pyCache.set(ch, v);
  }
  return v;
}
function sameChar(got, want) {
  if (got === want) return true;
  if ((HOMOPHONE[want] || '').includes(got)) return true;
  const a = noTone(got);
  return !!a && a === noTone(want);
}
// 命中返回剥离后的文本(可能是空串);没对上返回 null = 别动这句话
function stripWake(text, kw) {
  const arr = [...String(text || '')];
  let i = 0;
  const skip = () => { while (i < arr.length && GAPSET.has(arr[i])) i++; };
  skip();
  for (const c of [...String(kw || '')]) {
    skip();
    if (i >= arr.length || !sameChar(arr[i], c)) return null;
    i++;
  }
  skip();
  return arr.slice(i).join('');
}

// wakeWord 有值 = 这一轮是唤醒词触发的,定稿里要把唤醒词本身剥掉(见 final 里的注释)。
function startAsr(why, wakeWord) {
  awakeAt = Date.now();   // 有识别在跑 = 人正说着话,激活期从这一刻重新计时
  astat.frames = 0; astat.bad = 0; astat.fed = 0;
  if (asr) { const old = asr; asr = null; try { old.finish(); } catch (e) {} } // 旧会话顶掉即作废(final 会被丢弃)
  const mine = asr = new AsrStream({ endSilenceMs: Number(cfg.endSilenceMs) || 800, envPath: cfg.dashscopeEnvFile }).start();
  mine._wake = wakeWord || null;
  log(`[asr] 开始识别(${why})`);
  for (const p of preRoll) { mine.sendAudio(p); astat.fed++; }
  preRoll.length = 0; vadHits = 0;
  mine.lastAct = Date.now();
  const bump = () => { mine.lastAct = Date.now(); };
  mine.on('partial', bump); mine.on('sentence', bump);
  mine.on('ready', () => log('[asr] 识别任务就绪(task-started)'));
  mine.on('partial', (t) => { if (!mine._p1) { mine._p1 = true; log('[asr] 首个识别片段:', t); } });
  mine._probe = setInterval(() => log(`[probe] 帧=${astat.frames} 坏=${astat.bad} 喂=${astat.fed} ready=${mine.ready} partial=${JSON.stringify(mine.lastPartial)}`), 3000);
  // 判停:有内容且 ~900ms 无新识别 → 说完;完全没内容 10s → 空转收工(别一直挂着计费)
  mine.vad = setInterval(() => {
    if (asr !== mine) { clearInterval(mine.vad); return; }
    const idle = Date.now() - mine.lastAct;
    const has = mine.sentences.length || mine.lastPartial;
    if (has && idle > 900) { clearInterval(mine.vad); try { mine.finish(); } catch (e) {} }
    else if (!has && idle > 10000) { mine._silent = true; clearInterval(mine.vad); try { mine.finish(); } catch (e) {} }
  }, 250);
  mine.on('final', (raw) => {
    clearInterval(mine.vad); clearInterval(mine._probe);
    if (asr !== mine) { log('[asr] 丢弃残留定稿:', raw); return; }
    asr = null;
    let t = fixNames(raw);
    log('[asr] 定稿:', raw, t !== raw ? `→ 正名: ${t}` : '');
    // 唤醒词只是「叫醒」,不该当成一句话发给她(用户报的:「为什么唤醒词总是会被当成输入」)。
    // ⚠️0816 更正:我原先在这儿写过「不能靠清空 preRoll 解决,KWS 检出有延迟,清了会把正事削半句」——
    // **那是想当然**。KWS 是在唤醒词**说完**之后才命中的,preRoll 里装的就是唤醒词本身,后面的话
    // 是命中之后才 feed 进来的,根本不在 preRoll 里。真正的修法就在音频层(见 KWS 命中处的丢帧),
    // 这里只剩兜底:万一 KWS 抢跑、尾音漏进去了,按同音类剥掉开头(精确匹配没用,见 wakeStripRe)。
    if (mine._wake) {
      const after = stripWake(t, mine._wake);
      if (after !== null && after !== t) {
        log(`[wake] 剥掉唤醒词 → ${JSON.stringify(after)}`);
        t = after;
      }
    }
    if (!t.trim()) {
      // 只叫了名字、没说正事。这时**不能**当成空转把她放回待命 —— 用户是在叫她,得应一声。
      // 但也不该把唤醒词伪装成用户的发言塞给模型(记忆铁律:别往用户消息里塞东西),
      // 所以走板子事件通道,由 _boardMsg 打上「非用户发言」的标识。
      if (mine._wake) {
        log('[wake] 只叫了名字,没别的话 → 让她应一声');
        orch.onBoardEvent(`用户叫了你一声：${mine._wake}`, 800);
        return;
      }
      orch.onUtterance('');
      // 空转:请板子回待机。**不动 boardListening** —— 老固件不认这条下行(当未知消息忽略),
      // 提前把标记清掉会让本地 VAD 续听也失效,用户再开口就又没人听了。
      // 认这条的新固件退出聆听后自然不再送音频,VAD 也就不会触发,两版都对。
      // 开了服务端唤醒词就**不能**让板子回待机 —— 方案 C 靠的正是它常态上传,
      // 停了就再也听不见唤醒词了。改成自己退回待命,音频照收、只是重新等名字。
      if (mine._silent) {
        if (wake) sleepBack('空转收工');
        else { board.listenStop(); log('[board] 空转收工,请板子回待机'); }
      }
      return;
    }
    board.stt(t);
    if (breakerTripped()) {
      const mins = Math.ceil(breakerFreeInMs() / 60000);
      log(`[breaker] 1h 窗超限(${spent.length}/${MAX_TURNS_PER_HOUR} 轮,$${breakerCost().toFixed(2)}/$${MAX_COST_PER_HOUR},${mins} 分钟后松开),这句不进对话:`, t);
      board.emotion('confused');
      // 念一遍就够(5 分钟冷却),但**每次**都要把屏收回待命 —— 原先只在第一次给反馈,
      // 之后一律静默丢弃,屏上那句"聆听中"就一直亮着,看起来完全是链路坏了
      // (用户 0816:「卡聆听中,能识别到语音但是发不出去」—— 其实识别一路正常,是这儿把话吃了)。
      if (Date.now() - breakerNotifiedAt > 300e3) {
        breakerNotifiedAt = Date.now();
        phrasePcm(BREAKER_TEXT, 'breaker.pcm').then((p) => enqueuePcm(p)).catch(() => {});
      }
      if (wake) sleepBack('额度歇着'); else board.listenStop();
      return;
    }
    orch.onUtterance(t);
  });
  mine.on('error', (e) => { clearInterval(mine.vad); clearInterval(mine._probe); if (asr !== mine) return; asr = null; log('[asr] 失败:', e.message); orch.onUtterance(''); });
}

board.on('hello', (m) => {
  log('[board] hello:', JSON.stringify(m));
  // 方案 C:一连上就请板子进**常驻聆听**(采音上传但屏上显示待命),否则服务端听不见唤醒词。
  // 老固件(v2.4.12 及以前)不认这条,当未知消息忽略 —— 那种情况下退回原来的板端唤醒词流程,无害。
  if (wake) { board.listenPassive(); log('[wake] 已请板子常驻聆听(屏上仍显示待命)'); }
});
board.on('listen', (m) => {
  log('[board] listen:', JSON.stringify(m));
  if (m.state === 'detect') {
    // 按键唤醒(v2.4.29+ 固件):常驻聆听下按 key3 不再拔线,改发这条 —— 由这边起识别。
    // 老路径(板端唤醒词)也走 detect,但那时紧跟着会来一条 start、由下面的分支起识别,
    // 所以只在开了服务端唤醒词时接管,免得同一次唤醒起两路 ASR。
    if (wake) {
      awake = true; awakeAt = Date.now();
      board.listenActive();          // 屏上"待命"→"聆听中"(固件那边也自己切了,这条是给旧固件兜底)
      orch.onWake();
      startAsr('按键唤醒' + (m.text ? ':' + m.text : ''));
    } else {
      orch.onWake();
    }
  }
  else if (m.state === 'start') {
    boardListening = true; preRoll.length = 0;
    // ⚠️开了服务端唤醒词就**不能**在这里起 ASR:方案 C 下板子是常驻聆听、一连上就发 start,
    // 照旧起识别的话等于"一开机就挂着 DashScope",按时长计费直接烧穿。
    // 什么时候起识别改由 KWS 说了算(见 board.on('audio') 里那段)。
    if (wake) log('[wake] 板子进入聆听态(常驻),等唤醒词');
    else startAsr('板子唤醒');
  }
  else if (m.state === 'stop') { boardListening = false; if (asr) asr.finish(); } // manual 模式仍支持
});
// 板载 IMU 的姿态/摇晃(v2.4.13+ 固件)。
// 板子只报**物理事实**(重力压在哪个轴),叫什么在这儿定 —— IMU 的轴和板子的物理朝向怎么对应,
// 只有把板子摆几个姿势看日志才知道。屏幕朝向那件事已经靠推算错过两次,这次不猜:
// 下面这份表是**待校准**的,用户摆一遍、我照日志改这里就行,**不用重刷固件**。
const POSE_NAMES = Object.assign({
  '+X': '右侧躺着', '-X': '左侧躺着',
  '+Y': '立着', '-Y': '倒立着',
  '+Z': '仰面朝上', '-Z': '倒扣着',
}, cfg.poseNames || {});
let _poseAt = 0;
// 0815:板子发来的**未知**消息以前是**静默丢弃**的(server.js 那边 `default: emit('msg')`,
// 而这边压根没人监听 EventEmitter 就什么也不做)。刚查"IMU 到底活没活"时就栽在这儿 ——
// 板子若已经在发 pose,日志里也一个字都看不到。以后板子加什么新消息,这条都能让它现形。
board.on('msg', (m) => log('[board] 未知消息(没人处理):', JSON.stringify(m).slice(0, 200)));
board.on('pose', (m) => {
  const shake = m.event === 'shake';
  const name = POSE_NAMES[m.axis] || m.axis;
  const prev = POSE_NAMES[m.prev] || m.prev;
  log(`[pose] ${shake ? '被晃了晃' : `${prev} → ${name}`}  轴=${m.axis} (${m.ax}, ${m.ay}, ${m.az})`);
  // 第三道闸:冷却。前两道(角度阈值+迟滞、稳定 N 秒才确认)在板子那边 —— 那些是物理量、基本不用调;
  // 冷却要按手感调,所以放这儿,改完重启网关就行,不用刷机。
  const cool = Number(cfg.poseCooldownMs) || 30000;
  if (Date.now() - _poseAt < cool) { log(`[pose] 冷却期内(${cool}ms),这次不报给她`); return; }
  _poseAt = Date.now();
  orch.onBoardEvent(shake ? '被晃了晃' : `姿态：${prev} → ${name}`,
                    Number(cfg.poseGraceMs) || 1500);
});
// 板子每 10 秒自报一次内存(v2.4.15+)。查的是「常驻聆听把 internal RAM 榨干 → WiFi 分不到缓冲 →
// bcn_timeout 掉线」,要看的是**掉线前那几分钟的趋势**,所以每条都记 —— 一行一条,回头 grep 就是时间序列。
// 板子那边同样的数据也打串口,两边互为备份(断线瞬间的最后一条走 WS 多半发不出去)。
let _memPrev = null;
board.on('memstat', (m) => {
  // ⚠️别 round 成 K:开机尖峰那个最低值恰恰是**几十字节**级别的,
  // 显示成「0.0K」就把"还剩 40 字节"和"还剩 500 字节"抹成同一个样子(0815 差点因此又看漏)。
  const kb = (n) => (Number(n) < 4096 ? Number(n) + 'B' : (Number(n) / 1024).toFixed(1) + 'K');
  // 带上和上一条的差值:光看绝对值分不清"稳在低位"和"正在往下掉",而这两种要修的地方完全不同。
  const d = _memPrev == null ? '' : `  (Δ${((m.int - _memPrev) / 1024).toFixed(1)}K)`;
  _memPrev = Number(m.int);
  log(`[mem] internal ${kb(m.int)} 最低${kb(m.int_min)} 最大块${kb(m.int_blk)} | `
      + `dma ${kb(m.dma)} | psram ${kb(m.psram)} | 任务${m.tasks}${d}`);
});
board.on('audio', (pkt) => {
  astat.frames++;
  const pcm = codec.decodeUp(pkt);
  if (!pcm) { astat.bad++; return; }
  if (asr) { astat.fed++; asr.sendAudio(pcm); return; }
  // 无活跃识别:只要板子还在听、我方空闲且不在播音余韵里,就用本地 VAD 自己接上
  if (!boardListening) return;
  // 🔴0816 收音统计必须在这儿数,不能放到下面 —— 原先它蹲在**唤醒词分支的 return 之后**,
  // 而待命期每一帧都从那儿返回了,于是"空闲收音"在待命期恒等于 0 帧。
  // 那条日志的判据写着「0 帧 → 板子压根没发」,结果它自己变成了假阳性:今天 14:22 sleepBack
  // 一回待命就报 0 帧,看着像板子聋了(我差点照着这个去查板子),其实音频一直好好地在传。
  // 专门用来排"板子发没发"的诊断,自己先失灵了,比没有还坏。
  _idleFrames++;
  { const _ir = rms(pcm); if (_ir > _rmsPeak) _rmsPeak = _ir; }
  // 回合进行中(thinking / speaking):不开新识别,只做插话检测(barge-in)。
  // speaking 时喇叭在响,AEC 消不干净的回声会抬高底噪 —— 所以门槛比平时高一截(默认 3 倍)、
  // 且要求连续过线的帧数翻倍,**宁可漏一次也别让它自己打断自己**(那会变成自问自答)。
  // 插话的开头照样进 preRoll,打断后冷却一过就能连着这段一起送进 ASR。
  if (orch.cur || speaking) {
    preRoll.push(pcm); if (preRoll.length > PRE_ROLL) preRoll.shift();
    const _br = rms(pcm);
    if (_br > _bargePeak) _bargePeak = _br;   // **不管打断开没开都统计** —— 关了就不量的话,
                                             // 想知道"她插话时到底多响"就永远没数据(0815 踩过)
    // 只报峰值太粗:她的回声是**持续基线**,用户插话是叠在上面的**尖峰**。
    // 收全样本算分位,p50=基线(纯回声有多响)、max=尖峰。两者拉开=有人插话,贴在一起=纯回声。
    // 门槛能不能用,就看这两个数隔多远。
    if (_bargeSamples.length < 4000) _bargeSamples.push(_br);
    // 0815 用户"没有了打断":老判据是**连续** BARGE_HITS 帧都过线,而 cfg 里 hits=10 = 连续 600ms
    // 不许有一帧掉线 —— 人说话有音节起伏和换气,实测播报期 p90 才 410~670,连续 10 帧全超 600
    // 基本不可能发生,等于把打断关死了。改成**滑动窗口**:最近 BARGE_WIN 帧里有 BARGE_HITS 帧过线。
    // 偶发的 AEC 残留尖峰(1~2 帧)照样挡得住,真人说话(起伏但持续)能过。
    _bargeWin.push(_br >= BARGE_RMS ? 1 : 0);
    if (_bargeWin.length > BARGE_WIN) _bargeWin.shift();
    let hot = 0; for (const v of _bargeWin) hot += v;
    if (hot > _bargeHot) _bargeHot = hot;   // 本轮窗口内最高命中数(诊断用:直接看出门槛该设多少)
    bargeHits = hot;
    // ⚠️关了打断也必须继续统计(同一个错我犯第二次了):原先 `if(!BARGE_IN){_bargeWin.length=0;...;return;}`
    // 会把窗口清空,于是关掉打断的那段时间"命中峰值"永远是 1 —— 等于自断诊断,
    // 等想重新开打断时又没有数据可依。改成只在开关打开时**触发**,统计照常跑。
    if (BARGE_IN && hot >= BARGE_HITS) {
      _bargeWin.length = 0; bargeHits = 0;
      log(`[board] 插话打断(${BARGE_WIN}帧内${hot}帧 RMS≥${BARGE_RMS})`);
      orch.onAbort();
      _bargeAt = Date.now();   // onAbort 会把 lastSpeakEnd 推到现在、重新起 1.2s 冷却,
                               // 而 1.2s 恰好等于 preRoll 的长度 —— 不缩短的话,冷却期的帧
                               // 会把她插话的开头整个挤出缓冲。刚刚才确认过是人声、喇叭也停了,
                               // 没必要再等满,见下面 coolMs。
    }
    return;
  }
  bargeHits = 0;
  // preRoll 要**先于**冷却判断攒起来。原先冷却期(刚播完、防喇叭余音自问自答)是直接 return,
  // 那 1.2 秒里她开的口既不进 preRoll 也不触发 VAD —— 等冷却过了才开始收音,
  // 开头几个字就永远丢了(0815 用户报"聆听只能听到我说话的最后几个字")。
  // 现在改成:冷却期照常攒帧、只是不判定,冷却一过 VAD 触发时这段能一起回灌进 ASR。
  preRoll.push(pcm); if (preRoll.length > PRE_ROLL) preRoll.shift();
  // 刚被插话打断过的 3 秒内只等 300ms:那次打断本身就是"确认有人在说话"的证据。
  const coolMs = Date.now() - _bargeAt < 3000 ? 300 : SELF_HEAR_MS;
  if (Date.now() - lastSpeakEnd < coolMs) { vadHits = 0; return; }
  // ---- 服务端唤醒词(方案 C):待命期**只等她的名字**,不起 ASR ----
  // 位置是挑过的:①在自听冷却**之后** —— 喇叭余音里保不齐就有她刚说出口的自己的名字,
  // 冷却期一律不判定;②回合进行中(orch.cur/speaking)上面已经 return 了,所以她自己
  // 说话时这里根本不跑 —— 她念到自己名字不会把自己唤醒,打断仍归 barge-in 管。
  if (wake) {
    if (awake && Date.now() - awakeAt > AWAKE_HOLD_MS) sleepBack('静默超时');
    if (!awake) {
      const kw = wake.feed(pcm);            // preRoll 上面已经攒过了,唤醒词后面紧跟的话不会丢
      if (!kw) return;
      awake = true; awakeAt = Date.now();
      // 🔴0816「就没法强制切掉前面的吗」—— 能,而且必须在**音频**层切,不是在文字层。
      // 原先只在定稿里剥字符串前缀,前提是 ASR 会把唤醒词识别成唤醒词四个字;
      // 可实测同一段音频的定稿是「你好,谢谢。对不起妈。」—— 字面毫无关系,正则一个都匹配不上,
      // 于是这堆乱码整条当成用户的发言发给了模型(09:55 那轮花了 $0.12 回答一句没人说过的话)。
      // KWS 命中时唤醒词已经说完,preRoll 里装的**就是**它 —— 直接丢掉,别喂给 ASR。
      const drop = Math.max(0, preRoll.length - Math.max(0, WAKE_KEEP));
      if (drop) preRoll.splice(0, drop);
      log(`[wake] 听到「${kw}」${drop ? ` (丢掉唤醒词那 ${drop} 帧,留 ${preRoll.length} 帧)` : ''}`);
      board.listenActive();          // 屏上从"待命"换成"聆听中" —— 这下是真的在听了
      orch.onWake(); startAsr('唤醒词:' + kw, kw);
      return;
    }
  }
  // 激活期(或没开服务端唤醒词):本地 VAD 续听 —— 唤醒一次后能连着聊,不必每句都叫名字
  const _r = rms(pcm);                // 计数和峰值已在上面统一记过(见那段注释),这里只做 VAD 判定
  vadHits = _r >= VAD_RMS ? vadHits + 1 : 0;
  if (vadHits >= VAD_HITS) { orch.onWake(); startAsr('听到有人说话'); }
});
// 诊断(0815):板子串口显示 speaking -> listening 自己转回聆听了,屏幕也写着"聆听中",
// 但服务端这边可能一帧音频都没进来 —— 用户对着它说话毫无反应。
// 每 10 秒报一次空闲期的收音情况,把两种可能分开:
//   近10s 0 帧      → 板子压根没发(官方 realtime 模式下 AFE 本地 VAD 门控住了)
//   有帧但 vadHits 长期 0 → 发了,是我方 VAD_RMS=700 门槛太高
// ⚠️这个判据成立的前提是计数点在 handler 靠前的位置 —— 0816 修过一次,别再把它挪到
// 唤醒词分支后面去(那样待命期恒 0,这条日志就只会骗人)。vadHits 在待命期本来就是 0
// (那时走唤醒词、不走 VAD),别拿它当"没听见"的证据。
setInterval(() => {
  if (!boardListening || asr || orch.cur || speaking) { _idleFrames = 0; _rmsPeak = 0; return; }
  const d = _idleFrames; _idleFrames = 0;
  const peak = _rmsPeak; _rmsPeak = 0;
  const cool = Math.max(0, SELF_HEAR_MS - (Date.now() - lastSpeakEnd));
  log(`[audio] 空闲收音 近10s=${d}帧 峰值RMS=${peak.toFixed(0)}(门槛${VAD_RMS}) vadHits=${vadHits}${cool ? ' 冷却剩' + cool + 'ms' : ''}`);
}, 10000).unref?.();

board.on('abort', () => { log('[board] 打断'); orch.onAbort(); });
board.on('connect', () => {
  _face = ''; setFace(FACE_EMO.idle);   // 重连后板端脸已重置,去重记录也要清
  // 字幕节奏跟着下去 —— 板子刚重刷过固件的话 NVS 是默认值,不补这一下控制台里的数就是假的。
  setTimeout(() => pushSubtitleCfg('板子上线'), 1500);
});

// ---- 控制台数据源(board/server.js 的 /admin 端点来取) ----
// 只读快照 + 一个 apply。BoardServer 只管 HTTP 和鉴权,业务全留在这边,
// 免得配置逻辑散进协议层(那样以后两处都得改)。
const recent = [];   // 最近若干轮的耗时/花费,控制台用来看"慢在哪"
orch.on('reply', (r) => {
  recent.push({ at: Date.now(), cost: +(r.cost || 0), firstDelta: r.timings && r.timings.firstDelta, text: (r.text || '').slice(0, 40) });
  if (recent.length > 12) recent.shift();
});
function adminState() {
  const hourCost = spent.reduce((a, b) => a + b.cost, 0);
  return {
    now: Date.now(),
    // 她叫什么名字(config.json 的 persona)。控制台的标题和几处提示语用它 —— 名字属于配置,
    // 不该焊在页面里:换个人设、或者别人拿这套代码去养自己的,改一行 config 就行。
    persona: cfg.persona || '',
    board: {
      online: !!(board.client && board.client.readyState === 1),
      listening: boardListening, speaking, orch: orch.state || 'idle',
    },
    session: state.sessionId || '',
    audio: { idlePeak: Math.round(_rmsPeak), bargePeak: Math.round(_bargePeak), vadHits, bargeHits, frames: astat.frames },
    hour: {
      turns: spent.length, cost: +hourCost.toFixed(4),
      maxTurns: MAX_TURNS_PER_HOUR, maxCost: MAX_COST_PER_HOUR, tripped: breakerTripped(),
    },
    recent: recent.slice().reverse(),
    tunables: Object.fromEntries(Object.entries(TUNABLES).map(([k, t]) => [k, {
      // hint 允许写成函数:内容要跟着运行期状态变的(比如当前唤醒语)靠它
      label: t.label, unit: t.unit || '', hint: (typeof t.hint === 'function' ? t.hint() : t.hint) || '', type: t.type || 'num',
      min: t.min, max: t.max, step: t.step, value: t.get(),
    }])),
  };
}
// 唤醒语的读写要在**功能关着**的时候也能用(用户可能先改名字再打开开关),而 setWake(false) 会把
// wake 置 null。WakeWord 的构造函数不加载任何东西(模型是 start() 里懒加载的),所以临时 new 一个
// 只碰 keywords.txt 是安全的、也不占内存;wake 在跑就用它,那样 setKeyword 会顺手重载引擎。
const wakeIo = () => wake || new WakeWord(cfg.wakeWord || {});
board.admin = {
  state: adminState,
  apply: applyTunables,
  wake: {
    read: () => ({ ...wakeIo().read(), running: !!wake }),
    preview: (text) => wakeIo().preview(text),
    // 重载会再加载一次 90MB 模型、旧的等 GC(实测每次 +20~30MB),所以把 RSS 报给控制台显示 ——
    // 改几次唤醒语无所谓,但别当滑块拖;涨得多了重启网关一次归零。
    set: (text, tokens) => {
      const r = wakeIo().setKeyword(text, tokens);
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      log(`[wake] 唤醒语改成「${r.text}」(${r.tokens.join(' ')})${r.reloaded ? ` — 引擎已重载,RSS ${rss}MB` : ' — 功能关着,开起来就生效'}`);
      return { ...r, rss };
    },
  },
  sessions: () => telos.listSessions(200),
  // 换附着对话。orch.sessionId 只在每轮开头被读走(turn.js:135 telos.say(text, this.sessionId)),
  // 所以**切换只影响下一轮**,正在跑的那一轮照旧发完,不会串台。
  // 传空串 = 不附着,下一句话会新建一个对话。
  setSession: (id) => {
    const sid = String(id || '').trim();
    orch.sessionId = sid;
    state.sessionId = sid;
    saveState();
    log('[admin] 附着对话 →', sid || '(空:下一句新建)');
    return sid;
  },
};

// ---- 起 ----
telos.connect();
board.start();
log(`网关就绪:附着对话=${state.sessionId || '(首句新建)'} 语音模式=${cfg.voiceMode}`);
