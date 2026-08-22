'use strict';
// 局域网更新的自检。全离线：服务起在 127.0.0.1 的随机口上，自己拉自己。
// 守的是四件事：版本比较不许比反、文件名许可名单不许放宽（那就是防穿越的
// 全部）、sha256 校验不过必须删包、latest.json 的哈希缓存不许天天重算。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const updates = require('../src/updates');

let failed = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) failed++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-update-'));

(async () => {
  console.log('[1] 版本比较：按段数值比，缺段补 0');
  {
    check(updates.cmpVer('0.2.0', '0.1.0') > 0, '0.2.0 > 0.1.0');
    check(updates.cmpVer('1.2', '1.2.0') === 0, '1.2 == 1.2.0（缺段补 0）');
    check(updates.cmpVer('0.10.0', '0.9.9') > 0, '0.10.0 > 0.9.9（数值比，不是字符串比）');
    check(updates.cmpVer('1.0.0.1', '1.0.0') > 0, '四段也认');
    check(updates.cmpVer('', '1.0') < 0, '空串当 0');
  }

  console.log('\n[2] 文件名许可名单：它就是防穿越的全部，一步不许放宽');
  {
    check(updates.parseArtifact('WaifuCode-0.2.0-安装版.exe') === '0.2.0', '正经安装包认得出版本');
    check(updates.parseArtifact('WaifuCode-1.0-免安装.exe') === '1.0', '免安装的也认');
    check(updates.parseArtifact('..\\evil.exe') === null, '点点杠 → 不认');
    check(updates.parseArtifact('WaifuCode-1.0-../../x.exe') === null, '版本后面藏路径 → 不认');
    check(updates.parseArtifact('WaifuCode-1.0-安装版.txt') === null, '不是 exe → 不认');
    check(updates.parseArtifact('WaifuCode-abc-安装版.exe') === null, '版本不是数字 → 不认');
    check(updates.parseArtifact('evil-1.0-安装版.exe') === null, '不姓 WaifuCode → 不认');
    const src = String(updates.ART_RE);
    check(!src.includes('\\\\S') && !src.includes('.*'), '正则里不许出现 .* / \\S 这种大口子');
  }

  console.log('\n[3] 挑最新：文件夹里几个包，拿版本最高的');
  {
    fs.writeFileSync(path.join(TMP, 'WaifuCode-0.1.0-安装版.exe'), 'old');
    fs.writeFileSync(path.join(TMP, 'WaifuCode-0.3.0-安装版.exe'), 'newest-bytes');
    fs.writeFileSync(path.join(TMP, 'WaifuCode-0.2.0-安装版.exe'), 'mid');
    fs.writeFileSync(path.join(TMP, 'readme.txt'), 'x');
    const best = updates.newestArtifact(TMP);
    check(best && best.version === '0.3.0', '挑出来 0.3.0');
    check(updates.newestArtifact(path.join(TMP, '不存在')) === null, '文件夹不存在 → null，不炸');
  }

  console.log('\n[4] latest.json：内容对、哈希有缓存');
  {
    const cache = {};
    const m = await updates.manifestFor(TMP, cache);
    const want = crypto.createHash('sha256').update('newest-bytes').digest('hex');
    check(m.version === '0.3.0' && m.file === 'WaifuCode-0.3.0-安装版.exe', '版本和文件名对上');
    check(m.sha256 === want, 'sha256 是真算的');
    check(m.size === 12, 'size 对（newest-bytes 12 字节）');
    const key1 = cache.key;
    await updates.manifestFor(TMP, cache);
    check(cache.key === key1, '第二次走缓存（key 没变说明没重算）');
    // 包换了内容 → 缓存必须失效重算
    fs.writeFileSync(path.join(TMP, 'WaifuCode-0.3.0-安装版.exe'), 'changed!!');
    const m2 = await updates.manifestFor(TMP, cache);
    check(m2.sha256 === crypto.createHash('sha256').update('changed!!').digest('hex'),
          '包内容变了，哈希跟着变（按 mtime+size 失效）');
  }

  console.log('\n[5] 分发服务：只 GET、只两种路径，别的一概拒');
  {
    const srv = updates.createServer({ dir: TMP, log: () => {} });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const get = (p, method) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (res) => {
        let buf = Buffer.alloc(0);
        res.on('data', (d) => { buf = Buffer.concat([buf, d]); });
        res.on('end', () => resolve({ code: res.statusCode, body: buf }));
      });
      req.end();
    });

    const lj = await get('/latest.json');
    const m = JSON.parse(lj.body.toString());
    check(lj.code === 200 && m.version === '0.3.0', '/latest.json 出的是最新包');
    const dl = await get('/' + encodeURIComponent('WaifuCode-0.3.0-安装版.exe'));
    check(dl.code === 200 && dl.body.toString() === 'changed!!', '按名拉包，字节一样');
    check((await get('/readme.txt')).code === 404, '名单外的文件拉不到');
    check((await get('/..%2f..%2fpackage.json')).code === 404, '编码过的穿越也拉不到');
    check((await get('/latest.json', 'POST')).code === 405, 'POST 不伺候');
    check((await get('/%zz')).code === 400, '畸形 %zz 回 400，不许把进程打崩（decodeURIComponent 会抛）');
    await new Promise((r) => srv.close(r));
  }

  console.log('\n[6] 收包侧：source 归一、拉 manifest、下载校验');
  {
    check(updates.normalizeSource('192.168.1.5:47200') === 'http://192.168.1.5:47200', '光地址补 http://');
    check(updates.normalizeSource('http://a.b:1/') === 'http://a.b:1', '尾巴斜杠去掉');
    check(updates.normalizeSource('  ') === null, '空的 → null');

    const srv = updates.createServer({ dir: TMP, log: () => {} });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const src = '127.0.0.1:' + srv.address().port;

    const m = await updates.fetchLatest(src);
    check(m.version === '0.3.0', 'fetchLatest 拿到 manifest');

    const dlDir = path.join(TMP, 'dl');
    const got = await updates.download(src, m, dlDir);
    check(fs.readFileSync(got, 'utf8') === 'changed!!', '下载落盘，内容一致');

    // 校验不过：包必须被删掉，错误必须说人话
    let boom = '';
    try { await updates.download(src, { ...m, sha256: 'f'.repeat(64) }, dlDir); }
    catch (e) { boom = e.message; }
    check(boom.includes('校验'), '假哈希 → 报「校验对不上」');
    check(!fs.existsSync(path.join(dlDir, m.file)), '校验不过的包已删掉（半个包比没有包危险）');
    await new Promise((r) => srv.close(r));

    // 下载中途断线：必须**很快 reject**。原版手工 pipe 在这条路上永远不
    // settle（res 的错不进 req、pipe 不转发、30 秒 timeout 只管空闲）——
    // 评审实测复现过，这条就是防它回退的
    const abortSrv = http.createServer((rq, rs) => {
      rs.writeHead(200, { 'content-length': 1000000 });
      rs.write(Buffer.alloc(1024));
      setTimeout(() => rs.socket.destroy(), 50);
    });
    await new Promise((r) => abortSrv.listen(0, '127.0.0.1', r));
    const aSrc = '127.0.0.1:' + abortSrv.address().port;
    const fake = { file: 'WaifuCode-9.9.9-安装版.exe', sha256: '0'.repeat(64), version: '9.9.9' };
    let broke = '';
    const raced = await Promise.race([
      updates.download(aSrc, fake, dlDir).catch((e) => { broke = e.message; return 'rejected'; }),
      new Promise((r) => setTimeout(() => r('hung'), 8000)),
    ]);
    check(raced === 'rejected', '中途断线 8 秒内就报错，不挂死（' + broke.slice(0, 40) + '）');
    check(!fs.existsSync(path.join(dlDir, fake.file)), '断线的残包也删了');
    await new Promise((r) => abortSrv.close(r));
  }

  console.log('\n[7] 主进程接线：源码钉死几条不许退的');
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    check(main.includes("ipcMain.handle('update:check'") && main.includes("ipcMain.handle('update:apply'"),
          'IPC 两条都注册了');
    check(main.includes('syncUpdateServe(after)'), '设置保存时分发开关跟着走');
    const chk = main.slice(main.indexOf('async function checkUpdate'), main.indexOf('async function checkUpdate') + 2000);
    check(chk.includes('if (!source)') && chk.includes('updateLatest = null'),
          '没填更新源就空手回，还要把之前探到的新版作废（不然面板按钮僵住）');
    check(chk.includes('announced'), '同一个新版只喊一次（announced 挡着）');
    check(main.includes('updateApplying'), '下载有在途锁 —— 重复点不许并发双下载');
    const ap = main.slice(main.indexOf('async function _applyUpdate'), main.indexOf('async function _applyUpdate') + 2500);
    check(ap.includes('openErr'), 'shell.openPath 的返回值必须看 —— 它失败不 reject 只回错误串');
    check(ap.indexOf('session:say') > ap.indexOf('openErr'), '喜报在安装器真起来**之后**才播');
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'updates.js'), 'utf8');
    check(upd.includes('pipeline(res'), '下载走 stream.pipeline，不许退回手工 pipe');
    check(upd.includes('clientFor'), 'https 源按协议挑客户端，不许写死 http');
  }

  if (failed) {
    console.log('\n\x1b[31m✗ ' + failed + ' 条没过\x1b[0m');
    process.exitCode = 1;
  } else {
    console.log('\n\x1b[32m✓ 全过\x1b[0m');
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 临时目录留着也无妨 */ }
})();
