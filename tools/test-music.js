'use strict';

// 点歌这块的自检：标签读得对不对、拍子测得准不准、段落跟不跟得上。
// 全程不联网、不出声、不花钱 —— 音频是现场合成的，标签是现场拼的。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readTags } = require('../src/id3');
const { findPeaks, guessFromPeaks } = require('../src/renderer/bpm');
const { Dancer } = require('../src/renderer/dance');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-music-'));

// ---------------------------------------------------------------------------
// 手搓一个 ID3v2.3 标签，好精确验证解析器读得对不对
// ---------------------------------------------------------------------------
function frame(id, text, enc = 3) {
  const body = Buffer.concat([Buffer.from([enc]), Buffer.from(text, enc === 3 ? 'utf8' : 'latin1')]);
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function synchsafeBuf(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function makeMp3WithTags(fields) {
  const frames = Buffer.concat(Object.entries(fields).map(([id, v]) => frame(id, String(v))));
  const head = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([3, 0, 0]),          // v2.3，无 flag
    synchsafeBuf(frames.length),
  ]);
  // 后面接一段假的 mp3 数据，让它看起来像个正常文件
  return Buffer.concat([head, frames, Buffer.alloc(2048, 0x55)]);
}

console.log('\n[1] ID3v2 标签');
const f1 = path.join(TMP, 'track03_final(1).mp3');
fs.writeFileSync(f1, makeMp3WithTags({ TIT2: '晚风', TPE1: '某某某', TALB: '第一张', TBPM: '96' }));
const t1 = readTags(f1);
console.log('    读出来: ' + JSON.stringify(t1));
check(t1.title === '晚风', '歌名（文件名是 track03_final(1) 这种也不怕）');
check(t1.artist === '某某某', '歌手');
check(t1.album === '第一张', '专辑');
check(t1.bpm === 96, 'BPM 标签');

console.log('\n[2] 离谱的 BPM 标签要丢掉');
const f2 = path.join(TMP, 'b.mp3');
fs.writeFileSync(f2, makeMp3WithTags({ TIT2: 'x', TBPM: '9999' }));
check(!readTags(f2).bpm, '9999 不认');

console.log('\n[3] ID3v1（标签在文件末尾那 128 字节）');
const v1 = Buffer.alloc(128, 0);
v1.write('TAG', 0, 'latin1');
v1.write('老歌', 3, 'utf8');
v1.write('老歌手', 33, 'utf8');
const f3 = path.join(TMP, 'c.mp3');
fs.writeFileSync(f3, Buffer.concat([Buffer.alloc(4096, 0x55), v1]));
const t3 = readTags(f3);
console.log('    读出来: ' + JSON.stringify(t3));
check(t3.title === '老歌', 'v1 的歌名');
check(t3.artist === '老歌手', 'v1 的歌手');

console.log('\n[4] 没有标签的文件不能崩');
const f4 = path.join(TMP, 'd.mp3');
fs.writeFileSync(f4, Buffer.alloc(3000, 0x55));
check(JSON.stringify(readTags(f4)) === '{}', '干净地返回空');
check(JSON.stringify(readTags(path.join(TMP, '根本不存在.mp3'))) === '{}', '文件不存在也只是返回空');

// ---------------------------------------------------------------------------
// 拍子：合成一段已知 BPM 的鼓点，看能不能听出来
// ---------------------------------------------------------------------------
console.log('\n[5] 测拍子');
const SR = 44100;

function makeBeat(bpm, seconds, jitter = 0) {
  const data = new Float32Array(SR * seconds);
  const period = (60 / bpm) * SR;
  for (let b = 0; b * period < data.length; b++) {
    const at = Math.floor(b * period + (Math.random() - 0.5) * jitter * period);
    if (at < 0 || at >= data.length) continue;
    // 一下鼓：起振快、衰减慢
    for (let i = 0; i < 3000 && at + i < data.length; i++) {
      data[at + i] += Math.exp(-i / 600) * Math.sin(i / 8) * 0.9;
    }
  }
  return data;
}

// 要求测准，不接受半倍/两倍 —— 踩半拍和踩准拍，看上去差别很明显
for (const bpm of [80, 90, 100, 120, 128, 140, 160]) {
  const data = makeBeat(bpm, 25);
  const peaks = findPeaks(data, SR);
  const guess = guessFromPeaks(peaks, SR);
  const got = guess ? guess.bpm : null;
  check(got !== null && Math.abs(got - bpm) <= 2,
        '合成的 ' + bpm + ' BPM → 听成 ' + got + '（把握 ' +
        (guess ? Math.round(guess.confidence * 100) : 0) + '%）');
}

console.log('\n[6] 节奏乱一点也得撑得住');
const noisy = makeBeat(128, 25, 0.06);
const g = guessFromPeaks(findPeaks(noisy, SR), SR);
check(g && Math.abs(g.bpm - 128) <= 4, '有抖动的 128 BPM → ' + (g ? g.bpm : null));

console.log('\n[7] 没有节拍的东西别硬猜');
const noise = new Float32Array(SR * 20);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.3;
const gn = guessFromPeaks(findPeaks(noise, SR), SR);
console.log('    白噪声 → ' + (gn ? gn.bpm + ' BPM，把握 ' + Math.round(gn.confidence * 100) + '%' : '测不出'));
check(!gn || gn.confidence < 0.12, '把握值低于 0.12 这个门槛，会被退回默认拍子');

// ---------------------------------------------------------------------------
// 段落感知
// ---------------------------------------------------------------------------
console.log('\n[8] 跟着段落变化');
const fake = { internalModel: { coreModel: { getParameterIndex: () => -1 } } };
const d = new Dancer(fake, () => {});
d.start({ bpm: 120 });

// 先喂一段平稳的音量，让它建立起「这首歌大概多响」的基准
for (let i = 0; i < 3000; i++) d.feed(0.3);
const calmSection = d.section;
check(calmSection === 'normal', '平稳时是普通段落（' + calmSection + '）');

// 副歌来了：音量明显变大
for (let i = 0; i < 400; i++) d.feed(0.75);
check(d.section === 'hype', '音量拉起来 → 高潮段（energy ' + d.energy.toFixed(2) + '）');
check(d.amp > 1, '幅度跟着放开了（' + d.amp.toFixed(2) + '）');

// 间奏：安静下来
for (let i = 0; i < 600; i++) d.feed(0.08);
check(d.section === 'calm', '音量掉下去 → 安静段（energy ' + d.energy.toFixed(2) + '）');
check(d.amp < 1, '幅度收回来了（' + d.amp.toFixed(2) + '）');

console.log('\n[9] 她自己点名跳哪几套时，别自作主张换');
const d2 = new Dancer(fake, () => {});
d2.start({ bpm: 120, steps: ['shy', 'wave'] });
check(d2.autoSection === false, '关掉了自动换池');
for (let i = 0; i < 2000; i++) d2.feed(0.9);
check(d2.order.join() === 'shy,wave', '舞步还是她点的那两套');

console.log('\n[10] 中途改拍子不能让她抽一下');
const d3 = new Dancer(fake, () => {});
d3.start({ bpm: 100 });
const beatBefore = ((performance.now() - d3.t0) / 1000) * (d3.bpm / 60);
d3.setBpm(140);
const beatAfter = ((performance.now() - d3.t0) / 1000) * (d3.bpm / 60);
check(Math.abs(beatAfter - beatBefore) < 0.05, '拍号是连着的（' + beatBefore.toFixed(3) + ' → ' + beatAfter.toFixed(3) + '）');
check(d3.bpm === 140, '拍子确实改了');

d.stop(); d2.stop(); d3.stop();
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
process.exit(bad ? 1 : 0);
