'use strict';
// ---------------------------------------------------------------------------
// 手机工作台：把派活面板搬到手机上。
//
//   进入   面板点「手机工作台」→ 二维码（局域网地址 + 随机口令）→ 手机扫码
//   实时   SSE 长连接（EventSource），终端一有动静就整包推状态，断了自动重连
//   操作   派活（终端开在电脑上）、放行/拒绝（借 focus-window.ps1 把确认键
//          送进那个终端窗口 —— 只有窗口真到前台才发键，绝不误发）
//
// 零依赖（node 自带 http），跟局域网更新（updates.js）一个路数。
// 安全三道闸：随机口令（不带就 401）、只有 waiting 的线才收放行、
// 服务不开就完全不存在（mobile.enabled 默认关）。
// 【边界】扫码的人就是主人 —— 别把二维码发到群里。口令进了手机就存在
// 那台手机上、从地址栏抹掉（页面那头做的），所以别把**网址**当秘密防线。
// ---------------------------------------------------------------------------
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

/** 口令比对：长度不同直接假，相同就恒时比较（别给猜口令的人计时器） */
function tokenOk(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!want || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

/** 二进制收包（传文件走这条）。上限单独给 —— 手机拍的照片动辄五六 MB */
function readBytes(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { req.destroy(); reject(new Error('文件太大')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > cap) { req.destroy(); reject(new Error('载荷太大')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * hooks 契约（全部由 main 注入，这个模块不 require 任何业务模块）：
 *   full(id)        这条线的完整对话（按轮切开，从新到旧）
 *   state()            -> 整包状态（页面渲染要的全部）
 *   detail(id)         -> 这条线的详情 + 时间线（手机点开看的）
 *   dispatch(opts)     -> { ok, ... } 在电脑上开一条最小化终端线
 *   send(id, text)     -> { ok, error? } 往那条线的终端里追问一句
 *   approve(id, allow) -> { ok, error? } 把确认键送进那个终端窗口
 *   browse(dir)        -> { cwd, parent, dirs[], files[] } 让手机能翻电脑上的东西
 *   lanes(dir)         -> [{laneId,name,lastRun,alive,turns,hint}] 这个项目留着的线
 *   interrupt(id)      -> { ok, error? } 把 Esc 送进那个终端窗口（叫停）
 *   upload(name, buf)  -> { ok, path?, name?, error? } 手机上的图/文件落到电脑上
 *   peek(id)           -> { ok, file? } 那个终端窗口现在长什么样（截一张）
 *   key(id, name)      -> { ok, error? } 往那个窗口按一个**名单里**的键
 */
function createMobileServer({ pageFile, token, hooks, log, iconFile }) {
  const clients = new Set(); // SSE 连接
  let pushTimer = null;

  const server = http.createServer(async (req, res) => {
    const url = String(req.url || '');
    const [pathname, query] = url.split('?');
    const params = new URLSearchParams(query || '');
    const got = params.get('t') || req.headers['x-waifu-token'];

    const deny = () => { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('没口令不让进'); };
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    try {
      // 【这两件不看口令】装成 App 时浏览器自己去取 manifest 和图标，
      // **不会带上我们这个 ?t=** —— 要口令的话「加到主屏」出来的就是白图标。
      // 里面没有任何私货：一个名字、一个图标，跟 401 页面暴露的信息量一样
      if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
        res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
        return res.end(JSON.stringify({
          name: '小依 · 手机工作台', short_name: '小依', start_url: '.', scope: '.',
          display: 'standalone', background_color: '#0d0f16', theme_color: '#0d0f16',
          icons: [{ src: 'icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
        }));
      }
      if (req.method === 'GET' && pathname === '/icon.png' && iconFile) {
        try {
          const buf = fs.readFileSync(iconFile);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
          return res.end(buf);
        } catch (_) { res.writeHead(404); return res.end(); }
      }

      if (!tokenOk(got, token)) return deny();

      if (req.method === 'GET' && pathname === '/') {
        // 页面每次现读盘 —— 开发时改了页面刷新就生效，没有缓存陷阱
        const html = fs.readFileSync(pageFile, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        return json(200, await hooks.state());
      }

      // 一条线的详情（时间线在这儿）—— 手机点开任务看的就是它
      if (req.method === 'GET' && pathname === '/api/detail') {
        const d = await hooks.detail(String(params.get('id') || ''));
        return d ? json(200, d) : json(404, { error: '这条线不在了' });
      }

      // 这条线的**完整对话**（时间线上每段的「查看全部」点的就是它）。
      // 内存里的时间线是给一眼扫的（每条截 300 字），细节在会话档案里
      if (req.method === 'GET' && pathname === '/api/full') {
        const r = await hooks.full(String(params.get('id') || ''));
        return json(200, r || { ok: false, why: '这条线不在了', turns: [] });
      }

      /**
       * 手机上的图/文件传到电脑上，回一个**电脑上的路径**，你再把它丢给那条线。
       *
       * 【为什么不走 multipart】就一个文件，没必要拉一个解析器进来：
       * 文件名走查询串，正文就是**裸字节**。少一层解析＝少一批边界情况。
       *
       * 【安全全在 main 那头】这个模块不认业务规则：名字怎么洗、允许什么后缀、
       * 落到哪个目录，全由 upload 钩子说了算。这儿只管上限（别让人拿一个
       * 无限长的请求把内存撑爆）。
       */
      if (req.method === 'POST' && pathname === '/api/upload') {
        let buf;
        try { buf = await readBytes(req, 25 * 1024 * 1024); }
        catch (err) { return json(413, { ok: false, error: '文件太大（最多 25MB）' }); }
        const r = await hooks.upload(String(params.get('name') || ''), buf);
        if (log) log('[mobile] 收文件 ' + params.get('name') + ' -> ' + ((r && r.ok) ? r.path : (r && r.error) || '没收下'));
        return json(r && r.ok ? 200 : 400, r || { ok: false, error: '没收下' });
      }

      /**
       * 那个终端窗口现在长什么样。**直接把 PNG 吐回去**（不是路径）——
       * 手机够不到电脑的文件系统。
       *
       * 【为什么要有】CLI 会弹一些我们不知道的界面（codex 的「Hooks need
       * review」、/model 的选择面板…），那时候 hook 和档案里什么都没有，
       * 手机上就是「这条线彻底没回应」。人在外面不可能专门跑回电脑前点。
       */
      if (req.method === 'GET' && pathname === '/api/peek') {
        const r = await hooks.peek(String(params.get('id') || ''));
        if (!r || !r.ok || !r.file) return json(400, r || { ok: false, error: '截不下来' });
        try {
          const buf = fs.readFileSync(r.file);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(buf);
        } catch (err) { return json(400, { ok: false, error: '图读不出来' }); }
      }

      // 往那个窗口按一个键（配合上面那张截图）。**键名由 main 那头的名单说了算**
      if (req.method === 'POST' && pathname === '/api/key') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await hooks.key(String(body.id || ''), String(body.key || ''));
        if (log) log('[mobile] 按键 ' + body.key + ' -> ' + ((r && r.ok) ? '送到了' : (r && r.error) || '没送到'));
        return json(200, r || { ok: false, error: '没送到' });
      }

      // 这个项目留着的线（关掉的窗口也能接回去）—— 手机原来只能接**还开着**的
      if (req.method === 'GET' && pathname === '/api/lanes') {
        return json(200, { lanes: (await hooks.lanes(params.get('dir') || '')) || [] });
      }

      // 叫停：把 Esc 送进那个终端窗口。**只是送键**，跟放行同一条路子 ——
      // 她正在跑的那一步能不能被打断，是那个 CLI 自己的事
      if (req.method === 'POST' && pathname === '/api/interrupt') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = await hooks.interrupt(String(body.id || ''));
        if (log) log('[mobile] 叫停 ' + body.id + ' -> ' + ((r && r.ok) ? '送到了' : (r && r.error) || '没送到'));
        return json(200, r || { ok: false, error: '停不了' });
      }

      // 翻电脑上的东西（手机上没法调系统选择器，只能这么来）。
      // **只给名字路径类型大小，绝不读内容** —— 这个口只为「挑一个」服务
      if (req.method === 'GET' && pathname === '/api/browse') {
        return json(200, await hooks.browse(params.get('dir') || ''));
      }

      // 往那条线继续说一句（追问 / 下一步指令）
      if (req.method === 'POST' && pathname === '/api/send') {
        const body = JSON.parse(await readBody(req) || '{}');
        const id = String(body.id || '');
        const text = String(body.text || '');
        if (!id || !text.trim()) return json(400, { ok: false, error: '要说的话和终端 id 都得有' });
        const r = await hooks.send(id, text);
        if (log) log('[mobile] 追问 ' + id + ' -> ' + JSON.stringify(r));
        return json(200, r);
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        if (clients.size >= 8) return json(429, { error: '连的人太多了' });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          // 出门模式下这条长连接要穿过 Cloudflare 的边缘：不给这两个头的话
          // 那层会把内容攒着压缩再发，手机上就是「一直转圈、任务全空」。
          // no-transform 挡压缩，x-accel-buffering 是反代通用的「别缓冲」暗号
          'cache-control-extra': 'no-transform',
          'x-accel-buffering': 'no',
        });
        // 先塞 2KB 注释把中间层的缓冲区顶出去 —— 有些代理攒够一定字节才开闸
        res.write(': ' + '-'.repeat(2048) + '\n\n');
        res.write(': hi\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        // 一上来先给一包，别让页面干等第一次变化
        try { res.write('data: ' + JSON.stringify(await hooks.state()) + '\n\n'); } catch (_) { /* 拿不到就等推送 */ }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/dispatch') {
        const body = JSON.parse(await readBody(req) || '{}');
        const dir = String(body.dir || '').trim();
        const task = String(body.task || '').trim();
        if (!dir || !task) return json(400, { ok: false, error: '目录和任务都得有' });
        const r = await hooks.dispatch({
          projectPath: dir,
          task,
          // 接回这个项目留着的某条线（手机上那排「接着聊」）。
          // 空串要归成 undefined —— 传空串下去会被当成「指定了一条线」，
          // 而那条线永远找不到，于是每次都静默开新窗口
          laneId: String(body.laneId || '').trim() || undefined,
          laneName: String(body.laneName || '').trim(),
          permissionMode: body.permissionMode || undefined,
          agent: body.agent === 'codex' ? 'codex' : 'claude',
          // 模型原样透传，白名单归一交给 main（这个模块不认业务规则）
          model: String(body.model || ''),
        });
        return json(r && r.ok === false ? 400 : 200, r);
      }

      if (req.method === 'POST' && pathname === '/api/approve') {
        const body = JSON.parse(await readBody(req) || '{}');
        const id = String(body.id || '');
        const allow = Boolean(body.allow);
        if (!id) return json(400, { ok: false, error: '缺终端 id' });
        const r = await hooks.approve(id, allow);
        if (log) log('[mobile] ' + (allow ? '放行' : '拒绝') + ' ' + id + ' -> ' + JSON.stringify(r));
        return json(200, r);
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      if (log) log('[mobile] 请求炸了: ' + err.message);
      try { json(500, { error: '服务端出错了' }); } catch (_) { /* 头已发 */ }
    }
  });

  // 有动静就整包推。change 事件每次工具调用都来一发，800ms 合并 ——
  // 手机上肉眼分不出 0.8 秒，省一半流量和渲染
  function pushState() {
    if (pushTimer) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      if (!clients.size) return;
      let payload = '';
      try { payload = 'data: ' + JSON.stringify(await hooks.state()) + '\n\n'; } catch (_) { return; }
      for (const res of clients) {
        try { res.write(payload); } catch (_) { clients.delete(res); }
      }
    }, 800);
  }

  // SSE 心跳：中间设备（路由器/热点）对空闲连接下手很快，25 秒吱一声保活
  const beat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': beat\n\n'); } catch (_) { clients.delete(res); }
    }
  }, 25000);

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(beat);
    clearTimeout(pushTimer);
    for (const res of clients) { try { res.end(); } catch (_) { /* 收摊 */ } }
    clients.clear();
    return origClose(cb);
  };

  server.pushState = pushState;
  return server;
}

/** 生成一个够长的口令（进 URL，所以用 hex 不用 base64 —— 不带会打架的字符） */
function newToken() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = { createMobileServer, newToken, tokenOk };
