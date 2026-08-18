'use strict';

// 听一遍这首歌有多快。
//
// 放在渲染层做，是因为 Chromium 自带了各种格式的解码器（decodeAudioData），
// mp3/m4a/flac 全都能解。搬到主进程就得为这一件事装一个解码库。
//
// 思路是很老实的那一套：
//   低通滤掉人声和高频 → 只剩鼓点 → 找出峰值 → 统计峰值之间的间隔 →
//   出现次数最多的那个间隔，就是一拍的长度。
//
// 对鼓点清楚的流行歌相当准；纯钢琴、氛围音乐这类没有明显节拍的会测不准，
// 但那种歌本来也没什么拍子可踩，退回默认值照样能看 —— 动作幅度还跟着音量走，
// 不会显得不合拍。

// 只听中间这一段：前奏和收尾经常是散的，拿去统计会把结果带偏
const ANALYZE_SECONDS = 30;
const START_RATIO = 0.15;

// 人耳听到的「拍子」基本落在这个区间；超出的都是把一拍数成了半拍或两拍
const MIN_BPM = 70;
const MAX_BPM = 180;

/**
 * 把一段音频的低频提出来。
 * 鼓（尤其是底鼓）能量集中在 150Hz 以下，滤掉上面的东西之后，
 * 波形上一个个鼓点就变得非常好认。
 */
async function lowPassed(buffer) {
  const sr = buffer.sampleRate;
  const start = Math.floor(buffer.length * START_RATIO);
  const len = Math.min(Math.floor(sr * ANALYZE_SECONDS), buffer.length - start);
  if (len < sr * 4) return null; // 还不到四秒，没什么可分析的

  const off = new OfflineAudioContext(1, len, sr);

  const seg = off.createBuffer(1, len, sr);
  const src0 = buffer.getChannelData(0);
  const dst = seg.getChannelData(0);
  if (buffer.numberOfChannels > 1) {
    // 两个声道叠起来，侧重中间声道 —— 鼓和贝斯一般都摆在正中
    const src1 = buffer.getChannelData(1);
    for (let i = 0; i < len; i++) dst[i] = (src0[start + i] + src1[start + i]) / 2;
  } else {
    dst.set(src0.subarray(start, start + len));
  }

  const node = off.createBufferSource();
  node.buffer = seg;

  const lp = off.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 150;
  lp.Q.value = 1;

  node.connect(lp);
  lp.connect(off.destination);
  node.start(0);

  const rendered = await off.startRendering();
  return { data: rendered.getChannelData(0), sampleRate: sr };
}

/**
 * 找鼓点。
 *
 * 按半秒一块切开，每块只取最响的那一下 —— 一块里响两次的情况很少，
 * 这样能天然地避开同一个鼓点被算成好几个。然后按响度排个序，
 * 只留前一半：安静段落里那些「本块最大值」其实根本不是鼓点。
 */
function findPeaks(data, sampleRate) {
  const block = Math.floor(sampleRate / 2);
  const blocks = Math.floor(data.length / block);
  const peaks = [];

  for (let b = 0; b < blocks; b++) {
    let max = 0;
    let at = b * block;
    for (let i = b * block; i < (b + 1) * block; i++) {
      const v = Math.abs(data[i]);
      if (v > max) { max = v; at = i; }
    }
    peaks.push({ at, vol: max });
  }

  peaks.sort((a, b) => b.vol - a.vol);
  const keep = peaks.slice(0, Math.max(8, Math.floor(peaks.length * 0.55)));
  keep.sort((a, b) => a.at - b.at);
  return keep;
}

/** 统计峰值之间的间隔，看哪种间隔出现得最多 */
function guessFromPeaks(peaks, sampleRate) {
  const votes = new Map();

  peaks.forEach((peak, i) => {
    // 不只比相邻两个 —— 隔一个、隔两个的也算上，这样漏掉几个鼓点不至于把结果带跑
    for (let j = 1; j < 10 && i + j < peaks.length; j++) {
      const gap = peaks[i + j].at - peak.at;
      if (gap <= 0) continue;

      // **必须除以 j**：隔了 j 个鼓点，这段就是 j 拍的长度，
      // 不除的话每个 j 会各投给一个不同的倍频。踩过这个坑：
      // 140 BPM 的曲子，j=2/4/8 的间隔全都折叠到 70，票数直接压过
      // 只有 j=1 支持的 140，最后测出来是一半 —— 她就变成两拍才摆一下。
      let bpm = 60 / ((gap / j) / sampleRate);
      while (bpm < MIN_BPM) bpm *= 2;   // 太慢，多半是数成了半拍
      while (bpm > MAX_BPM) bpm /= 2;   // 太快，多半是数成了两拍
      if (bpm < MIN_BPM || bpm > MAX_BPM) continue;

      // 跨得越远，gap/j 的量化误差越大，说话权就越小
      const key = Math.round(bpm);
      votes.set(key, (votes.get(key) || 0) + 1 / j);
    }
  });

  if (!votes.size) return null;

  // 差一两拍的其实是同一个答案，合并到一起再比，免得票被拆散
  let best = null;
  for (const [bpm, count] of votes) {
    let merged = count;
    for (const d of [-2, -1, 1, 2]) merged += (votes.get(bpm + d) || 0) * 0.5;
    if (!best || merged > best.score) best = { bpm, score: merged, count };
  }

  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  return { bpm: best.bpm, confidence: total ? best.score / total : 0 };
}

/**
 * 主入口：给一段音频，告诉你它多快。
 * 测不出来就返回 null —— 调用方退回默认拍子即可，不是错误。
 */
async function detectBPM(arrayBuffer, log) {
  const say = log || (() => {});
  try {
    const t0 = performance.now();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // decodeAudioData 会把传进去的 ArrayBuffer 吃掉（detach），
    // 所以必须给它一份拷贝，否则后面拿它去播放会得到一个空 buffer
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

    const lp = await lowPassed(buffer);
    if (!lp) { ctx.close(); return null; }

    const peaks = findPeaks(lp.data, lp.sampleRate);
    const guess = guessFromPeaks(peaks, lp.sampleRate);
    ctx.close();

    if (!guess) { say('[bpm] 没听出拍子来'); return null; }

    say('[bpm] 听出来 ' + guess.bpm + ' BPM（把握 ' + Math.round(guess.confidence * 100) +
        '%，' + peaks.length + ' 个鼓点，用时 ' + Math.round(performance.now() - t0) + 'ms）');

    // 把握太低就别信了，宁可用默认拍子 —— 白噪声那种东西也能凑出个数来，
    // 但那个数是没意义的
    return guess.confidence >= 0.12 ? guess.bpm : null;
  } catch (err) {
    say('[bpm] 测不了: ' + (err && err.message));
    return null;
  }
}

if (typeof window !== 'undefined') window.WaifuBPM = { detectBPM };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectBPM, findPeaks, guessFromPeaks, MIN_BPM, MAX_BPM };
}
