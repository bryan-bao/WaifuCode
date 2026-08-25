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
// 【边界】口令在 URL 里，扫码的人就是主人 —— 别把二维码发到群里。
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
 *   state()            -> 整包状态（页面渲染要的全部）
 *   dispatch(opts)     -> { ok, ... } 在电脑上开一条最小化终端线
 *   approve(id, allow) -> { ok, error? } 把确认键送进那个终端窗口
 */
function createMobileServer({ pageFile, token, hooks, log }) {
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

      if (req.method === 'GET' && pathname === '/api/events') {
        if (clients.size >= 8) return json(429, { error: '连的人太多了' });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
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
          laneName: String(body.laneName || '').trim(),
          permissionMode: body.permissionMode || undefined,
          agent: body.agent === 'codex' ? 'codex' : 'claude',
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
