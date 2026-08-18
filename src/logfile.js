'use strict';

// 日志的刹车。
//
// `waifu.log` 原来是一路 `appendFileSync` 到底，**没有任何上限**。
// 正常速度下这不是问题（实测 10 天 0.86 MB，一年也就 31 MB），
// 真正的风险是**出 bug 的那天**：一个循环里的 log、一个反复重连的组件，
// 几个小时就能刷出几个 G，而且是刷在你最不希望它涨的那个盘上。
//
// 所以给它加个「超过 MAX 就砍掉前面一半」。选砍前半截而不是整个删掉，
// 是因为日志的用途就是排查**刚才**发生了什么 —— 最新的那半截才是有用的，
// 老的丢了不心疼。
//
// 为什么单独一个文件：`log()` 在 main.js 里，那个文件依赖 electron，
// 没法在自检里直接 require。抽出来就是一段纯 fs 逻辑，测起来一瞬间。

const fs = require('fs');

// 8 MB 上限，砍完保留最后 4 MB。
// 按现在每天 88 KB 的速度，8 MB 够记三个月；真出了疯狂刷日志的 bug，
// 砍一次还能留下 4 MB 最新的现场，足够看出它在刷什么。
const MAX = 8 * 1024 * 1024;
const KEEP = 4 * 1024 * 1024;

// 不到 1 MB 就用 KB 说 —— 直接 Math.round(n / 1048576) 的话，
// 把阈值调小来测的时候会得到一句「日志超过 0 MB」，看着像个 bug
const size2str = (n) => (n >= 1048576
  ? Math.round(n / 1048576) + ' MB'
  : Math.round(n / 1024) + ' KB');

/**
 * 砍掉前面一半，只留最后 KEEP 字节。
 *
 * 两个必须处理的边角：
 *
 *   · **不能从半行切开。** 从 KEEP 字节处硬切，第一行多半是断的，
 *     而且断在多字节汉字中间就是一串乱码。所以往后找到第一个换行符，
 *     从它后面开始留 —— 丢掉小半行，换来后面每一行都是完整的。
 *   · **一次写完，不要「先清空再追加」。** 那中间要是崩了，
 *     日志就只剩个头。拼成一个 Buffer 一次 write 下去，没有中间态。
 *
 * @returns {number} 砍完之后的字节数（没砍就是原大小，出错返回 -1）
 */
function trim(file, { max = MAX, keep = KEEP } = {}) {
  try {
    const size = fs.statSync(file).size;
    if (size <= max) return size;

    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      buf = Buffer.allocUnsafe(keep);
      const got = fs.readSync(fd, buf, 0, keep, size - keep);
      buf = buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }

    // 往后找到第一个换行，从它之后开始 —— 别留半行
    const nl = buf.indexOf(0x0a);
    const tail = nl >= 0 ? buf.subarray(nl + 1) : buf;

    const head = Buffer.from(
      '[' + new Date().toISOString() + '] [log] 日志超过 ' + size2str(max) +
      '，砍掉了前面 ' + size2str(size - tail.length) + '\n',
      'utf8'
    );
    const next = Buffer.concat([head, tail]);
    fs.writeFileSync(file, next);
    return next.length;
  } catch (_) {
    // 砍不动就算了，绝不能因为日志维护把桌宠拖垮
    return -1;
  }
}

/**
 * 写一行，顺便看看要不要砍。
 *
 * **不是每次都去 stat**：日志一天几百上千行，为每一行做一次系统调用不值。
 * 在内存里累加就行，只有累到超过上限时才真去量一次（那时 stat 的开销
 * 相对于紧接着的截断可以忽略）。第一次写的时候量一次，接上盘上已有的大小。
 */
function makeWriter(file, opts = {}) {
  const max = opts.max || MAX;
  let bytes = -1; // -1 = 还没量过盘上有多少

  return function write(line) {
    try {
      fs.appendFileSync(file, line);
      if (bytes < 0) {
        bytes = fs.statSync(file).size;
      } else {
        bytes += Buffer.byteLength(line, 'utf8');
      }
      if (bytes > max) {
        const after = trim(file, opts);
        // 砍失败（-1）就把计数器清掉，下次重新量，免得一直反复触发
        bytes = after >= 0 ? after : -1;
      }
    } catch (_) {
      /* 日志写不进去也不该拖垮桌宠 */
    }
  };
}

module.exports = { trim, makeWriter, MAX, KEEP };
