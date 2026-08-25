'use strict';
// 手机工作台的自检。全离线：服务起在 127.0.0.1 随机口，自己连自己。
// 守四件事：口令闸（不带/带错一律 401）、SSE 真能推、派活参数归一化、
// 远程放行只对 waiting 的线动手。
const http = require('http');
const path = require('path');
const fs = require('fs');
const mobile = require('../src/mobile');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const TOKEN = 'tok-1234567890abcdef';
const calls = { dispatch: [], approve: [] };
const state = {
  name: '小依', mood: 'happy', todayUsd: 1.23,
  projects: [{ name: 'demo', path: 'D:\\demo' }],
  terminals: [{ id: 'w1', status: 'waiting', waitDetail: '要跑 npm test' }],
};

const srv = mobile.createMobileServer({
  pageFile: path.join(__dirname, '..', 'src', 'renderer', 'mobile.html'),
  token: TOKEN,
  log: () => {},
  hooks: {
    state: () => state,
    dispatch: (o) => { calls.dispatch.push(o); return { ok: true, id: 'w9', name: o.projectPath }; },
    approve: (id, allow) => { calls.approve.push([id, allow]); return { ok: true }; },
  },
});

function req(pathname, { method = 'GET', body = null, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const q = token === null ? '' : (pathname.includes('?') ? '&' : '?') + 't=' + token;
    const r = http.request({
      host: '127.0.0.1', port: srv.address().port, path: pathname + q, method,
      headers: body ? { 'content-type': 'application/json' } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  console.log('[1] 口令闸：不带、带错，一律 401');
  {
    check((await req('/api/state', { token: null })).code === 401, '不带口令 → 401');
    check((await req('/api/state', { token: 'wrong' })).code === 401, '错口令 → 401');
    check((await req('/', { token: 'tok-1234567890abcdeX' })).code === 401, '差一个字符也是 401（恒时比较那条路）');
    check((await req('/api/dispatch', { method: 'POST', token: null, body: { dir: 'x', task: 'y' } })).code === 401,
          '写操作更不用说');
  }

  console.log('\n[2] 页面和状态');
  {
    const page = await req('/');
    check(page.code === 200 && page.body.includes('手机工作台'), '首页真是那张手机页');
    const st = await req('/api/state');
    const j = JSON.parse(st.body);
    check(j.name === '小依' && j.todayUsd === 1.23 && j.terminals.length === 1, '状态整包原样到手');
  }

  console.log('\n[3] 派活：参数校验 + agent 白名单归一');
  {
    check((await req('/api/dispatch', { method: 'POST', body: { dir: '', task: 'x' } })).code === 400, '没目录 → 400');
    check((await req('/api/dispatch', { method: 'POST', body: { dir: 'D:\\demo', task: '' } })).code === 400, '没任务 → 400');
    const ok = await req('/api/dispatch', { method: 'POST', body: { dir: 'D:\\demo', task: '修个 bug', agent: '乱写的' } });
    check(ok.code === 200 && JSON.parse(ok.body).ok, '正经派活 → 200');
    const got = calls.dispatch[0];
    check(got.projectPath === 'D:\\demo' && got.agent === 'claude', '不认识的 agent 一律当 claude（白名单归一）');
  }

  console.log('\n[4] 放行路由');
  {
    check((await req('/api/approve', { method: 'POST', body: {} })).code === 400, '缺 id → 400');
    await req('/api/approve', { method: 'POST', body: { id: 'w1', allow: true } });
    await req('/api/approve', { method: 'POST', body: { id: 'w1', allow: false } });
    check(calls.approve.length === 2 && calls.approve[0][1] === true && calls.approve[1][1] === false,
          '放行/拒绝都路由到了钩子');
  }

  console.log('\n[5] SSE 长连接：一上来给整包，pushState 有合并');
  {
    const frames = await new Promise((resolve, reject) => {
      const got = [];
      const r = http.get({
        host: '127.0.0.1', port: srv.address().port, path: '/api/events?t=' + TOKEN,
      }, (res) => {
        check(String(res.headers['content-type']).includes('text/event-stream'), '头是 event-stream');
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (chunk.startsWith('data: ')) got.push(JSON.parse(chunk.slice(6)));
          }
          // 第一包（连上就给） + 推的那一包，齐了就收
          if (got.length >= 2) { r.destroy(); resolve(got); }
        });
        // 连上后连推三次 —— 800ms 合并的话只该到一包
        setTimeout(() => { srv.pushState(); srv.pushState(); srv.pushState(); }, 150);
        setTimeout(() => { r.destroy(); resolve(got); }, 4000);
      });
      r.on('error', () => resolve([]));
    });
    check(frames.length === 2, '一共到手 2 包：连上那包 + 合并后的一推（' + frames.length + '）');
    check(frames.every((f) => f.name === '小依'), '包里是完整状态');
  }

  console.log('\n[6] 远程放行的源码闸（不真发键 —— 那要拉窗口）');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'terminals.js'), 'utf8');
    const ap = src.slice(src.indexOf('async approveRemote'), src.indexOf('async approveRemote') + 1600);
    check(ap.includes("!== 'waiting'"), '只对 waiting 的线发键 —— 别的状态发键是往人家终端乱敲字');
    check(ap.includes('SENT'), '只认 SENT 回执（键真送进了目标窗口才算数）');
    check(ap.includes("'{ESC}'"), 'claude 的拒绝是 Esc');
    const ps = fs.readFileSync(path.join(__dirname, 'focus-window.ps1'), 'utf8');
    check(ps.includes('GetForegroundWindow') && ps.includes('SendKeys($script:SendKeys)'),
          'ps1 发键前最后核一次前台是它 —— 不是就 BLOCKED 绝不发');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    check(main.includes("srv.listen(port, '0.0.0.0'"), '手机服务监听 0.0.0.0（手机要能进来），安全靠口令闸');
    check(!fs.readFileSync(path.join(__dirname, '..', 'src', 'mobile.js'), 'utf8').includes("require('./"),
          'mobile.js 不 require 业务模块 —— 契约全靠 hooks 注入，才测得动');
  }

  await new Promise((r) => srv.close(r));
  console.log('');
  console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了: ' + e.stack); process.exit(1); });
