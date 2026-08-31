'use strict';
// 预先信任目录：桌宠开 Claude Code 终端前，替用户把「这个文件夹信不信任」那个框先点了。
//
// 【为什么要有这个】claude 每进一个没来过的新目录，第一次都弹一个交互框
//   "Is this a project you trust? No, exit / Yes, I trust this folder"。
// 它跟权限模式（--permission-mode）是两码事：权限模式管「干活时每步问不问你」，
// 这个框管「这个目录让不让 claude 碰」，选了「自己判断」也拦不住它。
// 用户从面板选目录派活，本身就等于「我信任这个目录」—— 桌宠替他接了，省那一下点击。
//
// 【官方做法】没有 CLI 参数 / 环境变量能跳过它（--dangerously-skip-permissions 只管工具权限）。
// 官方文档（code.claude.com/docs/en/permissions）明写：预先信任就是把
//   ~/.claude.json 的 projects["<路径>"].hasTrustDialogAccepted 设成 true，只这一个字段。
//
// 【路径 key 怎么对齐】claude 存的 key = 磁盘真实大小写 + 正斜杠 + 无尾斜杠。
// 实测（tools/test-trust.js）：realpathSync.native 能把面板传来的各种脏格式
//   （反斜杠、错大小写 d:\、尾斜杠）全纠成 claude 认的那个 key。大小写敏感 ——
//   写错一个盘符大小写，claude 就当成另一个目录、照样弹框（.claude.json 里
//   F:/… 和 f:/… 真并存过两条）。
//
// 【安全】信任 = 允许这个目录的 .claude/settings.json 权限规则 / hooks / MCP 立即生效。
// 桌宠只信任「用户主动派活的那个目录」，不碰别的 —— 跟用户手点 Yes 的效果完全一样，
// 只是把那一下前移到了「派活」。绝不自动信任随机目录。

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 把目录规范成 claude.json 里的 key：磁盘真实大小写 + 正斜杠 + 去尾斜杠 */
function trustKey(dir) {
  let p;
  try {
    p = fs.realpathSync.native(dir);   // 拿磁盘上真实的大小写，跟 claude 一致
  } catch (_) {
    p = path.resolve(String(dir || ''));  // 目录还不在（少见）→ 退回 resolve，至少格式对
  }
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || p;
}

function detectIndent(raw) {
  const m = raw.match(/\n([ \t]+)"/);        // 跟随原文件缩进，别把人家的格式搅了
  if (!m) return 0;                          // 紧凑单行 → 也写紧凑
  return m[1][0] === '\t' ? '\t' : m[1].length;
}

/**
 * 确保 dir 已被 claude 信任。已经信任就不动（幂等，不碰盘）。
 * 返回 { changed, key, reason }。**任何情况都不抛** —— 信任写不进顶多再弹一次框，
 * 绝不能因为它把用户的 ~/.claude.json 搞坏（那里面是全部项目状态 + 全局设置）。
 */
function ensureTrusted(dir, opts) {
  opts = opts || {};
  const file = opts.file || path.join(os.homedir(), '.claude.json');
  const key = trustKey(dir);

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (_) { return { changed: false, key, reason: 'no-file' }; }   // 没有就别造一个残缺的

  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (_) { return { changed: false, key, reason: 'bad-json' }; }  // 解析不了 → 绝不覆盖
  if (!j || typeof j !== 'object') return { changed: false, key, reason: 'bad-json' };

  const projects = j.projects || (j.projects = {});
  const cur = projects[key] || (projects[key] = {});
  if (cur.hasTrustDialogAccepted === true) return { changed: false, key, reason: 'already' };
  cur.hasTrustDialogAccepted = true;         // 只加这一个字段，其余整份 JSON 原样

  const ind = detectIndent(raw);
  const text = ind ? JSON.stringify(j, null, ind) : JSON.stringify(j);
  // 原子写：temp + rename，中途崩了也只留个 .tmp、绝不写出半个 claude.json。
  // ponytail: 读-改-写有并发窗口，极小概率盖掉别的 claude 进程刚写的 lastCost 等统计；
  // 但我们只增 trust、不删任何东西，且派活是低频动作，撞上的概率极低。要更稳就上文件锁，overkill。
  const tmp = file + '.waifu-tmp';
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 清不掉也无妨 */ }
    return { changed: false, key, reason: 'write-failed:' + (e && e.code || 'err') };
  }
  return { changed: true, key };
}

module.exports = { trustKey, ensureTrusted, detectIndent };
