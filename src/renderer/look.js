'use strict';

// 眼神和色调。
//
// 「换装」在这个项目里只能做到这一步，原因写在 src/config.js 的 look 那一段：
// 模型里没有第二套服装素材，渲染库也不给单部件染色的口子。
// 所以能动的只有两样 —— 五官参数（眼神），和整个人的色调。
//
// 关键分寸：**只做偏移，不做覆盖。**
// 表情系统、眨眼、口型同步都在写这些参数，这里如果直接赋值就会把它们全压死 ——
// 她会变成一张不会眨眼、不会说话的僵脸。所以这里永远是「在别人写完的值上再加一点」。

// 眼神预设。数值都是偏移量，叠在当前表情之上。
const PRESETS = {
  default: { label: '原样', smile: 0, cheek: 0, brow: 0, browAngle: 0, eyeX: 0, eyeY: 0 },
  gentle:  { label: '温柔', smile: 0.35, cheek: 0.15, brow: -0.15, browAngle: -0.2, eyeX: 0, eyeY: -0.1 },
  bright:  { label: '精神', smile: 0.15, cheek: 0.05, brow: 0.35, browAngle: 0.15, eyeX: 0, eyeY: 0.15 },
  sleepyEyes: { label: '慵懒', smile: 0.1, cheek: 0, brow: -0.3, browAngle: -0.3, eyeX: 0, eyeY: -0.2 },
  tsundere: { label: '傲娇', smile: 0, cheek: 0.3, brow: 0.2, browAngle: 0.4, eyeX: -0.35, eyeY: 0 },
  cool:    { label: '清冷', smile: -0.1, cheek: -0.1, brow: 0.1, browAngle: 0.25, eyeX: 0, eyeY: 0.05 },
};

/**
 * 参数名。跟 dance.js 一样，不同模型叫法不同，找不到就跳过。
 *
 * **每项必须同时列驼峰和下划线两种写法。** Cubism 2.1 时代导出的模型（官方样例里
 * 那批猫、千岁、泉、春伞积木都是）参数叫 `PARAM_EYE_L_OPEN`，4.0 之后才是
 * `ParamEyeLOpen`。原来这张表只写了驼峰那一半，于是在下划线命名的模型上
 * **整个眼神层是死的** —— 视线不跟随、精力见底不垂眼皮、情绪不上脸，
 * 而且一句报错都没有（找不到就跳过是这层的设计）。
 *
 * 这个坑是收官方样例模型时踩的：验了「表情名对不对」「模型能不能加载」，
 * 唯独没验这张表。`tools/test-profiles.js` 现在会拿 models/ 下每个模型的
 * cdi3 参数表来对，再漏就会红。
 */
const LOOK_PARAMS = {
  smileL: ['ParamEyeLSmile', 'PARAM_EYE_L_SMILE'],
  smileR: ['ParamEyeRSmile', 'PARAM_EYE_R_SMILE'],
  cheek: ['ParamCheek', 'PARAM_CHEEK'],
  browLY: ['ParamBrowLY', 'PARAM_BROW_L_Y'],
  browRY: ['ParamBrowRY', 'PARAM_BROW_R_Y'],
  browLAngle: ['ParamBrowLAngle', 'PARAM_BROW_L_ANGLE'],
  browRAngle: ['ParamBrowRAngle', 'PARAM_BROW_R_ANGLE'],
  eyeX: ['ParamEyeBallX', 'PARAM_EYE_BALL_X'],
  eyeY: ['ParamEyeBallY', 'PARAM_EYE_BALL_Y'],
  eyeLOpen: ['ParamEyeLOpen', 'PARAM_EYE_L_OPEN'],
  eyeROpen: ['ParamEyeROpen', 'PARAM_EYE_R_OPEN'],
};

/**
 * 色调滤镜。
 *
 * 用 PIXI 的 ColorMatrixFilter 套在整个模型上 —— 只能整体调，
 * 没法单独把头发染成粉色（那需要单部件染色，库不给）。
 * 但「暖一点」「夜里偏蓝」这种氛围切换是实打实的。
 */
const TINTS = {
  none: null,
  warm: { label: '暖调', matrix: [1.10, 0.02, 0.00, 0, 0.02,
                                 0.00, 1.02, 0.00, 0, 0.01,
                                 0.00, 0.00, 0.90, 0, -0.01,
                                 0, 0, 0, 1, 0] },
  cool: { label: '冷调', matrix: [0.92, 0.00, 0.02, 0, 0.00,
                                 0.00, 1.00, 0.02, 0, 0.01,
                                 0.02, 0.02, 1.12, 0, 0.02,
                                 0, 0, 0, 1, 0] },
  night: { label: '夜间', matrix: [0.72, 0.02, 0.06, 0, -0.02,
                                  0.02, 0.76, 0.08, 0, -0.02,
                                  0.06, 0.08, 1.00, 0, 0.03,
                                  0, 0, 0, 1, 0] },
  vivid: { label: '鲜艳', matrix: [1.25, -0.12, -0.08, 0, 0,
                                  -0.10, 1.22, -0.08, 0, 0,
                                  -0.08, -0.12, 1.24, 0, 0,
                                  0, 0, 0, 1, 0] },
  faded: { label: '淡雅', matrix: [0.82, 0.12, 0.10, 0, 0.04,
                                  0.10, 0.82, 0.12, 0, 0.04,
                                  0.10, 0.12, 0.82, 0, 0.04,
                                  0, 0, 0, 1, 0] },
};

/**
 * 这个参数在模型上实际存不存在。
 *
 * 跟 dance.js 里那个是同一件事，原因也一样：`getParameterIndex` 遇到不认识的
 * id 不返回 -1，而是**现编一个下标**还给你，所以 `idx >= 0` 恒真 ——
 * 备选参数名从来没轮到过，写进去的值也全进了黑洞而不报错。
 * 得问 `_parameterIds` 这个真实的字符串数组。
 *
 * （两边各留一份，是因为 look.js 和 dance.js 在浏览器里是各自独立的 script，
 * 没有共同的模块入口；为这六行专门加一个文件反而更绕。）
 */
function hasParam(core, name) {
  if (Array.isArray(core._parameterIds)) return core._parameterIds.includes(name);
  try { return core.getParameterIndex(name) >= 0; } catch (_) { return false; }
}

class Look {
  constructor(model, log) {
    this.model = model;
    this.log = log || (() => {});
    this.cfg = { preset: 'default', smile: 0, cheek: 0, brow: 0, browAngle: 0, eyeX: 0, eyeY: 0 };
    this.hooked = false;
    this.filter = null;

    // 精力低时眼皮往下压多少（0 = 一点不压）。由 setDroop() 从外面推进来。
    this.droop = 0;      // 眼皮现在压到哪儿（跟着 droopWant 慢慢走）
    this.droopWant = 0;  // 该压到哪儿
    this.droopAt = 0;    // 上一帧的时刻，用来算 dt

    // 摸一遍这个模型认哪些参数
    this.available = {};
    const core = model && model.internalModel && model.internalModel.coreModel;
    if (core) {
      for (const [key, names] of Object.entries(LOOK_PARAMS)) {
        for (const n of names) {
          if (hasParam(core, n)) { this.available[key] = n; break; }
        }
      }
    }
    this.log('[look] 能调的五官: ' + (Object.keys(this.available).join(', ') || '（一个都没有）'));
  }

  /** 把预设和微调合成最终偏移量 */
  _offsets() {
    const p = PRESETS[this.cfg.preset] || PRESETS.default;
    const add = (a, b) => Math.max(-1, Math.min(1, (a || 0) + (b || 0)));
    return {
      smile: add(p.smile, this.cfg.smile),
      cheek: add(p.cheek, this.cfg.cheek),
      brow: add(p.brow, this.cfg.brow),
      browAngle: add(p.browAngle, this.cfg.browAngle),
      eyeX: add(p.eyeX, this.cfg.eyeX),
      eyeY: add(p.eyeY, this.cfg.eyeY),
    };
  }

  apply(cfg) {
    if (cfg) Object.assign(this.cfg, cfg);
    this._hookParams();
    this._applyTint(this.cfg.tint);
  }

  /**
   * 眼皮往下压多少：0 是精神，1 是快睁不开了。
   *
   * 为什么不做成一个「困」的表情：表情是离散的，一切换就是一整张脸变了；
   * 而「累」是连续的、跟精力值一一对应的。眼皮压三成的样子，
   * 你说不出她是什么表情，但一眼能看出她今天状态不太行 —— 这才像真人。
   *
   * 实现上用的是 **min 语义不是减法**：读出当前值，取它和上限里小的那个。
   * 眨眼时当前值本来就掉到 0 了，min 不会打断它；睁着的时候才被上限压住。
   * 写成 `cur - droop` 的话，眨眼那一下会被减成负数，眼睛闭得比正常还死。
   */
  setDroop(v) {
    const next = Math.max(0, Math.min(1, Number(v) || 0));
    if (Math.abs(next - this.droopWant) < 0.005) return;
    // **只改目标，不当场改值。** 心情一变（比如切到「困」）这个数会从 0 跳到 0.72，
    // 直接写下去就是眼皮「啪」地砸下来一半 —— 一帧之内走完，看着像掉帧。
    // 真实的「撑不住了」是一两秒里慢慢沉下去的，所以交给下面那道逼近去走。
    this.droopWant = next;
    this._hookParams(); // 还没挂钩子的话顺手挂上（比如色调从没设过）
  }

  _hookParams() {
    if (this.hooked) return;
    const im = this.model && this.model.internalModel;
    if (!im || !im.on) return;

    im.on('beforeModelUpdate', () => {
      const core = im.coreModel;
      const o = this._offsets();

      // 眼皮往目标那儿走。**按秒算不按帧算** —— 写成「每帧走 15%」的话，
      // 60fps 和 30fps 下的快慢差一倍，掉帧时她的眼皮会忽快忽慢。
      // 0.5 秒走完当前差距的一半：沉下去有过程，但不会慢到你察觉不出在动
      {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dt = this.droopAt ? Math.min(0.1, (now - this.droopAt) / 1000) : 1 / 60;
        this.droopAt = now;
        const k = 1 - Math.pow(0.5, dt / 0.5);
        this.droop += (this.droopWant - this.droop) * k;
        if (Math.abs(this.droopWant - this.droop) < 0.002) this.droop = this.droopWant;
      }
      const bump = (key, delta, lo, hi) => {
        const id = this.available[key];
        if (!id || !delta) return;
        try {
          // 读出来再加回去 —— 表情、眨眼、口型都在写这些参数，
          // 直接赋值会把它们统统压死
          const cur = core.getParameterValueById(id);
          core.setParameterValueById(id, Math.max(lo, Math.min(hi, cur + delta)));
        } catch (_) { /* 这个参数写不了就算了 */ }
      };

      bump('smileL', o.smile, 0, 1);
      bump('smileR', o.smile, 0, 1);
      bump('cheek', o.cheek, 0, 1);
      bump('browLY', o.brow * 0.6, -1, 1);
      bump('browRY', o.brow * 0.6, -1, 1);
      bump('browLAngle', o.browAngle * 0.7, -1, 1);
      bump('browRAngle', -o.browAngle * 0.7, -1, 1); // 左右眉是镜像的
      bump('eyeX', o.eyeX * 0.5, -1, 1);
      bump('eyeY', o.eyeY * 0.5, -1, 1);

      // 累了眼皮就抬不起来。上限从这个参数**自己的最大值**起算 ——
      // Hiyori 的 ParamEyeLOpen 能开到 1.2，按 1 算的话 droop=0 时就已经
      // 悄悄把她的眼睛压小了一圈。
      if (this.droop > 0.01) {
        const cap = (key) => {
          const id = this.available[key];
          if (!id) return;
          try {
            const open = this._maxOpen(core, id);
            const lid = open - this.droop * (open - 0.3); // droop=1 时只剩一条缝
            const cur = core.getParameterValueById(id);
            if (cur > lid) core.setParameterValueById(id, lid);
          } catch (_) { /* 没这个参数就算了 */ }
        };
        cap('eyeLOpen');
        cap('eyeROpen');
      }
    });

    this.hooked = true;
  }

  /** 这只眼睛最大能睁到多少。问模型自己，问不到就按 1。 */
  _maxOpen(core, id) {
    if (this._openMax && this._openMax[id] !== undefined) return this._openMax[id];
    let v = 1;
    try {
      const idx = core.getParameterIndex(id);
      const max = core.getParameterMaximumValue(idx);
      if (typeof max === 'number' && isFinite(max) && max > 0) v = max;
    } catch (_) { /* 用默认的 1 */ }
    if (!this._openMax) this._openMax = {};
    this._openMax[id] = v;
    return v;
  }

  _applyTint(name) {
    const t = TINTS[name || 'none'];
    if (!this.model) return;

    if (!t) {
      this.model.filters = null;
      this.filter = null;
      return;
    }

    try {
      if (!this.filter) this.filter = new PIXI.filters.ColorMatrixFilter();
      this.filter.matrix = t.matrix.slice();
      this.model.filters = [this.filter];
    } catch (err) {
      this.log('[look] 色调套不上: ' + (err && err.message));
    }
  }
}

if (typeof window !== 'undefined') window.WaifuLook = { Look, PRESETS, TINTS };
if (typeof module !== 'undefined' && module.exports) module.exports = { Look, PRESETS, TINTS, LOOK_PARAMS };
