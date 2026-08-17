// telos-client.js — 网关的 telos WS 客户端
// 协议红线(《实施计划》二.D,均有实测/探查依据,别松):
//  - 不发 tz / push_pref / presence(foreground:true) —— 会污染全局时区/推送/在场判定
//  - auth 带 client:'gateway' —— 配合 server 的 headless 标记(不抢手机的唤醒补发)
//  - 同对话串行:一次只有一个 in-flight turn,busy 时只排最新一条(服务端没有 per-session 队列)
//  - 不带 model/effort —— 跟对话 pref 走,换模型会击穿前缀缓存(实测 $0.17-0.50/轮)。
//    bridge 侧 `_pref` 回落已就位(server.js 那段注释点名本网关),所以"不带"才是正解;
//    但 pref 缺失时它最终会落到 **CLI 全局默认**,而那个值实测是 `opus[1m]` ——
//    见下面 turn_error 里的降级自愈,别把这条保险摘了。
//  - 回合结束以 turn_end 为准 —— mood 标记开始流之后 delta 会被静默吞掉
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const DEFAULTS = {
  url: 'ws://127.0.0.1:8790',
  safeModel: 'claude-opus-5',  // 撞 1M 付费墙时的降级目标(base 实测就是 1M 窗口,不带后缀零损失)
  telosConfigPath: path.join(__dirname, '..', 'server', 'config.json'),
  turnTimeoutMs: 300000, // 想太久 75s 后网关已承诺"想好了我叫你",这里放宽到 5min 别让长工具链的回合落空
};

function genId() { return 'gw' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

class TelosClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.token = this.opts.token || JSON.parse(fs.readFileSync(this.opts.telosConfigPath, 'utf8')).token;
    this.ws = null;
    this.authed = false;
    this.backoff = 1000;
    this.closed = false;
    this.turn = null;     // in-flight: {turnId,sessionId,resolve,reject,timer,lastI,deltaText,reply,t}
    this.pending = null;  // 排队的下一条(只留最新,旧的 reject 'superseded')
  }

  connect() {
    if (this.closed) return;
    const ws = this.ws = new WebSocket(this.opts.url);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: this.token, client: 'gateway' })));
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } this._onMsg(m); });
    ws.on('error', (e) => this.emit('log', 'ws error: ' + e.message));
    ws.on('close', () => {
      this.authed = false;
      if (this.closed) return;
      const wait = this.backoff = Math.min(this.backoff * 2, 30000);
      this.emit('log', `连接断开,${wait}ms 后重连`);
      setTimeout(() => this.connect(), wait);
    });
  }

  close() { this.closed = true; try { this.ws.close(); } catch (e) {} }

  _send(obj) { try { this.ws.send(JSON.stringify(obj)); } catch (e) { this.emit('log', 'ws send 失败: ' + e.message); } }

  _onMsg(m) {
    switch (m.type) {
      case 'auth_ok':
        this.authed = true; this.backoff = 1000;
        this.emit('ready', m);
        // 断线期间还挂着的 turn:服务端留 10 分钟宽限,attach 续流(after=最后收到的事件序号)
        if (this.turn) this._send({ type: 'attach', turnId: this.turn.turnId, after: this.turn.lastI });
        else this._drain();
        return;
      case 'auth_fail':
        this.emit('log', 'auth 失败(token 不对?)'); this.close(); return;
      case 'mood': this.emit('mood', m); return;          // 广播:{sessionId, mood:{on,label,note,wind,at}}
      case 'wake_message': this.emit('wake', m); return;  // 她主动唤醒的产出
      case 'sessions': {                                  // listSessions() 的回包(控制台换附着对话用)
        const w = this._sessWait; this._sessWait = null;
        if (w) { clearTimeout(w.timer); w.resolve(m.sessions || []); }
        return;
      }
    }
    const t = this.turn;
    if (!t || m.turnId !== t.turnId) return;
    if (typeof m._i === 'number') t.lastI = m._i;
    switch (m.type) {
      case 'turn_start': t.t.start = Date.now(); this.emit('turn_start', t.turnId); break;
      case 'session_init':
        if (m.sessionId) { t.sessionId = m.sessionId; this.emit('session', m); }
        break;
      case 'thinking': this.emit('thinking', m.text || ''); break;
      case 'assistant_delta':
        if (!t.t.firstDelta) t.t.firstDelta = Date.now();
        t.deltaText += (m.text || '');
        this.emit('delta', m.text || '');
        break;
      case 'assistant_text':
        // block 完成后的清洗版全文(已剥 mood 标记、媒体路径已改写)——比 delta 累积可靠
        t.reply.push(m.text || '');
        this.emit('text', m.text || '');
        break;
      case 'tool_use': this.emit('tool', m); break;
      case 'turn_end': this._finish(null, m); break;
      case 'turn_error': {
        const em = String(m.message || m.error || 'turn_error');
        // 撞 1M 付费墙 → 换 safeModel 重发一次,别让用户去查板子为什么突然哑了。
        // 触发路径:本对话在 sessmodel.json 里没有 pref(例如控制台刚新建的对话),bridge 的
        // `_pref` 回落落空 → 用 CLI 全局默认 → 实测那个值是 `opus[1m]` → 该变体要另买 credits。
        // 0814 就是这样每句话都哑的,当时靠网关硬钉模型治标,现在改成只在真撞墙时降级。
        if (!t.retried && /usage credits required for 1m/i.test(em)) {
          this.emit('log', `撞 1M 付费墙,改用 ${this.opts.safeModel} 重发一次`);
          clearTimeout(t.timer);
          this.turn = null;
          this._start({ text: t.text, sessionId: t.sessionId, resolve: t.resolve, reject: t.reject, retried: true });
          return;
        }
        this._finish(new Error(em));
        break;
      }
    }
  }

  // 请求 mood 全量(回包走 'mood' 事件,含 events/baseline)
  moodGet(sessionId) { this._send({ type: 'mood_get', sessionId }); }

  // 列对话(控制台换附着对话用)。bridge 的回包不带 turnId,所以走上面独立的 'sessions' case。
  // 同一时刻只留一个在途请求:控制台可能连点两下,复用同一个 Promise 比让先发的那个超时干净。
  listSessions(limit = 200) {
    if (this._sessWait) return this._sessWait.promise;
    if (!this.authed || !this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('telos 未连接'));
    const w = {};
    w.promise = new Promise((resolve, reject) => {
      w.resolve = resolve;
      w.timer = setTimeout(() => { if (this._sessWait === w) this._sessWait = null; reject(new Error('列对话超时')); }, 15000);
    });
    this._sessWait = w;
    this._send({ type: 'list_sessions', limit });
    return w.promise;
  }

  // 发一句话。resolve 于 turn_end:{sessionId, text, cost, timings}
  say(text, sessionId) {
    return new Promise((resolve, reject) => {
      const job = { text, sessionId, resolve, reject };
      if (this.turn || !this.authed) {
        if (this.pending) this.pending.reject(new Error('superseded'));
        this.pending = job;
        if (this.turn) this.emit('log', '上一轮未结束,已排队(只留最新)');
        return;
      }
      this._start(job);
    });
  }

  _start(job) {
    const turnId = genId();
    this.turn = {
      turnId, sessionId: job.sessionId || '',
      resolve: job.resolve, reject: job.reject,
      text: job.text,                 // 撞付费墙时要拿它重发
      retried: !!job.retried,         // 只降级一次,别绕成死循环
      lastI: -1, deltaText: '', reply: [],
      t: { send: Date.now(), start: 0, firstDelta: 0, end: 0 },
      timer: setTimeout(() => this._finish(new Error('turn 超时(' + this.opts.turnTimeoutMs + 'ms)')), this.opts.turnTimeoutMs),
    };
    // 模型:配了 opts.model 就钉死;否则**不带**,让 bridge 回落到本对话 pref(见文件头红线)。
    // 降级重发那一趟(job.retried)才显式带 safeModel。**任何时候都别带 [1m] 后缀** ——
    // 那是个要另买 credits 的独立 SKU,而 base `claude-opus-5` 实测窗口本来就是 1M(modelwin.json),
    // 带后缀纯亏一道付费墙。
    const msg = { type: 'send', text: job.text, mode: 'bypass', turnId };
    const model = job.retried ? this.opts.safeModel : this.opts.model;
    if (model) msg.model = model;
    if (job.sessionId) msg.sessionId = job.sessionId;
    this._send(msg);
  }

  _finish(err, endMsg) {
    const t = this.turn; if (!t) return;
    clearTimeout(t.timer);
    t.t.end = Date.now();
    this.turn = null;
    if (err) t.reject(err);
    else t.resolve({
      sessionId: t.sessionId,
      text: t.reply.join('\n') || t.deltaText,
      cost: (endMsg && endMsg.cost) || 0,
      timings: {
        start: t.t.start ? t.t.start - t.t.send : -1,
        firstDelta: t.t.firstDelta ? t.t.firstDelta - t.t.send : -1,
        total: t.t.end - t.t.send,
      },
    });
    this._drain();
  }

  _drain() {
    if (this.pending && !this.turn && this.authed) {
      const j = this.pending; this.pending = null; this._start(j);
    }
  }
}

module.exports = TelosClient;
