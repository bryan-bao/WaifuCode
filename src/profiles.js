'use strict';

// 每个模型的适配信息。
//
// 不同模型的表情命名、有没有 Head 点击区、动作组叫什么，全都不一样。
// 这些差异集中收在这里，其余代码只跟「心情状态」这一层抽象打交道，
// 换模型不用去翻渲染逻辑。
//
// ---------------------------------------------------------------------------
// 新加一个模型时，这几件事别靠猜：
//
//   1. **表情是什么意思**，去解 exp3.json 看它改了哪些参数。官方那批模型一半
//      叫 exp_01~exp_05，名字一个字都不告诉你。EyeSmile=1 是笑眼、Cheek=1 是
//      脸红、MouthForm 负是嘴角向下 —— 参数不会骗人，32 像素的小脸会。
//   2. **headRatio / mouthRatio 用工具量**：
//        npx electron tools/probe-parts.js --face --model=models/xxx/xxx.model3.json
//      它拧一下嘴巴参数看哪片网格动了，那片就是嘴；转个头，跟着转的就是脑袋。
//      量出来的值跟手调过的 Hiyori（0.34 vs 量出 0.36）对得上，可以信。
//      唯一要留神的是**长发**：头发跟着头转，会把「头」的下边界一路拖到腰上
//      （Izumi 量出 0.85 就是这么来的），这种得自己往回收。
//   3. 工具还会报「人占画布纵向百分之几」。**超出 0%~100% 的模型别收** ——
//      stage.js 的构图、气泡、点击判定全是按画布算的，人画到画布外面去，
//      在窗口里就是偏的。ずんだもん（67%~157%）就是因为这条没要。
// ---------------------------------------------------------------------------

const PROFILES = {
  'models/Hiyori/Hiyori.model3.json': {
    name: 'Hiyori',
    // 表情是 tools/make-expressions.js 自己生成的，名字直接就是状态名，
    // 所以不需要转换表（null = 恒等映射）
    faceMap: null,
    // 官方只给了 Body 一个点击区，没有 Head。用几何补一个：
    // 外接框顶部这个比例算「头」，摸头才有着落。
    headRatio: 0.34,
    // 嘴巴大概在外接框纵向的哪个位置 —— 说话气泡要从这儿冒出来。
    // 外接框是连头发带身子一起框的，所以这个值比「脸的中点」要靠上不少。
    mouthRatio: 0.27,
    tapMotion: 'TapBody',
    idleMotion: 'Idle',

    /**
     * 发型。Hiyori 的衣服全塞在一个 `PartBody` 里，换不了；但**藏掉部件**是能做的，
     * 所以「把马尾放下来」这个造型不用任何新美术资源 ——
     * 藏掉两条侧马尾，后发本来就在，自然就垂下来了（红色发饰还留着，看着挺自然）。
     *
     * 只列这两个是查过的：`npm run probe-parts` 报 `ArtMesh61_Skinning` 和
     * `ArtMesh62_Skinning` 各挂 7 片网格、落在头脸 4%~27% 的左右两侧，正是那两条
     * サイドアップ。cdi3 里跟它们配对的 `Part` / `Part2`（回転用）**一片网格都没挂**，
     * 是纯分组的空壳，写进来也是白写。
     */
    hairStyles: {
      normal: { label: '双马尾（原样）', hide: [] },
      down: { label: '放下来', hide: ['ArtMesh61_Skinning', 'ArtMesh62_Skinning'] },
    },
  },

  'models/haru/haru_greeter_t03.model3.json': {
    name: 'Haru',
    // Haru 自带 8 个表情，名字是 f00~f07，得按参数含义对映射
    faceMap: {
      normal: 'f00', working: 'f00', excited: 'f01',
      frustrated: 'f02', sad: 'f03', lonely: 'f03',
      happy: 'f04', proud: 'f04', surprised: 'f05',
      shy: 'f06', tired: 'f07', sleepy: 'f07',
    },
    headRatio: null, // 有真的 HitArea Head，不需要几何兜底
    mouthRatio: 0.22,
    tapMotion: 'Tap',
    idleMotion: 'Idle',
  },

  'models/Mao/Mao.model3.json': {
    name: 'Mao',

    /**
     * exp_01~exp_08 官方没写含义，但**不用猜** —— 直接解 exp3.json 看它改哪些参数，
     * 比盯着 32 像素的小脸看可靠得多：
     *
     *   exp_01  EyeOpen ×1（Multiply，等于什么都没改）      → 中性
     *   exp_02  EyeLSmile / EyeRSmile = 1                    → 笑眼
     *   exp_03  一个参数都没有，空表情                        → 用不上
     *   exp_04  眼睛睁到 1.2 + 笑眼 + EyeEffect（眼里有光）  → 兴奋
     *   exp_05  眉角和眉形 -1，MouthDown = 1（嘴角向下）      → 低落
     *   exp_06  Cheek = 1（脸红）+ 垂眉                       → 害羞
     *   exp_07  睁大眼 + EyeBallForm -1（瞳孔变形）+ 嘴角下   → 吃惊
     *   exp_08  EyeForm = 1 + MouthAngry + MouthAngryLine     → 生气
     *
     * sleepy 故意映到中性脸：Mao 没有困倦表情，但精力低的时候 look.js 会把眼皮
     * 压下来（setDroop），那个连续的「睁不开眼」比任何一张离散的脸都像困。
     */
    faceMap: {
      normal: 'exp_01', working: 'exp_01', sleepy: 'exp_01',
      happy: 'exp_02',
      proud: 'exp_04', excited: 'exp_04',
      sad: 'exp_05', tired: 'exp_05',
      shy: 'exp_06',
      surprised: 'exp_07',
      frustrated: 'exp_08', lonely: 'exp_08',
    },

    headRatio: null, // 有真的 HitArea Head
    mouthRatio: 0.24,
    tapMotion: 'TapBody',
    idleMotion: 'Idle',

    /**
     * Mao 是这三个模型里**唯一真能换装**的 —— 她的帽子、外套、法杖是三组
     * 各自独立的部件，藏掉就是另一套造型（不是换个色，是真的脱掉）。
     * 这些 id 是 `npx electron tools/probe-parts.js` 按顶点几何量出来的：
     *
     *   PartHat    18 片网格，占画面 19.5%，落在**头顶 1%~19%** 处 → 就是那顶巫师帽
     *   PartRobe    9 片，34.4%，上身 26%~67%                      → 深蓝长袍
     *   PartHoodie 16 片，21.2%，上身 23%~55%                      → 里面那件白帽衫
     *   PartWandA/B 各 4 片                                         → 法杖的两种握姿
     *
     * 别去动 PartArmLA/LB、PartArmRA/RB —— 那是 pose3 的切换组（同一条胳膊的
     * 两个姿势），碰了会多出一条手臂。PartHoodie 也别藏，藏了里面就空了。
     */
    hairStyles: {
      witch: { label: '巫师（原样）', hide: [] },
      nohat: { label: '摘掉帽子', hide: ['PartHat'] },
      casual: { label: '居家（脱外套）', hide: ['PartHat', 'PartRobe'] },
      offduty: { label: '下班（连杖也收了）', hide: ['PartHat', 'PartRobe', 'PartWandA', 'PartWandB'] },
    },

  },
  // -------------------------------------------------------------------------
  // 下面这批是官方免费样例（live2d.com/en/learn/sample/），原来一个档案都没有，
  // 所以在设置里全叫「未知模型」，切过去也没表情。
  // -------------------------------------------------------------------------

  'models/Natori/Natori.model3.json': {
    name: '名执尽',

    /**
     * 官方给的名字表情已经够用，剩下 exp_01~05 补两个空缺：
     *   exp_01  EyeForm=3（眼睛弯到底）+ 嘴角上   → 咧嘴大笑，比 Smile 更外放
     *   exp_02  TeethOn=1（露牙）+ 眉毛微挑        → 得意
     *   exp_05  EyeOpen=-1（闭眼）+ BrowForm=1     → 闭着眼，正好当困
     * exp_03/exp_04 跟 Sad/Surprised 撞车，不用。
     */
    faceMap: {
      normal: 'Normal', working: 'Normal',
      happy: 'Smile', proud: 'exp_02', excited: 'exp_01',
      sad: 'Sad', lonely: 'Sad',
      shy: 'Blushing', surprised: 'Surprised', frustrated: 'Angry',
      tired: 'exp_05', sleepy: 'exp_05',
    },
    headRatio: null, // 有真的 HitArea Head
    mouthRatio: 0.17,
    tapMotion: 'TapBody',
    idleMotion: 'Idle',
  },

  'models/Ren/Ren.model3.json': {
    name: 'Ren Foster',

    /**
     * Ren 是 Cubism 5.3 做的，**旧的 Cubism Core 打不开它**（moc3 已经到第 6 版，
     * 5.1.0 的 Core 只认到第 5 版，报 csmReviveMocInPlace is failed 然后一片空白）。
     * vendor 里那份换成 6.0.1 之后才有它。
     *
     * 只有 5 张脸，解出来是：
     *   exp_01  全 0                              → 中性
     *   exp_02  EyeOpen=-1 + EyeSmile=1           → 笑眼
     *   exp_03  EyeOpen=-1，不笑                  → 闭着眼
     *   exp_04  眉角眉形 -1，嘴角 -1              → 沉下脸
     *   exp_05  眉角 +0.7、眉形 -1，嘴角 -1       → 八字眉，难过
     * 没有脸红也没有吃惊，shy 借笑眼、surprised 干脆不给 —— 与其硬套一张不像的，
     * 不如让脸留在原样（faceFor 拿到 null 就不切）。
     */
    faceMap: {
      normal: 'exp_01', working: 'exp_01',
      happy: 'exp_02', proud: 'exp_02', excited: 'exp_02', shy: 'exp_02',
      sad: 'exp_05', lonely: 'exp_05',
      frustrated: 'exp_04',
      tired: 'exp_03', sleepy: 'exp_03',
    },
    headRatio: null, // 有真的 HitArea Head
    mouthRatio: 0.15,
    tapMotion: 'TapBody',
    idleMotion: 'Idle',
  },

  'models/Mark/Mark.model3.json': {
    name: 'Mark 君',
    // 官方拿它当「最简单的 Live2D 长什么样」的教学模型：没有点击区，
    // 动作只有 Idle 一组。点他就再播一次待机，至少有个反应。
    // Q 版三头身，脑袋占了整整半个画布，所以这两个数字这么大。
    //
    // 表情是 tools/make-expressions.js 生成的（他自带的一个都没有）——
    // 名字就是状态名，所以这儿写 null（恒等映射）。他脸上只有眼睛、眼球、
    // 眉毛、张嘴四样，所以「害羞」「闹脾气」这种只靠眼球方向的会比较轻
    faceMap: null,
    headRatio: 0.50,
    mouthRatio: 0.47,
    tapMotion: 'Idle',
    idleMotion: 'Idle',
  },

  'models/Rice/Rice.model3.json': {
    name: 'Rice Glassfield',

    /**
     * 没有表情文件。嘴那几片网格不吃 MouthOpen 参数（这模型的嘴是画在贴图上
     * 靠切换做的），--face 量不出来，这两个数是照截图量的。
     *
     * ⚠️ 这个模型的画布是 **4500x3000 的横版，而且人只站在右边那一块**。
     * 桌宠窗口是竖的，按画布等比缩进去，她会又小又偏右，气泡还会飘到她左边的
     * 空气里（气泡横向是照画布中线走的）。不是坏了，是这张图本来就这么构图。
     * 真要用她，得让 stage.js 按「人实际占的那块」而不是按画布来排版。
     *
     * 表情是生成的，但**她脸上只有「眼睛开合」和「眼球方向」**，别的一概没有
     * （没嘴、没眉毛、没脸红）。所以十二张脸全靠眼睛，几张之间差别注定比别人小 ——
     * 那是这个模型的天花板，不是没写好。
     */
    faceMap: null,
    headRatio: 0.35,
    mouthRatio: 0.29,
    tapMotion: 'TapBody',
    idleMotion: 'Idle',
  },

  'models/Wanko/Wanko.model3.json': {
    name: '汪子',
    // 一只趴在碗里的狗。嘴量不出来（贴图切换做的），照截图取的值。
    // 量出来的 headRatio 是 0.71 —— 那是**整只狗**跟着头一起转造成的，
    // 脑袋其实只到 0.60，再往下就是碗了。
    //
    // 表情是生成的。狗没有眉毛，但作者给了两个现成的好东西：
    // PARAM_TERE（照れ＝脸红）拿来当害羞，PARAM_FACE_01（どや キリッ）当得意。
    // 其余靠耳朵 —— 往后压 = 不爽、竖起来 = 来劲，比人脸还好读
    faceMap: null,
    headRatio: 0.60,
    mouthRatio: 0.53,
    tapMotion: 'TapBody',
    idleMotion: 'Idle',
  },

  'models/Chitose/chitose.model3.json': {
    name: '千岁',
    // 表情自带名字，一眼就能对上。f01 是「冒汗 + 眉毛上扬 + 勉强笑」，
    // 也就是心虚陪笑那张，拿来当「累」比当「难过」贴切。
    faceMap: {
      normal: 'Normal', working: 'Normal', sleepy: 'Normal',
      happy: 'Smile', proud: 'Smile',
      excited: 'Surprised', surprised: 'Surprised',
      sad: 'Sad', lonely: 'Sad',
      shy: 'Blushing', frustrated: 'Angry',
      tired: 'f01',
    },
    headRatio: 0.28,
    mouthRatio: 0.24,
    tapMotion: 'Tap',
    idleMotion: 'Idle',
  },

  'models/Izumi/izumi_illust.model3.json': {
    name: '泉',
    faceMap: {
      normal: 'Normal', working: 'Normal', sleepy: 'Normal',
      happy: 'Smile', proud: 'Smile',
      excited: 'Surprised', surprised: 'Surprised',
      sad: 'Sad', lonely: 'Sad',
      shy: 'Blushing', frustrated: 'Angry',
      tired: 'f01',
    },
    // 量出来是 0.85，但那是**长发跟着头一起转**造成的 —— 头发垂到腰，
    // 一路把「头」的下边界拖了下去。嘴在 0.40，下巴撑死到 0.45，按这个来。
    headRatio: 0.45,
    mouthRatio: 0.40,
    tapMotion: 'Tap',
    idleMotion: 'Idle',
  },

  'models/Tsumiki/tsumiki.model3.json': {
    name: '春伞积木',

    /**
     * 名字表情之外还有 f01~f05，解出来补了几个空：
     *   f01  笑眼闭 + 嘴角上         → 开怀笑
     *   f02  张嘴 + 眉毛困扰         → 「欸？」，当兴奋
     *   f04  闭眼 + 眉上扬 + 嘴角上  → 满足地眯着，当困
     *   f05  半闭眼 + 眼球左下       → 心虚发怵，当累
     * f03 是斜眼不爽，跟 Angry 重了，没用。
     */
    faceMap: {
      normal: 'Normal', working: 'Normal',
      happy: 'f01', proud: 'f04', excited: 'f02',
      sad: 'Sad', lonely: 'f05',
      shy: 'Blushing', surprised: 'Surprised', frustrated: 'Angry',
      tired: 'f05', sleepy: 'f04',
    },
    headRatio: 0.25,
    mouthRatio: 0.21,
    tapMotion: 'Tap',
    idleMotion: 'Idle',
  },

  /**
   * 「海梦」—— 你自己丢进来的，一个角色三种配色。
   *
   * 三种配色**不是三个角色**：moc3、表情、动作、physics 全都一个字节不差，只有贴图不同。
   * 所以只留这一份档案，另外两身（哥特黑、换色测试）躺在 `models/海梦/skins/` 底下，
   * 右键「换套贴图」里选 —— 不然角色列表里会冒出三个同名同脸的人，
   * 而且每份都把 16 MB 的 moc3 和动作重复存一遍。
   *

   * **她自带的七个表情跟脸没关系，全废了。** 那七个叫 expression1~7，
   * 解开看：expression1 是空的，2/3/4 改 `Param40`/`Param43`，5/6/7 改
   * `Action02/03/04`。拿联络表逐张量（tools/expression-sheet.js，
   * 每张跟「不加表情」比一个 Δ）：**七张全是 0.0%~0.2%，脸上什么都没发生**。
   * Param40/Param43 其实是「叉腰」（hands on hips），是身体动作不是表情。
   *
   * 这坑踩过一次：光看名字把 expression1 当中性脸、expression2 当害羞配进 faceMap，
   * 结果她从头到尾一张脸，日志里一个字都没有 —— **切表情失败是静默的**。
   *
   * 现在这十二张是 tools/make-expressions.js 用她真正的脸部参数生成的
   * （ARKit 那套：EyeL_Squint、ParamJawOpen、MouthFrown、MouthCheekPuff…），
   * 名字就是状态名，所以 faceMap 写 null。得意那张顺手把叉腰也拉上了。
   */  'models/海梦/female_01Arkit_6.model3.json': {
    name: '海梦',
    faceMap: null,
    headRatio: 0.27,  // 没有 HitArea，量出来的：人占画布 9%~98%，头到 27%
    mouthRatio: 0.20,
    // 这个模型没有 Tap 组。点她就播 hello（打招呼），比硬塞一个不存在的组名强
    tapMotion: 'hello',
    idleMotion: 'idle',
  },

  // とろろ 和 ひじき 官方是两只猫，但**文件上是同一只换了花色** —— moc3、动作、
  // physics 全都一个字节不差，只有那张 2048 的贴图不同。所以这儿只留一条档案，
  // ひじき（黑的那只）躺在 `models/Tororo/skins/羊栖菜黑猫/`，右键换套贴图就变。
  //
  // 猫的头和身子是连着动的，--face 量出来的 0.65 把大半个身子算进了「头」，
  // 收到 0.42（下巴的位置）。摸猫本来摸哪儿都行，这条不必太较真。
  //
  // 表情是生成的。猫没有眉毛，靠的是耳朵（往后压 = 炸毛）、PARAM_EYE_FORM
  // （眼睛眯成缝 / 瞪圆）、舌头，生气那张还拉了 PARAM_TAIL_ANGRY ——
  // 作者专门做的炸毛尾巴。
  'models/Tororo/tororo.model3.json': {
    name: '猫',
    faceMap: null,
    headRatio: 0.42,
    mouthRatio: 0.34,
    tapMotion: 'Tap',
    idleMotion: 'Idle',
  },
};

const FALLBACK = {
  faceMap: {},
  headRatio: 0.34,
  mouthRatio: 0.26,
  tapMotion: 'Tap',
  idleMotion: 'Idle',
};

function profileFor(modelPath) {
  const key = String(modelPath).replace(/\\/g, '/');
  if (PROFILES[key]) return PROFILES[key];
  // 没配过档案的，**名字用它所在的目录名**，别一律叫「未知模型」——
  // 自己往 models/ 里丢了几个模型，设置里就会看到一排一模一样的「未知模型」，
  // 根本分不出谁是谁（FALLBACK.name 是个非空字符串，调用方那句 `|| sub` 永远轮不上）
  const dir = key.split('/').slice(-2, -1)[0];
  return dir ? { ...FALLBACK, name: dir } : FALLBACK;
}

module.exports = { profileFor, PROFILES };
