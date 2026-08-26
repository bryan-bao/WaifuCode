'use strict';
// ---------------------------------------------------------------------------
// 局域网版本更新。没有服务器，发包的那台机器自己当分发点：
//
//   发包侧  electron-builder 打出来的 WaifuCode-x.y.z-安装版.exe 丢进分发
//           文件夹 → 这里起一个只读小服务（node 自带 http，零依赖）。
//   收包侧  定时拉 http://<发包机>:<口>/latest.json，版本比自己新就亮按钮，
//           点了下载安装包、校验 sha256、拉起安装器。
//
// 协议就两个 GET：/latest.json（{version,file,size,sha256}）和 /<文件名>。
// 以后有真服务器，把这两个文件原样放上去、把 source 地址一改就完了 ——
// 协议从第一天就照这个设计，代码不用动。
//
// 【边界，文档里也写了】局域网内没有身份验证，同一网络里谁都能冒充分发点。
// 朋友/家里内网玩没问题；真上公网要加包签名校验，那是有服务器之后的事。
// sha256 防的是下载损坏，不防恶意。
// ---------------------------------------------------------------------------
const http = require('http');
const https = require('https');
const { pipeline } = require('stream');
const crypto = require('crypto');

// source 允许 https://（以后搬上真服务器就是它）—— 按协议挑客户端，
// 不挑的话 https 源 100% 失败、报错还看不出为什么（评审抓的）
const clientFor = (url) => (/^https:/i.test(url) ? https : http);
const fs = require('fs');
const path = require('path');
const os = require('os');

// 版本比较：按 . 分段数值比，缺段补 0（1.2 == 1.2.0）。返回 >0 表示 a 新。
// 不认预发布后缀 —— 我们的 artifactName 里也不会出现
function cmpVer(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// 打包时的版本递增：'major' 大改（1.0.0 起新篇）、'minor' 中改（第二段 +1、
// 尾段归零）、'patch' 小改（尾段 +1，默认）。归零是规矩的一部分 —— 不归零
// 的话 0.1.7 加个功能变 0.2.7，看着像已经修过 7 轮
function bumpVer(v, kind) {
  const p = String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  if (kind === 'major') return (p[0] + 1) + '.0.0';
  if (kind === 'minor') return p[0] + '.' + (p[1] + 1) + '.0';
  return p[0] + '.' + p[1] + '.' + (p[2] + 1);
}

// 从安装包文件名里抠版本：WaifuCode-0.2.0-安装版.exe → '0.2.0'。
// 这个正则同时就是服务端的「许可名单」—— 对不上的一律当不存在，
// 所以它绝不能放宽到会匹配路径分隔符/点点
const ART_RE = /^WaifuCode-(\d+(?:\.\d+){0,3})-[\w一-鿿.]+\.exe$/;

function parseArtifact(name) {
  const m = ART_RE.exec(String(name || ''));
  return m ? m[1] : null;
}

// 分发文件夹里版本最高的那个安装包（没有就 null）
function newestArtifact(dir) {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  for (const name of names) {
    const ver = parseArtifact(name);
    if (!ver) continue;
    if (!best || cmpVer(ver, best.version) > 0) best = { version: ver, file: name };
  }
  return best;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// latest.json 的内容。哈希按「路径+大小+改动时间」缓存 —— 安装包几十上百 MB，
// 别每来一个请求都重算一遍
async function manifestFor(dir, cache) {
  const best = newestArtifact(dir);
  if (!best) return null;
  const full = path.join(dir, best.file);
  const st = fs.statSync(full);
  const key = full + '|' + st.size + '|' + st.mtimeMs;
  if (!cache.key || cache.key !== key) {
    cache.sha256 = await sha256File(full);
    cache.key = key;
  }
  return { version: best.version, file: best.file, size: st.size, sha256: cache.sha256 };
}

// 分发端：只读、只 GET、只认两种路径。listen 交给调用方（好测：port 0）
function createServer({ dir, log }) {
  const cache = {};
  return http.createServer((req, res) => {
    const fail = (code, why) => { res.writeHead(code); res.end(why || ''); };
    if (req.method !== 'GET') return fail(405);
    // 畸形的 %zz 会让 decodeURIComponent 当场抛 URIError —— 这是暴露在局域网
    // 上的口子，一个端口扫描器就能把发包机打崩（评审实测复现过），必须接住
    let name;
    try {
      name = decodeURIComponent(String(req.url || '').split('?')[0].replace(/^\/+/, ''));
    } catch (_) { return fail(400); }

    // 谁来拉过要记一笔 —— 今天排障时想知道「对面那台到底够没够到我们」，
    // 翻遍日志只有「分发开在 :47200」，一条请求记录都没有，两眼一抹黑
    if (log) log('[update] ' + (req.socket.remoteAddress || '?') + ' 来拉 ' + (name || 'latest.json'));
    if (name === 'latest.json') {
      manifestFor(dir, cache).then((m) => {
        if (!m) return fail(404, '还没有包');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(m));
      }).catch((err) => { if (log) log('[update] latest.json 出不来: ' + err.message); fail(500); });
      return;
    }

    // 只发「长得像我们安装包」的文件名，别的一概 404 —— ART_RE 不含 / \ .. ，
    // 这一条就是防目录穿越的全部
    if (!parseArtifact(name)) return fail(404);
    const full = path.join(dir, name);
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return fail(404);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
    });
  });
}

// 本机局域网 IPv4，给设置页显示「让朋友填这个」
// ── 更新说明的攒法与选法（pack.js 写、main.js 读，逻辑收在这儿才测得住）──

// 打包时把这一版的说明**摞在历史上**，而不是覆盖 —— 用户可能隔着好几版
// 才更新一次（0.2.1 直接跳 1.0.1），只留最后一版的话，中间那些大功能
// 他永远看不到说明。同版重打就替换那一条；历史封顶 10 版。
// 一条说明归哪组：新增 / 修复 / 优化。给弹窗排版用 —— 新增放最前面，
// 然后是修的 bug，最后是优化整理。按提交信息的关键词判：
//   修复：开头带「修」、或提到修复/排障/坑/静默失效/没反应/乱码这类病症
//   优化：合并/重构/整理/文档/版本号这类家务
//   其余全算新增 —— 功能提交的措辞五花八门，兜底进「新增」比漏掉强。
// 想让分类更准：提交信息以「修：」开头就必进修复区（惯例写进开发手册）
function classifyNote(text) {
  const t = String(text || '');
  if (/^修|修复|排障|堵|坑|静默失效|没反应|乱码|误报/.test(t)) return 'fix';
  if (/^(合并|重构|整理|打磨|优化|除旧|收拾|清理|文档|README|版本号|自检|测试)/.test(t) || /不入库|gitignore/.test(t)) return 'opt';
  return 'new';
}

function mergeNotes(prev, version, notes, at) {
  const old = prev && typeof prev === 'object' ? prev : {};
  // 老格式（单版）也算一条历史 —— 升级打包机上的旧文件不丢
  let hist = Array.isArray(old.history) ? old.history.slice()
    : (old.version && Array.isArray(old.notes) ? [{ version: old.version, notes: old.notes }] : []);
  hist = hist.filter((h) => h && h.version && cmpVer(h.version, version) !== 0);
  hist.unshift({ version, notes: notes || [], at: at || new Date().toISOString().slice(0, 10) });
  hist.sort((a, b) => cmpVer(b.version, a.version));
  return { version, notes: notes || [], history: hist.slice(0, 10) };
}

// 升级后弹窗该给他看哪几版：seen（他上次用的）< v <= cur（现在装的），
// 新的在前。没有 history 的老文件退回单版行为。
function notesSince(rn, seenVer, curVer) {
  if (!rn) return [];
  const hist = Array.isArray(rn.history) && rn.history.length ? rn.history
    : (rn.version && Array.isArray(rn.notes) ? [{ version: rn.version, notes: rn.notes }] : []);
  return hist
    .filter((h) => h && Array.isArray(h.notes) && h.notes.length &&
                   cmpVer(h.version, seenVer) > 0 && cmpVer(h.version, curVer) <= 0)
    .sort((a, b) => cmpVer(b.version, a.version));
}

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

// source 允许「192.168.1.5:47200」或带 http:// 的完整地址
function normalizeSource(source) {
  let s = String(source || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}

function getJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = clientFor(url).get(url, { timeout: timeoutMs || 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let buf = '';
      // 中途断线的错误发给 res 不发给 req，不接的话这个 Promise 就地挂死
      res.on('error', (e) => reject(new Error('连接断了：' + e.message)));
      res.on('data', (d) => { buf += d; if (buf.length > 65536) req.destroy(new Error('latest.json 大得不像话')); });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

// 收包侧：问一嘴现在最新是什么
async function fetchLatest(source, timeoutMs) {
  const base = normalizeSource(source);
  if (!base) return null;
  const m = await getJSON(base + '/latest.json', timeoutMs);
  if (!m || !m.version || !parseArtifact(m.file)) throw new Error('latest.json 不像话');
  return m;
}

// 收包侧：下载 + 校验。任何一种失败都删残包再报错 —— 半个包比没有包危险。
// 走 stream.pipeline 不走手工 pipe：中途断线的错误发给 res、pipe 不往下游
// 转发，30 秒 timeout 又只管「socket 闲着」不管「socket 没了」，三件事凑齐
// 就是 Promise 永远不 settle、面板卡「下载中」到天荒地老（评审实测复现过）
function download(source, manifest, destDir) {
  const base = normalizeSource(source);
  const url = base + '/' + encodeURIComponent(manifest.file);
  const dest = path.join(destDir, manifest.file);
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(dest); } catch (_) { /* 还没写出来就没得删 */ }
      reject(err);
    };
    const req = clientFor(url).get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error('HTTP ' + res.statusCode)); }
      const h = crypto.createHash('sha256');
      res.on('data', (d) => h.update(d));
      pipeline(res, fs.createWriteStream(dest), (err) => {
        if (err) return fail(new Error('下载断了：' + err.message));
        if (settled) return;
        if (h.digest('hex') !== manifest.sha256) {
          return fail(new Error('校验对不上，下载的包已删掉（网络坏包或源不对）'));
        }
        settled = true;
        resolve(dest);
      });
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', fail);
  });
}

module.exports = {
  mergeNotes, notesSince, classifyNote,
  cmpVer, bumpVer, parseArtifact, newestArtifact, sha256File, manifestFor,
  createServer, lanIPs, normalizeSource, fetchLatest, download, ART_RE,
};
