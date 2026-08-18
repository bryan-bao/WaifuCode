'use strict';

// 动作到底连不连贯，逐帧量出来。
//
// 「切片感」的本质是**相邻两帧之间参数跳了一大截**。所以这里假装自己是渲染循环，
// 一帧一帧地驱动编舞引擎，把每个参数每一帧的值都记下来，再看最大跳变有多大。
//
// 顺带验帧率无关：同一段舞用 60fps 和 30fps 各跑一遍，
// 轨迹得基本重合 —— 否则掉帧的时候她的动作会忽快忽慢。
//
// 不开窗口、不花钱、几秒钟跑完。

const { Dancer, STEPS, GESTURES } = require('../src/renderer/dance');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const ANGLE_PARAMS = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
                      'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'];

// 假模型：只负责把写进来的参数记下来。
//
// 一帧里有两个钩子，**顺序必须跟真库一致**：afterMotionUpdate 先（编舞在那儿
// 算这一帧、顺手写掉物理输入那几个参数），beforeModelUpdate 后（写剩下的）。
// 只挂一个的话，编舞根本不会被驱动，整个测试量出来会是一片死寂。
function makeRig() {
  const written = {};
  const after = [];
  const before = [];
  const rig = {
    written,
    frame: () => {
      for (const h of after) h();
      for (const h of before) h();
      return { ...written };
    },
    model: {
      internalModel: {
        coreModel: {
          // 假装什么参数都有。真模型走的是 _parameterIds 那条路，
          // 这儿没有那个数组，dance.js 会自动退回问 getParameterIndex
          getParameterIndex: () => 0,
          // 范围也报成 0~1，这样开合量的行程换算系数就是 1，
          // 量出来的数值跟改这段之前可比
          getParameterMaximumValue: () => 1,
          setParameterValueById: (id, v) => { written[id] = v; },
        },
        on: (ev, cb) => {
          if (ev === 'afterMotionUpdate') after.push(cb);
          else if (ev === 'beforeModelUpdate') before.push(cb);
        },
        motionManager: { stopAllMotions: () => {} },
      },
    },
  };
  return rig;
}

/** 跑一段舞，返回每帧的参数快照 */
function run(opts, seconds, fps, feedFn) {
  const rig = makeRig();
  let t = 0;
  const d = new Dancer(rig.model, () => {}, () => t);
  d.start(opts);

  const frames = [];
  const step = 1000 / fps;
  for (let i = 0; i < seconds * fps; i++) {
    t += step;
    if (feedFn) d.feed(feedFn(i / fps));
    frames.push(rig.frame());
  }
  return { frames, dancer: d, tick: (n) => { for (let i = 0; i < n; i++) { t += step; rig.frame(); } }, rig };
}

/** 相邻帧之间某个参数最多跳了多少 */
function maxJump(frames, param) {
  let max = 0;
  let at = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1][param];
    const b = frames[i][param];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const j = Math.abs(b - a);
    if (j > max) { max = j; at = i; }
  }
  return { max, at };
}

console.log('\n[1] 平稳跳一分钟，逐帧量跳变（60fps，120 BPM）');
{
  const { frames } = run({ bpm: 120 }, 60, 60);
  console.log('    一共 ' + frames.length + ' 帧');

  let worstAngle = 0;
  for (const p of ANGLE_PARAMS) {
    const { max } = maxJump(frames, p);
    if (max > worstAngle) worstAngle = max;
  }
  const armJump = Math.max(maxJump(frames, 'ParamArmLA').max, maxJump(frames, 'ParamArmRA').max);

  console.log('    角度类最大单帧跳变: ' + worstAngle.toFixed(2) + '°');
  console.log('    手臂类最大单帧跳变: ' + armJump.toFixed(3));
  check(worstAngle < 3.5, '角度每帧跳变 < 3.5°（再大肉眼就看出台阶了）');
  check(armJump < 0.12, '手臂每帧跳变 < 0.12');
}

console.log('\n[2] 换舞步的那一下 —— 这是「切片感」的老窝');
{
  // 不做混合的话，换舞步瞬间会跳多少？直接拿两套舞步在同一拍上的值作差
  let worstRaw = 0;
  let pair = '';
  for (const from of Object.keys(STEPS)) {
    for (const to of Object.keys(STEPS)) {
      if (from === to) continue;
      const a = STEPS[from](8, 0.5, 0);
      const b = STEPS[to](8, 0.5, 0);
      for (const k of ['angleX', 'angleY', 'angleZ', 'bodyX', 'bodyY', 'bodyZ']) {
        const d = Math.abs((a[k] || 0) - (b[k] || 0));
        if (d > worstRaw) { worstRaw = d; pair = from + '→' + to + ' 的 ' + k; }
      }
    }
  }
  console.log('    要是说换就换，最狠的一下是 ' + pair + '：' + worstRaw.toFixed(1) + '° 瞬间跳完');

  // 实际跑一遍，看混合之后还剩多少
  const { frames } = run({ bpm: 140, barsPer: 4 }, 40, 60);
  let worst = 0;
  for (const p of ANGLE_PARAMS) worst = Math.max(worst, maxJump(frames, p).max);
  console.log('    实际跑下来最大单帧跳变: ' + worst.toFixed(2) + '°');
  check(worst < worstRaw / 4, '比硬切平滑了至少四倍（' + worstRaw.toFixed(1) + '° → ' + worst.toFixed(2) + '°）');
}

console.log('\n[3] 起跳是「长」出来的，不是「弹」出来的');
{
  const { frames } = run({ bpm: 120 }, 3, 60);
  const first = frames[2];
  const later = frames[100];
  const amp0 = ANGLE_PARAMS.reduce((s, p) => s + Math.abs(first[p] || 0), 0);
  const amp1 = ANGLE_PARAMS.reduce((s, p) => s + Math.abs(later[p] || 0), 0);
  console.log('    第 3 帧的总幅度 ' + amp0.toFixed(2) + '，1.7 秒后 ' + amp1.toFixed(2));
  check(amp0 < 1.5, '刚起跳时几乎还在中性姿势');
  check(amp1 > amp0 * 3, '之后才涨到正常幅度');
}

console.log('\n[4] 收势：慢慢收回中性，收干净了才交还给待机动作');
{
  const r = run({ bpm: 120 }, 10, 60);
  let faded = false;
  r.dancer.stop(() => { faded = true; });

  check(!faded, '刚喊停的时候还没收完（不是当场定住）');
  r.tick(10);
  check(!faded, '十帧之后还在收');

  r.tick(120); // 再给两秒
  check(faded, '收干净了，回调来了（待机动作这时才接手）');

  const end = r.rig.written;
  const rest = ANGLE_PARAMS.reduce((s, p) => s + Math.abs(end[p] || 0), 0);
  console.log('    收完之后的残余幅度: ' + rest.toFixed(3));
  check(rest < 0.6, '停在中性姿势上，跟待机动作接得上');
  check(Math.abs((end.ParamBreath || 0) - 0.5) < 0.1, '呼吸停在中位 0.5，不是憋着气的 0');
}

console.log('\n[5] 帧率无关：60fps 和 30fps 得跳出同一支舞');
{
  const a = run({ bpm: 120 }, 20, 60).frames;
  const b = run({ bpm: 120 }, 20, 30).frames;

  // 取同样的时间点比对（60fps 的第 2i 帧 ≈ 30fps 的第 i 帧）
  let worst = 0;
  for (let i = 30; i < b.length; i++) {
    for (const p of ANGLE_PARAMS) {
      const va = a[i * 2] && a[i * 2][p];
      const vb = b[i] && b[i][p];
      if (typeof va === 'number' && typeof vb === 'number') {
        worst = Math.max(worst, Math.abs(va - vb));
      }
    }
  }
  console.log('    同一时刻两种帧率的最大差异: ' + worst.toFixed(2) + '°');
  check(worst < 2.5, '两种帧率下动作基本一致（掉帧不会让她忽快忽慢）');
}

console.log('\n[6] 不管怎么跳都不许把她甩出去');
{
  const { frames } = run({ bpm: 155, amp: 1.5 }, 30, 60, (t) => 0.5 + 0.5 * Math.sin(t));
  let worst = 0;
  for (const f of frames) {
    for (const p of ANGLE_PARAMS) worst = Math.max(worst, Math.abs(f[p] || 0));
  }
  console.log('    最大幅度: ' + worst.toFixed(1) + '°');
  check(worst < 45, '角度没有失控（< 45°）');
  check(frames.every((f) => ANGLE_PARAMS.every((p) => isFinite(f[p] || 0))), '没有算出 NaN');
}

console.log('\n[7] 情绪动作：不许一顿一顿的，收尾不许「啪」一下');
{
  /**
   * 「僵硬」的物理量是**加速度**，不是速度。
   *
   * 速度大只是动作快（甩头本来就快）；而**速度突变**——加速度尖峰——才是肉眼
   * 读成「顿了一下 / 机械感」的那个东西。老代码的包络是直线
   * （`Math.min(1, t * 4)`），两头各有一个拐点：0 一下变成满速、满速一下变成 0。
   *
   * 更狠的一处在收尾：动作演完当场撒手，而 cur 是带 0.055 秒惯性跟过来的、
   * 还差一点没走到中性 —— 那点残余被瞬间抹掉。逐帧量出来，**每个动作的加速度
   * 峰值都正好落在它结束的那一刻**（happy 1.80s、proud 2.40s、lonely 2.60s…）。
   */
  const GESTS = ['happy', 'proud', 'shy', 'surprised', 'frustrated',
                 'tired', 'sleepy', 'lonely', 'excited'];
  // 这几个是「摆个姿势再收回来」，通篇都该是绵的（甩头、吓一跳本来就该快）
  const SLOW = ['proud', 'shy', 'tired', 'sleepy', 'lonely'];
  const fps = 60;

  const play = (name) => {
    const rig = makeRig();
    let t = 0;
    const d = new Dancer(rig.model, () => {}, () => t);
    d.gesture(name);
    const frames = [];
    for (let i = 0; i < 5 * fps; i++) { t += 1000 / fps; frames.push(rig.frame()); }
    return frames;
  };

  // 一段帧里最大的「速度突变」
  const maxAcc = (frames, from, to) => {
    let m = 0;
    for (const p of ANGLE_PARAMS) {
      for (let i = Math.max(2, from); i < Math.min(frames.length, to); i++) {
        const a = frames[i - 2][p], b = frames[i - 1][p], c = frames[i][p];
        if ([a, b, c].some((x) => typeof x !== 'number')) continue;
        const acc = Math.abs((c - b) - (b - a));
        if (acc > m) m = acc;
      }
    }
    return m;
  };

  let worstSlow = 0, worstEnd = 0, worstRest = 0, worstJump = 0;
  let slowName = '', endName = '';
  for (const name of GESTS) {
    const frames = play(name);

    for (const p of ANGLE_PARAMS) {
      const j = maxJump(frames, p).max;
      if (j > worstJump) worstJump = j;
    }

    // 收尾那一下：**窗口要卡在这个动作自己结束的时刻**上。
    // 图省事看「最后一秒」是不行的——短动作 1.8 秒就演完了，最后一秒早静止了，
    // 量出来永远是 0.000，这条断言就成了永远绿的摆设
    const endAt = Math.round(GESTURES[name].sec * fps);
    const end = maxAcc(frames, endAt - 4, endAt + 30);
    if (end > worstEnd) { worstEnd = end; endName = name; }

    let rest = 0;
    for (const p of ANGLE_PARAMS) {
      const v = frames[frames.length - 1][p];
      if (typeof v === 'number' && Math.abs(v) > rest) rest = Math.abs(v);
    }
    if (rest > worstRest) worstRest = rest;

    if (SLOW.includes(name)) {
      const acc = maxAcc(frames, 0, frames.length);
      if (acc > worstSlow) { worstSlow = acc; slowName = name; }
    }
  }

  console.log('    九个动作里：最大单帧跳变 ' + worstJump.toFixed(2) + '°');
  console.log('    「摆姿势」那五个的最大加速度 ' + worstSlow.toFixed(3) + '°/帧²（' + slowName + '）');
  console.log('    收尾那一下的最大加速度 ' + worstEnd.toFixed(3) + '°/帧²（' + endName + '）');
  console.log('    收完之后残余 ' + worstRest.toFixed(3) + '°');

  check(worstJump < 2.5, '每帧跳变 < 2.5°');
  check(worstSlow < 0.1,
        '**「摆姿势」那几个通篇都是绵的** —— 加速度 < 0.1°/帧²（直线包络时 0.13）');
  // 0.05 这条线是这么定的：改之前每个动作在自己结束那一刻都是 0.10~0.23，
  // 改之后只剩 happy 的 0.033 —— 那是「蹦两下」最后落地本身的顿挫（abs(sin) 的拐点），
  // 是这个动作该有的，不是收尾没收干净
  check(worstEnd < 0.05,
        '**收尾没有「啪」那一下** —— 演完那一刻几乎没有加速度（当场撒手时 0.10~0.23）');
  check(worstRest < 0.2, '收干净了，没把姿势留在半路上');
}

console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
process.exit(bad ? 1 : 0);
