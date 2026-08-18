'use strict';

// 编舞和选歌的自检。不开窗口、不花钱、不放声音。
//
// 舞步是纯函数（拍号 → 各部位该摆成什么样），所以能直接在 node 里跑一遍，
// 检查它有没有把身体扭到离谱的角度、会不会算出 NaN 卡住整个渲染循环。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { STEPS, ORDER } = require('../src/renderer/dance');
const { Performer } = require('../src/perform');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

// 角度类参数超过这个就不像跳舞像抽筋了
const ANGLE_LIMIT = 40;
const ANGLE_KEYS = ['angleX', 'angleY', 'angleZ', 'bodyX', 'bodyY', 'bodyZ'];
const UNIT_KEYS = ['armL', 'armR', 'handL', 'handR', 'shoulder', 'leg', 'breath'];

console.log('\n[1] 每套舞步都得算得出、算得稳');
for (const name of ORDER) {
  const fn = STEPS[name];
  let allFinite = true;
  let inRange = true;
  let moves = new Set();

  // 跳满 16 拍，音量从静到满，都试一遍
  for (let i = 0; i < 320; i++) {
    const beat = i / 20;
    const level = (i % 40) / 40;
    const out = fn(beat, level, i % 20 === 0 ? 1 : 0);

    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'number') continue;
      if (!isFinite(v)) allFinite = false;
      if (ANGLE_KEYS.includes(k) && Math.abs(v) > ANGLE_LIMIT) inRange = false;
      if (UNIT_KEYS.includes(k) && Math.abs(v) > 1.05) inRange = false;
      moves.add(k + ':' + v.toFixed(2));
    }
  }

  check(allFinite, name + ' —— 没算出 NaN / Infinity');
  check(inRange, name + ' —— 幅度没超（角度 ≤' + ANGLE_LIMIT + '°，其余 ≤1）');
  check(moves.size > 20, name + ' —— 是在动的，不是摆个固定姿势（' + moves.size + ' 种取值）');
}

console.log('\n[2] 该动的部位都动了');
for (const name of ORDER) {
  const keys = new Set();
  for (let i = 0; i < 80; i++) {
    for (const k of Object.keys(STEPS[name](i / 10, 0.5, 0))) keys.add(k);
  }
  const hasHead = ['angleX', 'angleY', 'angleZ'].some((k) => keys.has(k));
  const hasBody = ['bodyX', 'bodyY', 'bodyZ'].some((k) => keys.has(k));
  check(hasHead && hasBody, name + ' —— 头和身子都参与了');
  check(!keys.has('mouth') && !keys.has('eye'), name + ' —— 没去碰嘴和眼睛（留给口型和眨眼）');
}

console.log('\n[3] 音乐越响动作越大');
for (const name of ['sway', 'bounce', 'swing']) {
  const quiet = STEPS[name](1.3, 0.0, 0);
  const loud = STEPS[name](1.3, 1.0, 0);
  const amp = (o) => ANGLE_KEYS.reduce((s, k) => s + Math.abs(o[k] || 0), 0);
  check(amp(loud) >= amp(quiet), name + ' —— 大声时幅度不小于安静时');
}

console.log('\n[4] 歌名里的 BPM 和标题');
check(Performer.bpmOf('某首歌 [128].mp3') === 128, '[128] 解析成 128');
check(Performer.bpmOf('没写拍子.mp3') === null, '没写就是 null，用默认拍子');
check(Performer.bpmOf('乱写的 [999].mp3') === null, '离谱的数值不认');
check(Performer.titleOf('某首歌 [128].mp3') === '某首歌', '标题里把 BPM 标记去掉');
check(Performer.titleOf('another song.flac') === 'another song', '没标记的原样保留');

console.log('\n[5] music 文件夹');
const p = new Performer({ log: () => {} });
check(fs.existsSync(p.dir), '目录自动建好了');
check(fs.existsSync(path.join(p.dir, '把歌放这里.txt')), '放了张说明进去');
const list = p.list();
check(Array.isArray(list), '列得出歌单（现在 ' + list.length + ' 首）');
check(!list.some((s) => !/\.(mp3|m4a|aac|wav|ogg|opus|flac|weba|webm)$/i.test(s.file)), '只认音频文件');

console.log('\n[6] 只认歌单里的文件，别的一律不读');
// 先放一个占位文件进去，让歌单非空 —— 否则会因为「一首歌都没有」提前抛错，
// 根本走不到该验的那段逻辑上（第一版测试就是这么自己骗了自己）
const decoy = path.join(p.dir, '_自检占位 [100].mp3');
fs.writeFileSync(decoy, Buffer.alloc(64));
try {
  check(p.list().some((s) => s.file === path.basename(decoy)), '占位文件进了歌单');

  for (const evil of ['..\\config.json', '../config.json', 'C:\\Windows\\win.ini']) {
    let blocked = false;
    let why = '';
    try { p.load(evil); } catch (err) { blocked = true; why = err.message; }
    check(blocked, '拒绝了 ' + evil + '（' + why + '）');
  }
} finally {
  fs.unlinkSync(decoy); // 自己造的自己收拾干净
}

console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
process.exit(bad ? 1 : 0);
