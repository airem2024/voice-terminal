// board/server.js — 小智协议服务端(《架构》四.1;字段对照官方 docs/websocket.md)
// 同端口两副面孔:HTTP(仅 /xiaozhi/ota/ 一个端点)+ WS 升级(语音通道)。
// OTA 端点:固件开机先 GET/POST 它拿配置,响应里的 websocket{url,token} 会被整个存进板子 NVS
// (ota.cc:168 ArrayForEach 透传),firmware.version 给 "0.0.0" 永远不触发自升级。
// ⚠️它吐 boardToken → 用 Device-Id(=板子 MAC,已知)做门槛;MAC 可伪造但 WS 层还有 token 关。
// 鉴权:WS 握手 Authorization: Bearer <token> + Device-Id 白名单(空名单=只验 token)
// 上行:hello / listen(start|stop|detect) / abort / mcp + 二进制 Opus(16k/60ms)
// 下行:hello / stt / llm(emotion) / tts(start|sentence_start|stop) / custom + 二进制 Opus(24k/60ms)
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));

class BoardServer extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.port = cfg.boardPort || 8791;
    this.token = cfg.boardToken || '';
    this.tzOffsetMin = Number(cfg.tzOffsetMin ?? 480);  // 下发给板子的时区偏移(分钟),默认北京 UTC+8
    this.allow = cfg.deviceAllow || [];
    // 板子从公网连回来的地址,OTA 应答里下发给它。**必须配**(config.json 的 publicWsUrl/
    // publicHttpUrl)——没有默认值可给,填错板子就连不回来。留空则 OTA 里不带,板子沿用它自己
    // NVS 里存的那个。
    this.publicWsUrl = cfg.publicWsUrl || '';
    this.publicHttpUrl = cfg.publicHttpUrl || '';
    // 绑哪个网卡。默认只听本机(前面套 nginx 的标准做法,最安全)。
    // **家里的电脑/树莓派当服务器时要填 `0.0.0.0`** —— 板子和它在同一个局域网,
    // 直连 192.168.x.x:8791 就行,不用公网、不用域名、不用 nginx。
    // ⚠️填 0.0.0.0 等于把控制台和 OTA 端点暴露给整个局域网(有 token 挡着,但别在公共 WiFi 下这么干)。
    this.bindHost = cfg.bindHost || '127.0.0.1';
    this.ota = cfg.ota || null;   // {version,file}:配了才推固件(见 _handleHttp)
    this.client = null;       // 单板;多卫星时改 Map(架构 九)
    this.sessionId = '';
    this._mcpId = 0;          // MCP 请求自增 id
    this._mcpWait = new Map(); // id → 等着回应的 resolver(见 /admin/mcp)
    this._lagN = 0; this._lagSum = 0; this._lagMax = 0; this._lagHits = 0; // 下行积压统计(见 sendAudio)

    this.ota = cfg.ota || null;   // {version,file}:配了才推固件(见 _handleHttp)
    this.client = null;       // 单板;多卫星时改 Map(架构 九)
    this.sessionId = '';
    this._mcpId = 0;          // MCP 请求自增 id
    this._mcpWait = new Map(); // id → 等着回应的 resolver(见 /admin/mcp)
    this._lagN = 0; this._lagSum = 0; this._lagMax = 0; this._lagHits = 0; // 下行积压统计(见 sendAudio)
  }
  _okDevice(dev) { return this.allow.length === 0 || this.allow.includes((dev || '').toLowerCase()) || this.allow.includes((dev || '').toUpperCase()) || this.allow.includes(dev || ''); }
  _handleHttp(req, res) {
    const url = (req.url || '').split('?')[0];
    // 固件分发:板子的 Ota::Upgrade 直接 GET 这个地址,整包写进另一个 ota 分区后重启切过去。
    // 配置在 config.json 的 ota:{version,file};版本号比板上的新才会触发(见 OTA 端点)。
    if (url === '/fw/firmware.bin') {
      const f = this.ota && this.ota.file;
      let st = null;
      try { st = f && fs.statSync(f); } catch (e) {}
      if (!st) { res.writeHead(404); return res.end(); }
      // 缓存策略(0815 定稿:public+immutable)。走完整段弯路才看清:
      // ①原本 no-store → `cf-cache-status: BYPASS` → 板子每次都**跨境回源到东京**、只跑 4KB/s,
      //   2.9MB 要十几分钟,这么长的连接在那条链路上**必断**;而 ota.cc 把 `Read()==0` 当成"下载正常结束",
      //   断了也照走 esp_ota_end → 校验不过 → 板上只显示"升级失败"(0815 实测:79 秒就断,约 300KB)。
      // ②我一度以为 0814 那次"卡在 OTA 页"是 CF 缓存害的,就回退了 no-store —— **判断错了**,
      //   回退等于把唯一的提速手段也关掉,当晚 v9 立刻又是同样的断流失败。
      // URL 带 ?v=<version> 已保证每版独立地址,缓存拿不到旧包;让 CF 边缘就近扛才是正解。
      // ⚠️真正的结构缺陷仍在:**固件下载没有断点续传**,链路一抖就得从头再来。要根治得让 ota 支持 Range。
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      this.emit('log', `固件分发中 ${(st.size / 1048576).toFixed(1)}MB → ${this.ota.version}`);
      // 计量:板子那边失败只会显示"升级失败",不说断在哪。这里记录实际发出的字节和耗时,
      // 断点位置能区分是链路中断(卡在某个字节)还是板端校验不过(发完了才失败)。
      const t0 = Date.now();
      let sent = 0;
      let ended = false;
      const done = (why) => {
        if (ended) return;
        ended = true;
        this.emit('log', `固件分发${why} ${(sent / 1048576).toFixed(2)}/${(st.size / 1048576).toFixed(2)}MB 用时${((Date.now() - t0) / 1000).toFixed(1)}s`);
      };
      const s = fs.createReadStream(f);
      s.on('data', (c) => { sent += c.length; });
      s.on('error', () => { done('读文件失败'); res.destroy(); });
      res.on('finish', () => done(sent >= st.size ? '完成' : '提前结束'));
      res.on('close', () => done('连接中断'));
      return s.pipe(res);
    }
    // 整片刷机包分发(0815 加,配 tools/flash.py)。为什么需要它:板子的 OTA 通道**只写 app 分区**(0x20000),
    // bootloader(0x0)/分区表(0x8000)/assets(0x800000) 一个都够不着——想换成微雪官方出厂固件(Brookesia,
    // 整包烧 0x0)、或把唤醒词模型刷进 assets,都只能走串口 esptool。
    // 与上面 /fw/firmware.bin 的关键差别:**支持 Range**。OTA 那条链路没有断点续传,跨境一抖就得从头再来
    // (0815 的固定失败模式);这里的包 15MB 起、更经不起断,所以直接把续传做进来。
    if (url.startsWith('/fw/file/')) {
      const q = new URLSearchParams((req.url || '').split('?')[1] || '');
      if ((req.headers['x-token'] || q.get('t') || '') !== this.token) { res.writeHead(403); return res.end(); }
      // basename + 白名单字符:这个端点直接拼路径,不挡住就是任意文件读取。
      const name = path.basename(decodeURIComponent(url.slice('/fw/file/'.length)));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(400); return res.end(); }
      const f = path.join(__dirname, 'firmware', name);
      let st = null;
      try { st = fs.statSync(f); } catch (e) {}
      if (!st || !st.isFile()) { res.writeHead(404); return res.end(); }
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      let start = 0, end = st.size - 1, code = 200;
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1);
        if (start >= st.size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        code = 206;
      }
      // 🔴清单必须 no-store。immutable 只对**带版本号、永不改内容**的固件包成立;
      // manifest.json 每次重新生成都变,被 CF 缓存住就等于所有换包都不生效。
      // 0815 踩过一半:换了 240 的新表情包却沿用 face-assets.bin 这个旧名,CF 照旧吐 6 小时前
      // 那份 2873427 字节的包,而 flash.py 本地正好有同样大小的残件 → Range 起点越界 → HTTP 416。
      // 包这边的解法是**改包就换名**(见 gen-manifest.js 的注释);清单这边只能靠 no-store。
      // immutable 只对**带版本号、内容永不变**的固件包成立。清单和刷机脚本都会改,
      // 缓存住就等于换包/改脚本全不生效 —— 0815 两次都踩了:
      //   ① face-assets.bin 沿用旧名 → CF 吐旧包 → flash.py 续传起点越界 → HTTP 416
      //   ② flash.py 自己加了新目标,用户重下却可能拿到缓存的旧脚本 → "没有 app 这个目标"
      // 固件包那边的解法是**改包就换名**(见 gen-manifest.js);这两个会变的文件只能 no-store。
      // 判据按**类型**而不是列名字:清单 + 所有 .py 脚本都会改,一律 no-store。
      // 0815 差点又踩:serial-relay.py 加了断线重连,但它不在名单里 → 被打 immutable →
      // CF 锁一年 → 用户重下永远是旧脚本。以后再加 .py 工具不用记得回来改这行。
      const mutable = name === 'manifest.json' || name.endsWith('.py');
      const isJson = name.endsWith('.json');
      const head = {
        'Content-Type': isJson ? 'application/json; charset=utf-8'
          : name.endsWith('.py') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': mutable ? 'no-store, must-revalidate' : 'public, max-age=31536000, immutable',
      };
      if (code === 206) head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      res.writeHead(code, head);
      if (req.method === 'HEAD') return res.end();
      this.emit('log', `刷机包 ${name} ${(start / 1048576).toFixed(1)}→${(end / 1048576).toFixed(1)}MB`);
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    // 板子串口日志回传(0815 加):ESP_LOGI 全在串口上,而串口插在用户的电脑、我在 VPS 上够不着。
    // 她电脑跑 tools/serial-relay.py 把串口逐行 POST 到这里,我就能实时看板子到底在干什么——
    // 在此之前我改固件全是盲改,每次都得她重启板子来当我的调试器(0814-0815 循环了整整两晚)。
    if (url === '/devlog') {
      if ((req.headers['x-token'] || '') !== this.token) { res.writeHead(403); return res.end(); }
      let buf = '';
      req.on('data', (d) => { if (buf.length < 262144) buf += d; });
      req.on('end', () => {
        try { fs.appendFileSync(path.join(__dirname, '..', 'serial.log'), buf); } catch (e) {}
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    // 走板子的 MCP 通道下命令(0815 加)。板子在 hello 里报 features.mcp,注册了一批 self.* 工具,
    // 其中三个是自主运维的关键:self.reboot、self.upgrade_firmware(直接给 URL 推固件,
    // **不必等用户重启板子**)、self.assets.set_download_url(唯一能更新 assets 分区的路子——
    // 普通 OTA 只写 app 分区 0x20000,唤醒词模型/字体在 0x800000 永远刷不到)。
    // tools/call 不校验 user_only(只有 tools/list 过滤),所以这些"用户专用"工具也能调。
    // 只绑 127.0.0.1 + token,不对公网开。
    // 控制台(0815 加):手机浏览器开 /admin?t=<token>,看状态 + 热调语音参数。
    // 数据源挂在 index.js 的 board.admin,这里只负责 HTTP 和鉴权 —— 配置逻辑不进协议层。
    // ⚠️ 页面必须 no-store:CF 会把 no-cache 改写成 max-age=14400,改完四小时看不到新版(踩过)。
    if (url === '/admin' || url === '/admin/state' || url === '/admin/apply'
        || url === '/admin/sessions' || url === '/admin/session' || url === '/admin/wake') {
      const aq = new URLSearchParams((req.url || '').split('?')[1] || '');
      if ((req.headers['x-token'] || aq.get('t') || '') !== this.token) { res.writeHead(403); return res.end('403'); }
      if (!this.admin) { res.writeHead(503); return res.end('控制台未挂载'); }
      if (url === '/admin') {
        let html = '';
        try { html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); }
        catch (e) { res.writeHead(500); return res.end('admin.html 读不到'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (url === '/admin/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(this.admin.state()));
      }
      // 列对话:要往 telos 发一趟请求,可能超时,所以单独一个端点、不拖累 2 秒一次的 /admin/state
      if (url === '/admin/sessions') {
        this.admin.sessions().then((list) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, sessions: list }));
        }).catch((e) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: e.message, sessions: [] }));
        });
        return;
      }
      if (url === '/admin/session') {
        let sessBody = '';
        req.on('data', (d) => { if (sessBody.length < 8192) sessBody += d; });
        req.on('end', () => {
          let p = null;
          try { p = JSON.parse(sessBody || '{}'); } catch (e) { res.writeHead(400); return res.end('bad json'); }
          const sid = this.admin.setSession(p.id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, session: sid }));
        });
        return;
      }
      // 唤醒语:GET 读当前的,POST {text} 只预览拼音,POST {text,tokens,save:true} 才落盘+重载。
      // 预览和保存分开是因为多音字必须让人看见转出来的音、手改了再存(自动转换按标准音来,名字常不按)。
      if (url === '/admin/wake') {
        const done = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(obj));
        };
        if (!this.admin.wake) return done(503, { error: '这版网关不支持改唤醒语' });
        if (req.method !== 'POST') { try { return done(200, this.admin.wake.read()); } catch (e) { return done(500, { error: e.message }); } }
        let wkBody = '';
        req.on('data', (d) => { if (wkBody.length < 8192) wkBody += d; });
        req.on('end', () => {
          let p = null;
          try { p = JSON.parse(wkBody || '{}'); } catch (e) { return done(400, { error: 'bad json' }); }
          try {
            if (!p.save) return done(200, this.admin.wake.preview(p.text || ''));
            return done(200, { ok: true, ...this.admin.wake.set(p.text || '', p.tokens || '') });
          } catch (e) { return done(200, { error: e.message }); }   // 200 + error:控制台要把原因显示出来
        });
        return;
      }
      // POST /admin/apply —— 变量名避开上面 /devlog 用的 b(块级作用域虽然隔开了,
      // 但 0815 那次 TDZ 就是同名变量咬的,不给自己留这种机会)
      let adminBody = '';
      req.on('data', (d) => { if (adminBody.length < 65536) adminBody += d; });
      req.on('end', () => {
        let patch = null;
        try { patch = JSON.parse(adminBody || '{}'); } catch (e) { res.writeHead(400); return res.end('bad json'); }
        let applied = {};
        try { applied = this.admin.apply(patch); }
        catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, applied, state: this.admin.state() }));
      });
      return;
    }
    if (url === '/admin/mcp') {
      // query token 也认:控制台页面统一走 ?t=,不必为这一个端点单开 header(0815)
      const mq = new URLSearchParams((req.url || '').split('?')[1] || '');
      if ((req.headers['x-token'] || mq.get('t') || '') !== this.token) { res.writeHead(403); return res.end(); }
      let b = '';
      req.on('data', (d) => { if (b.length < 65536) b += d; });
      req.on('end', () => {
        if (!this.client || this.client.readyState !== WebSocket.OPEN) {
          res.writeHead(503); return res.end(JSON.stringify({ error: '板子不在线' }));
        }
        let payload; try { payload = JSON.parse(b); } catch (e) { res.writeHead(400); return res.end('bad json'); }
        const id = ++this._mcpId;
        payload.jsonrpc = '2.0'; payload.id = id;
        const timer = setTimeout(() => {
          this._mcpWait.delete(id);
          res.writeHead(504); res.end(JSON.stringify({ error: '板子没回应(15s)' }));
        }, 15000);
        this._mcpWait.set(id, (r) => {
          clearTimeout(timer);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r));
        });
        this.send({ type: 'mcp', payload });
        this.emit('log', `[mcp] → ${payload.method} ${JSON.stringify(payload.params || {}).slice(0, 120)}`);
      });
      return;
    }
    if (url === '/xiaozhi/ota/' || url === '/xiaozhi/ota') {
      const dev = req.headers['device-id'] || '';
      if (!this._okDevice(dev)) {
        this.emit('log', `OTA 拒绝 device=${dev || '(无)'}`);
        res.writeHead(404); return res.end();
      }
      // POST body 是板子自报家门:{application:{version,...},board:{...}}。
      // 0814 用户"我都没法确定 v6 是否更新成功"——根因就是这里老写法把 body 丢了,
      // 板子明明每次开机都告诉我它是哪版,我却没记。现在解出来打进日志。
      // ⚠️变量名必须避开 body:这个 end 回调后面有 `const body = JSON.stringify(...)`(响应体),
      // 再在前面声明同名的 let body 会让**整个回调作用域**的 body 进入 TDZ,
      // JSON.parse(reqBody) 抛 ReferenceError。第一版的 `catch (e) {}` 把它静默吞了 →
      // 版本日志永远不打、还一声不吭,害我先去怀疑 4096 截断(0814 真·根因)。
      let reqBody = '';
      req.on('data', (d) => { if (reqBody.length < 65536) reqBody += d; });
      req.on('end', () => {
        let cur = '', diag = '';
        try {
          const j = JSON.parse(reqBody);
          cur = ((j.application || {}).version) || '';
          if (!cur) diag = `JSON 里没有 application.version,顶层键=[${Object.keys(j).join(',')}]`;
        } catch (e) {
          diag = `解析失败 method=${req.method} body=${reqBody.length}字节 err=${e.message}`;
        }
        if (cur) {
          const want = (this.ota && this.ota.version) || '';
          this.emit('log', `板子自报版本 ${cur}${want && want !== cur ? ` → 将升级到 ${want}` : '(已是最新)'}`);
        } else {
          // 0814:改完 4096→65536 上限后版本还是读不出来,说明根因不在截断。别再猜了,把实情记下来。
          this.emit('log', `[诊断] 读不到板子版本 — ${diag || 'body 为空'}`);
        }
        // 没配 ota 就报 0.0.0(永远不升级);配了就报真版本号 + 下载地址,板子自己比对版本决定升不升。
        // publicHttpUrl 没配就别推固件:拼出来会是个相对路径,板子下不到、还报"升级失败"
        const fw = (this.ota && this.ota.version && this.ota.file && this.publicHttpUrl)
          // URL 必须带版本号:CF 会缓存这个地址(0814 实测缓存住了旧包,板子每次下到的都是上一版,
          // 更糟的是那份缓存是被重启打断的半截响应 → 板端校验必然失败 = "升级失败")。
          // 每个版本一个独立地址,天然绕开任何中间缓存。
          ? { version: this.ota.version, url: this.publicHttpUrl + 'fw/firmware.bin?v=' + encodeURIComponent(this.ota.version) }
          : { version: '0.0.0', url: '' };
        const payload = {
          firmware: fw,
          // 板子拿这个偏移显示时间。0815 从 540(东京 UTC+9)改成 480(北京 UTC+8)——
          // 之前板上的钟一直快一小时。系统时区保持 UTC 不动(心跳 cron 是按 UTC 换算配的,改了全乱)。
          server_time: { timestamp: Date.now(), timezone_offset: this.tzOffsetMin },
        };
        // 没配 publicWsUrl 就整个字段不发 —— 下发一个空 url 会把板子 NVS 里存的那个覆盖掉,
        // 它从此连不回来,而且只能靠串口救。宁可不改。
        if (this.publicWsUrl) payload.websocket = { url: this.publicWsUrl, token: this.token };
        const body = JSON.stringify(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        this.emit('log', `OTA 已发配置 device=${dev}`);
      });
      return;
    }
    res.writeHead(404); res.end();
  }
  start() {
    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocket.Server({
      server: this.httpServer,
      verifyClient: (info, cb) => {
        const h = info.req.headers;
        const okToken = h.authorization === 'Bearer ' + this.token;
        const okDev = this._okDevice(h['device-id']);
        if (okToken && okDev) return cb(true);
        this.emit('log', `拒绝板子连接 device=${h['device-id'] || ''} token=${okToken ? 'ok' : 'bad'}`);
        cb(false, 401, 'Unauthorized');
      },
    });
    this.httpServer.listen(this.port, this.bindHost);
    this.wss.on('connection', (ws, req) => {
      ws._dev = req.headers['device-id'] || '?';
      ws.isAlive = true;
      // pong 往返时间 = 板子到 VPS 的真实网络质量。WiFi 一差它就飙,是"说话卡"最直接的先行指标。
      // 只在异常时出声(>1.5s 或比历史最好值差一个量级),平时不刷屏。
      ws.on('pong', () => {
        ws.isAlive = true; ws._missed = 0;
        if (!ws._pingAt) return;
        const rtt = Date.now() - ws._pingAt; ws._pingAt = 0;
        ws._rttMin = Math.min(ws._rttMin ?? rtt, rtt);
        ws._rttMax = Math.max(ws._rttMax ?? rtt, rtt);
        ws._rttN = (ws._rttN || 0) + 1; ws._rttSum = (ws._rttSum || 0) + rtt;
        // 0815 直连实验的主仪表。旧阈值 1500ms 太高,把「最好也要 550ms」这个事实一直藏在底下——
        // 那 550ms 根本不是板子慢,是音频每帧都在跨 Cloudflare 隧道绕行(板子→CF 边缘→cloudflared→8791)。
        // 板子固件解码队列硬上限 2400ms(MAX_DECODE_PACKETS_IN_QUEUE=2400/60=40 帧),抖动一旦超过它就断音,
        // 而实测抖到过 3082ms。直连 Tokyo 预期 50~80ms,所以阈值降到 400ms:直连正常时不会响,
        // 一响就说明这条路也在抖。
        if (ws._rttN === 1) {
          this.emit('log', `[net] 首拍心跳 ${rtt}ms ← 链路体检值(直连预期 50~80ms;走 CF 隧道时最好 550ms)`);
        } else if (rtt > 400 || (ws._rttMin > 0 && rtt > ws._rttMin * 10)) {
          this.emit('log', `[net] 心跳往返 ${rtt}ms(最好 ${ws._rttMin}ms) ← 链路在抖`);
        }
        // 每 10 拍(约 200s)汇总一次分布:零散告警看不出全貌,要的是「最差值有没有摸到 2400ms」。
        if (ws._rttN % 10 === 0) {
          this.emit('log', `[net] 心跳 ${ws._rttN} 拍统计:最好 ${ws._rttMin}ms / 最差 ${ws._rttMax}ms / 均 ${Math.round(ws._rttSum / ws._rttN)}ms`);
        }
      });
      if (this.client && this.client.readyState === WebSocket.OPEN) this.client.close(); // 单板:新连接顶掉旧的
      this.client = ws;
      ws._since = Date.now();   // 连接时刻(断开时用来报"连了多久"——短命连接=信号问题)
      this.emit('log', `板子已连接 device=${ws._dev}`);
      ws.on('message', (data, isBinary) => {
        if (isBinary) { this.emit('audio', data); return; }
        let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
        switch (m.type) {
          case 'hello':
            this.sessionId = crypto.randomUUID();
            this._raw({ type: 'hello', transport: 'websocket', session_id: this.sessionId,
              audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 } });
            this.emit('hello', m);
            break;
          case 'listen': this.emit('listen', m); break;
          case 'abort': this.emit('abort', m); break;
          case 'pose': this.emit('pose', m); break;   // 板载 IMU 的姿态/摇晃(v2.4.13+ 固件才有)
          case 'memstat': this.emit('memstat', m.m || {}); break;  // 板子每 10 秒自报内存(v2.4.15+)
          case 'mcp': {   // 板子对 /admin/mcp 请求的回应,按 id 交回给等着的那个 HTTP 请求
            const p = m.payload || {};
            const cb = this._mcpWait.get(p.id);
            if (cb) { this._mcpWait.delete(p.id); cb(p); }
            this.emit('log', `[mcp] ← ${JSON.stringify(p).slice(0, 200)}`);
            break;
          }
          default: this.emit('msg', m);
        }
      });
      // 0815:断连必须留痕。用户报"说着话还卡,卡了之后直接返回待命",现场日志在 speaking 之后
      // 整整 4 分钟一片空白 —— 因为这里只 emit、不打日志,板子掉线在日志里完全隐形,
      // 而掉线的表现恰好就是"声音停住、屏幕回待命"。close code 尤其要记:
      // 1006=没收到 close 帧的异常断开(网络/信号),1001=板子主动走,1000=正常收尾。
      ws.on('close', (code, reason) => {
        if (this.client !== ws) return;
        this.client = null;
        const sec = ws._since ? Math.round((Date.now() - ws._since) / 1000) : -1;
        const r = String(reason || '').slice(0, 40);
        this.emit('log', `板子断开 device=${ws._dev} code=${code}${r ? ' reason=' + r : ''} 已连接${sec}s` +
          (code === 1006 ? '  ← 异常断开(没有 close 帧),多半是 WiFi/信号' : ''));
        this.emit('disconnect', ws._dev);
      });
      ws.on('error', (e) => this.emit('log', 'board ws error: ' + e.message));
      this.emit('connect', ws._dev);
    });
    // 协议级心跳(过 cloudflared 时防 ~100s 空闲回收,与 bridge 同款)
    this._ping = setInterval(() => {
      if (!this.client) return;
      if (this.client.isAlive === false) {
        // 上一轮 ping 没等到 pong。这条以前是静默 terminate,于是板子"说着说着没声了"
        // 在日志里找不到任何线索(0815)。
        // ⚠️只给一次机会太狠:实测板子忙起来心跳往返能到 3082ms(最好才 550ms),
        // 它是在一颗 ESP32 上同时做解码+播放+AEC+刷屏,偶尔顾不上回 pong 很正常。
        // 被 terminate 掉 = 正在播的音频当场全丢、板子回待命 —— 那正是用户报的症状。
        // 给两轮(40s)宽限,真死了也就晚 20 秒清理,板子本来就会自己重连。
        this.client._missed = (this.client._missed || 0) + 1;
        if (this.client._missed < 2) {
          this.emit('log', `心跳没回(第${this.client._missed}次,20s),再等一轮`);
        } else {
          this.emit('log', '心跳连续两轮没回(40s),判定连接已死 → 强制断开');
          try { this.client.terminate(); } catch (e) {}
          return;
        }
      }
      this.client.isAlive = false;
      this.client._pingAt = Date.now();
      try { this.client.ping(); } catch (e) {}
    }, 20000);
    this.emit('log', `小智协议端就绪 ${this.bindHost}:${this.port}(WS+OTA)`);
    // 这两个漏配不会立刻报错,但板子会连不回来/升不了级 —— 说在前面
    if (!this.publicWsUrl) this.emit('log', '⚠️没配 publicWsUrl:OTA 不会下发服务器地址,板子只能沿用它自己存的');
    if (!this.publicHttpUrl) this.emit('log', '⚠️没配 publicHttpUrl:固件推送整个不可用');
    return this;
  }
  stop() { clearInterval(this._ping); try { this.wss.close(); } catch (e) {} try { this.httpServer.close(); } catch (e) {} }

  _raw(obj) { if (this.client && this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(obj)); }
  send(obj) { this._raw(Object.assign({ session_id: this.sessionId }, obj)); }
  // 下行音频。**唯一没有仪表的一段**(0815):服务端侧 TTS 快 11x 实时、Opus 编码快 58x、
  // 发送定时器零抖动 —— 全都实测过了,可用户还是听着卡。剩下只可能是 VPS→板子这段网络。
  // ws.send 是"交给内核"就返回,网络供不上时帧堆在 socket 缓冲里,服务端浑然不觉
  // (clock 照常推进、欠载数为 0),板子那头却在断断续续。bufferedAmount 就是那个堆积量:
  // 一帧 60ms 音频约 100-200 字节,持续 >8KB 意味着积压 >3 秒 = 板子必然断音。
  sendAudio(frame) {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(frame, { binary: true });
    const b = this.client.bufferedAmount || 0;
    this._lagN++; this._lagSum += b;
    if (b > this._lagMax) this._lagMax = b;
    if (b > 4096) this._lagHits++;
  }
  // 每轮播完报一次积压情况(index.js 的 stopSpeaking 调),0 积压 = 网络跟得上,卡顿在板子端。
  reportLag() {
    if (!this._lagN) return;
    const avg = Math.round(this._lagSum / this._lagN);
    if (this._lagMax > 1024) {
      this.emit('log', `[net] 下行积压 均${avg}B 峰${this._lagMax}B 超4KB ${this._lagHits}帧/${this._lagN}帧` +
        (this._lagMax > 8192 ? '  ← 网络供不上,板子必然断音' : ''));
    } else {
      this.emit('log', `[net] 下行积压 峰${this._lagMax}B (${this._lagN}帧) — 网络通畅`);
    }
    this._lagN = this._lagSum = this._lagMax = this._lagHits = 0;
  }

  tts(state, text) { const m = { type: 'tts', state }; if (text) m.text = text; this.send(m); }
  stt(text) { this.send({ type: 'stt', text }); }
  // 反向请板子退出聆听态回待机(官方固件没这条下行,是 v2 自家固件加的;老固件当未知消息忽略)
  listenStop() { this.send({ type: 'listen', state: 'stop' }); }
  // ---- 方案 C(唤醒词搬服务端)的三条下行,都要 v2.4.13+ 固件才认;老固件当未知消息忽略,无害 ----
  // ①常驻聆听:板子一直采音上传(否则服务端根本听不见唤醒词),但屏上显示**待命** ——
  //   passive 就是这个意思:在采音,不代表"正在听你说话"。
  listenPassive() { this.send({ type: 'listen', state: 'start', passive: true }); }
  // ②唤醒词检出:这下是真的在听了,屏上换成"聆听中"
  listenActive() { this.send({ type: 'listen', state: 'start' }); }
  // ③回合结束:UI 收回"待命",但 keep=true **别停采音** —— 停了就再也听不见下一次唤醒。
  listenIdle() { this.send({ type: 'listen', state: 'stop', keep: true }); }
  // 主动给板子下一条 MCP 命令(不等回应)。控制台改字幕节奏就走这儿 ——
  // /admin/mcp 那条路要挂 HTTP 响应,内部调用不需要,失败(板子不在线)返回 false 由调用方决定要不要重来。
  mcpCall(name, args) {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return false;
    const id = ++this._mcpId;
    this.send({ type: 'mcp', payload: { jsonrpc: '2.0', id, method: 'tools/call',
                                        params: { name, arguments: args || {} } } });
    this.emit('log', `[mcp] → tools/call ${name} ${JSON.stringify(args || {})}`);
    return true;
  }
  emotion(emo) { this.send({ type: 'llm', emotion: emo }); }
  custom(payload) { this.send({ type: 'custom', payload }); }
}

module.exports = { BoardServer };
