'use strict';
// ---------------------------------------------------------------------------
// 出门模式：把手机工作台临时暴露成一个公网网址。
//
// 用 Cloudflare 的 quick tunnel（cloudflared 一个 exe，**不要账号、不要
// 服务器、不用碰路由器**）：起一条出站加密隧道，它回一个
// https://xxx.trycloudflare.com 的临时地址，转发到本机的手机工作台端口。
//
// 三条要知道的：
//   · 网址每次开都不一样（临时隧道的性质）—— 所以用二维码，不让人去记
//   · 开着才存在：关掉出门模式隧道即断，不开就完全不暴露
//   · 网址带着口令参数，跟局域网那条是同一道闸
//
// cloudflared 没装就自己下（官方发布页的单文件 exe，落在数据目录，不进 C 盘）。
// 下载和起隧道都可能失败（公司网、代理），全都老实报错，绝不假装成功。
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
// 起隧道到出网址，慢的时候要十几秒
const READY_MS = 45000;

function binPath(dataRoot) {
  return path.join(dataRoot, 'bin', 'cloudflared.exe');
}

function installed(dataRoot) {
  try { return fs.statSync(binPath(dataRoot)).size > 1024 * 1024; } catch (_) { return false; }
}

/** 下载 cloudflared（跟着 302 跳转走，最多 5 跳）。装好返回路径 */
function install(dataRoot, onProgress) {
  const dest = binPath(dataRoot);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';

  const get = (url, hop) => new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error('跳转太多次了'));
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, hop + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(tmp);
      res.on('data', (d) => {
        got += d.length;
        if (onProgress && total) onProgress(Math.round((100 * got) / total));
      });
      res.on('error', reject);
      out.on('error', reject);
      res.pipe(out);
      out.on('finish', () => {
        try {
          if (fs.statSync(tmp).size < 1024 * 1024) throw new Error('下下来的文件不像话');
          fs.renameSync(tmp, dest);
          resolve(dest);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });

  return get(DOWNLOAD_URL, 0).catch((err) => {
    try { fs.unlinkSync(tmp); } catch (_) { /* 没写出来就没得删 */ }
    throw err;
  });
}

/**
 * 起一条隧道，指到本机 port。拿到公网网址才 resolve。
 * @returns {{ child, url, stop() }}
 */
function start({ dataRoot, port, log }) {
  const bin = binPath(dataRoot);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      'tunnel', '--no-autoupdate',
      '--url', 'http://127.0.0.1:' + port,
    ], { windowsHide: true });

    let settled = false;
    let tail = '';
    const done = (err, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) { try { child.kill(); } catch (_) { /* 已经死了 */ } return reject(err); }
      resolve({ child, url, stop: () => { try { child.kill(); } catch (_) { /* 已经死了 */ } } });
    };

    // 网址是打在 stderr 上的（cloudflared 把日志全走 stderr）
    const eat = (buf) => {
      const s = String(buf);
      tail = (tail + s).slice(-4000);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(tail);
      if (m) {
        if (log) log('[tunnel] 出门地址: ' + m[0]);
        done(null, m[0]);
      }
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (e) => done(new Error('cloudflared 起不来：' + e.message)));
    child.on('exit', (code) => {
      if (!settled) done(new Error('cloudflared 退了（code ' + code + '）：' + tail.slice(-200)));
      else if (log) log('[tunnel] 隧道断了 code=' + code);
    });

    const deadline = setTimeout(() => {
      done(new Error('等了 45 秒还没出网址 —— 网络可能连不上 Cloudflare'));
    }, READY_MS);
  });
}

module.exports = { installed, install, start, binPath, DOWNLOAD_URL };
