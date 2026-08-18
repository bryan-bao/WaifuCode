'use strict';

// 情绪动作 + 眼神偏移的自检。不开窗口、不花钱。
//
// 最要紧的一条：**眼神必须是「在别人写完的值上再加一点」，不能直接赋值。**
// 表情系统、自动眨眼、唱歌口型同步都在写这几个参数，
// 一旦覆盖，她就变成一张不会眨眼也不会张嘴的僵脸 —— 而且不会报任何错。

const { Dancer, GESTURES, NEUTRAL } = require('../src/renderer/dance');

// look.js 里会碰 PIXI 的滤镜，node 里没有，先摆一个假的
global.PIXI = { filters: { ColorMatrixFilter: function () { this.matrix = []; } } };
const { Look, PRESETS, TINTS } = require('../src/renderer/look');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const ANGLE_KEYS = ['angleX', 'angleY', 'angleZ', 'bodyX', 'bodyY', 'bodyZ'];
const UNIT_KEYS = ['armL', 'armR', 'handL', 'handR', 'shoulder', 'leg', 'breath'];

console.log('\n[1] 每个情绪动作的曲线');
for (const [name, g] of Object.entries(GESTURES)) {
  let finite = true;
  let inRange = true;
  let moves = new Set();

  for (let i = 0; i <= 100; i++) {
    const out = g.fn(i / 100);
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'number') continue;
      if (!isFinite(v)) finite = false;
      if (ANGLE_KEYS.includes(k) && Math.abs(v) > 32) inRange = false;
      if (UNIT_KEYS.includes(k) && Math.abs(v) > 1.05) inRange = false;
      moves.add(k + ':' + v.toFixed(2));
    }
  }

  // 首尾都该收在中性附近，不然接不回待机姿势
  const head = g.fn(0);
  const tail = g.fn(1);
  const amp = (o) => ANGLE_KEYS.reduce((s, k) => s + Math.abs(o[k] || 0), 0);

  const ok = finite && inRange && moves.size > 10 && amp(head) < 6 && amp(tail) < 6;
  check(ok, name.padEnd(11) + ' 时长 ' + g.sec + 's，' + moves.size + ' 种取值，' +
        '起 ' + amp(head).toFixed(1) + '° 收 ' + amp(tail).toFixed(1) + '°');
}

// --- 假模型 ---
//
// 两个钩子分开收，触发顺序跟真库一致：afterMotionUpdate（编舞在这儿算这一帧、
// 写物理输入）→ beforeModelUpdate（编舞写剩下的、眼神在这儿叠偏移）。
function makeRig(paramValues) {
  const written = {};
  const after = [];
  const before = [];
  const vals = paramValues || {};
  return {
    written, hooks: before,
    fire: () => { for (const h of after) h(); for (const h of before) h(); },
    model: {
      internalModel: {
        coreModel: {
          getParameterIndex: () => 0,
          getParameterMaximumValue: () => 1, // 报 0~1，行程换算系数就是 1
          getParameterValueById: (id) => (vals[id] !== undefined ? vals[id] : 0),
          setParameterValueById: (id, v) => { written[id] = v; },
        },
        on: (ev, cb) => {
          if (ev === 'afterMotionUpdate') after.push(cb);
          else if (ev === 'beforeModelUpdate') before.push(cb);
        },
        motionManager: { stopAllMotions: () => {} },
      },
      filters: null,
    },
  };
}

console.log('\n[2] 情绪动作：播得出、播完自己收');
{
  const rig = makeRig();
  let t = 0;
  const d = new Dancer(rig.model, () => {}, () => t);

  check(d.gesture('happy') === true, '接了「开心」这个动作');
  check(d.gesture('nonexistent') === false, '没这个动作就老实说不接');

  // 播到一半，身体应该真的在动
  for (let i = 0; i < 50; i++) { t += 1000 / 60; rig.fire(); }
  const mid = ANGLE_KEYS.reduce((s, k) => s + Math.abs(rig.written[{ angleX: 'ParamAngleX', angleY: 'ParamAngleY', angleZ: 'ParamAngleZ', bodyX: 'ParamBodyAngleX', bodyY: 'ParamBodyAngleY', bodyZ: 'ParamBodyAngleZ' }[k]] || 0), 0);
  check(mid > 2, '播到一半身体确实在动（幅度 ' + mid.toFixed(1) + '°）');

  // 播完 + 收势
  for (let i = 0; i < 240; i++) { t += 1000 / 60; rig.fire(); }
  const end = Math.abs(rig.written.ParamAngleY || 0) + Math.abs(rig.written.ParamBodyAngleY || 0);
  check(d.gest === null, '动作播完了，自己退场');
  check(end < 0.6, '收回中性姿势（残余 ' + end.toFixed(3) + '°）');
}

console.log('\n[3] 跳舞时不许插队');
{
  const rig = makeRig();
  let t = 0;
  const d = new Dancer(rig.model, () => {}, () => t);
  d.start({ bpm: 120 });
  check(d.gesture('shy') === false, '正在跳舞，情绪动作被挡住了（不然动作会打架）');
}

console.log('\n[4] 眼神：只加不覆盖 —— 这条最要命');
{
  // 假装表情系统已经把这些参数写成了这些值
  const rig = makeRig({
    ParamEyeLSmile: 0.3, ParamEyeRSmile: 0.3,
    ParamCheek: 0.2, ParamBrowLY: 0.1, ParamBrowRY: 0.1,
    ParamBrowLAngle: 0, ParamBrowRAngle: 0,
    ParamEyeBallX: 0.4, ParamEyeBallY: 0,
  });

  const look = new Look(rig.model, () => {});
  look.apply({ preset: 'gentle', tint: 'none' });
  rig.fire();

  const p = PRESETS.gentle;
  console.log('    温柔预设的笑眼偏移 ' + p.smile + '，表情系统原本写的是 0.3');
  console.log('    最终写进去的是 ' + rig.written.ParamEyeLSmile);
  check(Math.abs(rig.written.ParamEyeLSmile - (0.3 + p.smile)) < 0.001,
        '笑眼 = 原值 + 偏移（不是把原值冲掉）');
  check(rig.written.ParamEyeBallX === undefined,
        '偏移是 0 的参数**根本不去碰它**（视线跟随完全不受干扰）');

  // 换个视线偏移非 0 的预设，验证叠加确实在做
  const rig2 = makeRig({ ParamEyeBallX: 0.4 });
  new Look(rig2.model, () => {}).apply({ preset: 'tsundere', tint: 'none' });
  rig2.fire();
  const t = PRESETS.tsundere;
  check(Math.abs(rig2.written.ParamEyeBallX - (0.4 + t.eyeX * 0.5)) < 0.001,
        '偏移非 0 时叠在原值上（0.4 + ' + (t.eyeX * 0.5) + ' = ' + rig2.written.ParamEyeBallX.toFixed(3) + '）');
  check(rig.written.ParamEyeLOpen === undefined && rig.written.ParamMouthOpenY === undefined,
        '**没碰眼睛开合和嘴** —— 那两个归眨眼和口型同步管');
}

console.log('\n[5] 眼神：微调叠在预设之上，而且夹得住');
{
  const rig = makeRig({});
  const look = new Look(rig.model, () => {});
  look.apply({ preset: 'tsundere', smile: 0.5, cheek: 0.5, tint: 'none' });
  rig.fire();

  const p = PRESETS.tsundere;
  check(Math.abs(rig.written.ParamCheek - Math.min(1, p.cheek + 0.5)) < 0.001,
        '脸红 = 傲娇预设(' + p.cheek + ') + 微调(0.5)');

  // 拉到爆也不能超出参数范围
  const rig2 = makeRig({ ParamCheek: 0.9 });
  const look2 = new Look(rig2.model, () => {});
  look2.apply({ preset: 'tsundere', cheek: 1, tint: 'none' });
  rig2.fire();
  check(rig2.written.ParamCheek <= 1.0001, '拉满也不会越界（' + rig2.written.ParamCheek + ' ≤ 1）');
}

console.log('\n[6] 预设和色调表本身');
{
  for (const [id, p] of Object.entries(PRESETS)) {
    const ok = ['smile', 'cheek', 'brow', 'browAngle', 'eyeX', 'eyeY']
      .every((k) => typeof p[k] === 'number' && Math.abs(p[k]) <= 1);
    check(ok, '预设「' + p.label + '」的数值都在 -1~1 之间');
  }
  for (const [id, t] of Object.entries(TINTS)) {
    if (!t) continue;
    check(Array.isArray(t.matrix) && t.matrix.length === 20,
          '色调「' + t.label + '」是合法的 5×4 颜色矩阵');
  }
}

console.log('\n[7] 模型不认识这些参数时不能崩');
{
  const rig = {
    model: {
      internalModel: {
        coreModel: { getParameterIndex: () => -1 }, // 什么参数都没有
        on: () => {},
      },
    },
  };
  let threw = false;
  try {
    const look = new Look(rig.model, () => {});
    look.apply({ preset: 'gentle', tint: 'warm' });
  } catch (_) { threw = true; }
  check(!threw, '一个参数都对不上也能安静地什么都不做');
}

console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
process.exit(bad ? 1 : 0);
