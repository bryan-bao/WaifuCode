'use strict';

// 编舞。
//
// 没有走「循环播放模型自带的 motion」那条路 —— 那些动作是设计给待机用的，
// 一个接一个放出来只是「她在动」，不是「她在跳舞」。这里直接按拍子驱动
// 身体参数：腰左右摆、头跟着歪、肩膀弹、腿踏步、手臂甩。
//
// 白捡的好处是 Live2D 的物理：只要身体动起来，头发、呆毛、裙子、缎带
// 会自己跟着甩，完全不用管。这也是它看起来「像真的在跳」的一大半原因。
//
// 两条纪律：
//   1. 只碰身体，**不碰眼睛和嘴**。眼睛留给自动眨眼，嘴留给唱歌的口型同步，
//      抢了就会变成一张僵脸在扭。
//   2. 写参数要分两个时机，见下面「写在什么时候」那一段。
//
// ---------------------------------------------------------------------------
// 写在什么时候：一帧里有两个钩子，各管一半
//
// 库里每一帧的实际顺序是（node_modules/pixi-live2d-display/dist/cubism4.js）：
//
//   动作 → **afterMotionUpdate** → saveParameters → 表情 → 眨眼 → 视线 → 呼吸
//        → physics.evaluate → pose → **beforeModelUpdate** → coreModel.update()
//        → loadParameters（把 save 之后写的全还原回去）
//
// 于是同一个值写在哪个钩子上，效果完全不同：
//
//   · beforeModelUpdate 在**物理下游** —— 这一帧画面上看得见，但物理算不到它，
//     所以头发、裙子、缎带**一根都不会跟着甩**。实测同样 ±25° 的 AngleZ 跑 3 秒，
//     写这里 ParamSkirt 摆幅 0.362（基线 0.379，等于毫无反应）。
//   · afterMotionUpdate 在**物理上游**，而且它写的值会被随后的 saveParameters
//     记进快照，帧末的 loadParameters 还原的就是它自己 —— 不会丢。
//     同一段信号写这里，ParamSkirt 摆幅 2.000，直接打满。
//
// 所以：**能带动物理的那几个参数（见 PHYSICS_KEYS）走 afterMotionUpdate，
// 其余的走 beforeModelUpdate。** 后者晚于表情和眨眼，才压得住动作数据。
//
// 顺带一个好处：物理输入只在 afterMotionUpdate 写一次，后面的视线（updateFocus）
// 和呼吸（CubismBreath）都是**加法**叠上来的 —— 跳舞时她照样会呼吸、
// 照样会瞟你一眼，而不是被我们按死。

const TAU = Math.PI * 2;

// 每段舞跳几拍再换下一段
const BARS_PER_STEP = 8;

/**
 * 一套舞步就是一个函数：给它「现在是第几拍」和「音乐多大声」，
 * 它吐出这一帧各个参数该是多少。
 *
 * beat  —— 走过的拍数，带小数（2.5 就是第二拍半）
 * level —— 当前音量 0~1，用来让动作跟着音乐大小起伏
 * kick  —— 刚踩到重拍时是 1，然后迅速衰减到 0，用来做「弹一下」
 */
const STEPS = {
  // 左右摇摆：最基础的律动，腰跟头反着走，像真人跟拍子
  sway(beat, level, kick) {
    const p = beat * Math.PI; // 两拍一个来回
    return {
      bodyX: Math.sin(p) * 12 * (0.6 + level * 0.6),
      bodyZ: Math.sin(p) * 6,
      angleX: Math.sin(p) * 14,
      angleZ: -Math.sin(p) * 10,
      shoulder: kick * 0.35,
      armL: 0.15 + Math.sin(p) * 0.15,
      armR: 0.15 - Math.sin(p) * 0.15,
      breath: 0.5 + Math.sin(p) * 0.5,
    };
  },

  // 上下弹跳：重拍往下沉一下，靠肩膀和呼吸做出弹性
  bounce(beat, level, kick) {
    const p = beat * TAU;
    const bob = Math.abs(Math.sin(p / 2));
    return {
      bodyY: -bob * 9 * (0.5 + level),
      angleY: -bob * 8,
      angleZ: Math.sin(p / 4) * 6,
      shoulder: bob * 0.6,
      leg: Math.sin(p / 2) * 0.5,
      armL: 0.3 + bob * 0.3,
      armR: 0.3 + bob * 0.3,
      armL2: 0.2 + bob * 0.35,
      armR2: 0.2 + bob * 0.35,
      // 整个人真的上下走。以前「弹跳」全靠身体角度装，脚底板一直钉在原地
      allY: bob * 3.2,
      breath: bob,
      kick,
    };
  },

  // 手臂波浪：左右手错开半拍，身体轻轻跟
  wave(beat, level) {
    const p = beat * Math.PI;
    return {
      bodyX: Math.sin(p / 2) * 7,
      angleX: Math.sin(p / 2) * 9,
      angleZ: Math.sin(p) * 7,
      armL: 0.5 + Math.sin(p) * 0.5,
      armR: 0.5 + Math.sin(p + Math.PI) * 0.5,
      // 波浪是一节一节传下去的：肩 → 肘 → 腕，各差四分之一拍。
      // 只动肩的话那是两根棍子在划圈，不是波浪
      armL2: 0.45 + Math.sin(p - Math.PI / 2) * 0.45,
      armR2: 0.45 + Math.sin(p + Math.PI / 2) * 0.45,
      armL3: 0.3 + Math.sin(p - Math.PI) * 0.3,
      armR3: 0.3 + Math.sin(p) * 0.3,
      handL: Math.sin(p) * 0.6,
      handR: Math.sin(p + Math.PI) * 0.6,
      breath: 0.5 + Math.sin(p) * 0.5,
      level,
    };
  },

  // 踏步转身：整个人小幅度转过去又转回来
  step(beat, level, kick) {
    const p = beat * Math.PI;
    const turn = Math.sin(beat * Math.PI / 4); // 八拍一个大来回
    return {
      bodyY: turn * 16,
      angleY: turn * 12,
      bodyX: Math.sin(p) * 6,
      angleZ: Math.sin(p) * 8,
      leg: Math.sin(p) * 0.9,
      // Mao 身上压根没有 ParamLeg（probe-params 查出来的），所以上面那行在她身上
      // 是空转的 —— 靠整体的左右挪动和倾斜把「踏步」做出来
      allX: turn * 2.5,
      allRot: Math.sin(p) * 2,
      shoulder: kick * 0.4,
      armL: 0.2 + turn * 0.35,
      armR: 0.2 - turn * 0.35,
      breath: 0.5 + Math.sin(p) * 0.5,
      level,
    };
  },

  // 甩头：幅度最大的一段，留给副歌
  swing(beat, level, kick) {
    const p = beat * Math.PI;
    return {
      angleZ: Math.sin(p) * 22 * (0.6 + level * 0.5),
      angleX: Math.sin(p / 2) * 16,
      bodyZ: Math.sin(p) * 10,
      bodyX: Math.sin(p / 2) * 10,
      shoulder: kick * 0.5,
      armL: 0.4 + Math.sin(p) * 0.4,
      armR: 0.4 - Math.sin(p) * 0.4,
      armL2: 0.35 + Math.sin(p) * 0.35,
      armR2: 0.35 - Math.sin(p) * 0.35,
      handL: Math.sin(p) * 0.5,
      handR: -Math.sin(p) * 0.5,
      allRot: Math.sin(p) * 3.5,
      allY: Math.abs(Math.sin(p)) * 1.6,
      breath: 1,
    };
  },

  // 转身：整个人转过去停一下再转回来，慢歌里很好用
  spin(beat, level) {
    const turn = Math.sin(beat * Math.PI / 4);
    const ease = Math.sign(turn) * Math.pow(Math.abs(turn), 0.6); // 到位后停一下再走
    return {
      bodyY: ease * 26,
      angleY: ease * 18,
      angleZ: Math.sin(beat * Math.PI / 2) * 8,
      armL: 0.35 + ease * 0.4,
      armR: 0.35 - ease * 0.4,
      armL2: 0.3 + ease * 0.3,
      armR2: 0.3 - ease * 0.3,
      allRot: ease * 4,
      allX: ease * 2,
      handL: ease * 0.5,
      handR: -ease * 0.5,
      breath: 0.5 + Math.sin(beat * Math.PI) * 0.5,
      level,
    };
  },

  // 拍手：双手往中间收，重拍上合一下
  clap(beat, level, kick) {
    const p = beat * Math.PI;
    const close = (Math.sin(p) + 1) / 2;
    return {
      armL: 0.55 + close * 0.4,
      armR: 0.55 + close * 0.4,
      // 拍手是往身前收，肘弯不下来的话两只手根本碰不到一块
      armL2: 0.3 + close * 0.55,
      armR2: 0.3 + close * 0.55,
      handL: close * 0.8,
      handR: -close * 0.8,
      shoulder: kick * 0.45,
      angleZ: Math.sin(p / 2) * 7,
      bodyX: Math.sin(p / 2) * 5,
      angleY: -close * 5,
      breath: close,
      level,
    };
  },

  // 小碎步：幅度收得很小，害羞或者慢歌用
  shy(beat, level) {
    const p = beat * Math.PI;
    return {
      bodyX: Math.sin(p / 2) * 4,
      angleX: Math.sin(p / 2) * 5,
      angleZ: Math.sin(p / 4) * 4,
      angleY: 4,             // 微微低头
      shoulder: 0.2,
      armL: 0.1,
      armR: 0.1,
      breath: 0.4 + Math.sin(p / 2) * 0.3,
      level,
    };
  },

  // 定格：几乎不动，摆个姿势喘口气，用来收尾
  pose(beat, level) {
    const p = beat * Math.PI / 4;
    return {
      angleZ: 8 + Math.sin(p) * 2,
      angleX: 6,
      bodyZ: 5,
      bodyX: 3,
      armL: 0.7,
      armR: 0.2,
      handL: 0.4,
      breath: 0.3 + Math.sin(p) * 0.3,
      level,
    };
  },
};

// 没指定舞步时的默认串烧
const ORDER = ['sway', 'bounce', 'wave', 'step', 'swing'];

/**
 * 按段落分的三个舞步池。
 *
 * 一首歌从头到尾一个劲儿地摇，看两分钟就腻了 —— 真人跳舞是前奏轻轻晃、
 * 副歌整个人放开、间奏收回来喘口气。这里靠音量包络判断现在是哪一段，
 * 从对应的池子里挑舞步。
 */
const POOLS = {
  calm: ['shy', 'sway', 'pose'],
  normal: ['sway', 'wave', 'step', 'clap'],
  hype: ['bounce', 'swing', 'spin'],
};

// 这些是角度（度），整体幅度缩放只作用在它们身上；
// armL/breath 那些是 0~1 的开合量，缩放了语义就变了
// allX/allY/allRot 也算进来：它们的单位就是参数自己的单位（-10~10），
// 跟角度一样直接写、不做「开到几成」的行程换算
const ANGLE_KEYS = ['angleX', 'angleY', 'angleZ', 'bodyX', 'bodyY', 'bodyZ',
                    'allX', 'allY', 'allRot'];

/**
 * 哪几个参数是**物理的输入**——写它们，头发裙子缎带才会跟着甩。
 *
 * 这几个名字是 Live2D 的标准命名，解模型自己的 physics3.json 逐条核对过：
 *   Hiyori  输入 = AngleX / AngleZ / BodyAngleX / BodyAngleY / BodyAngleZ
 *   Mao     输入 = 上面那五个，**再加 AngleY**（她点头也会带动帽子和头发）
 * 取并集，六个都算上。多算一个的代价只是它也在动作之后写（本来就该压过动作），
 * 少算一个的代价是那个方向上头发彻底不动 —— 不对称，宁可多算。
 *
 * 物理的**输出**是 ParamHairFront / ParamHairBack / ParamSkirt / ParamRobeL /
 * ParamHatBrim 那一堆 —— **千万别去直接写那些**，那是物理算出来的结果，
 * 手写等于把物理效果按死。
 */
const PHYSICS_KEYS = new Set(['angleX', 'angleY', 'angleZ', 'bodyX', 'bodyY', 'bodyZ']);

/**
 * 这个参数在模型上实际存不存在。
 *
 * **不能用 `getParameterIndex(name) >= 0` 判断。** 那个函数遇到不认识的 id
 * 不会返回 -1，而是**现编一个下标**（参数总数 + 已经编过的个数）并缓存下来 ——
 * 实测给 Hiyori 传一个瞎编的名字，返回的是 70，而它参数总数正好 70。
 * 于是 `idx >= 0` 恒真，PARAM_MAP 里那些备选名（'ParamArmL' 之类）
 * 从来没轮到过，而写进去的值全进了黑洞，**一句报错都没有**。
 *
 * `_parameterIds` 是 framework 自己 push 出来的普通字符串数组，问它才作数。
 * 拿不到这个数组时（比如测试里的假模型）再退回老办法。
 */
function hasParam(core, name) {
  if (Array.isArray(core._parameterIds)) return core._parameterIds.includes(name);
  try { return core.getParameterIndex(name) >= 0; } catch (_) { return false; }
}

/**
 * 不跳舞时的中性姿势。
 *
 * 有两个地方要用它，都很关键：
 *
 * 1. **舞步没输出的参数得有个归宿。** 每套舞步只管自己关心的那几个部位 ——
 *    sway 把腰摆到 +12°，切到 spin 时 spin 压根不写腰，那一帧腰就失控了，
 *    看着就是「咔」地一下。缺的参数一律当成中性值参与混合，就没这回事。
 *
 * 2. **起跳和停跳的淡入淡出。** 从中性渐渐长到舞姿、再渐渐收回中性，
 *    收完了才把身体交还给待机动作，中间不会有一帧的突变。
 */
const NEUTRAL = {
  angleX: 0, angleY: 0, angleZ: 0,
  bodyX: 0, bodyY: 0, bodyZ: 0,
  breath: 0.5, // 呼吸的中位，不是 0 —— 0 是憋着气
  shoulder: 0, leg: 0,
  armL: 0, armR: 0, handL: 0, handR: 0,
  armL2: 0, armL3: 0, armR2: 0, armR3: 0, // 肘和腕
  allX: 0, allY: 0, allRot: 0,            // 整个人
};

// 换舞步时交叉淡化的长度（拍）。跟着 BPM 走，快歌切得利落、慢歌切得绵。
const CROSS_BEATS = 1.1;
const FADE_IN_SEC = 0.45;
const FADE_OUT_SEC = 0.55;

// 姿态换过去的快慢。比舞步那道平滑（0.055）慢一个数量级 —— 心情是渐变的，
// 「唰」地换个姿势会像被人从背后掰了一下
const POSTURE_HALFLIFE = 0.38;

/**
 * 帧率无关的逼近：halfLife 秒走完当前差距的一半。
 *
 * 不能写成 `cur += (want-cur) * 0.15` 那样 —— 那个 0.15 是「每帧」的比例，
 * 60fps 和 30fps 下的实际速度差一倍，掉帧的时候动作就会忽快忽慢。
 */
function approach(cur, want, dt, halfLife) {
  const k = 1 - Math.pow(0.5, dt / halfLife);
  return cur + (want - cur) * k;
}

// 缓入缓出，让交叉淡化两头都不生硬
function ease(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * 一次性动作的包络：起手 attack、收尾 release，中间保持满幅。
 *
 * **两头必须是缓的，不能用 `Math.min(1, t * 4)` 那种直线。** 直线的两头是
 * **速度突变** —— 0 一下变成满速、满速一下变成 0，中间那个拐点肉眼直接读成
 * 「顿了一下」。逐帧量出来就是加速度尖峰：改之前 frustrated 在起手拐点上
 * 0.48°/帧²，比它自己的最大速度还大。
 *
 * attack / release 都是「占总时长的几分之几」，跟时长解耦，改 sec 不用重调。
 */
function envelope(t, attack = 0.2, release = 0.25) {
  const up = ease(Math.max(0, Math.min(1, t / attack)));
  const down = ease(Math.max(0, Math.min(1, (1 - t) / release)));
  return up * down;
}

/**
 * 情绪动作：心情一变，身体也跟着表个态。
 *
 * 跟舞步的区别是这些**不循环**——给一个 0→1 的进度，走完就完了。
 * 光换张脸太单薄：她说「烦死了」的时候，头得真的甩两下；
 * 说「不弄了」的时候肩膀得塌下去。这一层补的就是这个。
 *
 * 每条曲线首尾都收在 0 附近，配合外面的包络，起收都不会突兀。
 */
const GESTURES = {
  // 开心：原地蹦两下
  happy: {
    sec: 1.8,
    fn(t) {
      const b = Math.abs(Math.sin(t * Math.PI * 2.2)) * (1 - t * 0.5);
      return {
        bodyY: -b * 11, angleY: -b * 9, angleZ: Math.sin(t * Math.PI * 4) * 5,
        shoulder: b * 0.6, armL: 0.25 + b * 0.35, armR: 0.25 + b * 0.35, breath: b,
        // 整个人真的离地。以前「蹦两下」是靠身体角度装出来的，人一直钉在原地
        allY: b * 4,
        // 肘跟着弯，不然举起来的是两根棍子
        armL2: 0.3 + b * 0.4, armR2: 0.3 + b * 0.4,
      };
    },
  },

  // 得意：挺胸、微微仰头、一只手叉腰
  proud: {
    sec: 2.4,
    fn(t) {
      const k = envelope(t, 0.25, 0.25);
      return {
        angleY: -k * 9, bodyY: -k * 4, bodyZ: k * 6, angleZ: k * 7,
        armL: k * 0.75, armR: k * 0.15, shoulder: k * 0.25, breath: 0.5 + k * 0.4,
        // 「叉腰」这个姿势全在肘上 —— 只转肩的话手是伸直往外指的
        armL2: k * 0.7, armL3: k * 0.35, allY: k * 1.5,
      };
    },
  },

  // 害羞：侧身、低头、缩肩
  shy: {
    sec: 2.6,
    fn(t) {
      const k = envelope(t, 0.33, 0.3);
      return {
        angleY: k * 11, angleZ: -k * 13, bodyX: -k * 8, bodyZ: -k * 5,
        shoulder: k * 0.55, armL: k * 0.5, armR: k * 0.2, breath: 0.4,
        armL2: k * 0.45, armR2: k * 0.3, allRot: -k * 2, allY: -k * 1,
      };
    },
  },

  // 吃惊：猛地后仰一下，再慢慢缓过来
  surprised: {
    sec: 1.6,
    fn(t) {
      // 吓一跳那一下**故意**收得极快（attack 只有 5%）—— 但也得是缓的，
      // 不然那一帧的加速度直接顶到天花板，看着像卡了一下而不是吓了一跳
      const k = Math.exp(-t * 3.5) * ease(Math.min(1, t / 0.05));
      return {
        angleY: k * 14, bodyY: k * 10, angleZ: Math.sin(t * Math.PI * 6) * k * 4,
        shoulder: k * 0.7, armL: k * 0.4, armR: k * 0.4, breath: 1,
        // 吓一跳是整个人往后一缩，不只是脖子往后仰
        allY: -k * 2.5, allRot: Math.sin(t * Math.PI * 6) * k * 2.5,
        armL2: k * 0.55, armR2: k * 0.55,
      };
    },
  },

  // 烦躁：左右快速甩头
  frustrated: {
    sec: 1.8,
    fn(t) {
      const k = (1 - t) * ease(Math.min(1, t / 0.12));
      return {
        angleX: Math.sin(t * Math.PI * 7) * k * 16,
        bodyX: Math.sin(t * Math.PI * 7) * k * 6,
        angleY: k * 5, shoulder: k * 0.4, breath: 0.7,
        allRot: Math.sin(t * Math.PI * 7) * k * 3,
      };
    },
  },

  // 累了：垂头，肩膀塌下去
  tired: {
    sec: 2.8,
    fn(t) {
      const k = envelope(t, 0.4, 0.25);
      return {
        angleY: k * 13, angleZ: k * 4, bodyY: k * 6,
        shoulder: -k * 0.3, armL: k * 0.1, armR: k * 0.1, breath: 0.3 - k * 0.2,
        allY: -k * 2.5,   // 累是整个人往下坠，不只是低头
      };
    },
  },

  // 犯困：一点一点地打盹
  sleepy: {
    sec: 3.0,
    fn(t) {
      // 低头那部分也得跟着包络走。写成常数 8 的话，曲线首尾停在 8°上，
      // 起手和收尾各有一个台阶 —— 这一条是被自检抓出来的。
      const k = envelope(t, 0.33, 0.2);
      const nod = Math.sin(t * Math.PI * 2) * k;
      return { angleY: k * 8 + nod * 10, angleZ: nod * 6, bodyY: k * 4, shoulder: -k * 0.2,
               breath: 0.25, allY: -k * 2, allRot: nod * 2 };
    },
  },

  // 闹脾气：扭头不看你
  lonely: {
    sec: 2.6,
    fn(t) {
      const k = envelope(t, 0.33, 0.3);
      return {
        bodyY: -k * 20, angleY: -k * 14, angleZ: k * 6,
        armL: k * 0.15, armR: k * 0.15, shoulder: k * 0.3, breath: 0.4,
        // 「不看你」是整个人转开半步，不是光扭脖子
        allRot: -k * 3.5, allX: -k * 2.5,
      };
    },
  },

  // 来劲了：整个人往前凑
  // 真火了：**往前逼一步** + 肩膀端起来 + 一下顿住（跟 frustrated 的
  // 「原地抖」分得开 —— 生气是朝着你去的，烦躁是自己拧巴）
  angry: {
    sec: 2.2,
    fn(t) {
      const k = envelope(t, 0.12, 0.35);       // attack 特意短：发火是突然的
      const shake = Math.sin(t * Math.PI * 9) * k * (1 - t);
      return {
        angleY: -k * 4, bodyY: -k * 6, angleZ: shake * 4, bodyX: shake * 3,
        shoulder: k * 0.65, armL: k * 0.45, armR: k * 0.45, breath: 0.55 + k * 0.45,
        armL2: k * 0.55, armR2: k * 0.55,
        allY: k * 1.2, allX: k * 1.4,           // 往你那侧压过去
      };
    },
  },

  // 搞怪：歪着头左右晃两下 + 肩膀一耸（坏笑的身体）
  playful: {
    sec: 2.0,
    fn(t) {
      const k = envelope(t, 0.18, 0.28);
      const w = Math.sin(t * Math.PI * 4);
      return {
        angleZ: -k * 16 + w * k * 6,            // 主要是歪头，再晃
        angleY: -k * 3, bodyZ: -k * 5, bodyX: w * k * 5,
        shoulder: k * 0.4, armL: k * 0.5, armR: k * 0.15,
        armL2: k * 0.5, breath: 0.5 + k * 0.3,
        allRot: -k * 2.5, allY: k * 0.8,
      };
    },
  },

  // 鄙夷：抬下巴 + 整个人侧开 + 半转身（「懒得看你」）。
  // 慢：瞧不上是慢动作，快了就成了受惊
  scorn: {
    sec: 2.8,
    fn(t) {
      const k = envelope(t, 0.35, 0.35);
      return {
        angleY: -k * 10,                        // 下巴抬起来
        angleX: -k * 12, bodyX: -k * 8,         // 脸和身子一起转开
        angleZ: k * 6, bodyZ: k * 4,
        shoulder: k * 0.3, armL: k * 0.35, armL2: k * 0.4,
        breath: 0.35, allRot: -k * 2, allX: -k * 1.6,
      };
    },
  },

  // 好奇：探身凑近 + 歪头（跟 surprised 的「往后仰」正好相反）
  curious: {
    sec: 2.2,
    fn(t) {
      const k = envelope(t, 0.28, 0.3);
      return {
        angleZ: k * 14, angleY: k * 4, angleX: k * 5,
        bodyY: -k * 3, bodyZ: k * 4,
        shoulder: k * 0.2, armL: k * 0.25, armR: k * 0.1, armL2: k * 0.3,
        breath: 0.5 + k * 0.2,
        allY: k * 0.8, allX: k * 1.2, allRot: k * 1.5,    // 往前凑一点
      };
    },
  },

  // 慌了：整个人一抖 + 缩肩 + 往后半步，抖动比别的动作快得多
  panic: {
    sec: 1.8,
    fn(t) {
      const k = envelope(t, 0.08, 0.4);        // 慌是瞬间的
      const j = Math.sin(t * Math.PI * 14) * k * (1 - t * 0.6);
      return {
        angleZ: j * 9, angleX: j * 7, bodyX: j * 6, bodyY: -k * 4,
        shoulder: k * 0.8, armL: k * 0.6, armR: k * 0.6,
        armL2: k * 0.6, armR2: k * 0.6, breath: 0.6 + k * 0.4,
        allX: j * 1.5, allY: k * 1.4, allRot: j * 2.5,
      };
    },
  },

  // 无聊：整个人往下泄一口气 + 头歪到一边（敷衍）
  bored: {
    sec: 2.6,
    fn(t) {
      const k = envelope(t, 0.3, 0.35);
      return {
        angleY: k * 7, angleZ: k * 11, angleX: -k * 6,
        bodyY: k * 4, shoulder: -k * 0.35, breath: -k * 0.1,
        armL: k * 0.1, allY: -k * 1.8, allRot: k * 1.2,
      };
    },
  },

  excited: {
    sec: 2.0,
    fn(t) {
      const k = envelope(t, 0.2, 0.3);
      const w = Math.sin(t * Math.PI * 5) * k;
      return {
        angleY: -k * 6, bodyY: -k * 7, angleZ: w * 8, bodyX: w * 6,
        shoulder: k * 0.5, armL: 0.3 + k * 0.4, armR: 0.3 + k * 0.4, breath: 0.6 + k * 0.4,
        allY: k * 2, allRot: w * 2, armL2: 0.25 + k * 0.5, armR2: 0.25 + k * 0.5,
      };
    },
  },
};

/**
 * 姿态：一层常驻的「底色」，跟情绪动作和跳舞都不是一回事。
 *
 * 动作是「演两秒就收」，姿态是**一直挂着**——她今天没精神，那就一整天肩膀
 * 都是塌的。以前心情从 25 跑到 85，身体动作一模一样（9 个 Idle 随机轮播），
 * 数值全在肚子里、屏幕上看不出来。这一层补的就是这个：你不用戳她，
 * 扫一眼就知道她什么状态。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须是**加法**，不能是覆盖
 *
 * 待机动作（Hiyori 有 9 个在轮播）本来就在写这些参数。姿态要是写绝对值，
 * 等于把待机动作按死 —— 她会僵在一个姿势上一动不动，比没有姿态还糟。
 * 所以这里读一下当前值再加偏移，让待机动作照常演，我们只是把整个人
 * 往某个方向「掰」一点。
 *
 * ---------------------------------------------------------------------------
 * 加法的那个坑：会累加到飞出屏幕
 *
 * 帧末的 loadParameters 还原的是 saveParameters 那一刻的快照，而快照里
 * **包含我们在 afterMotionUpdate 写进去的偏移**。于是下一帧开头：
 *
 *   · 待机动作驱动的参数 —— 被动作重新写成绝对值，偏移没了，该加
 *   · 动作**没**驱动的参数 —— 还带着上一帧的偏移，再加一次就是双份
 *
 * 每帧多加一份，几秒后角度就是几百度。两种情况必须分开处理，而分开的依据
 * 是现成的：**记住上一帧我们写进去的最终值**，这一帧读回来对一下 ——
 * 一模一样说明没人动过它（第二种），对不上说明动作重写了（第一种）。
 * 精确、也不用去猜哪个模型的哪个动作驱动了哪些参数。
 *
 * ---------------------------------------------------------------------------
 * 幅度上的克制：这是底色，不是动作
 *
 * 角度一律压在 10° 以内、开合量压在 0.3 以内。再大就不像「今天没什么精神」，
 * 而像「正在表演没精神」，那是 GESTURES 那一层该干的事。
 */
const POSTURES = {
  normal: {},

  // 有精神的几种：重心往上提，肩膀打开
  happy: { angleY: -3, bodyY: -2, shoulder: 0.12, breath: 0.06, allY: 0.9 },
  excited: { angleY: -4, bodyY: -4, shoulder: 0.2, breath: 0.1, allY: 1.4, armL2: 0.2, armR2: 0.2 },
  proud: { angleY: -5, bodyZ: 3, angleZ: 3, shoulder: 0.15, armL: 0.18, allY: 1.2, armL2: 0.4 },

  // 没精神的几种：肩膀塌、头往下坠、呼吸浅
  // allY 是负的 = 整个人往下坠。这比「低头」有说服力得多 ——
  // 低头只是脖子的事，人往下沉是整个身体没劲了
  tired: { angleY: 6, bodyY: 3, shoulder: -0.22, breath: -0.05, allY: -1.4, armL2: 0.1 },
  sleepy: { angleY: 9, angleZ: 3, bodyY: 4, shoulder: -0.3, breath: -0.08, allY: -2.2 },
  sad: { angleY: 7, angleZ: -2, bodyY: 2, shoulder: -0.18, breath: -0.04, allY: -1.6 },

  // 闹别扭：身子和头都侧开一点。用 angleX（左右转）不是 angleY（上下点头）——
  // 「不看你」是转开，不是低头
  lonely: { angleX: -9, bodyX: -6, angleZ: 4, shoulder: 0.1, allRot: -2.2, allX: -1.5 },
  frustrated: { angleX: 4, angleZ: 5, bodyX: 4, shoulder: 0.18, breath: 0.05 },

  // 聊天时她自己标的那六种，动作演完之后身体还留着余味。
  // 幅度都比上面的 GESTURES 小一截 —— 这是「挂着」的姿态，不是「演一下」
  angry: { angleY: -4, bodyY: -4, shoulder: 0.4, breath: 0.16, allY: 0.8, allX: 0.8, armL2: 0.25 },
  scorn: { angleY: -6, angleX: -8, bodyX: -5, angleZ: 4, shoulder: 0.16, allRot: -1.6, allX: -1.2 },
  playful: { angleZ: -10, angleY: -2, bodyZ: -3, shoulder: 0.2, allRot: -1.4, allY: 0.6 },
  curious: { angleZ: 9, angleX: 3, bodyZ: 3, angleY: 2, shoulder: 0.12, allRot: 1, allX: 0.6 },
  panic: { angleY: -3, shoulder: 0.55, breath: 0.2, armL: 0.3, armR: 0.3, allY: 0.7 },
  bored: { angleY: 5, angleZ: 8, angleX: -4, shoulder: -0.3, breath: -0.06, allY: -1.5, allRot: 0.9 },
  shy: { angleY: 5, angleZ: -5, bodyX: -3, shoulder: 0.22, armL: 0.15, armR: 0.1 },

  // --- 下面这些不是心情，是当下正在发生的事 ---

  // 被摸着不放：眯着眼往你手的方向蹭。头歪过去 + 肩膀松下来，
  // 这是「摸着舒服」和「被点了一下」体感上最大的区别
  pet: { angleZ: -11, angleY: 4, bodyZ: -5, shoulder: -0.16, breath: -0.06, allRot: -1.6 },

  // 摸太久了：身子先躲开半步，头别过去
  petAway: { angleX: -13, bodyX: -9, angleY: -3, shoulder: 0.22, allX: -2.2, allRot: -1.8 },

  // --- 干活时的四个状态 -----------------------------------------------------
  //
  // 这四个是**挂很久**的（一段活能跑好几分钟），所以幅度必须比情绪动作收得多。
  // 目的不是让你盯着看，是让你**余光扫一眼就知道要不要过去看**。

  // 顺利推进：微微前倾、头低一点像在看手上的活，肩膀是稳的
  working: { angleY: 5, bodyY: 2, bodyZ: 2, shoulder: 0.08, allY: -0.6, breath: 0.03 },

  // 一直在报错：身体绷起来、头压低、呼吸变快。烦躁那个动作是演两秒的，
  // 这个要挂几分钟，所以只留「绷着」的部分，不带甩头
  struggling: { angleY: 8, angleZ: 4, bodyX: 3, shoulder: 0.26, breath: 0.12, armL2: 0.15 },

  // 卡住不动了：歪着头停在那儿，像在想不通
  stuck: { angleZ: 12, angleY: 3, angleX: -5, bodyZ: 4, shoulder: -0.1, breath: -0.05 },

  // 在等你确认：**转过来正对着你、抬头**。这个是四个里唯一「朝向你」的，
  // 因为它要的就是被你看见
  waiting: { angleY: -6, angleX: 0, bodyY: 0, shoulder: 0.14, allY: 0.8, breath: 0.05 },

  // 正在想（戳完她到她开口之间那几秒）：微微仰头偏一边，
  // 配上 stage.js 那边把视线往上飘，就是「在琢磨」的样子
  think: { angleY: -4, angleZ: 7, angleX: 5, bodyZ: 3, shoulder: 0.08 },
};

/**
 * 参数名 -> 这个模型上实际叫什么。不同模型命名差别很大，按顺序试，找不到的就跳过。
 *
 * 备选名不是摆设：Hiyori 的手臂叫 `ParamArmLA`，Mao 的叫 `ParamArmLA01`
 * （她的每条胳膊拆成了三节），肩膀更是左右分开成两个参数。
 * 这张表以前形同虚设 —— 因为判断「有没有这个参数」用的是 `getParameterIndex() >= 0`，
 * 那个恒真，所以永远停在第一个候选上，后面的备选名一个都没轮到过。
 */
const PARAM_MAP = {
  // 每组都得带上 `PARAM_XXX_YYY` 那套下划线写法 —— Cubism 2.1 时代导出的模型
  // （官方样例里的两只猫、汪子、千岁、泉、春伞积木全是）参数就长那样。
  // 只写驼峰的话，这些模型**整支舞是死的**：头不转、身子不摆、呼吸不起伏，
  // 而且一声不吭（认不出来的参数直接跳过是这层的设计）。
  // 下面这些下划线名字是 `npx electron tools/probe-params.js` 和各模型的
  // cdi3 里量出来的，不是照着驼峰硬翻的。
  angleX: ['ParamAngleX', 'PARAM_ANGLE_X'],
  angleY: ['ParamAngleY', 'PARAM_ANGLE_Y'],
  angleZ: ['ParamAngleZ', 'PARAM_ANGLE_Z'],
  bodyX: ['ParamBodyAngleX', 'PARAM_BODY_ANGLE_X'],
  bodyY: ['ParamBodyAngleY', 'PARAM_BODY_ANGLE_Y'],
  bodyZ: ['ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z'],
  breath: ['ParamBreath', 'PARAM_BREATH'],
  shoulder: ['ParamShoulder', 'ParamLeftShoulderUp', 'ParamShoulderL'],
  shoulderR: ['ParamRightShoulderUp', 'ParamShoulderR'], // 左右肩拆开的模型才有，见 MIRROR
  leg: ['ParamLeg', 'PARAM_LEG_L'],
  armL: ['ParamArmLA', 'ParamArmL', 'ParamArmLA01', 'PARAM_ARM_L_A', 'PARAM_ARM_L'],
  armR: ['ParamArmRA', 'ParamArmR', 'ParamArmRA01', 'PARAM_ARM_R_A', 'PARAM_ARM_R'],
  handL: ['ParamHandL', 'ParamHandLB', 'ParamHandLA', 'PARAM_HAND_L'],
  handR: ['ParamHandR', 'ParamHandRB', 'ParamHandRA', 'PARAM_HAND_R'],

  // --- 手臂的第二、三节 ---------------------------------------------------
  //
  // 有的模型把一条胳膊拆成了三节（Mao 就是：肩 → 肘 → 腕）。
  // 只驱动第一节的话，整条胳膊是**像根棍子一样整体摆动**的 —— 这正是原来
  // 「手臂甩不起来」的观感来源。接上二三节才有肘和腕，动作才像人。
  //
  // 实测（npm run probe-params）：Mao 的 ParamArmRA02 单独一个就能掀动身高的
  // 48%，比我们已经在驱动的任何一个参数都大。
  //
  // 只接 A 那条链，**不碰 ArmLB/ArmRB**：那是同一条胳膊的另一个姿势，
  // 归 pose3 管，两条一起写会打架（probe-parts 的注释里也记着这件事）。
  armL2: ['ParamArmLA02'],
  armL3: ['ParamArmLA03'],
  armR2: ['ParamArmRA02'],
  armR3: ['ParamArmRA03'],

  // --- 整个人 -------------------------------------------------------------
  //
  // 平移和旋转整个身体。这是身体语言里最大的一件 —— 跳起来、歪倒、转圈、
  // 往后缩，全靠它。以前一个都没接，所以她的「动」永远发生在原地。
  //
  // 单位就是参数自己的单位（-10~10），所以列进了 ANGLE_KEYS 不做行程换算。
  allX: ['ParamAllX'],
  allY: ['ParamAllY'],
  allRot: ['ParamAllRotate'],
};

/**
 * 有些模型把一个部位拆成了左右两个参数（Mao 的肩膀就是），
 * 而舞步曲线里只写一个 `shoulder`。这张表让多出来的那半边跟着同一个值走，
 * 舞步那边一个字都不用改。
 */
const MIRROR = { shoulderR: 'shoulder' };

class Dancer {
  // nowFn 只为测试而留：舞蹈是「几十秒里每帧一点点」的东西，
  // 拿真实时钟跑一遍要真等几十秒，注入个假时钟才测得动
  constructor(model, log, nowFn) {
    this.model = model;
    this.log = log || (() => {});
    this.now = nowFn || (() => performance.now());
    this.on = false;
    this.bpm = 118;
    this.t0 = 0;
    this.level = 0;    // 当前音量
    this.kick = 0;     // 重拍的那一下
    this.lastBeat = -1;
    this.hooked = false;

    this.order = ORDER.slice(); // 这次跳哪几套、什么顺序
    this.barsPer = BARS_PER_STEP;
    this.baseAmp = 1;           // 她指定的幅度基准
    this.amp = 1;               // 实际幅度（会跟着段落浮动）
    this.stepName = this.order[0];
    this.autoStop = null;

    // 段落感知
    this.autoSection = true;    // 她自己点了名要跳哪几套时就不乱换了
    this.avg = 0;               // 整首歌的响度基准（很慢的滑动平均）
    this.energy = 1;            // 当前响度 ÷ 基准，>1 是副歌，<1 是间奏
    this.section = 'normal';

    // 动作混合。这几个变量就是「不一顿一顿」的全部秘密：
    this.cur = { ...NEUTRAL };  // 每个参数当前真正输出的值（平滑跟过去）
    this.prevStep = null;       // 上一套舞步，交叉淡化期间还要继续参与混合
    this.crossT = 1;            // 淡化进度 0→1，1 表示已经完全切过去了
    this.gain = 0;              // 整体强度：起跳 0→1，停跳 1→0
    this.lastFrameAt = 0;
    this.onFaded = null;        // 淡出彻底结束后叫一声，好把身体交还给待机动作
    this.gest = null;           // 正在演的情绪动作
    this.onSection = null;      // 歌走到新段落时叫一声，好让脸也跟着变

    // 常驻姿态那一层。跟上面几个变量的区别是它**不归 gain 管** ——
    // 跳舞停了、动作演完了，姿态还挂着，因为她的状态没变。
    this.postureName = 'normal';
    this.posture = POSTURES.normal;
    this.postureCur = {};   // 平滑跟过去的当前偏移
    this.postureGain = 1;   // 跳舞/演动作时压到 0，让位给那两层
    this.lastWrote = {};    // 上一帧最终写进去的值，用来判断「这个参数被动作重写了没」
    this.lastDelta = {};    // 上一帧加进去的偏移，配合 lastWrote 还原出干净的底值
    // 这一帧到底有没有输出。闲着的时候两个钩子都不该往模型里写东西，
    // 否则待机动作会被我们按在中性姿势上动弹不得
    this._live = false;

    // 这个模型到底有哪些参数可用，先摸一遍底，跳舞时就不用一次次试了
    this.available = {};
    // 开合量的行程换算，见下面那段注释
    this.scale = {};
    const core = model && model.internalModel && model.internalModel.coreModel;
    if (core) {
      for (const [key, names] of Object.entries(PARAM_MAP)) {
        for (const n of names) {
          if (!hasParam(core, n)) continue;
          this.available[key] = n;
          this.scale[key] = this._unitScale(core, key, n);
          break;
        }
      }
    }
    this.log('[dance] 这个模型能驱动的部位: ' + Object.keys(this.available).join(', '));
  }

  /**
   * 开合量的行程换算。
   *
   * 舞步曲线里 armL/handL/breath 这些一律按 0~1（handL/R 是 -1~1）写，
   * 那是「开到几成」的语义。但模型上它们的**实际范围不一定就是 0~1**——
   * Hiyori 的 `ParamArmLA` 是 **-10~10**，把 0.8 原样写进去只走了 8% 行程，
   * 肉眼根本看不出手臂在动。现有那几套舞步里的「手臂甩」一直没甩起来，就是这个原因。
   *
   * 所以写入前按模型自报的最大值换算一次，换模型也不用回来改这里。
   *
   * 两条克制：
   *   · 乘 0.6 而不是拉满 —— `ParamArmLA` 拉到 ±10 是极限姿势，官方待机动作
   *     也只用到 -10~+3，满行程甩起来会像脱臼。
   *   · 再夹一个绝对上限 8 —— 有的模型范围是不对称的（Mao 的 `ParamArmLA01`
   *     是 **-10~30**），光按 60% 算会得出 ×18，那个幅度已经不是跳舞是求救了。
   *
   * 角度类（angleX 那些）本来就是度数，不参与换算。
   */
  _unitScale(core, key, id) {
    if (ANGLE_KEYS.includes(key)) return 1;
    try {
      const idx = core.getParameterIndex(id);
      const max = core.getParameterMaximumValue(idx);
      if (typeof max === 'number' && isFinite(max) && max > 1.5) {
        return Math.max(1, Math.min(max * 0.6, 8));
      }
    } catch (_) {
      /* 读不到范围就按 1 处理，跟改这段之前的行为一致 */
    }
    return 1;
  }

  _hook() {
    if (this.hooked) return;
    const im = this.model && this.model.internalModel;
    if (!im || !im.on) return;

    // 一帧算一次，就在这儿算 —— 顺便把物理输入那几个参数写掉（物理上游）
    im.on('afterMotionUpdate', () => this._frame());
    // 其余参数留到物理算完再写，这样才压得住动作数据。
    // 姿态那层无条件写：它是常驻的，不跟着 _live 走
    im.on('beforeModelUpdate', () => {
      if (this._live) this._write(false);
      this._writePosture(false);
    });

    this.hooked = true;
  }

  /**
   * 换一个常驻姿态。传心情状态名，或者直接传一组偏移。
   *
   * 认不出来的名字一律当 normal —— 心情系统以后加新状态时，
   * 最差也就是没姿态，不会把她掰成一个奇怪的样子。
   */
  setPosture(name) {
    const next = typeof name === 'object' && name ? name : (POSTURES[name] || POSTURES.normal);
    const label = typeof name === 'string' ? name : 'custom';
    if (next === this.posture) return;

    this.posture = next;
    this.postureName = label;
    this._hook(); // 只改姿态、不跳舞不做动作时，钩子还没挂过
    this.log('[dance] 姿态: ' + label);
  }

  /**
   * 开跳。
   *
   * 全都是可选的 —— 什么都不给就按默认串烧摇：
   *   bpm     多快
   *   steps   跳哪几套、什么顺序（她聊天时会自己编这个）
   *   amp     整体幅度，0.5 收着跳、1.4 放开跳
   *   barsPer 每套跳几拍再换
   *   seconds 跳多久自动停
   */
  start(opts) {
    const o = typeof opts === 'number' ? { bpm: opts } : (opts || {});

    if (o.bpm > 40 && o.bpm < 220) this.bpm = o.bpm;

    // 编出来的舞步名可能有错别字或者根本没这套，挨个筛一遍，全没了就用默认的
    if (Array.isArray(o.steps) && o.steps.length) {
      const valid = o.steps.filter((s) => STEPS[s]);
      this.order = valid.length ? valid : ORDER.slice();
      // 她点了名要跳这几套，那就照跳，别再自作主张按段落换
      this.autoSection = !valid.length;
      if (valid.length !== o.steps.length) {
        this.log('[dance] 有几套舞步不认识，跳过了: ' +
          o.steps.filter((s) => !STEPS[s]).join(', '));
      }
    } else {
      this.order = ORDER.slice();
      this.autoSection = true;
    }

    this.baseAmp = typeof o.amp === 'number' ? Math.max(0.2, Math.min(1.8, o.amp)) : 1;
    this.amp = this.baseAmp;
    this.barsPer = o.barsPer > 0 ? o.barsPer : BARS_PER_STEP;

    this.avg = 0;
    this.energy = 1;
    this.section = 'normal';

    this._hook();

    // 本来就在跳（比如换了首歌），那就跟旧舞步交叉一下再切过去；
    // 从静止起跳的话不用交叉 —— gain 会负责把她从中性姿势「长」出来
    const wasOn = this.on;
    this.prevStep = wasOn ? this.stepName : null;
    this.crossT = wasOn ? 0 : 1;

    this.t0 = this.now();
    this.lastFrameAt = 0;
    this.lastBeat = -1;
    this.stepName = this.order[0];
    this.onFaded = null;
    this.on = true;

    clearTimeout(this.autoStop);
    if (o.seconds > 0) {
      this.autoStop = setTimeout(() => {
        this.stop();
        if (typeof o.onEnd === 'function') o.onEnd();
      }, o.seconds * 1000);
    }

    // 待机动作会跟我们抢身体，先让它停下
    try {
      const mm = this.model.internalModel.motionManager;
      if (mm && mm.stopAllMotions) mm.stopAllMotions();
    } catch (_) {
      /* 停不掉就算了，顶多动作叠在一起 */
    }
    this.log('[dance] 开跳，' + Math.round(this.bpm) + ' BPM，幅度 ' + this.amp +
            '，舞步 ' + this.order.join(' → '));
  }

  /**
   * 收势。
   *
   * 不是当场定住 —— 那样她会在半个动作上僵住，然后「啪」地弹回待机姿势。
   * 这里只是把强度调头往下走，接下来半秒里身体自己收回中性，
   * 收干净了才回调 onFaded，那时候再让待机动作接手才接得上。
   */
  stop(onFaded) {
    clearTimeout(this.autoStop);
    this.autoStop = null;
    this.level = 0;

    if (!this.on && this.gain <= 0.002) {
      if (onFaded) onFaded();
      return;
    }

    this.on = false;
    this.onFaded = onFaded || null;
    this.log('[dance] 收势');
  }

  /**
   * 中途改拍子（一般是「先放着，同时后台听出了真实 BPM」）。
   *
   * 不能直接改 this.bpm —— 拍号是拿「开跳到现在多久 × 每秒多少拍」算的，
   * 直接改会让拍号瞬间跳一大截，看上去就是她突然抽了一下。
   * 得把起点往回挪，让**这一瞬间的拍号保持不变**，后面才自然接上。
   */
  setBpm(bpm) {
    if (!(bpm > 40 && bpm < 220) || Math.abs(bpm - this.bpm) < 0.5) return;
    const now = this.now();
    const beatNow = ((now - this.t0) / 1000) * (this.bpm / 60);
    this.bpm = bpm;
    this.t0 = now - (beatNow / (bpm / 60)) * 1000;
    this.log('[dance] 拍子改成 ' + Math.round(bpm) + ' BPM');
  }

  /**
   * 音频那边每帧喂进来的音量。
   *
   * 除了让动作幅度跟着起伏，还用它判断现在是歌的哪一段：
   * 拿当前音量比整首歌的响度基准，明显高就是副歌，明显低就是前奏或间奏。
   */
  feed(level) {
    this.level = Math.max(0, Math.min(1, level));

    // 很慢的滑动平均，代表这首歌整体多响（十几秒的时间常数）
    this.avg = this.avg ? this.avg * 0.997 + this.level * 0.003 : this.level;

    // 太安静时比值会失真（分母趋零），干脆当作普通段落
    const raw = this.avg > 0.02 ? this.level / this.avg : 1;
    this.energy = this.energy * 0.92 + raw * 0.08; // 平滑，免得一个鼓点就换段

    const next = this.energy > 1.18 ? 'hype' : (this.energy < 0.72 ? 'calm' : 'normal');
    if (next !== this.section) {
      this.section = next;
      if (this.autoSection) this.log('[dance] 进入' + { calm: '安静', normal: '普通', hype: '高潮' }[next] + '段落');
      // 副歌来了脸上也该有反应，光身体嗨、表情不变就很怪
      if (this.onSection) { try { this.onSection(next); } catch (_) { /* 不能让它拖累这一帧 */ } }
    }

    // 幅度跟着走：副歌放开、间奏收回来。范围压住，别一首歌把她甩出屏幕
    const want = this.baseAmp * Math.max(0.55, Math.min(1.35, this.energy));
    this.amp = this.amp * 0.94 + want * 0.06;
  }

  _switchStep(name) {
    if (name === this.stepName) return;
    // 旧的那套不是立刻扔掉 —— 接下来一拍里它还要和新的一起混，慢慢让位
    this.prevStep = this.stepName;
    this.stepName = name;
    this.crossT = 0;
  }

  /**
   * 演一个情绪动作（开心蹦一下、烦躁甩甩头这种）。
   *
   * 正在跳舞时直接不理 —— 跳到一半插进来一个「害羞」，动作会打架。
   * 返回 true 表示接了这活。
   */
  gesture(name) {
    if (this.on || this.gest) return false;
    const g = GESTURES[name];
    if (!g) return false;

    this._hook();
    this.gest = { fn: g.fn, sec: g.sec, start: this.now() };
    this.log('[dance] 情绪动作: ' + name);
    return true;
  }

  _frameGesture(now, dt) {
    const g = this.gest;
    const t = (now - g.start) / 1000 / g.sec;

    /**
     * 演完了 —— **但不能在这儿直接撒手。**
     *
     * `this.cur` 是带惯性跟过来的（_apply 末尾那道 0.055 秒低通），包络归零的
     * 那一刻它还差一点点没走到中性。当场停止输出 = 把这点残余瞬间抹掉 =
     * 收尾「啪」一下。逐帧量出来，**每个情绪动作的加速度峰值都正好落在它结束的
     * 那一刻**（happy 在 1.80s、得意在 2.40s、闹脾气在 2.60s…），就是这个。
     *
     * 所以再补一小段「收干净」：gain 已经是 0，等于持续往中性靠，
     * 收到肉眼看不出来了才真的交还给待机动作。0.6 秒是保险丝，
     * 正常 0.2 秒出头就收完了。
     */
    if (t >= 1) {
      this.gain = 0;
      this._apply(NEUTRAL, null, dt);
      if (this._nearNeutral() || t > 1 + 0.6 / g.sec) this.gest = null;
      return;
    }

    // 首尾各留一小段淡入淡出，起收都不打眼。**用缓的，不用直线**（见 envelope）
    this.gain = envelope(t, 0.12, 0.2);
    this._apply(g.fn(t), null, dt);
  }

  /** 现在这套姿势离中性还有多远 —— 收尾判「收干净了没」用 */
  _nearNeutral() {
    for (const key of Object.keys(this.available)) {
      const src = MIRROR[key] || key;
      const neutral = NEUTRAL[src] || 0;
      const v = this.cur[key];
      if (typeof v !== 'number') continue;
      // 角度按度算、开合量按 0~1 算，两者的「看不出来」不是一个数量级
      const eps = ANGLE_KEYS.includes(key) ? 0.15 : 0.01;
      if (Math.abs(v - neutral) > eps) return false;
    }
    return true;
  }

  _frame() {
    const now = this.now();
    // 第一帧没有上一帧，给个 60fps 的假设；掉帧掉太狠也夹住，
    // 不然切个窗口回来会因为 dt 巨大而瞬移
    const dt = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 1 / 60;
    this.lastFrameAt = now;

    // 先当这一帧没输出。真走到 _apply 才会翻回 true —— 这样闲着的时候
    // beforeModelUpdate 那半边就不会去干扰待机动作
    this._live = false;

    this._danceFrame(now, dt);

    // 姿态在跳舞那层**之后**算、之后写：它是加在别人头上的偏移，
    // 底下那层得先落定
    this._posture(dt);
  }

  _danceFrame(now, dt) {
    // 情绪动作插在最前面：它是一次性的，走完自己退场，
    // 后面的收尾逻辑照样管它把姿势收回中性
    if (this.gest) {
      this._frameGesture(now, dt);
      return;
    }

    // 停跳之后还要继续跑几帧把姿势收回中性，收完了才真的撒手
    if (!this.on && this.gain <= 0.002) {
      if (this.gain !== 0) {
        this.gain = 0;
        const cb = this.onFaded;
        this.onFaded = null;
        if (cb) cb();
      }
      return;
    }

    // 起跳渐入、停跳渐出
    this.gain = approach(this.gain, this.on ? 1 : 0, dt,
                         this.on ? FADE_IN_SEC / 3 : FADE_OUT_SEC / 3);

    const beat = ((now - this.t0) / 1000) * (this.bpm / 60);

    if (this.on) {
      const whole = Math.floor(beat);
      if (whole !== this.lastBeat) {
        this.lastBeat = whole;
        this.kick = 1;
        // 每几拍换一套舞步，不然看久了很呆
        if (whole % this.barsPer === 0) {
          const n = Math.floor(whole / this.barsPer);
          if (this.autoSection) {
            // 没人点名跳哪几套，那就看这会儿是歌的哪一段，从对应池子里挑
            const pool = POOLS[this.section] || POOLS.normal;
            this._switchStep(pool[n % pool.length]);
          } else {
            this._switchStep(this.order[n % this.order.length]);
          }
        }
      }
    }

    // 重拍那一下的衰减也得跟时间走，不能按帧算 —— 否则掉帧时节奏感都变了
    this.kick *= Math.pow(0.015, dt);

    // 交叉淡化按拍走：快歌切得利落，慢歌切得绵
    if (this.crossT < 1) {
      this.crossT = Math.min(1, this.crossT + (dt * (this.bpm / 60)) / CROSS_BEATS);
    }

    const a = (STEPS[this.stepName] || STEPS.sway)(beat, this.level, this.kick);
    const b = this.crossT < 1 && this.prevStep
      ? (STEPS[this.prevStep] || STEPS.sway)(beat, this.level, this.kick)
      : null;

    this._apply(a, b, dt);
  }

  /**
   * 算出这一帧每个部位该是多少。
   *
   * 三层叠上去，缺一层就会看出「一顿一顿」：
   *   1. 交叉淡化 —— 换舞步时新旧两套一起算，按进度插值，不是说换就换
   *   2. 整体强度 —— 起跳从中性长出来、停跳收回中性，两头都不突兀
   *   3. 逐参数平滑 —— 最后再跟一道低通，把所有残余的台阶磨平
   *
   * 算完立刻把**物理输入**那一半写进去 —— 这个函数是从 afterMotionUpdate
   * 调下来的，正好卡在 physics.evaluate 前面，头发裙子才吃得到。
   * 剩下那一半留到 beforeModelUpdate 再写。
   */
  _apply(a, b, dt) {
    const mix = b ? ease(this.crossT) : 1;

    for (const key of Object.keys(this.available)) {
      // 左右拆开的部位（比如 Mao 的两个肩膀）跟着同一条曲线走
      const src = MIRROR[key] || key;
      const neutral = NEUTRAL[src] || 0;

      // 舞步没写到的部位一律按中性算 —— 这样它是「平滑地回到中性」，
      // 而不是「突然没人管了」
      const va = typeof a[src] === 'number' && isFinite(a[src]) ? a[src] : neutral;
      let want = va;

      if (b) {
        const vb = typeof b[src] === 'number' && isFinite(b[src]) ? b[src] : neutral;
        want = vb + (va - vb) * mix;
      }

      // 幅度只缩放角度，别去动 armL/breath 那些 0~1 的开合量
      if (ANGLE_KEYS.includes(key)) want *= this.amp;

      // 按整体强度往中性靠：gain=1 是完整舞姿，gain=0 就是站着不动
      want = neutral + (want - neutral) * this.gain;

      this.cur[key] = approach(this.cur[key] === undefined ? neutral : this.cur[key],
                               want, dt, 0.055);
    }

    this._live = true;
    this._write(true);
  }

  /**
   * 把算好的值写进模型。
   *
   * physics 为 true 时只写物理输入那几个（在 afterMotionUpdate 里调），
   * false 时写剩下的（在 beforeModelUpdate 里调）。分开的理由见文件头。
   */
  _write(physics) {
    const core = this.model && this.model.internalModel && this.model.internalModel.coreModel;
    if (!core) return;

    for (const [key, id] of Object.entries(this.available)) {
      if (PHYSICS_KEYS.has(key) !== Boolean(physics)) continue;

      const v = this.cur[key];
      if (typeof v !== 'number' || !isFinite(v)) continue;

      try {
        core.setParameterValueById(id, v * (this.scale[key] || 1));
      } catch (_) {
        /* 个别模型参数范围不同，写不进去就跳过这一帧 */
      }
    }
  }

  /**
   * 算这一帧的姿态偏移。
   *
   * 跳舞和情绪动作期间让位到 0：那两层本来就在表达状态，再叠一层
   * 幅度就超出设计了 —— 「开心」的姿态加上「开心」的蹦跳，会蹦出屏幕。
   */
  _posture(dt) {
    const busy = this.on || this.gest || this.gain > 0.01;
    this.postureGain = approach(this.postureGain, busy ? 0 : 1, dt, 0.22);

    // 注意 postureGain **不在这儿乘**，留到写入时再乘。
    // 乘在这儿的话，让位要穿过两道串联的滞后（gain 自己一道 + 下面这道），
    // 实测起跳 1.5 秒后姿态还剩 14% 没退干净。放到写入端就只剩一道，
    // 同样 1.5 秒退到 1% 以内。语义也更顺：postureCur 是「她本来的姿态」，
    // gain 是「这会儿露出来多少」。
    const want = this.posture || {};
    for (const key of Object.keys(this.available)) {
      const src = MIRROR[key] || key;
      const raw = want[src];
      const w = typeof raw === 'number' && isFinite(raw) ? raw : 0;
      const v = approach(this.postureCur[key] || 0, w, dt, POSTURE_HALFLIFE);
      // approach 永远到不了正整 0，不掐掉的话会一直写一个微不足道的偏移。
      // 真实姿态值最小是 0.04，掐在 1e-3 碰不到它们
      this.postureCur[key] = Math.abs(v) < 1e-3 ? 0 : v;
    }

    this._writePosture(true);
  }

  /**
   * 把姿态偏移**加**到模型当前值上。
   *
   * 「加到什么上」是这个函数唯一的难点，展开在 POSTURES 那段注释里：
   * 读回来的值等于我们上一帧写进去的，说明这中间没人动过它，
   * 里头还含着上一帧的偏移，得先减掉再加新的；对不上说明待机动作
   * 已经把它重写成干净的绝对值了，直接加就行。
   *
   * 不做这个区分的话，动作没驱动的那几个参数每帧都会多叠一份，
   * 几秒钟就是几百度 —— 人直接飞出屏幕。
   */
  _writePosture(physics) {
    const core = this.model && this.model.internalModel && this.model.internalModel.coreModel;
    if (!core || typeof core.getParameterValueById !== 'function') return;

    for (const [key, id] of Object.entries(this.available)) {
      if (PHYSICS_KEYS.has(key) !== Boolean(physics)) continue;

      let d = (this.postureCur[key] || 0) * this.postureGain * (this.scale[key] || 1);
      if (Math.abs(d) < 1e-4) d = 0; // 让位收干净，别拖着一条写不完的小尾巴
      const prev = this.lastDelta[key] || 0;
      // 这帧和上帧都没偏移就别碰它。少写一个参数，就少一分干扰待机动作的机会
      if (!d && !prev) continue;

      try {
        const cur = core.getParameterValueById(id);
        if (typeof cur !== 'number' || !isFinite(cur)) continue;

        const untouched = this.lastWrote[key] !== undefined &&
                          Math.abs(cur - this.lastWrote[key]) < 1e-6;
        const out = (untouched ? cur - prev : cur) + d;

        core.setParameterValueById(id, out);
        this.lastWrote[key] = out;
        this.lastDelta[key] = d;
      } catch (_) {
        /* 跟 _write 一个处理：写不进去就跳过这一帧 */
      }
    }
  }
}

// 浏览器里挂到 window 给 stage.js 用；node 里导出来是为了能单独测舞步曲线
if (typeof window !== 'undefined') window.WaifuDancer = Dancer;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Dancer, STEPS, ORDER, PARAM_MAP, GESTURES, POSTURES, NEUTRAL, PHYSICS_KEYS, hasParam,
  };
}
