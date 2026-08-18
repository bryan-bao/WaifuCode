'use strict';

// 找出「会把终端搞成乱码」的 .bat / .cmd。
//
//   npm run scan-chcp            扫 registry 里所有派过活的项目
//   npm run scan-chcp -- E:\某目录   只扫指定目录
//
// 【为什么这是桌宠该管的事】
//
// 桌宠开的终端一进去就 `chcp 65001`（UTF-8），claude 的中文才显示得对。
// 但 `chcp` 改的是**整个控制台**的属性，不是某个进程自己的 —— 你让她跑的任何一个
// 脚本只要设了别的代码页又不还回去，从那一刻起 claude 的输出就全乱了，
// 而且**这个窗口再也回不来**，除非退出 claude 手动敲 chcp。
//
// 症状长这样（真实截图里抠出来的）：
//
//     •  ESC [ 3 G      UTF-8 字节:  E2 80 A2 1B 5B 33 47
//     按 GBK 解码:      E2 80 → 鈥    A2 1B → ?（非法组合，把 ESC 吞了）
//     屏幕上:           鈥?[3G
//
// 中文变成 鈥/闀/鍥，连转义码都漏成文字 —— 后者特别容易误判成「VT 没开」，
// 其实是 ESC 被吞进了非法字节对。
//
// 【为什么不在桌宠这边强行改回去】
//
// 想过在心跳里每 5 秒 `chcp 65001` 自愈。不能这么干：人家那个 bat 要 936
// 是因为它自己的输出就是 GBK 的。你抢回 65001，claude 界面是好了，
// **他的打包日志全乱**。两边只能有一个对，而那会儿该对的是他正在跑的东西。
//
// 所以只能在源头修：脚本用完把代码页还回去。改法见 docs/开发手册.md。

const fs = require('fs');
const path = require('path');

const REG = path.join(__dirname, '..', 'sessions', 'registry.json');
const SKIP = new Set(['node_modules', 'venv', '.venv', '.git', 'dist', 'build',
                      '.cache', '__pycache__', 'site-packages', 'backup']);

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const roots = new Set();

if (args.length) {
  for (const a of args) if (fs.existsSync(a)) roots.add(path.resolve(a));
} else {
  try {
    for (const r of Object.values(JSON.parse(fs.readFileSync(REG, 'utf8')))) {
      if (r.path && fs.existsSync(r.path)) roots.add(path.resolve(r.path));
    }
  } catch (_) {
    /* 还没派过活，registry 是空的 */
  }
}

if (!roots.size) {
  console.log('没有可扫的目录。用法: npm run scan-chcp -- E:\\某个项目');
  process.exit(0);
}

const hits = [];
function walk(dir, depth) {
  if (depth > 4) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      walk(p, depth + 1);
    } else if (/\.(bat|cmd)$/i.test(e.name)) {
      let buf;
      try { buf = fs.readFileSync(p); } catch (_) { continue; }
      if (buf.length > 200000) continue;
      // latin1 = 字节直读，编码无关（chcp 那行一定是 ASCII）
      const s = buf.toString('latin1');
      const codes = [...new Set([...s.matchAll(/^\s*@?chcp\s+(\d+)/gim)].map((m) => m[1]))];
      if (!codes.length) continue;
      hits.push({
        file: p,
        codes,
        // 有没有「存下原值再设回去」的痕迹
        restores: /chcp\s+%[^%\s]+%/i.test(s),
      });
    }
  }
}
for (const r of roots) walk(r, 0);

// 只设 65001 的无所谓 —— 桌宠的终端本来就是 65001，再设一次等于没设。
// 危险的是设成别的（936 之类）又不还。
const danger = hits.filter((h) => !h.restores && h.codes.some((c) => c !== '65001'));
const harmless = hits.filter((h) => !h.restores && !h.codes.some((c) => c !== '65001'));
const fixed = hits.filter((h) => h.restores);

const C = { bad: (s) => '\x1b[31m' + s + '\x1b[0m', ok: (s) => '\x1b[32m' + s + '\x1b[0m',
            dim: (s) => '\x1b[90m' + s + '\x1b[0m', b: (s) => '\x1b[1m' + s + '\x1b[0m' };

console.log('');
console.log(C.dim('扫了 ' + roots.size + ' 个目录，' + hits.length + ' 个脚本会动代码页'));
console.log('');

if (danger.length) {
  console.log(C.b(C.bad('会把终端搞成乱码的（' + danger.length + ' 个）')));
  console.log(C.dim('  跑过之后，那个窗口里 claude 的中文就全乱了，而且回不来'));
  for (const h of danger) console.log('  ' + C.bad('chcp ' + h.codes.join(',')) + '  ' + h.file);
  console.log('');
  console.log(C.dim('  修法：进来时记下代码页，每个出口前还回去。见开发手册「终端里突然满屏乱码」'));
} else {
  console.log(C.ok('✓ 没有会留下乱码的脚本'));
}

if (fixed.length) {
  console.log('');
  console.log(C.dim('已经会还回去的（' + fixed.length + ' 个）:'));
  for (const h of fixed) console.log(C.dim('  ' + h.file));
}

if (harmless.length) {
  console.log('');
  console.log(C.dim('只设 65001、不还的（' + harmless.length + ' 个）—— 无害，'
    + '终端本来就是 65001'));
}

console.log('');
process.exit(danger.length ? 1 : 0);
