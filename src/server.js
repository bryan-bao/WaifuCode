'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// 端口区间。固定单端口容易被别的程序占掉，多备几个挨个试。
const PORT_RANGE = [23411, 23412, 23413, 23414, 23415];

/**
 * 收 Claude Code hook 事件的本地小服务。
 *
 * 跟 sessions.js 的分工：
 *   sessions.js 管的是「她自己被派出去干的活」，靠 stream-json 直接读输出；
 *   这里管的是「你自己在别的终端手动跑的 Claude Code」，靠官方 hook 推事件。
 * 两条路都会汇进同一个心情系统，所以不管活是谁干的，她都有反应。
 *
 * 只监听 127.0.0.1 —— 这东西没有任何鉴权，绝不能暴露到外网。
 */
function startServer({ runtimeFile, onEvent, onTermEvent, onListen, log }) {
  const server = http.createServer((req, res) => {
    // /hook  —— Claude Code 的官方 hook 转发过来的事件
    // /term  —— 我们自己开的终端窗口（hooks/term-shell.js）上报的开/心跳/关
    const isHook = req.method === 'POST' && req.url === '/hook';
    const isTerm = req.method === 'POST' && req.url === '/term';

    if (isHook || isTerm) {
      let body = '';
      req.on('data', (c) => {
        body += c;
        // 挡一手异常大的载荷，避免内存被撑爆
        if (body.length > 1024 * 512) {
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (isTerm) {
            // close 那条的返回值带一行总账，作为响应体还给 term-shell
            //（它印在「按回车关掉」上面）。别的事件照旧 204 秒回
            const reply = onTermEvent ? onTermEvent(payload) : null;
            if (reply && reply.line) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(reply));
              return;
            }
          } else {
            onEvent(payload);
          }
        } catch (err) {
          if (log) log('[server] 载荷解析失败: ' + err.message);
        }
        // 上报方不关心返回内容，尽快放它走，别拖慢那边
        res.writeHead(204);
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'waifu-code' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  let idx = 0;
  function tryListen() {
    if (idx >= PORT_RANGE.length) {
      if (log) log('[server] 所有候选端口都被占了，hook 功能不可用');
      return;
    }
    const port = PORT_RANGE[idx++];
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        tryListen();
      } else if (log) {
        log('[server] 监听出错: ' + err.message);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      // 把实际端口落盘，hook 脚本靠读它找到我们
      try {
        fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
        fs.writeFileSync(
          runtimeFile,
          JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
          'utf8'
        );
      } catch (err) {
        if (log) log('[server] 写 runtime.json 失败: ' + err.message);
      }
      if (log) log('[server] hook 服务已监听 127.0.0.1:' + port);
      // 端口是抢出来的，别处（比如开终端时要告诉 term-shell 往哪儿汇报）得知道最终是哪个
      if (onListen) onListen(port);
    });
  }
  tryListen();

  return server;
}

module.exports = { startServer, PORT_RANGE };
