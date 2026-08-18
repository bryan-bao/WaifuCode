'use strict';

// 读 mp3 的标签：歌名、歌手、专辑，还有 BPM。
//
// 为什么自己写而不装个库：只需要认四五个帧，用不着为这点事多一个依赖。
// 而且这里的原则是**读不出来就算了** —— 标签是锦上添花，读失败绝不能影响放歌。
//
// 支持 ID3v2.3/2.4（文件开头）和 ID3v1（文件末尾 128 字节）。
// FLAC 的 Vorbis Comment、M4A 的 iTunes atom 没做 —— 那两种格式回落到文件名，
// 对「点歌」这个场景够用了。

const fs = require('fs');

// 我们关心的帧。ID3v2.2 用三字母，2.3/2.4 用四字母。
const FRAMES = {
  TIT2: 'title',  TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album',  TAL: 'album',
  TBPM: 'bpm',    TBP: 'bpm',
};

/**
 * ID3v2 的长度字段是「同步安全整数」：每字节只用低 7 位。
 * 这么设计是为了让长度里永远不出现 0xFF，避免被误当成 mp3 帧同步头。
 * 直接按普通大端整数读会得到一个错得离谱的值。
 */
function synchsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) |
         ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function decodeText(buf) {
  if (!buf.length) return '';
  const enc = buf[0];
  const body = buf.slice(1);

  let s;
  if (enc === 1) {
    // UTF-16，开头带 BOM
    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) s = body.slice(2).toString('utf16le');
    else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) s = swap16(body.slice(2)).toString('utf16le');
    else s = body.toString('utf16le');
  } else if (enc === 2) {
    s = swap16(body).toString('utf16le'); // UTF-16BE，没有 BOM
  } else if (enc === 3) {
    s = body.toString('utf8');
  } else {
    // 0 = ISO-8859-1。但国内一大堆 mp3 其实往里塞的是 GBK，
    // latin1 解出来是乱码。这里试一下：能当 UTF-8 解通就按 UTF-8。
    s = tryUtf8(body);
  }

  return s.replace(/\0+$/, '').trim();
}

function swap16(b) {
  const out = Buffer.from(b);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t;
  }
  return out;
}

// 拿不准编码时，能解成合法 UTF-8 就当 UTF-8，否则退回 latin1
function tryUtf8(b) {
  const s = b.toString('utf8');
  return s.includes('�') ? b.toString('latin1') : s;
}

function readV2(fd, size) {
  const head = Buffer.alloc(10);
  if (fs.readSync(fd, head, 0, 10, 0) < 10) return null;
  if (head.toString('latin1', 0, 3) !== 'ID3') return null;

  const version = head[3];
  const tagSize = synchsafe(head, 6);
  if (tagSize <= 0 || tagSize > size) return null;

  const body = Buffer.alloc(Math.min(tagSize, 1024 * 1024)); // 一兆封顶，标签里可能塞了整张封面
  fs.readSync(fd, body, 0, body.length, 10);

  const idLen = version === 2 ? 3 : 4;
  const out = {};
  let p = 0;

  while (p + idLen + (idLen === 3 ? 3 : 6) <= body.length) {
    const id = body.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 到填充区了

    let len;
    if (idLen === 3) {
      len = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
      p += 6;
    } else {
      // 2.4 的帧长度也是同步安全的；2.3 是普通整数。
      // 2.3 的文件按同步安全读会短得离谱，所以两种都算一下取合理的那个。
      const plain = body.readUInt32BE(p + 4);
      const safe = synchsafe(body, p + 4);
      len = version === 4 ? safe : (plain > body.length - p ? safe : plain);
      p += 10;
    }

    if (len <= 0 || p + len > body.length) break;

    const key = FRAMES[id];
    if (key && !out[key]) {
      const v = decodeText(body.slice(p, p + len));
      if (v) out[key] = v;
    }
    p += len;
  }

  return Object.keys(out).length ? out : null;
}

function readV1(fd, size) {
  if (size < 128) return null;
  const tail = Buffer.alloc(128);
  fs.readSync(fd, tail, 0, 128, size - 128);
  if (tail.toString('latin1', 0, 3) !== 'TAG') return null;

  const cut = (from, to) => tryUtf8(tail.slice(from, to)).replace(/\0.*$/s, '').trim();
  const out = {};
  const title = cut(3, 33);
  const artist = cut(33, 63);
  const album = cut(63, 93);
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (album) out.album = album;

  return Object.keys(out).length ? out : null;
}

/**
 * 读一个音频文件的标签。
 * 读不出来返回 {} —— 调用方回落到文件名就行，这不是个错误。
 */
function readTags(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');

    const tags = readV2(fd, size) || readV1(fd, size) || {};

    if (tags.bpm) {
      const n = parseInt(String(tags.bpm), 10);
      tags.bpm = n >= 40 && n <= 220 ? n : null;
      if (!tags.bpm) delete tags.bpm;
    }
    return tags;
  } catch (_) {
    return {}; // 标签读不出来是小事，绝不能因此放不了歌
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* noop */ } }
  }
}

module.exports = { readTags };
