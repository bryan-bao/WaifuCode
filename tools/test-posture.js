'use strict';

// 常驻姿态那一层：她今天什么状态，身体一直挂着，不用戳也看得出来。
//
// 这个自检只盯一件事，但那件事是整层的命门：**加法会不会越加越多**。
//
// 姿态必须叠加在待机动作头上（写绝对值会把动作按死，她当场僵住），
// 而叠加的坑在于帧末的 loadParameters 还原的快照里**含着我们自己写的偏移** ——
// 待机动作没驱动的那些参数，下一帧读回来还带着上一帧的偏移，
// 再加一次就是双份。每帧多一份，几秒钟角度就是几百度，人直接飞出屏幕。
//
// 所以这儿不用 test-smooth 那个简化的假模型，而是**照着真实帧管线复刻一个**：
//
//   动作(只重写它驱动的那些) → afterMotionUpdate → saveParameters
//     → …表情/眨眼/视线/呼吸/物理/pose… → beforeModelUpdate
//     → update → loadParameters(把 save 之后写的全还原)
//
// 只有把「动作不驱动的参数会带着上一帧的值进入下一帧」这件事复刻出来，
// 才测得到那个事故。不花钱，一秒跑完。

const { Dancer, POSTURES } = require('../src/renderer/dance');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

// 待机动作每帧会重写的参数。**其余的它不碰** —— 累加事故就出在那些上面。
// 真模型里这个集合因动作而异，所以代码不能去猜它，只能自己判断。
const DRIVEN = ['ParamAngleZ', 'ParamBreath'];

/**
 * 一个忠实复刻真实帧管线的台子。
 * motionAt(i) 是待机动作这一帧输出的值，用来验证「动作还活着没被按死」。
 */
function makeRig(motionAt) {
  let vals = {};
  const after = [];
  const before = [];
  let i = 0;

  const model = {
    internalModel: {
      coreModel: {
        getParameterIndex: () => 0,
        getParameterMaximumValue: () => 1, // 行程换算系数 = 1，数值好对
        getParameterValueById: (id) => (typeof vals[id] === 'number' ? vals[id] : 0),
        setParameterValueById: (id, v) => { vals[id] = v; },
      },
      on: (ev, cb) => {
        if (ev === 'afterMotionUpdate') after.push(cb);
        else if (ev === 'beforeModelUpdate') before.push(cb);
      },
      motionManager: { stopAllMotions: () => {} },
    },
  };

  const frame = () => {
    const mv = motionAt(i++);
    for (const id of DRIVEN) vals[id] = mv;   // 1. 动作只重写它管的那几个

    for (const h of after) h();               // 2. afterMotionUpdate（物理输入写这儿）
    const snapshot = { ...vals };             // 3. saveParameters
    for (const h of before) h();              // 4. beforeModelUpdate（其余写这儿）

    const seen = { ...vals, _motion: mv };    // 这一帧画面上真正看到的
    vals = snapshot;                          // 5. loadParameters：save 之后写的全还原
    return seen;
  };

  return { model, frame };
}

/** 跑若干帧，返回每帧看到的参数 */
function run(dancer, rig, frames, fps, clock) {
  const step = 1000 / fps;
  const out = [];
  for (let n = 0; n < frames; n++) {
    clock.t += step;
    out.push(rig.frame());
  }
  return out;
}

function spin(posture, frames = 240, fps = 60, motionAt = () => 0) {
  const clock = { t: 0 };
  const rig = makeRig(motionAt);
  const d = new Dancer(rig.model, () => {}, () => clock.t);
  d.setPosture(posture);
  const seen = run(d, rig, frames, fps, clock);
  return { d, rig, clock, seen, fps };
}

console.log('\n[1] 最要命的一条：动作不驱动的参数不许越加越多');
{
  // sleepy 同时覆盖四种情况，一次全测了：
  //   angleZ  物理输入 + 动作驱动
  //   breath  非物理   + 动作驱动
  //   angleY  物理输入 + 动作**不**驱动  ← 事故就在这类上
  //   shoulder 非物理  + 动作**不**驱动
  const { seen } = spin('sleepy', 600, 60); // 跑满 10 秒

  const at = (n, p) => seen[n][p] || 0;
  const want = POSTURES.sleepy;

  // 半衰期 0.38 秒，第 5 秒时离目标已经只差万分之一 —— 从这儿到第 10 秒
  // 还有任何变化，就只可能是累加，不可能是「还在收敛」
  const s5 = 300;
  const s10 = 599;

  const drift = Math.abs(at(s10, 'ParamAngleY') - at(s5, 'ParamAngleY'));
  console.log('    ParamAngleY  第5秒 ' + at(s5, 'ParamAngleY').toFixed(4) +
              ' → 第10秒 ' + at(s10, 'ParamAngleY').toFixed(4) +
              '（目标 ' + want.angleY + '）');
  check(drift < 1e-3, '**物理输入 + 动作不驱动：五秒里一动没动**（漂了就是每帧在累加）');
  check(Math.abs(at(s10, 'ParamAngleY') - want.angleY) < 0.01, '而且停在该停的地方');

  const sdrift = Math.abs(at(s10, 'ParamShoulder') - at(s5, 'ParamShoulder'));
  console.log('    ParamShoulder 第5秒 ' + at(s5, 'ParamShoulder').toFixed(4) +
              ' → 第10秒 ' + at(s10, 'ParamShoulder').toFixed(4) +
              '（目标 ' + want.shoulder + '）');
  check(sdrift < 1e-3, '非物理 + 动作不驱动：也一动没动');
  check(Math.abs(at(s10, 'ParamShoulder') - want.shoulder) < 0.01, '也停在该停的地方');

  // 顺带确认真的没算出天文数字
  const worst = seen.reduce((m, f) => Math.max(m,
    Math.abs(f.ParamAngleY || 0), Math.abs(f.ParamAngleX || 0), Math.abs(f.ParamBodyAngleY || 0)), 0);
  console.log('    十秒里最大角度: ' + worst.toFixed(1) + '°');
  check(worst < 20, '没有失控（真出事故的话这儿会是几百度）');
}

console.log('\n[2] 待机动作还活着 —— 姿态是「掰一点」，不是「按死」');
{
  // 让动作输出一个明显在动的正弦波
  const motion = (i) => Math.sin(i / 10) * 12;
  const { seen } = spin('sleepy', 600, 60, motion);

  const tail = seen.slice(400); // 收敛完了再看，不然量到的是渐变本身
  const zs = tail.map((f) => f.ParamAngleZ || 0);
  const span = Math.max(...zs) - Math.min(...zs);
  console.log('    ParamAngleZ 的摆幅: ' + span.toFixed(1) + '°（动作本身是 24°）');
  check(span > 20, '**动作驱动的参数照样在动** —— 没被姿态按住');

  // 而且是「动作 + 固定偏移」，不是别的什么东西
  const offs = tail.map((f) => (f.ParamAngleZ || 0) - f._motion);
  const spread = Math.max(...offs) - Math.min(...offs);
  console.log('    减掉动作之后剩下的偏移: ' + offs[offs.length - 1].toFixed(3) +
              '（目标 ' + POSTURES.sleepy.angleZ + '，抖动 ' + spread.toFixed(4) + '）');
  check(spread < 0.01, '偏移是稳的常量，没跟着动作一起抖');
  check(Math.abs(offs[offs.length - 1] - POSTURES.sleepy.angleZ) < 0.05, '偏移量正是姿态要的那个');
}

console.log('\n[3] normal 姿态什么都不写 —— 闲着时一点都不许干扰待机动作');
{
  const motion = (i) => Math.sin(i / 10) * 12;
  const { seen } = spin('normal', 120, 60, motion);
  const off = seen.slice(60).map((f) => Math.abs((f.ParamAngleZ || 0) - f._motion));
  check(Math.max(...off) < 1e-9, '动作输出什么，画面上就是什么，一丝不差');
  check(!('ParamShoulder' in seen[119]) || seen[119].ParamShoulder === 0,
        '连碰都没碰过没偏移的参数');
}

console.log('\n[4] 换姿态是渐变的，不是「唰」一下被人掰过去');
{
  const clock = { t: 0 };
  const rig = makeRig(() => 0);
  const d = new Dancer(rig.model, () => {}, () => clock.t);
  d.setPosture('normal');
  run(d, rig, 30, 60, clock);

  d.setPosture('sleepy');           // 心情从 normal 掉到 sleepy
  const seen = run(d, rig, 180, 60, clock);

  let jump = 0;
  for (let i = 1; i < seen.length; i++) {
    jump = Math.max(jump, Math.abs((seen[i].ParamAngleY || 0) - (seen[i - 1].ParamAngleY || 0)));
  }
  console.log('    相邻帧最大跳变: ' + jump.toFixed(3) + '°');
  check(jump < 0.6, '一帧一帧挪过去的（跳变 < 0.6°）');

  // 半衰期 0.38 秒：第 0.4 秒该走了一半左右，别太快也别太慢
  const half = seen[24].ParamAngleY || 0;
  console.log('    0.4 秒时走到: ' + half.toFixed(2) + '° / ' + POSTURES.sleepy.angleY + '°');
  check(half > 2.5 && half < 7, '快慢合适（0.4 秒走掉一半上下）');
}

console.log('\n[5] 跳舞和演情绪动作时，姿态让位');
{
  const clock = { t: 0 };
  const rig = makeRig(() => 0);
  const d = new Dancer(rig.model, () => {}, () => clock.t);
  d.setPosture('sleepy');
  const idle = run(d, rig, 300, 60, clock);
  const before = idle[idle.length - 1].ParamAngleY;

  d.start({ bpm: 120, steps: ['sway'] });
  run(d, rig, 90, 60, clock);   // 1.5 秒
  // 量的是**实际加进去的偏移**，不是内部那个 postureCur ——
  // 后者现在只管「她本来的姿态」，让位是写入时乘 postureGain 实现的
  const leaked = Math.abs(d.lastDelta.angleY || 0);
  console.log('    起跳前偏移 ' + before.toFixed(2) + '° → 跳起来 1.5 秒后还剩 ' +
              leaked.toFixed(3) + '°');
  check(leaked < 0.2,
        '**跳舞时姿态让位了** —— 不然「困」的姿态叠上舞步，幅度会超出设计');

  d.stop();
  run(d, rig, 240, 60, clock);
  check(Math.abs((d.lastDelta.angleY || 0) - POSTURES.sleepy.angleY) < 0.5,
        '不跳了姿态自己回来（她还是困，这个没变）');
}

console.log('\n[6] 回到 normal 要收干净，不能留个尾巴');
{
  const clock = { t: 0 };
  const rig = makeRig(() => 0);
  const d = new Dancer(rig.model, () => {}, () => clock.t);
  d.setPosture('lonely');
  run(d, rig, 240, 60, clock);

  d.setPosture('normal');
  const seen = run(d, rig, 300, 60, clock);
  const last = seen[seen.length - 1];

  check(Math.abs(last.ParamAngleX || 0) < 1e-9, '偏移彻底归零（不是「差不多零」）');
  check(d.lastDelta.angleX === 0, '内部记账也清了，下一帧就不再碰这个参数了');
}

console.log('\n[7] 认不出来的姿态名不许把她掰坏');
{
  const { d, seen } = spin('这是个不存在的状态', 120, 60);
  const last = seen[seen.length - 1];
  check(Math.abs(last.ParamAngleY || 0) < 1e-9, '当成 normal 处理，一动不动');
  check(d.posture === POSTURES.normal, '内部也确实退回了 normal');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
