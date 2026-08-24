'use strict';

// 给**脸是死的**那些模型补一套表情。
//
// Live2D 的「表情」本质就是一组参数偏移，所以只要模型作者暴露了眼睛/眉毛/嘴，
// 完全可以自己写出来。这个项目里有两种「脸是死的」：
//
//   · 官方样例压根没配 exp3.json —— Hiyori、Mark 君、Rice、两只猫、汪子
//   · 配了，但**那些表情跟脸没关系** —— 海梦那七个 expression1~7 里，
//     四个改的是 `Param40/Param43`（hands on hips，叉腰！），另外三个是
//     `Action02/03/04`，实测推到头脸上 0.0% 变化。名字里一点意思都没有，
//     光看名字必然当成表情用（这个项目就当了一阵子，faceMap 里指着它们，
//     结果她的脸从头到尾一动不动，日志里一个字都没有）。
//
// 参数用 Add 混合而不是 Overwrite：Overwrite 会把自动眨眼和动作里的眼部数据
// 整个盖掉，人就僵了；Add 是叠加，眨眼照常眨，表情照常在。
//
// 跑法：
//   node tools/make-expressions.js              全部重新生成
//   node tools/make-expressions.js Mark 海梦    只生成这几个
//
// 改完**一定要看一眼**：
//   npx electron tools/expression-sheet.js --model=models/Mark/Mark.model3.json
// 那张联络表会给每张脸标一个 Δ（跟「不加表情」比差多少）。
// **Δ 0.0% 就是白写了** —— 参数名对不上是静默的，不看这张表你不会知道。
//
// ---------------------------------------------------------------------------
// 三条写表情的经验（都是踩出来的）：
//
// 1. **别把情绪压在眉毛上。** Hiyori 是厚刘海，眉毛几乎全被头发盖住 ——
//    第一版给 frustrated 堆了 8 个眉毛参数，应用成功，屏幕上跟平静脸没区别。
//    真正看得见的是眼睛开合、笑眼、眼球方向、脸红、张嘴、呆毛。
// 2. **动物看耳朵和尾巴。** 猫和狗没有眉毛可用，但耳朵往后压 = 生气、
//    耳朵竖起来 = 警觉，比人脸还好读。猫还有 `PARAM_TAIL_ANGRY`。
// 3. **0~1 的参数只能往一个方向走。** 眼睛开合是 0~1、默认 1（睁着），
//    所以「瞪圆眼」加不出来（加上去也是 1），得靠眉毛和张嘴表达吃惊。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 18 张脸 = mood.js 的 computeState() 那 12 个 + 聊天时她自己标的那 6 个
// （angry/playful/scorn/curious/panic/bored，见 chat.js 的 MOODS）。
// 表情名直接用状态名，这样 profiles.js 里的 faceMap 就是恒等的（写 null），
// 少一层转换，也少一处能写错的地方。
//
// 【后加那六张是干嘛的】「跟真人聊天」缺的不是更多好情绪，是**负面和玩闹的
// 层次**：真人会翻白眼（scorn）、会坏笑（playful）、会真的火（angry，跟
// frustrated 的「烦」不是一回事）、会突然来兴趣（curious）、会慌（panic）、
// 会敷衍（bored）。这六张的参数思路：
//   · angry —— 眉毛压到底 + 眉形内聚（怒眉）+ 眼睛睁着瞪 + 嘴绷紧/张开吼
//   · scorn —— **半垂眼 + 俯视**（看不起的核心就是这个）+ 单边挑眉 + 嘴角撇
//   · playful —— **单眼眨**（左右眼开合不对称，这是最好读的搞怪信号）+ 咧嘴
//   · curious —— 睁大一点 + 抬眉 + 视线偏一侧（歪头看）+ 嘴微张
//   · panic —— 瞪圆 + 眉毛高 + 嘴大张 + 视线乱瞟
//   · bored —— 半垂眼 + 视线飘开 + 嘴平 + 眉毛塌（跟 tired 的区别在视线偏）
const STATES = ['normal', 'working', 'happy', 'proud', 'frustrated', 'sad',
                'shy', 'lonely', 'tired', 'sleepy', 'surprised', 'excited',
                'angry', 'playful', 'scorn', 'curious', 'panic', 'bored'];

// --- Hiyori（2026-08-24 按联络表实测把还有余量的几处推狠了：嘴张大、腮红加深）---------------------------------
const HIYORI = {
  normal: { ParamMouthForm: 0.3 },

  working: {
    ParamEyeLOpen: 0.12, ParamEyeROpen: 0.12,
    ParamMouthForm: -0.25, ParamMouthOpenY: -0.1,
    ParamBrowLY: -0.25, ParamBrowRY: -0.25,
  },

  happy: {
    ParamEyeLOpen: -1, ParamEyeROpen: -1,
    ParamEyeLSmile: 1, ParamEyeRSmile: 1,
    ParamMouthForm: 1, ParamMouthOpenY: 0.9,
    ParamCheek: 0.55,
    ParamHairAhoge: 0.8,
    ParamBrowLY: 0.4, ParamBrowRY: 0.4,
  },

  proud: {
    ParamEyeLOpen: -0.6, ParamEyeROpen: -0.6,
    ParamEyeLSmile: 0.9, ParamEyeRSmile: 0.9,
    ParamMouthForm: 1, ParamMouthOpenY: 0.3,
    ParamCheek: 0.25,
    ParamHairAhoge: 1,
    ParamBrowLY: 0.5, ParamBrowRY: 0.5,
  },

  frustrated: {
    ParamEyeLOpen: -0.4, ParamEyeROpen: -0.4,
    ParamMouthForm: -1.8, ParamMouthOpenY: 0.7,
    ParamCheek: 0.3,
    ParamHairAhoge: -0.9,
    ParamBrowLY: -1, ParamBrowRY: -1,
    ParamBrowLForm: -1, ParamBrowRForm: -1,
  },

  sad: {
    ParamEyeLOpen: -0.45, ParamEyeROpen: -0.45,
    ParamEyeBallY: -0.75,
    ParamMouthForm: -1.6, ParamMouthOpenY: -0.2,
    ParamHairAhoge: -1,
    ParamBrowLY: -0.55, ParamBrowRY: -0.55,
    ParamBrowLAngle: 0.7, ParamBrowRAngle: 0.7,
  },

  shy: {
    ParamCheek: 1,
    ParamEyeLOpen: -0.35, ParamEyeROpen: -0.35,
    ParamEyeBallY: -0.5, ParamEyeBallX: 0.3,
    ParamMouthForm: -0.4, ParamMouthOpenY: 0.2,
    ParamBrowLY: -0.3, ParamBrowRY: -0.3,
  },

  lonely: {
    ParamCheek: 0.65,
    ParamEyeBallX: -0.95,
    ParamEyeLOpen: -0.3, ParamEyeROpen: -0.3,
    ParamMouthForm: -1.5, ParamMouthOpenY: -0.15,
    ParamHairAhoge: -0.5,
    ParamBrowLY: -0.7, ParamBrowRY: -0.7,
  },

  tired: {
    ParamEyeLOpen: -0.6, ParamEyeROpen: -0.6,
    ParamEyeBallY: -0.4,
    ParamMouthForm: -0.4, ParamMouthOpenY: 0.25,
    ParamHairAhoge: -0.85,
    ParamBrowLY: -0.45, ParamBrowRY: -0.45,
  },

  sleepy: {
    ParamEyeLOpen: -0.88, ParamEyeROpen: -0.88,
    ParamEyeBallY: -0.3,
    ParamMouthForm: -0.2, ParamMouthOpenY: 0.45,
    ParamHairAhoge: -1,
    ParamBrowLY: -0.5, ParamBrowRY: -0.5,
  },

  surprised: {
    ParamEyeLOpen: 1, ParamEyeROpen: 1,
    ParamMouthOpenY: 1, ParamMouthForm: -0.3,
    ParamHairAhoge: 1,
    ParamBrowLY: 1, ParamBrowRY: 1,
  },

  excited: {
    ParamEyeLOpen: 0.45, ParamEyeROpen: 0.45,
    ParamEyeLSmile: 0.5, ParamEyeRSmile: 0.5,
    ParamMouthForm: 0.9, ParamMouthOpenY: 0.95,
    ParamCheek: 0.5,
    ParamHairAhoge: 0.85,
    ParamBrowLY: 0.6, ParamBrowRY: 0.6,
  },

  // 真火了：跟 frustrated 的差别是**眼睛睁着瞪**（烦是眯着的）、呆毛炸起来
  angry: {
    ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8,
    ParamBrowLY: -1, ParamBrowRY: -1,
    ParamBrowLForm: -1, ParamBrowRForm: -1,
    ParamBrowLAngle: -1, ParamBrowRAngle: -1,
    ParamMouthForm: -2, ParamMouthOpenY: 1,
    ParamCheek: 0.9,
    ParamHairAhoge: 1,
  },

  // 搞怪：单眼眨（左闭右睁）+ 咧嘴 + 呆毛翘
  playful: {
    // 右眼 +0.3 是没用的：开合 0~1 默认 1，正向 Add 直接饱和 —— 改成 0
    ParamEyeLOpen: -1, ParamEyeROpen: 0,
    ParamEyeLSmile: 1,
    ParamMouthForm: 1, ParamMouthOpenY: 0.8,
    ParamCheek: 0.2,
    ParamHairAhoge: 1,
    ParamBrowLY: 0.3, ParamBrowRY: -0.2,   // 一高一低，坏笑的眉
    ParamBrowLAngle: -0.4,
  },

  // 鄙夷：半垂眼 + 俯视（看不起的核心）+ 单边挑眉 + 嘴角撇下去
  scorn: {
    ParamEyeLOpen: -0.62, ParamEyeROpen: -0.62,
    ParamEyeBallY: -0.55, ParamEyeBallX: -0.7,
    ParamBrowLY: 0.55, ParamBrowRY: -0.6,  // 一挑一压，最典型的不屑
    ParamBrowLAngle: -0.5, ParamBrowRAngle: -0.2,
    ParamMouthForm: -1.4, ParamMouthOpenY: -0.1,
  },

  // 好奇：眼睛睁大一点 + 抬眉 + 视线偏一侧（配合歪头）+ 嘴微张
  curious: {
    ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55,
    ParamEyeBallX: 0.45, ParamEyeBallY: 0.2,
    ParamBrowLY: 0.8, ParamBrowRY: 0.45,
    ParamMouthForm: 0.2, ParamMouthOpenY: 0.3,
    ParamHairAhoge: 0.6,
  },

  // 慌了：瞪圆 + 眉毛高 + 嘴大张 + 呆毛炸
  panic: {
    ParamEyeLOpen: 1, ParamEyeROpen: 1,
    ParamEyeBallX: -0.4, ParamEyeBallY: 0.15,
    ParamBrowLY: 1, ParamBrowRY: 1,
    ParamBrowLAngle: 0.6, ParamBrowRAngle: 0.6,
    ParamMouthForm: -1.5, ParamMouthOpenY: 1,
    ParamCheek: 0.4,
    ParamHairAhoge: 1,
  },

  // 无聊：半垂眼 + **视线飘到一边**（跟 tired 的区别就在这儿）+ 嘴平 + 眉塌
  bored: {
    ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5,
    ParamEyeBallX: -1, ParamEyeBallY: -0.15,
    ParamBrowLY: -0.55, ParamBrowRY: -0.55,
    ParamMouthForm: -0.6, ParamMouthOpenY: 0.05,
    ParamHairAhoge: -0.7,
  },
};

// --- 海梦（ARKit 那套命名，脸上的料最全）----------------------------------
// 她的嘴是拆成一堆 ARKit 形状的（Frown/ShrugUpper/UpperUp/LowerDown/CheekPuff…），
// 没有一个「嘴角弧度」的总开关，所以「笑」要靠 UpperUp 提上唇 + 张一点下巴凑。
// 得意那张顺手把 Param40/Param43 拉满 —— 那两个是**叉腰**，正好是得意的样子。
const HAIMENG = {
  normal: { MouthUpperUpLeft: 0.12, MouthUpperUpRight: 0.12 },

  working: {
    EyeL_Squint: 0.35, EyeR_Squint: 0.35,
    ParamEyeLOpen: -0.28, ParamEyeROpen: -0.28,
    ParamBrowLY: -0.35, ParamBrowRY: -0.35,
    MouthShrugUpper: 0.25,
  },

  // Squint 单用太轻（联络表上只差 0.4%），得配合眼睛开合一起压才看得出笑眯眼
  happy: {
    EyeL_Squint: 0.9, EyeR_Squint: 0.9,
    ParamEyeLOpen: -0.6, ParamEyeROpen: -0.6,
    ParamJawOpen: 0.45,
    MouthUpperUpLeft: 0.9, MouthUpperUpRight: 0.9,
    ParamBrowLY: 0.5, ParamBrowRY: 0.5,
  },

  proud: {
    EyeL_Squint: 0.7, EyeR_Squint: 0.7,
    ParamEyeLOpen: -0.45, ParamEyeROpen: -0.45,
    MouthUpperUpLeft: 0.6, MouthUpperUpRight: 0.6,
    ParamBrowLAngle: -0.7, ParamBrowRAngle: -0.7,
    ParamEyeBallY: 0.35,      // 微微抬眼，一副「怎么样」的样子
    Param40: 1, Param43: 1,   // 叉腰。这两个是她仅有的那七个「表情」里唯一有用的东西
  },

  frustrated: {
    ParamBrowLY: -1, ParamBrowRY: -1,
    ParamBrowLForm: -1, ParamBrowRForm: -1,
    ParamJawOpen: 0.5,
    MouthFrownLeft: 0.7, MouthFrownRight: 0.7,
    EyeL_Squint: 0.4, EyeR_Squint: 0.4,
  },

  sad: {
    ParamBrowLAngle: 0.8, ParamBrowRAngle: 0.8,
    ParamBrowLY: -0.3, ParamBrowRY: -0.3,
    MouthFrownLeft: 0.9, MouthFrownRight: 0.9,
    ParamEyeLOpen: -0.4, ParamEyeROpen: -0.4,
    ParamEyeBallY: -0.6,
  },

  shy: {
    MouthCheekPuff: 0.35,
    ParamEyeBallX: 0.55, ParamEyeBallY: -0.4,
    EyeL_Squint: 0.5, EyeR_Squint: 0.5,
    ParamEyeLOpen: -0.3, ParamEyeROpen: -0.3,
    MouthShrugUpper: 0.5,
  },

  lonely: {
    MouthCheekPuff: 1,          // 鼓着脸
    ParamEyeBallX: -0.95,
    MouthFrownLeft: 0.5, MouthFrownRight: 0.5,
    ParamBrowLY: -0.4, ParamBrowRY: -0.4,
  },

  tired: {
    ParamEyeLOpen: -0.55, ParamEyeROpen: -0.55,
    ParamEyeBallY: -0.4,
    ParamBrowLY: -0.4, ParamBrowRY: -0.4,
    MouthShrugLower: 0.5,
  },

  sleepy: {
    ParamEyeLOpen: -0.88, ParamEyeROpen: -0.88,
    ParamJawOpen: 0.4,
    ParamBrowLY: -0.5, ParamBrowRY: -0.5,
  },

  // 眼睛开合是 0~1、默认就睁着，「瞪圆」加不出来 —— 吃惊全靠眉毛和嘴
  surprised: {
    ParamJawOpen: 0.85,
    ParamBrowLY: 1, ParamBrowRY: 1,
    ParamMouthFunnel: 0.6,
  },

  excited: {
    EyeL_Squint: 0.3, EyeR_Squint: 0.3,
    ParamJawOpen: 0.7,
    MouthUpperUpLeft: 1, MouthUpperUpRight: 1,
    ParamMouthLowerDownLeft: 0.5, ParamMouthLowerDownRight: 0.5,
    ParamBrowLY: 0.8, ParamBrowRY: 0.8,
    ParamEyeBallY: 0.3,
  },

  // 真火了：眉压到底 + 眉形内聚 + 张嘴吼（frustrated 是撇嘴 Frown，这个是吼）
  angry: {
    ParamBrowLY: -1, ParamBrowRY: -1,
    ParamBrowLForm: -1, ParamBrowRForm: -1,
    ParamBrowLAngle: -1, ParamBrowRAngle: -1,
    ParamJawOpen: 0.9,
    ParamMouthLowerDownLeft: 0.8, ParamMouthLowerDownRight: 0.8,
    MouthCheekPuff: 0.4,
  },

  playful: {
    ParamEyeLOpen: -1,                 // 左眼闭上 = 眨眼
    EyeR_Squint: 0.5,
    MouthUpperUpLeft: 1, MouthUpperUpRight: 0.3,  // 嘴角一高一低，坏笑
    ParamJawOpen: 0.4,
    ParamBrowLY: 0.6, ParamBrowRY: -0.2,
  },

  scorn: {
    EyeL_Squint: 0.85, EyeR_Squint: 0.85,
    ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5,
    ParamEyeBallY: -0.5, ParamEyeBallX: -0.4,
    ParamBrowLY: 0.5, ParamBrowRY: -0.5,
    MouthFrownLeft: 0.8, MouthFrownRight: 0.2,   // 只撇一边，嗤之以鼻
    MouthShrugUpper: 0.4,
  },

  curious: {
    ParamBrowLY: 0.9, ParamBrowRY: 0.5,
    ParamEyeBallX: 0.5, ParamEyeBallY: 0.25,
    ParamJawOpen: 0.3,
    MouthUpperUpLeft: 0.35, MouthUpperUpRight: 0.35,
  },

  panic: {
    ParamBrowLY: 1, ParamBrowRY: 1,
    ParamBrowLAngle: 0.8, ParamBrowRAngle: 0.8,
    ParamJawOpen: 1,
    ParamMouthFunnel: 0.5,
    ParamEyeBallX: -0.5,
  },

  bored: {
    ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5,
    ParamEyeBallX: -0.85, ParamEyeBallY: -0.2,
    ParamBrowLY: -0.5, ParamBrowRY: -0.5,
    MouthShrugLower: 0.6,
  },
};

// --- Mark 君（官方的教学模型，脸上只有眼睛、眼球、眉毛、张嘴）-------------
const MARK = {
  normal: { ParamMouthOpenY: 0.06 },
  working: { ParamEyeLOpen: -0.3, ParamEyeROpen: -0.3, ParamBrowLY: -0.4, ParamBrowRY: -0.4 },
  happy: {
    ParamEyeLOpen: -0.85, ParamEyeROpen: -0.85,
    ParamMouthOpenY: 0.7, ParamBrowLY: 0.5, ParamBrowRY: 0.5,
  },
  proud: {
    ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5,
    ParamMouthOpenY: 0.3, ParamBrowLY: 0.75, ParamBrowRY: 0.75,
  },
  frustrated: {
    ParamEyeLOpen: -0.35, ParamEyeROpen: -0.35,
    ParamMouthOpenY: 0.6, ParamBrowLY: -1, ParamBrowRY: -1,
  },
  sad: {
    ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5, ParamEyeBallY: -0.7,
    ParamMouthOpenY: 0.15, ParamBrowLY: -0.6, ParamBrowRY: -0.6,
  },
  shy: {
    ParamEyeLOpen: -0.4, ParamEyeROpen: -0.4,
    ParamEyeBallX: 0.6, ParamEyeBallY: -0.45, ParamMouthOpenY: 0.2,
  },
  lonely: {
    ParamEyeBallX: -0.95, ParamEyeLOpen: -0.3, ParamEyeROpen: -0.3,
    ParamBrowLY: -0.5, ParamBrowRY: -0.5,
  },
  tired: {
    ParamEyeLOpen: -0.6, ParamEyeROpen: -0.6, ParamEyeBallY: -0.4,
    ParamBrowLY: -0.5, ParamBrowRY: -0.5,
  },
  sleepy: {
    ParamEyeLOpen: -0.9, ParamEyeROpen: -0.9,
    ParamMouthOpenY: 0.4, ParamBrowLY: -0.6, ParamBrowRY: -0.6,
  },
  surprised: { ParamMouthOpenY: 1, ParamBrowLY: 1, ParamBrowRY: 1 },
  excited: {
    ParamMouthOpenY: 0.8, ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamEyeBallY: 0.3,
  },
  // 眼睛睁着瞪 + 眉压死 —— 跟 frustrated（眯着）分得开
  angry: {
    ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7,
    ParamBrowLY: -1, ParamBrowRY: -1, ParamMouthOpenY: 0.9,
  },
  playful: {
    ParamEyeLOpen: -1, ParamEyeROpen: 0.25,   // 单眼眨
    ParamMouthOpenY: 0.55, ParamBrowLY: 0.5, ParamBrowRY: -0.25,
  },
  scorn: {
    ParamEyeLOpen: -0.6, ParamEyeROpen: -0.6,
    ParamEyeBallY: -0.55, ParamEyeBallX: -0.4,
    ParamBrowLY: 0.5, ParamBrowRY: -0.55, ParamMouthOpenY: 0.05,
  },
  curious: {
    ParamEyeLOpen: 0.5, ParamEyeROpen: 0.5,
    ParamEyeBallX: 0.5, ParamEyeBallY: 0.2,
    ParamBrowLY: 0.85, ParamBrowRY: 0.4, ParamMouthOpenY: 0.3,
  },
  panic: {
    ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamEyeBallX: -0.45,
    ParamBrowLY: 1, ParamBrowRY: 1, ParamMouthOpenY: 1,
  },
  bored: {
    ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5,
    ParamEyeBallX: -0.85, ParamBrowLY: -0.55, ParamBrowRY: -0.55,
    ParamMouthOpenY: 0.05,
  },
};

// --- Rice（**只有眼睛和眼球**，别的一概没有）------------------------------
// 这是这批里最省的一个：没有嘴、没有眉毛、没有脸红。所以她的十二张脸全靠
// 「睁多大 + 看哪儿」，几张之间的差别注定比别人小。这不是没写好，是天花板。
const RICE = {
  normal: { ParamEyeBallY: 0.05 },
  working: { ParamEyeLOpen: -0.25, ParamEyeROpen: -0.25 },
  happy: { ParamEyeLOpen: -0.8, ParamEyeROpen: -0.8 },
  proud: { ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5, ParamEyeBallY: 0.35 },
  frustrated: { ParamEyeLOpen: -0.45, ParamEyeROpen: -0.45, ParamEyeBallY: 0.25 },
  sad: { ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5, ParamEyeBallY: -0.8 },
  shy: { ParamEyeLOpen: -0.4, ParamEyeROpen: -0.4, ParamEyeBallX: 0.7, ParamEyeBallY: -0.45 },
  lonely: { ParamEyeLOpen: -0.3, ParamEyeROpen: -0.3, ParamEyeBallX: -1 },
  tired: { ParamEyeLOpen: -0.65, ParamEyeROpen: -0.65, ParamEyeBallY: -0.35 },
  sleepy: { ParamEyeLOpen: -0.92, ParamEyeROpen: -0.92 },
  surprised: { ParamEyeBallY: 0.7 },
  excited: { ParamEyeLOpen: -0.15, ParamEyeROpen: -0.15, ParamEyeBallY: 0.5 },
  // 她只有眼睛可用，所以这六张全靠「睁多大 + 看哪儿 + 左右眼一不一样」。
  // playful 的单眼眨在她身上反而是最明显的一张
  angry: { ParamEyeLOpen: -0.1, ParamEyeROpen: -0.1, ParamEyeBallY: 0.2 },
  playful: { ParamEyeLOpen: -1, ParamEyeROpen: 0.1 },
  scorn: { ParamEyeLOpen: -0.68, ParamEyeROpen: -0.68, ParamEyeBallY: -0.6, ParamEyeBallX: -0.5 },
  curious: { ParamEyeLOpen: 0.1, ParamEyeROpen: 0.1, ParamEyeBallX: 0.7, ParamEyeBallY: 0.3 },
  panic: { ParamEyeLOpen: 0.2, ParamEyeROpen: 0.2, ParamEyeBallX: -0.7, ParamEyeBallY: 0.35 },
  bored: { ParamEyeLOpen: -0.55, ParamEyeROpen: -0.55, ParamEyeBallX: -0.9, ParamEyeBallY: -0.2 },
};

// --- 猫（とろろ / ひじき 是同一个 moc3）------------------------------------
// 猫没有眉毛可用，但**耳朵和尾巴比人脸还好读**：耳朵往后压 = 不爽，
// 竖起来 = 警觉。`PARAM_TAIL_ANGRY` 是模型作者专门做的「炸毛尾巴」。
// `PARAM_EYE_FORM` 管眼睛形状（眯成缝 / 瞪圆），是这只猫表情的主力。
//
// **这只猫的眼睛开合不能大改。** 她的待机动作把 PARAM_EYE_L_OPEN 常年按在 0.5
// （猫本来就是半眯着的），而 look.js 还会按精力再压一道眼皮（droop）。
// 两边叠起来：-0.9 的「困」实测把眼睛按到 **0，完全闭死** —— 精力一低她就
// 全程闭着眼，看着不是困是睡死了。所以困/累这两张主要交给 droop 去压，
// 表情这边只给一点点，眯的形状交给 EYE_FORM。
const CAT = {
  normal: { PARAM_EAR_L: 0.1, PARAM_EAR_R: 0.1 },
  working: {
    PARAM_EYE_FORM: -0.5, PARAM_EYE_L_OPEN: -0.12, PARAM_EYE_R_OPEN: -0.12,
    PARAM_EAR_L: 0.35, PARAM_EAR_R: 0.35,
  },
  happy: {
    PARAM_EYE_FORM: 1, PARAM_EYE_L_OPEN: -0.3, PARAM_EYE_R_OPEN: -0.3,
    PARAM_MOUTH_OPEN_Y: 0.5, PARAM_MOUTH_FORM: 0.8,
    PARAM_EAR_L: 0.7, PARAM_EAR_R: 0.7,
  },
  proud: {
    PARAM_EYE_FORM: 0.6, PARAM_EYE_L_OPEN: -0.2, PARAM_EYE_R_OPEN: -0.2,
    PARAM_EAR_L: 0.8, PARAM_EAR_R: 0.8,
    PARAM_MUSTACHE_FRONT_L: 0.6, PARAM_MUSTACHE_FRONT_R: 0.6,
    PARAM_TAIL: 0.6,
  },
  frustrated: {
    PARAM_EAR_L: -1, PARAM_EAR_R: -1,          // 耳朵整个往后压
    PARAM_TAIL_ANGRY: 1,                        // 炸毛
    PARAM_EYE_FORM: -0.6,
    PARAM_EYE_L_OPEN: -0.15, PARAM_EYE_R_OPEN: -0.15,
    PARAM_MOUTH_OPEN_Y: 0.65,
    PARAM_BLOW_L: -0.8, PARAM_BLOW_R: -0.8,
  },
  sad: {
    PARAM_EAR_L: -0.75, PARAM_EAR_R: -0.75,
    PARAM_EYE_L_OPEN: -0.25, PARAM_EYE_R_OPEN: -0.25,
    PARAM_EYE_FORM: 0.4,
    PARAM_EYE_BALL_Y: -0.7, PARAM_MOUTH_FORM: -0.8,
  },
  shy: {
    PARAM_EYE_L_OPEN: -0.2, PARAM_EYE_R_OPEN: -0.2, PARAM_EYE_FORM: 0.5,
    PARAM_EYE_BALL_X: 0.6, PARAM_EYE_BALL_Y: -0.4,
    PARAM_EAR_L: -0.35, PARAM_EAR_R: -0.35,
  },
  lonely: {
    PARAM_EYE_BALL_X: -1, PARAM_EAR_L: -0.55, PARAM_EAR_R: -0.55,
    PARAM_MOUTH_FORM: -0.6, PARAM_TAIL_ANGRY: 0.4,
  },
  // 困和累这两张**故意只给一点点** —— 眼皮那道 droop 已经按精力在压了，
  // 这儿再压一次就是彻底闭死（实测 -0.9 让她全程闭眼）
  tired: {
    PARAM_EYE_L_OPEN: -0.2, PARAM_EYE_R_OPEN: -0.2, PARAM_EYE_FORM: 0.35,
    PARAM_EYE_BALL_Y: -0.3, PARAM_EAR_L: -0.5, PARAM_EAR_R: -0.5,
  },
  sleepy: {
    PARAM_EYE_L_OPEN: -0.3, PARAM_EYE_R_OPEN: -0.3, PARAM_EYE_FORM: 0.6,
    PARAM_MOUTH_OPEN_Y: 0.5, PARAM_TONGUE: 0.35,
    PARAM_EAR_L: -0.6, PARAM_EAR_R: -0.6,
  },
  surprised: {
    PARAM_EYE_FORM: -1, PARAM_MOUTH_OPEN_Y: 0.9,
    PARAM_EAR_L: 1, PARAM_EAR_R: 1,
    PARAM_MUSTACHE_FRONT_L: 0.8, PARAM_MUSTACHE_FRONT_R: 0.8,
  },
  excited: {
    PARAM_EYE_FORM: 0.5, PARAM_MOUTH_OPEN_Y: 0.7, PARAM_TONGUE: 0.6,
    PARAM_EAR_L: 0.85, PARAM_EAR_R: 0.85, PARAM_TAIL: 0.8,
  },

  // 猫生气：耳朵压死 + 炸毛尾巴拉满 + 呲牙（比 frustrated 更狠一档）
  angry: {
    PARAM_EAR_L: -1, PARAM_EAR_R: -1,
    PARAM_TAIL_ANGRY: 1, PARAM_TAIL: -0.6,
    PARAM_EYE_FORM: -1,
    PARAM_MOUTH_OPEN_Y: 1, PARAM_MOUTH_FORM: -1,
    PARAM_BLOW_L: -1, PARAM_BLOW_R: -1,
    PARAM_MUSTACHE_FRONT_L: -0.6, PARAM_MUSTACHE_FRONT_R: -0.6,
  },

  // 搞怪：单眼眨 + 吐舌 + 一只耳朵歪着
  playful: {
    PARAM_EYE_L_OPEN: -0.45, PARAM_EYE_R_OPEN: 0.3,
    PARAM_EYE_FORM: 0.8,
    PARAM_TONGUE: 1, PARAM_MOUTH_OPEN_Y: 0.4, PARAM_MOUTH_FORM: 0.6,
    PARAM_EAR_L: 0.9, PARAM_EAR_R: -0.4,
    PARAM_TAIL: 0.7,
  },

  // 鄙夷：眯眼俯视 + 耳朵半后 + 尾巴甩开（猫的「不理你」）。
  // 量过一版 0.4% 太轻 —— 猫脸在画面里本来就小，靠耳朵和眼形不够，
  // 得把嘴和尾巴一起算上
  scorn: {
    PARAM_EYE_FORM: -0.7,
    PARAM_EYE_L_OPEN: -0.35, PARAM_EYE_R_OPEN: -0.35,
    PARAM_EYE_BALL_Y: -0.8, PARAM_EYE_BALL_X: -0.7,
    PARAM_EAR_L: -0.7, PARAM_EAR_R: -0.7,
    PARAM_MOUTH_FORM: -1, PARAM_MOUTH_OPEN_Y: 0.15,
    PARAM_MUSTACHE_FRONT_L: -0.8, PARAM_MUSTACHE_FRONT_R: -0.8,
    PARAM_TAIL: -0.8,
  },

  // 好奇：耳朵**竖到最前**（猫最好读的信号）+ 瞳孔圆 + 尾巴竖起来。
  // 同 scorn：第一版只动耳朵和眼球，量出来 0.2%，加了嘴和尾巴才够看
  curious: {
    PARAM_EAR_L: 1, PARAM_EAR_R: 1,
    PARAM_EYE_FORM: -1,
    PARAM_EYE_L_OPEN: 0.25, PARAM_EYE_R_OPEN: 0.25,
    PARAM_EYE_BALL_X: 0.7, PARAM_EYE_BALL_Y: 0.3,
    PARAM_MOUTH_OPEN_Y: 0.45, PARAM_MOUTH_FORM: 0.3,
    PARAM_MUSTACHE_FRONT_L: 1, PARAM_MUSTACHE_FRONT_R: 1,
    PARAM_TAIL: 1,
  },

  panic: {
    PARAM_EYE_FORM: -1,
    PARAM_EAR_L: -0.9, PARAM_EAR_R: 0.9,     // 一只压一只竖，慌乱
    PARAM_TAIL_ANGRY: 0.8,
    PARAM_MOUTH_OPEN_Y: 1, PARAM_MOUTH_FORM: -0.5,
    PARAM_EYE_BALL_X: -0.7,
  },

  bored: {
    PARAM_EYE_FORM: 0.45,
    PARAM_EYE_L_OPEN: -0.22, PARAM_EYE_R_OPEN: -0.22,
    PARAM_EYE_BALL_X: -0.9, PARAM_EYE_BALL_Y: -0.2,
    PARAM_EAR_L: -0.4, PARAM_EAR_R: -0.4,
    PARAM_MOUTH_FORM: -0.3, PARAM_TAIL: -0.3,
  },
};

// --- 汪子（碗里的狗）------------------------------------------------------
// 作者给了两个现成的好东西：`PARAM_TERE`（照れ = 脸红）和
// `PARAM_FACE_01`（どや キリッ = 得意的那副表情）。直接拿来当害羞和得意。
const WANKO = {
  normal: { PARAM_EAR_L: 0.1, PARAM_EAR_R: 0.1 },
  working: {
    PARAM_EYE_L_OPEN: -0.3, PARAM_EYE_R_OPEN: -0.3,
    PARAM_EAR_L: 0.4, PARAM_EAR_R: 0.4,
  },
  happy: {
    PARAM_EYE_L_OPEN: -0.7, PARAM_EYE_R_OPEN: -0.7,
    PARAM_MOUTH_OPEN_Y: 0.7, PARAM_EAR_L: 0.7, PARAM_EAR_R: 0.7,
  },
  proud: {
    PARAM_FACE_01: 1,                       // どや顔
    PARAM_EAR_L: 0.6, PARAM_EAR_R: 0.6,
  },
  frustrated: {
    PARAM_EAR_L: -1, PARAM_EAR_R: -1,
    PARAM_MOUTH_OPEN_Y: 0.7,
    PARAM_EYE_L_OPEN: -0.3, PARAM_EYE_R_OPEN: -0.3,
  },
  sad: {
    PARAM_EAR_L: -0.85, PARAM_EAR_R: -0.85,
    PARAM_EYE_L_OPEN: -0.5, PARAM_EYE_R_OPEN: -0.5,
    PARAM_MOUTH_FORM: -0.7,
  },
  shy: {
    PARAM_TERE: 1,                          // 照れ = 脸红
    PARAM_EYE_L_OPEN: -0.4, PARAM_EYE_R_OPEN: -0.4,
    PARAM_EAR_L: -0.3, PARAM_EAR_R: -0.3,
  },
  lonely: {
    PARAM_EAR_L: -0.6, PARAM_EAR_R: -0.6,
    PARAM_MOUTH_FORM: -0.6,
    PARAM_EYE_L_OPEN: -0.25, PARAM_EYE_R_OPEN: -0.25,
  },
  tired: {
    PARAM_EYE_L_OPEN: -0.6, PARAM_EYE_R_OPEN: -0.6,
    PARAM_EAR_L: -0.5, PARAM_EAR_R: -0.5,
  },
  sleepy: {
    PARAM_EYE_L_OPEN: -0.92, PARAM_EYE_R_OPEN: -0.92,
    PARAM_MOUTH_OPEN_Y: 0.4, PARAM_EAR_L: -0.6, PARAM_EAR_R: -0.6,
  },
  surprised: {
    PARAM_EAR_L: 1, PARAM_EAR_R: 1, PARAM_MOUTH_OPEN_Y: 1,
  },
  excited: {
    PARAM_MOUTH_OPEN_Y: 0.8, PARAM_EAR_L: 0.9, PARAM_EAR_R: 0.9,
    PARAM_FACE_01: 0.4,
  },

  angry: {
    PARAM_EAR_L: -1, PARAM_EAR_R: -1,
    PARAM_EYE_L_OPEN: 0.6, PARAM_EYE_R_OPEN: 0.6,   // 瞪着（frustrated 是眯着）
    PARAM_MOUTH_OPEN_Y: 1, PARAM_MOUTH_FORM: -1,
  },

  playful: {
    PARAM_EYE_L_OPEN: -1, PARAM_EYE_R_OPEN: 0.2,     // 单眼眨
    PARAM_MOUTH_OPEN_Y: 0.6, PARAM_MOUTH_FORM: 0.7,
    PARAM_EAR_L: 0.8, PARAM_EAR_R: -0.35,
  },

  // 她没有眼球参数（只有开合），所以「俯视」做不出来 —— 鄙夷靠
  // 半垂眼 + どや顔 + 撇嘴 + 耳朵后压凑
  scorn: {
    PARAM_EYE_L_OPEN: -0.62, PARAM_EYE_R_OPEN: -0.62,
    PARAM_FACE_01: 0.55,
    PARAM_EAR_L: -0.5, PARAM_EAR_R: -0.5,
    PARAM_MOUTH_FORM: -0.9,
  },

  curious: {
    PARAM_EAR_L: 1, PARAM_EAR_R: 0.55,   // 一只竖得更高 = 竖起耳朵听
    PARAM_EYE_L_OPEN: 0.35, PARAM_EYE_R_OPEN: 0.35,
    PARAM_MOUTH_OPEN_Y: 0.25, PARAM_MOUTH_FORM: 0.2,
  },

  panic: {
    PARAM_EYE_L_OPEN: 0.85, PARAM_EYE_R_OPEN: 0.85,
    PARAM_EAR_L: -0.85, PARAM_EAR_R: 0.85,   // 一压一竖 = 慌
    PARAM_MOUTH_OPEN_Y: 1, PARAM_MOUTH_FORM: -0.6,
    PARAM_TERE: 0.5,                          // 脸也涨红了
  },

  bored: {
    PARAM_EYE_L_OPEN: -0.55, PARAM_EYE_R_OPEN: -0.55,
    PARAM_EAR_L: -0.45, PARAM_EAR_R: -0.2,   // 耳朵塌一边，敷衍
    PARAM_MOUTH_FORM: -0.35, PARAM_MOUTH_OPEN_Y: 0.08,
  },
};

// keep=true：模型自带的表情**留着**，我们的追加进去（海梦那七个虽然跟脸无关，
// 但 Param40/43 是叉腰，删了可惜）。其余的模型本来就一个都没有，写进去即可。
const MODELS = {
  Hiyori: { dir: 'Hiyori', json: 'Hiyori.model3.json', table: HIYORI },
  Mark: { dir: 'Mark', json: 'Mark.model3.json', table: MARK },
  Rice: { dir: 'Rice', json: 'Rice.model3.json', table: RICE },
  Tororo: { dir: 'Tororo', json: 'tororo.model3.json', table: CAT },
  Wanko: { dir: 'Wanko', json: 'Wanko.model3.json', table: WANKO },
  // 海梦自带那七个**不留**：实测脸上 0.0% 变化（四个是叉腰、三个什么都不干），
  // 留在名单里只会让人再一次把它们当表情用。叉腰那个效果被收进了 proud
  海梦: { dir: '海梦', json: 'female_01Arkit_6.model3.json', table: HAIMENG },
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

/**
 * 这个模型身上到底有哪些参数 —— 拿 cdi3 核对。
 *
 * **必须核**：`setParameterValueById` 遇到不认识的名字既不抛错也不警告，
 * 表情照样「应用成功」，脸就是不动。名字写错一个字母，你能查一下午。
 */
function paramsOf(dir) {
  const d = path.join(ROOT, 'models', dir);
  const cdi = fs.readdirSync(d).find((f) => f.endsWith('.cdi3.json'));
  if (!cdi) return null;   // 没有 cdi3 就没法核，放行
  return new Set((readJson(path.join(d, cdi)).Parameters || []).map((p) => p.Id));
}

function build(name) {
  const m = MODELS[name];
  const dir = path.join(ROOT, 'models', m.dir);
  const modelJson = path.join(dir, m.json);
  const expDir = path.join(dir, 'expressions');
  const have = paramsOf(m.dir);

  const missing = [];
  for (const [state, params] of Object.entries(m.table)) {
    for (const id of Object.keys(params)) {
      if (have && !have.has(id)) missing.push(state + '.' + id);
    }
  }
  if (missing.length) {
    throw new Error(name + ' 身上没有这些参数（写错了就是脸一直不动，还不报错）：\n  ' +
                    missing.join('\n  '));
  }

  const absent = STATES.filter((s) => !m.table[s]);
  if (absent.length) {
    // faceMap 写 null 的模型，缺哪个状态哪个状态就悄悄不换脸
    console.log('  [!] ' + name + ' 缺这几个状态: ' + absent.join('、'));
  }

  fs.mkdirSync(expDir, { recursive: true });
  const entries = [];
  for (const [state, params] of Object.entries(m.table)) {
    const exp = {
      Type: 'Live2D Expression',
      FadeInTime: 0.45,  // 别切太快，硬切表情很出戏
      FadeOutTime: 0.45,
      Parameters: Object.entries(params).map(([Id, Value]) => ({ Id, Value, Blend: 'Add' })),
    };
    const file = 'expressions/' + state + '.exp3.json';
    fs.writeFileSync(path.join(dir, file), JSON.stringify(exp, null, 2), 'utf8');
    entries.push({ Name: state, File: file });
  }

  // 挂进 model3.json，加载器才认
  const model = readJson(modelJson);
  model.FileReferences = model.FileReferences || {};
  const old = m.keep ? (model.FileReferences.Expressions || []) : [];
  const mine = new Set(entries.map((e) => e.Name));
  model.FileReferences.Expressions = old.filter((e) => !mine.has(e.Name)).concat(entries);
  fs.writeFileSync(modelJson, JSON.stringify(model, null, 2) + '\n', 'utf8');

  console.log('  ' + name.padEnd(8) + ' ' + entries.length + ' 张脸' +
              (old.length ? '（模型自带的 ' + old.length + ' 个留着）' : '') +
              ' -> ' + m.json);
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = want.length ? want : Object.keys(MODELS);

for (const name of list) {
  if (!MODELS[name]) {
    console.error('不认识这个模型: ' + name + '（有的是: ' + Object.keys(MODELS).join('、') + '）');
    process.exit(1);
  }
  build(name);
}

console.log('');
console.log('写完了。**一定要看一眼**，Δ 0.0% 就是白写：');
for (const name of list) {
  console.log('  npx electron tools/expression-sheet.js --model=models/' +
              MODELS[name].dir + '/' + MODELS[name].json);
}
