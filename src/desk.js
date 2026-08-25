'use strict';

// 桌面感知的纯逻辑：拖过来的东西是什么、仓库攒着没提交要不要念叨、
// 前台是不是全屏。全都不碰 Electron、不发请求 —— 读盘只有 tailOf 一处，
// 好离线测。真正「做什么」在 main。

const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// 能当文字读的。名单制而不是「试着读读看」—— 二进制文件读出来是乱码，
// 塞进提示词是白花钱
const TEXT_EXTS = new Set([
  '.log', '.txt', '.md', '.json', '.js', '.ts', '.py', '.java', '.cs', '.cpp',
  '.c', '.h', '.go', '.rs', '.html', '.css', '.yml', '.yaml', '.toml', '.ini',
  '.sh', '.ps1', '.bat', '.xml', '.csv', '.sql', '.vue', '.jsx', '.tsx',
]);
const TEXT_MAX_BYTES = 2 * 1024 * 1024; // 再大的文本文件，尾巴也够说明问题了

/**
 * 拖过来的这个东西该怎么接。只判断，不动手。
 *   dir   → 派活面板预填
 *   music → 收进歌单
 *   image → 进剪贴板（跟截图一个待遇）
 *   text  → 读尾巴拿去问她
 *   nope  → 看不懂
 */
function kindOf(p, st) {
  if (st.isDirectory()) return 'dir';
  const ext = path.extname(p).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return 'music';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext) && st.size <= TEXT_MAX_BYTES) return 'text';
  return 'nope';
}

/**
 * 文件的最后 n 个字。报错永远在日志**尾巴**上 —— 整个文件塞进提示词，
 * 既花钱又把重点淹了。
 */
function tailOf(file, n = 3000) {
  const size = fs.statSync(file).size;
  const from = Math.max(0, size - n * 3); // utf8 一个汉字 3 字节，宁多读别少读
  const buf = Buffer.alloc(Math.min(size, n * 3));
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  // 掐头去掉可能切了一半的字符
  let s = buf.toString('utf8').replace(/^�+/, '');
  if (s.length > n) s = s.slice(s.length - n);
  return (from > 0 ? '…（前面略）\n' : '') + s;
}

/** 往歌单文件夹拷的时候起个不打架的名。重名不覆盖 —— 那可能是首不同的歌 */
function freshName(dir, base) {
  if (!fs.existsSync(path.join(dir, base))) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 50; i++) {
    const cand = stem + '(' + i + ')' + ext;
    if (!fs.existsSync(path.join(dir, cand))) return cand;
  }
  return stem + '-' + Date.now() + ext;
}

// ── 仓库攒着没提交 ──────────────────────────────────────────────────────────
// 状态机独立出来是为了能测「3 小时」这条线 —— 真等 3 小时的测试没人跑。
//
// state 是 { [key]: firstDirtyAtMs }。规则：
//   脏了 → 记下第一次看见脏的时刻；连续脏满 nagAfterMs → 该念叨（一天一次由
//   调用方管）；变干净 → 从头来。
const NAG_AFTER_MS = 3 * 60 * 60 * 1000;

function gitNagCheck(state, key, dirtyCount, now = Date.now()) {
  if (!dirtyCount) { delete state[key]; return false; }
  if (!state[key]) { state[key] = now; return false; }
  return now - state[key] >= NAG_AFTER_MS;
}

// ── 前台全屏判定的去抖 ──────────────────────────────────────────────────────
// 进入要连着两拍都是全屏（切窗口的瞬间可能闪一下），退出一拍就退 ——
// 憋着不说话的状态多留一秒都是浪费
function fsDebounce(st, isFs) {
  if (isFs) {
    st.hits = (st.hits || 0) + 1;
    if (st.hits >= 2) st.on = true;
  } else {
    st.hits = 0;
    st.on = false;
  }
  return Boolean(st.on);
}

module.exports = {
  kindOf, tailOf, freshName, gitNagCheck, fsDebounce,
  NAG_AFTER_MS, TEXT_MAX_BYTES, AUDIO_EXTS, IMAGE_EXTS, TEXT_EXTS,
};
