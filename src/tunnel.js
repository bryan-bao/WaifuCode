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

// 下载源按顺序试。**镜像排前面**：国内直连 GitHub 十次有九次是
// ECONNRESET / ETIMEDOUT（实机日志里就这么挂的），先试通的那个省一分钟。
// 全挂了也不是绝路 —— 报错里告诉用户自己下一个丢进那个目录就行
const SOURCES = [
  'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
];
const DOWNLOAD_URL = SOURCES[SOURCES.length - 1];
// 起隧道 + 等边缘同步：出网址十几秒，通了还要十几秒，给足
const READY_MS = 150000;

function binPath(dataRoot) {
  return path.join(dataRoot, 'bin', 'cloudflared.exe');
}

function installed(dataRoot) {
  try { return fs.statSync(binPath(dataRoot)).size > 1024 * 1024; } catch (_) { return false; }
}

/**
 * 下载 cloudflared（跟着 302 跳转走，最多 5 跳）。装好返回路径。
 * 多个源依次试，全挂了把「自己下载丢进这个目录」的话说清楚。
 */
async function install(dataRoot, onProgress, log) {
  const dest = binPath(dataRoot);
  const errs = [];
  for (const url of SOURCES) {
    try {
      if (log) log('[tunnel] 试这个源: ' + url.split('/')[2]);
      return await downloadTo(url, dest, onProgress);
    } catch (err) {
      errs.push(url.split('/')[2] + '(' + err.message + ')');
    }
  }
  throw new Error('几个下载源都不通：' + errs.join('、') +
    '。你可以自己下一个 cloudflared-windows-amd64.exe，改名成 cloudflared.exe 放到 ' +
    binPath(dataRoot) + ' 再点一次');
}

function downloadTo(url0, dest, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';

  const get = (url, hop) => new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error('跳转太多次了'));
    const req = https.get(url, { timeout: 20000 }, (res) => {
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
        req.setTimeout(20000); // 有数据就把空闲计时器往后推 —— 54MB 慢网要几分钟
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

  return get(url0, 0).catch((err) => {
    try { fs.unlinkSync(tmp); } catch (_) { /* 没写出来就没得删 */ }
    throw err;
  });
}

/**
 * 探到这个公网地址真的能用了才算数（Cloudflare 边缘同步要几秒）。
 * 最多探 40 秒，2 秒一次 —— 探不通就当没开成，绝不把一个报错页塞给用户。
 */
function waitReady(url, log) {
  // 实测：随机子域名的 DNS 要传播 ~60 秒（全程 ENOTFOUND），第 63 秒才通。
  // 所以这儿必须给足两分钟 —— 早放弃就等于「这功能没用」
  const deadline = Date.now() + 130000;
  const once = () => new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      res.resume();
      // 200 是通了；530/1033 是边缘还没同步好；其它状态也算通（起码转发到了）
      resolve(res.statusCode !== 530 && res.statusCode !== 502 && res.statusCode !== 404);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  return (async () => {
    let tries = 0;
    while (Date.now() < deadline) {
      tries += 1;
      if (log && tries % 5 === 0) log('[tunnel] 还在等公网生效…（' + tries * 3 + ' 秒）');
      if (await once()) {
        if (log) log('[tunnel] 通了（探了 ' + tries + ' 次）');
        return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('隧道起来了，但两分钟了公网还访问不通 —— 这个网络可能拦了 Cloudflare');
  })();
}

/**
 * 起一条隧道，指到本机 port。**探到公网真能访问**才 resolve。
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
    let sawUrl = false;
    const eat = (buf) => {
      const s = String(buf);
      tail = (tail + s).slice(-4000);
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(tail);
      if (m && !sawUrl) {
        sawUrl = true;
        if (log) log('[tunnel] 出门地址: ' + m[0] + '，等它在公网上生效…');
        // **网址出来 ≠ 能用**：Cloudflare 边缘要几秒才把这条隧道同步开，
        // 早了访问是 530 / error 1033（实测 4s、8s 还挂，12s 才通）。
        // 这时候把二维码给用户，他扫出来就是一个报错页 —— 用户第一反应
        // 是「这功能没用」。所以自己探到真通了再交货
        waitReady(m[0], log).then(() => done(null, m[0]))
          .catch((e) => done(e));
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
      done(new Error('等太久了还没通 —— 网络可能连不上 Cloudflare'));
    }, READY_MS);
  });
}

module.exports = { installed, install, start, binPath, DOWNLOAD_URL, SOURCES };
