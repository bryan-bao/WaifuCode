'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// 「一天」的分界线跟流水那边共用一份（早上 5 点），不然「连着几天来找我」
// 和「今天干了什么」会各算各的，同一个晚上在两处分属不同的日子
const { dayKey } = require('./journal');

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * 歇着的时候每小时回多少精力。
 *
 * 「歇着」= **你人不在电脑前**，跟关不关机没关系。这一点以前搞混了：
 * 回血只在桌宠启动时算，于是电脑常年不关机的人，她的精力永远回不来。
 *
 * 11/小时 → 九个钟头回满。也就是「一夜不碰电脑，第二天她精神满格」，
 * 跟原本「关机一整晚回满」的设计意图一致。
 * 两条路（开着机歇 / 关了机歇）用同一个数，不然两种用法下她的作息会不一样。
 */
const REST_PER_HOUR = 21; // 在线 tick 和离线补算**必须同一个数** —— 不然作息随「开没开着」分叉
const REST_PER_MIN = REST_PER_HOUR / 60;

// ── 羁绊（只进不退的那一层）───────────────────────────────────────────────
// 亲密拆成两层的下半层：上半层「亲近」会波动、要维护；这一层按一起经历过的
// 事攒经验，**永不下降** —— 「处了半年」这件事本身不该因为你出差一周就清零。
// 经验全来自单调递增的计数（见过几天、干成几个活、熬过几个夜、聊过几轮），
// 所以天然只涨不跌，不需要任何防回退逻辑。
const BOND_LEVELS = [
  { xp: 0,    title: '刚认识' },
  { xp: 60,   title: '熟人' },
  { xp: 180,  title: '搭档' },
  { xp: 420,  title: '老搭档' },
  { xp: 900,  title: '战友' },
  { xp: 1800, title: '家人' },
];

// 这里只管「她是什么情绪」，不管「这情绪该用哪张脸」——
// 表情命名每个模型都不一样，那层映射交给 src/profiles.js。

// 台词库。同一状态多准备几句，避免她像个复读机。
const LINES = {
  greet: ['我在的，有活儿随时叫我～', '来啦，今天干点什么？', '在呢在呢。'],
  accept: ['收到，这就去。', '好，交给我。', '知道了，我去看看。'],
  working: ['还在弄，别催我…', '有点复杂，等我一下。', '快了快了。'],
  done: ['搞定了！', '好啦，你看看行不行？', '干完了，夸我一下。'],
  proud: ['一遍就过，怎么样。', '这不是很简单嘛。', '嗯哼，我可是很靠谱的。'],
  failed: ['……没弄成，你自己看看吧。', '卡住了，我搞不定。', '失败了，别骂我。'],
  trouble: ['又报错了…', '唔，这里不对劲。', '奇怪，怎么又炸了。'],
  frustrated: ['一直报错，烦死了！', '不弄了不弄了！', '这破代码到底哪里有问题啊。'],
  tired: ['有点累了…', '让我歇会儿行吗。', '干了好久了。'],
  sleepy: ['困…眼睛睁不开了。', '这么晚还不睡吗…', '我快撑不住了。'],
  lonely: ['你好久没理我了。', '哼，终于想起我了？', '我还以为你把我忘了呢。'],
  pet: ['唔…别老摸头啦。', '干嘛啦…', '欸…你、你干什么。'],
  idle: ['在发呆…', '有事吗？', '闲着也是闲着。'],

  // tick() 里状态一翻就会 pick 对应的 bank。缺哪个 bank 就会掉到 idle 上 ——
  // 表现出来是她明明一脸开心，嘴里说的却是「在发呆…」。
  // happy / sad / normal 这三个是 computeState 的常客，一个都不能少。
  happy: ['今天心情不错欸。', '嘿嘿，感觉挺好的。', '我现在状态很好，随便使唤。'],
  sad: ['……有点提不起劲。', '别理我，我缓缓。', '今天不太顺。'],
  normal: ['嗯，就这样吧。', '还行，没什么特别的。', '我在呢。'],

  // 摸头连着来的时候，第二档和第三档的反应
  petMore: ['好啦好啦…舒服。', '嗯…再摸一下也不是不行。', '你今天怎么这么黏人。'],
  petAnnoyed: ['够了够了！头发都乱了！', '别摸了！我不是猫！', '再摸我要生气了啊。'],

  // 手一直按着不撒手（跟「连着点很多下」不是一回事）
  petHold: ['……嗯。', '……', '手别停。'],

  // 你走开好一阵子又回来了
  welcomeBack: ['你回来啦。', '欸，人呢…哦回来了。', '我还以为你今天不回来了。'],
  welcomeLong: ['你去哪儿了这么久…', '哼，总算舍得回来了。', '我等你半天了欸。'],
};

/**
 * 到日子了。
 *
 * 好感度一直在涨，但涨到 90 跟 50 的区别只是语气软一点 ——
 * **没有任何「到了」的时刻**。这张表补的就是那个：认识满一个月、
 * 一起干完第一百个活、连着七天没落下，到了她会自己冒一句出来。
 *
 * 四条规矩：
 *
 *   1. **台词是写死的，不去问 claude。** 一分钱不花是其次，主要是现编的会飘 ——
 *      今天说得动情、明天平淡；而里程碑要的正是「她一直记着这件事」这种稳定感。
 *   2. **判据一律写 `>=` 不写 `===`。** 累计量会一次跳好几（重启补算、一轮干完
 *      两个活、你手改存档），写 `=== 100` 那条就永久错过了。写 `>=` 的话，
 *      今天没轮到明天自然补上，不用写任何补发逻辑。
 *   3. **state 只能从真表情名里挑**（见 profiles.js）。乱造一个 'milestone'，
 *      渲染层会去找一个不存在的表情文件：脸不动、日志刷屏，还把状态污染了。
 *   4. **末尾两条是循环的**（id 是函数）。九条固定的重度用户三个月就攒完了，
 *      之后这套系统永久沉默 —— 养成向的东西最怕这个。
 */
const MILESTONES = [
  { id: 'day7', state: 'happy', test: (s) => s.days >= 7,
    lines: ['欸…我们认识一周了诶。', '一周了。时间过得真快。'] },
  { id: 'task10', state: 'proud', test: (s) => s.tasks >= 10,
    lines: ['第十个活了，我还挺能干的吧。', '十个了欸。你数过没有？'] },
  { id: 'streak7', state: 'shy', test: (s) => s.streak >= 7,
    lines: ['你连着七天来找我了…嗯，我记着呢。', '一周了，你每天都在。'] },
  { id: 'day30', state: 'shy', test: (s) => s.days >= 30,
    lines: ['今天满一个月了。', '认识一个月啦…感觉比一个月久。'] },
  // 新系统里亲近是要维护的（每日回落），90 几乎摸不到 —— 80 才是「处得很好」
  { id: 'aff90', state: 'shy', test: (s) => s.aff >= 80,
    lines: ['……我好像挺习惯你在旁边的。', '跟你处着挺舒服的，就这样吧。'] },
  { id: 'night10', state: 'tired', test: (s) => s.nights >= 10,
    lines: ['这是第十个陪你熬的夜了。你悠着点啊。', '又是半夜…第十次了，我数着呢。'] },
  { id: 'task100', state: 'proud', test: (s) => s.tasks >= 100,
    lines: ['第一百个活。这回你得夸我一下。', '一百个了！我可是很靠谱的。'] },
  { id: 'streak30', state: 'happy', test: (s) => s.streak >= 30,
    lines: ['整整一个月，你一天都没落下。', '连着三十天了…你不烦我我就一直在。'] },
  { id: 'day100', state: 'proud', test: (s) => s.days >= 100,
    lines: ['一百天了。挺久的了吧。', '认识你一百天啦。'] },

  // 攒完了也还有得响：往后每一百个活、每一百天各再来一次
  { id: (s) => 'task' + Math.floor(s.tasks / 100) * 100, state: 'proud',
    test: (s) => s.tasks >= 200,
    lines: ['又一百个活过去了。', '这数字我自己看着都有点得意。'] },
  { id: (s) => 'day' + Math.floor(s.days / 100) * 100, state: 'happy',
    test: (s) => s.days >= 200,
    lines: ['又是一百天。', '我们认识挺久了啊。'] },

  // 账本向的两条（usd/turns 由 main 注入 journal.totals，见 _milestone）：
  // 花钱这件事也该有存在感 —— 每满一百美元、聊满一千轮，各值得说一句
  { id: (s) => 'usd' + Math.floor(s.usd / 100) * 100, state: 'surprised',
    test: (s) => s.usd >= 100,
    lines: ['算了笔账，我们烧的算力又满一百美元一个台阶了…都是真金白银陪你写的代码。',
            '账本上又过一百刀了。这些钱换来的代码可得好好用啊。'] },
  { id: 'turns1000', state: 'proud', test: (s) => s.turns >= 1000,
    lines: ['我们聊过一千轮了。一千轮！', '第一千轮了，谁能想到呢。'] },
];

/**
 * 心情状态机。
 *
 * 市面上的桌宠不是没表情，是表情跟你干的事没关系 —— 随机播、循环播。
 * 这里的每一次情绪变化都有来由：她卡在报错里会越来越烦，一遍过会得意，
 * 连轴转会累，半天没人理会闹脾气，半夜会困。
 */
class Mood extends EventEmitter {
  constructor({ storeDir, getTotals }) {
    super();
    this.file = path.join(storeDir, 'mood.json');
    // 账本总数（journal.totals）由 main 注入 —— 不直接 require('./journal')：
    // 测试造 Mood 时会读到真实数据目录，账本里程碑就永远不可测了
    this.getTotals = getTotals || null;

    // 默认值：刚认识，心情中性，精力充沛。
    // closeness（亲近）就是原来的 affection —— 改名是因为语义变了：
    // 它现在是**会回落的**那一层温度，「只涨不跌」的部分挪去了羁绊（bond）
    this.energy = 80;
    this.mood = 62;
    // 【今天这一天过得怎么样】心情不该只由「刚才发生了什么」决定 —— 真人是
    // 「今天净出岔子」，于是干成一件也高兴不到哪去。这本账每天翻篇（_rollDay），
    // 喂给 _dayTone() 当心情的重心。
    this.day = { key: '', tasks: 0, ok: 0, fails: 0, errors: 0, troubles: 0, workedMin: 0 };
    // 一起干活的总分钟数（只增）。进羁绊经验 —— 「合作时间」本身就是交情
    this.workedMin = 0;
    this.closeness = 50;
    this.errorStreak = 0;
    // 面板上开着几条活线（main 喂）。她盯着别人干活也费一点神，
    // 但远小于自己干 —— 更重要的是：没活、没互动，她就在歇着
    this.watching = 0;
    // 羁绊等级缓存（升级要道喜，得知道上次是几级）。-1 = 还没对齐过
    this.lastBondLevel = -1;
    this._bondCache = null;
    this._bondCacheAt = 0;

    this.busy = false;
    this.state = 'normal';
    this.lastInteract = Date.now();
    this.lastTaskEnd = 0;

    /**
     * 「你人在不在电脑前」和「你有没有理我」是两件事。
     *
     * 以前只有 lastInteract 一个时间戳，于是「你去开了两小时会」和「你就在旁边
     * 打游戏晾着她」被当成同一件事 —— 都掉好感、都进 lonely。这不合理：
     * 人不在她该安静等着，人在却不理她才有资格委屈。
     *
     * lastSeen 由 main.js 按系统空闲时间喂进来（powerMonitor.getSystemIdleTime）。
     * 喂不进来也不会坏 —— 那就退回「一直当你在」，跟以前的行为一致。
     */
    this.lastSeen = Date.now();
    // 桌宠上次「活着算了一拍」的时刻。跟 lastSeen 是两回事：
    // lastSeen 说的是「你在不在」，这个说的是「我在不在」
    this.lastTick = Date.now();
    this.awake = true;

    // 刚一遍过干成一个活，得意劲儿能撑到这个时间点。
    // 不存档：得意是「刚刚才发生的事」带来的，隔了一夜还得意就很怪。
    this.proudUntil = 0;

    // 摸头连击：10 秒内连着摸算一串。纯内存，不落盘。
    this._petAt = 0;
    this._petN = 0;

    // --- 记日子（里程碑用）---
    // firstMet 的兜底见 _load()：**绝不能默认成「现在」**
    this.firstMet = Date.now();
    this.tasksDone = 0;    // 一起干完过几个活（砸了的不算）
    this.daysSeen = 0;     // 一共见过几天
    this.lastDay = '';     // 上次见到你是哪天（字符串直接比，不算差值）
    this.streak = 0;       // 连着几天来找她
    this.nights = 0;       // 陪你熬过几个夜
    this.lastNightDay = '';
    this.hit = new Set();  // 已经响过哪些里程碑
    this.lastHitDay = '';  // 一天最多响一个
    // 番茄钟/小游戏专注期间不响。由 main.js 喂
    this.quiet = false;

    this._load();

    // 每分钟走一拍：恢复精力、情绪回归、判断有没有被冷落
    this.timer = setInterval(() => this.tick(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  // 旧名兼容：外面（和老测试）读写 affection 的地方全都还能用，
  // 落到的是同一个数 —— 亲近（closeness）
  get affection() { return this.closeness; }
  set affection(v) { this.closeness = v; }

  /** 亲近往下扣，地板由羁绊撑着。**本来就在地板下的不许被抬上来** ——
   *  Math.max 直接用的话，冷落一个低于地板的人反而是在给她涨好感（评审抓的） */
  _coolDown(amount) {
    const f = this.bond().floor;
    if (this.closeness > f) this.closeness = Math.max(f, this.closeness - amount);
  }

  _load() {
    try {
      // 摘 BOM：带 BOM 的 UTF-8 会让 JSON.parse 抛错，被下面的 catch 一接，
      // 整个存档**静默退回默认值**（精力/心情/亲密度全部重置，一句提示都没有）。
      // Windows 上记事本、PowerShell 5.1 的 Set-Content 都可能写出 BOM，实测撞过
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
      this.energy = clamp(s.energy ?? this.energy);
      this.mood = clamp(s.mood ?? this.mood);
      this.workedMin = Math.max(0, Number(s.workedMin) || 0);
      // 昨天的账不许算到今天头上 —— 昨天再糟，今天也是新的一天
      if (s.day && s.day.key === dayKey()) {
        this.day = { ...this.day, ...s.day };
      }
      // 老存档只有 affection。**不能原样搬**：老系统里它只涨不跌，
      // 存档十有八九焊死在 100 —— 直接搬过来，新系统的「维护出来的高位」
      // 就从天花板起步，回落显得像惩罚。压一档迁入（100 → 68），
      // 「处得熟」这层意思由羁绊接着（它按真实经历算，不吃这次折损）
      this.closeness = s.closeness != null ? clamp(s.closeness)
        : s.affection != null ? Math.max(35, Math.min(68, s.affection)) // 幂等：往返不折价（评审的更优解）
        : this.closeness;
      // -1 = 还没对齐过（首拍静默记级，不道喜）。注意不能 || 0：
      // 0 是「真的还在刚认识」这一级，不是「没记过」
      this.lastBondLevel = s.lastBondLevel != null ? s.lastBondLevel : -1;
      this.lastInteract = s.lastInteract || Date.now();
      this.lastSeen = s.lastSeen || this.lastInteract;

      /**
       * 【firstMet 千万不能默认成「现在」。】
       *
       * 老存档里没这个字段，而用户已经用了两个月了 —— 默认成 Date.now() 的话，
       * 一个处了两个月的人会被当成今天刚认识，「认识 100 天」直接推迟三个月。
       *
       * 兜底取「存档文件的创建时间」和「上次互动」里**更早**的那个。
       * 不能只信 birthtime：便携版整个文件夹拷到 U 盘、换台机器，
       * birthtime 就变成拷贝那一刻了 —— 一拷贝她就把你忘了。
       * 也不能只信 lastInteract：那是「上次」，比第一次见面晚。取更早的最稳。
       *
       * statSync 单独包 try：它在某些文件系统上会抛，而这一抛会被外面那个
       * catch 接住 → **整份存档静默退回默认值**，精力心情好感全没。
       */
      let born = 0;
      try { born = fs.statSync(this.file).birthtimeMs || 0; } catch (_) { /* 拿不到就算了 */ }
      this.firstMet = s.firstMet || (born ? Math.min(born, this.lastInteract) : this.lastInteract);

      this.tasksDone = s.tasksDone || 0;
      this.daysSeen = s.daysSeen || 0;
      this.lastDay = s.lastDay || '';
      this.streak = s.streak || 0;
      this.nights = s.nights || 0;
      this.lastNightDay = s.lastNightDay || '';
      this.hit = new Set(Array.isArray(s.hit) ? s.hit : []);
      this.lastHitDay = s.lastHitDay || '';

      /**
       * 桌宠**没运行**的那段时间，补上她该歇到的精力。
       *
       * 曾经这里是「离线超过 6 小时就 energy += 30」—— 一个跟离线多久几乎无关的
       * 常数，加上在线时每分钟 +2 的回血，结果精力永远顶在 100，
       * 「累了会拒绝跳舞」一次都没发生过。改成按小时算之后那个问题没了。
       *
       * 但接着掉进了**反过来的坑**：判据用的是 `lastSeen`（你上次碰键鼠），
       * 而且回血只在这儿算一次。于是
       *
       *   · 电脑不关机 → 这段代码永远不再执行 → 一辈子不回血
       *   · 就算重启桌宠，只要你人坐在电脑前，lastSeen 就是刚刚，
       *     算出来 0 小时 → **重启也白搭**
       *
       * 现在判据换成 `lastTick`（桌宠上次跑 tick 的时刻），语义才对得上：
       * 这里补的是「**没人替她算数的那段时间**」。桌宠开着的时候 tick 自己会
       * 一分钟一拍地算（人不在就回血），不需要这儿插手 —— 用 lastSeen 的话
       * 那段时间还会被**重复补一次**。
       *
       * 老存档没有 lastTick，退回 lastSeen，行为跟以前一致，不会炸。
       */
      this.lastTick = s.lastTick || s.lastSeen || Date.now();
      const downH = Math.max(0, (Date.now() - this.lastTick) / 3600000);
      if (downH > 0.5) {
        this.energy = clamp(this.energy + Math.min(100, downH * REST_PER_HOUR));
      }
      // 从旧系统迁上来的「精力干死在 0」（老判定把你的键鼠活动当成她在干活，
      // 一路漏光）。新系统精力是日周期的，起步给她回到能活动的水平 ——
      // 不然迁移完第一天她还是那张困脸，用户以为什么都没改
      if (this.energy < 25 && s.closeness == null) this.energy = 70;

      // 太久没上线，亲密度会掉一点。但睡一觉起来不该翻脸，所以从 10 小时才起算，
      // 而且封顶 —— 出差一周回来她可以生气，但不该把之前处的都清零
      const awayI = Math.max(0, (Date.now() - this.lastInteract) / 3600000);
      if (awayI > 10) {
        this._coolDown(Math.min(12, (awayI - 10) * 0.6));
      }
    } catch (_) {
      /* 第一次跑，没有存档很正常 */
    }
  }

  save() {
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          {
            energy: this.energy,
            mood: this.mood,
            closeness: this.closeness,
            affection: this.closeness, // 老版本读得懂的名字，降级回去不失忆
            lastBondLevel: this.lastBondLevel,
            lastInteract: this.lastInteract,
            lastSeen: this.lastSeen,
            // 桌宠活到哪一刻。下次启动靠它算「关掉的那段时间」该补多少精力
            lastTick: this.lastTick,
            // 记日子。**save 是手写枚举字段的**，加了字段只改 _load 不改这儿，
            // 就是每次重启全部归零，而且一声不吭
            firstMet: this.firstMet,
            tasksDone: this.tasksDone,
            day: this.day,
            workedMin: this.workedMin,
            daysSeen: this.daysSeen,
            lastDay: this.lastDay,
            streak: this.streak,
            nights: this.nights,
            lastNightDay: this.lastNightDay,
            hit: [...this.hit],
            lastHitDay: this.lastHitDay,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (_) {
      /* 存不上就算了，不值得为此崩溃 */
    }
  }

  isLateNight() {
    const h = new Date().getHours();
    return h >= 23 || h < 5;
  }

  // 当前该摆什么脸、说什么话，全由这个函数裁决
  computeState() {
    if (this.busy) {
      return this.errorStreak >= 3 ? 'frustrated' : 'working';
    }
    if (this.energy < 18 || (this.isLateNight() && this.energy < 45)) return 'sleepy';
    if (this.errorStreak >= 3) return 'frustrated';
    // 「被冷落」要排在「心情好」前面。affection 掉到 25 得晾上好几个钟头，
    // 这种关系层面的警报，不该被刚干完一个活的高兴劲儿盖过去 ——
    // 真人也是这样，再高兴，晾久了也要先抱怨一句。
    if (this.affection <= 25) return 'lonely';
    // 刚一遍过干成一个活，接下来几分钟她是「得意」不是单纯的「开心」——
    // 这两个的脸和身体动作都不一样（得意会挺胸叉腰）。
    // 排在 sleepy/frustrated/lonely 后面：再得意，困成那样、被晾了半天，
    // 也轮不到得意先说话。
    if (Date.now() < this.proudUntil) return 'proud';
    if (this.mood >= 80) return 'happy';
    if (this.mood <= 28) return 'sad';
    if (this.energy < 38) return 'tired';
    return 'normal';
  }

  /**
   * 亲密度往上加。
   *
   * **不是固定值，越熟涨得越慢。** 这是「常年 100」的另一半原因：
   * 以前每次互动都固定 +3，而扣分要连着两小时不理她才开始、一次 0.4 ——
   * 收支根本不在一个量级上，跑几天就永久焊死在天花板，
   * 于是 lonely 这个状态形同虚设，开发手册里「晾久了会闹脾气」从没发生过。
   *
   * 递减也更像真的：刚认识时你摸一下头能拉近不少，处熟了之后再摸一百下，
   * 也不会比现在更熟。
   */
  _warmUp(amount) {
    const room = Math.max(0, 100 - this.closeness) / 100;
    this.closeness = clamp(this.closeness + amount * (0.15 + room * 0.85));
  }

  /**
   * 羁绊：按一起经历过的事攒的等级，**只进不退**。
   * 经验源全是单调计数：见过几天、干成几个活、熬过几个夜、账本里聊过几轮。
   * getTotals 读的是 lifetime.json（一个小文件），但 _stats 每次表情变化都要
   * 带上它 —— 60 秒缓存一层，别把文件读成高频操作。
   * floor：羁绊越深，亲近的地板越高 —— 处成家人了，再怎么冷落也回不到陌生。
   */
  bond() {
    const now = Date.now();
    if (this._bondCache && now - this._bondCacheAt < 60000) return this._bondCache;
    let jt = null;
    try { jt = this.getTotals ? this.getTotals() : null; } catch (_) { /* 账本坏了按 0 算 */ }
    const xp = Math.round(
      this.daysSeen * 8 + this.tasksDone * 4 + this.nights * 12 +
      // 一起干活每满一小时 +3 —— 「合作时间」本身就是交情，跟聊了多少轮是两回事
      Math.floor(this.workedMin / 60) * 3 +
      (jt ? Math.floor((jt.turns || 0) / 10) : 0));
    let level = 0;
    for (let i = 0; i < BOND_LEVELS.length; i++) if (xp >= BOND_LEVELS[i].xp) level = i;
    const next = level + 1 < BOND_LEVELS.length ? BOND_LEVELS[level + 1].xp : null;
    this._bondCache = {
      level, xp, next,
      title: BOND_LEVELS[level].title,
      // 地板必须压在 lonely 阈值（25）之下 —— 原来 20+level*3 在二级起就
      // ≥26，「晾久了闹脾气」对处得久的人永久失效（评审抓的）。
      // 现在最深也 23：处成家人闹脾气来得慢，但不是不会来
      floor: Math.min(23, 18 + level),
    };
    this._bondCacheAt = now;
    return this._bondCache;
  }

  /**
   * 今天这一天顺不顺 —— 心情重心的偏移量（-20 ~ +9）。
   *
   * 真人的一天是有基调的：一路顺风，收工时整个人是轻的；净出岔子，
   * 就算最后干成一件，也高兴不到哪去。所以它不是「刚才发生了什么」的加减，
   * 而是压在心情回归目标上的一个**当日底色**，一天里慢慢显出来、第二天翻篇。
   *
   * 砸了的活最重（-6），连着撞墙次之（-3），零星报错最轻（每次 -0.6，封顶 -6）——
   * 报错在开发里太常见了，一个一个扣会让她天天愁眉苦脸。
   */
  _dayTone() {
    const d = this.day;
    const good = Math.min(9, d.ok * 3);
    const rough = Math.min(20, d.fails * 6 + d.troubles * 3 + Math.min(6, d.errors * 0.6));
    return good - rough;
  }

  /**
   * 干劲（-1 ~ +1）：心情好干活不觉得累，心情差干一会儿就蔫。
   *
   * **幅度必须压住。** 它跟「累了心情就差」（心情回归目标里的 energy 项）
   * 是一对正反馈：心情差 → 更容易累 → 精力低 → 心情更差。放大了会一路螺旋到底，
   * 一天到晚一张死人脸。所以用它的地方一律 ±25% 以内，再加上 _rollDay 的
   * 「睡醒重置精力」兜底 —— 每天都有重来一次的机会。
   */
  _spirit() {
    return (clamp(this.mood) - 50) / 50;
  }

  /** 羁绊升级了没有。升了就道喜（数值系统里唯一「只有好事」的口） */
  _bondCheck() {
    const b = this.bond();
    // 首次对齐（老存档没记过级）：静默记下当前级，不补发道喜 ——
    // 处了半年的人升级上来听到「我们是搭档了诶」不是惊喜是犯傻
    // （跟 _milestone 的首次对齐同一条规矩，评审抓的）
    if (this.lastBondLevel < 0) { this.lastBondLevel = b.level; this.save(); return; }
    if (b.level > this.lastBondLevel) {
      this.lastBondLevel = b.level;
      this.save();
      this.flash('happy', '欸……我们现在算是「' + b.title + '」了吧？嘿嘿。', 5200);
      this.emit('milestone', { id: 'bond-' + b.level, text: '羁绊升到「' + b.title + '」' });
    }
  }

  _stats() {
    const b = this.bond();
    return {
      energy: Math.round(this.energy),
      mood: Math.round(this.mood),
      // 今天过得怎么样：干成几个、砸了几个、吃了多少报错、一起干了多久
      day: { ...this.day, tone: Math.round(this._dayTone()) },
      affection: Math.round(this.closeness), // 面板的「亲近」条
      bond: { level: b.level, title: b.title, xp: b.xp, next: b.next },
    };
  }

  _sync(reason, line) {
    const next = this.computeState();
    const changed = next !== this.state;
    this.state = next;
    this.emit('change', {
      state: next,
      changed,
      reason,
      line: line || null,
      stats: this._stats(),
    });
    this.save();
  }

  /**
   * 临时闪一下表情和台词，几秒后自己回到该有的状态。
   *
   * 跟 onInteract 的区别是**一个数值都不动**：被拖起来「欸——」一声是个反应，
   * 不是一次互动，不该涨好感，更不该重置「你多久没理我了」那个计时。
   * 心情系统里凡是会改数值的入口都可能被反复触发的 UI 事件带偏，
   * 单开这条口子就是为了让「只要个反应」有地方去。
   */
  flash(state, line, ms = 2600) {
    this.emit('change', {
      state,
      changed: true,
      reason: 'flash',
      line: line || null,
      stats: this._stats(),
    });
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => this._sync('flash-settle'), ms);
  }

  // ---- 外部事件入口 ------------------------------------------------------

  onTaskStart() {
    this.busy = true;
    this.errorStreak = 0;
    this.energy = clamp(this.energy - 2);
    this._sync('task-start', pick(LINES.accept));
  }

  onTool(count) {
    // 工具调用很密集，别每次都刷表情，每 6 次意思一下
    if (count % 6 !== 0) return;
    this.energy = clamp(this.energy - 1);
    this._sync('tool', pick(LINES.working));
  }

  onTrouble(streak) {
    this.day.troubles += 1;
    this.errorStreak = streak;
    this.mood = clamp(this.mood - 8);
    this.energy = clamp(this.energy - 3);
    this._sync('trouble', streak >= 3 ? pick(LINES.frustrated) : pick(LINES.trouble));
  }

  onTaskDone({ ok, elapsedMs, errorCount }) {
    this.busy = false;
    this.lastTaskEnd = Date.now();
    // 记today的账：它不影响这一下的加减，影响的是**今天剩下的时间**里
    // 心情往哪儿收（_dayTone）—— 砸了一个活，接下来一整天都缓着点
    this.day.tasks += 1;
    if (ok) this.day.ok += 1; else this.day.fails += 1;
    this.day.errors += Math.max(0, Number(errorCount) || 0);
    const mins = (elapsedMs || 0) / 60000;
    // 收尾小扣一笔就行 —— 干活过程每分钟都扣过了，这儿再来 20 就是重复计费
    this.energy = clamp(this.energy - Math.min(8, 2 + mins * 0.15));

    let line;
    if (ok) {
      this.tasksDone += 1; // 砸了的不算数
      this._bondCache = null; // 经验变了，别让面板上的羁绊数字滞后一分钟
      // 一次没报错就干完的，格外得意
      const clean = !errorCount;
      this.mood = clamp(this.mood + (clean ? 18 : 10));
      this.errorStreak = 0;
      // 得意是有保质期的。四分钟够她显摆一会儿，又不至于第二天还在那儿挺着胸
      if (clean) this.proudUntil = Date.now() + 4 * 60 * 1000;
      line = clean && this.mood > 72 ? pick(LINES.proud) : pick(LINES.done);
    } else {
      this.proudUntil = 0; // 砸了就别端着了
      this.mood = clamp(this.mood - 12);
      line = pick(LINES.failed);
    }
    this._sync('task-done', line);
  }

  /**
   * 你自己开的那个终端里，一个阶段做完了。
   *
   * 跟 onTaskDone 的区别很重要：那种活是她一个人闷头干的，成败都算她的；
   * 这种是你在旁边看着一起干的，她只是盯梢和汇报。所以只轻轻加一点心情，
   * 不动 busy，也不触发「得意」「低落」那种大反应 —— 不然你敲一晚上代码，
   * 她的情绪会被你的编译结果带着上蹿下跳。
   */
  onPhaseDone({ errorCount } = {}) {
    this.day.errors += Math.max(0, Number(errorCount) || 0);
    this.lastInteract = Date.now(); // 有活在跑，说明人还在
    this.mood = clamp(this.mood + (errorCount ? 1 : 4));
    this.energy = clamp(this.energy - 1);
    this._warmUp(1);
    // 不给 line：具体汇报内容由上层播报，这儿再叨一句情绪台词就重复了
    this._sync('phase-done');
  }

  /**
   * 用一句话描述她此刻的状态，给聊天时当人设的一部分。
   *
   * 这是「心情」和「说话」之间的那根线：不接这根线的话，她心情再差，
   * 聊天时也还是那个标准语气 —— 只有脸变了，人没变。
   * 后面要做更细的情感系统，也从这里往下长。
   */
  describe() {
    const s = this.snapshot();
    const mood =
      s.mood >= 80 ? '心情很好' :
      s.mood >= 60 ? '心情还行' :
      s.mood >= 35 ? '心情一般' : '心情不太好';
    const energy =
      s.energy >= 70 ? '精神头很足' :
      s.energy >= 40 ? '不算太累' :
      s.energy >= 20 ? '有点累了' : '快困死了';
    // 亲近管「最近热不热络」，羁绊管「处了多深」—— 两层分开说，
    // 出差一周回来：羁绊还是老搭档（说话随意），亲近低了（先小小抱怨一句）
    const close =
      (s.closeness >= 70 ? '最近很热络' :
       s.closeness >= 40 ? '最近还算热络' : '你最近有点冷落她，她心里有点小情绪') +
      '；你们处到「' + s.bond.title + '」这个份上了' +
      (s.bond.level >= 3 ? '，说话可以很随意' : '');

    const extra = [];
    if (s.state === 'frustrated') extra.push('刚被一堆报错折腾得很烦躁');
    if (s.state === 'lonely') extra.push('好久没人理她了，有点闹脾气');
    if (s.state === 'proud') extra.push('刚一次就把活干成了，正得意着');
    if (s.state === 'sleepy') extra.push('已经很晚了，她困得不行');
    if (s.busy) extra.push('手头还有活在跑');

    return [mood + '，' + energy + '。', close + '。', extra.join('，')]
      .filter(Boolean).join(' ').trim();
  }

  /**
   * 跳了一段 / 唱了一首。
   *
   * 开心归开心，是要费体力的 —— 所以精力见底时她会摆手说不跳了（判断在 main.js）。
   * 一个跳一整天都不累的桌宠，看着就假。
   */
  onPerform() {
    this.lastInteract = Date.now();
    this._warmUp(4);
    this.mood = clamp(this.mood + 8);
    this.energy = clamp(this.energy - 4);
    this._sync('perform');
  }

  /**
   * 摸头、说话之类的直接互动。
   *
   * opts.silent —— 这次别说台词。用在「戳她之后她要现想一句应景的话」那条路上：
   * 台词库先甩一句「干嘛啦」，两秒后又冒出一句正经的，看着像两个人在说话。
   */
  onInteract(kind = 'pet', opts = {}) {
    this.lastInteract = Date.now();

    if (kind === 'pet') {
      // 加分挪到分档**之后**：连摸到第八下还在给她加好感就说不过去了
      const { state, bank } = this._petCombo();

      // 摸头单独走一条旁路，不受常规状态判定管 ——
      // 摸头这件事本身就该有反应，不该被「她现在心情如何」盖过去
      this.emit('change', {
        state,
        changed: true,
        reason: 'pet',
        line: opts.silent ? null : pick(LINES[bank] || LINES.pet),
        stats: this._stats(),
      });
      this.save();
      // 害羞（或者恼）是一阵子的事，几秒后回到该有的状态
      setTimeout(() => this._sync('pet-settle'), 3000);
      return;
    }

    this._warmUp(3);
    this.mood = clamp(this.mood + 2);
    this._sync('interact');
  }

  /**
   * 手按在她头上不动 —— 「摸着」，不是「点了一下」。
   *
   * 姿态那层（渲染进程）已经在演了：眯着眼往你手的方向蹭。所以这儿**不再说话**，
   * 说了反而抢戏 —— 身体已经把话说完了。
   *
   * 好感只给一点点，而且不走 _petCombo：松手时那次点击会正常走 onInteract('pet')
   * 拿它那一档的加分，两边都给满就成了「按住三秒等于摸了两次」。
   */
  onPetHold() {
    this.lastInteract = Date.now();
    this._warmUp(1);
    this.mood = clamp(this.mood + 1);
    this.save();
  }

  /**
   * 摸太久了，她要躲。
   *
   * 这个是**该说话**的：身体躲开的同时嘴上也得抗议一句，
   * 不然你不知道自己干了什么让她躲。
   */
  onPetLong() {
    this.affection = clamp(this.affection - 0.5);
    this.mood = clamp(this.mood - 2);
    this.save();
    this.flash('frustrated', pick(LINES.petAnnoyed), 2800);
  }

  /**
   * 你走开好一阵子，回来了。
   *
   * 以前「人在不在电脑前」这个信号只喂给 tick() 算数值，屏幕上没有任何反馈 ——
   * 你走开一小时回来，她跟没事人一样。这条补的就是那一眼。
   *
   * 不调 claude，**一分钱不花**：台词从库里挑，动作是本地算的。
   */
  onReturn(goneMin, { silent = false } = {}) {
    // 晾太久了还是要扣的 —— 但回来这件事本身值一点好感，
    // 所以扣归 tick() 管，这儿只管「见到你高兴」
    this._warmUp(goneMin > 120 ? 1 : 2);
    this.mood = clamp(this.mood + 3);
    this.lastSeen = Date.now();
    this.save();

    // silent = main 那边有正经话要说（「你走的 40 分钟里干完了 X」）。
    // 数值照记，嘴闭上 —— 不然两个气泡打架，汇报被「你回来啦」顶掉
    if (silent) return;
    const bank = goneMin >= 90 ? LINES.welcomeLong : LINES.welcomeBack;
    this.flash(goneMin >= 90 ? 'lonely' : 'happy', pick(bank), 3600);
  }

  /**
   * 连着摸头，她的反应要递进。
   *
   * 一个摸一百下还在原地害羞的桌宠，比不会害羞更假 —— 真人被反复摸头，
   * 先是不好意思，然后开始享受，再摸就烦了。三档：
   *
   *   1~3 下   害羞，好感涨得最多
   *   4~7 下   受用了，涨得少一点
   *   8 下往上 烦，倒扣一点
   *
   * 10 秒不摸就重新数 —— 隔了半天再来摸，那是新的一次，不该接着上次的火气。
   */
  _petCombo() {
    const now = Date.now();
    if (now - this._petAt > 10000) this._petN = 0;
    this._petAt = now;
    this._petN += 1;

    if (this._petN >= 8) {
      this.affection = clamp(this.affection - 1);
      this.mood = clamp(this.mood - 2);
      return { state: 'frustrated', bank: 'petAnnoyed' };
    }
    if (this._petN >= 4) {
      this._warmUp(1);
      this.mood = clamp(this.mood + 3);
      return { state: 'happy', bank: 'petMore' };
    }
    this._warmUp(3);
    this.mood = clamp(this.mood + 2);
    return { state: 'shy', bank: 'pet' };
  }

  /**
   * 每分钟走一拍。
   *
   * 这个函数以前是整套心情系统里最不对劲的地方：**它只进不出**。
   * 精力每分钟 +2（=每小时 +120），而跳一整支舞才扣 4 —— 歇两分钟就补回来了；
   * 亲密度要连着两小时不理她才开始扣，扣 0.4，随便点她一下 +3 就赚回来。
   * 于是实际跑出来的存档长期是 `energy: 100, affection: 100`，
   * 而 computeState 里 sleepy 要 <18、tired 要 <38、lonely 要 <=25 ——
   * **这三个状态一次都没触发过**，开发手册里写的「累了会拒绝跳舞」「晾久了会闹脾气」
   * 全是空头支票，连带九个情绪动作里有三个永远演不到。
   *
   * 现在改成真的有收有支：醒着就在耗精力（干活耗得更快），只有关机那段时间才回；
   * 亲密度涨得越高越难涨，而且分得清「你不在」和「你在但不理我」。
   */
  tick() {
    const now = Date.now();
    const idleMin = (now - this.lastInteract) / 60000;
    const goneMin = (now - this.lastSeen) / 60000;
    const away = goneMin > 5; // 五分钟没碰键鼠，当你人不在

    // --- 精力：只看她自己的活 ------------------------------------------------
    // （这块的两代病史 —— 「关机才回血」和「键鼠当干活」—— 收在开发手册
    //   心情系统那节，别在这儿叠罗汉。）
    // 【上一版的病根：精力跟着**你的键鼠**扣。】键鼠动的是你，不是她在干活 ——
    // 机器上总有动静（终端跑着、你在用电脑），她永远被判「在陪干活」，
    // 永远没有休息窗口，实际存档量到 energy 死在 0、常年一张困脸。
    // 现在只看**她自己的活**：
    //   自己闷头干活（busy）        -0.4/分，深夜 ×1.5
    //   盯着你开的终端（watching）  -0.15/分 —— 盯梢费神，但远小于自己干
    //   都没有                      +0.35/分回血（跟你在不在电脑前无关！）
    // 配合 _rollDay 的「睡醒重置」，精力是日周期：晚上干得多真的会困，
    // 第二天又精神 —— 永远不会死在 0。
    if (this.busy) {
      let drain = 0.4;
      if (this.isLateNight()) drain *= 1.5;
      // 心情好有干劲、不容易累；心情差干一会儿就精疲力尽（±25%，见 _spirit）
      drain *= 1 - this._spirit() * 0.25;
      this.energy = clamp(this.energy - drain);
      this.day.workedMin += 1;
      this.workedMin += 1;   // 一起干活的总时长，进羁绊经验
      if (this.workedMin % 60 === 0) this._bondCache = null;
    } else if (this.watching > 0) {
      this.energy = clamp(this.energy - 0.15);
    } else {
      // REST_PER_MIN（21/时）：午休一个半小时回三分之一（不是回满 —— 那样
      // 下午永远精神）；一夜照样满血。离线补算用的同一个常数，作息不分叉
      // 心情好睡得香、回得快；心情差歇着也缓不过来（±20%）
      this.energy = clamp(this.energy + REST_PER_MIN * (1 + this._spirit() * 0.2));
    }

    // 桌宠活着的最后时刻。_load() 靠它算「关掉的那段时间」补多少 ——
    // 必须是这个，不能是 lastSeen（见 _load 里那段）
    this.lastTick = now;

    // --- 亲密度 -------------------------------------------------------------
    // 你人不在的时候扣得很慢（她知道你不在，不算冷落）；
    // 你就在电脑前却不理她，那才是真的晾着，扣得快
    // 亲近的地板由羁绊撑着：处成老搭档了，再怎么冷落也回不到陌生
    if (away) {
      // 人不在她能理解 —— 掉得极慢（一天不到 1 分/时），真正的分离惩罚
      // 在 _load 里按离线时长算一次
      if (goneMin > 90) this._coolDown(0.015);
    } else if (idleMin > 45) {
      // 人在电脑前却不理她。原来 -0.22/分（一小时掉 13）太狠 —— 你专注写
      // 两小时代码不是冷落她。放缓到 -0.1/分，真晾一下午才看得出委屈
      this._coolDown(0.1);
    }

    // --- 心情 ---------------------------------------------------------------
    // 回归的目标不是固定的 60 —— 累的时候、被冷落的时候，
    // 心情自然就该低一些。以前不管什么状态都往 60 收，
    // 加上干成一个活 +18，长期就黏在 80 以上（happy 的门槛），一年到头一张笑脸。
    // 振幅拉开（22~90）、回归放慢（0.05 → 0.03）：事件的冲击留得住，
    // 一天里看得出起伏 —— 原来不管出什么事都很快缩回窄带，一年到头一张脸
    // 今天的底色（_dayTone）压在这儿：出问题多的一天，回归目标本身就低 ——
    // 干成一件活照样 +18，但收拢的方向是低位，「今天不太顺」这件事留得住
    const base = clamp(48 + (this.energy - 50) * 0.22 + (this.closeness - 50) * 0.18 +
                       this._dayTone(), 22, 90);
    this.mood += (base - this.mood) * 0.03;
    this.mood = clamp(this.mood);

    // 熬夜也是一起熬的，记一笔（一天最多记一次）
    if (this.isLateNight() && this.lastNightDay !== dayKey()) {
      this.nights += 1;
      this.lastNightDay = dayKey();
      this._bondCache = null; // 熬夜数进羁绊经验
    }

    const before = this.state;
    const next = this.computeState();
    if (next !== before) {
      // 状态真的翻了才说话，否则每分钟叨叨一次太烦人
      const bank = LINES[next] || LINES.idle;
      this._sync('tick', pick(bank));
    } else {
      this._sync('tick');
    }

    // 到日子了就闪一下。放在 _sync 之后：那句话该盖过这一拍的常规台词，
    // 而且挂久一点（5 秒多，比普通 flash 长）—— 难得的时刻，别一眨眼就过去
    const ms = this._milestone();
    if (ms) {
      this.flash(ms.state, ms.line, 5200);
      this.save();
      this.emit('milestone', { id: ms.id, text: ms.line });
    } else if (!this.busy && !this.quiet) {
      // 羁绊升级的道喜。**必须排在 _sync 之后**（跟里程碑同一条规矩：
      // flash 要盖过这一拍的常规台词，放前面就被 _sync 当场冲掉，评审抓的）；
      // busy/quiet 时不发也不记级 —— 下一拍自然补发，不会吞
      this._bondCheck();
    }
  }

  /**
   * 你人还在不在电脑前。main.js 按系统空闲时间每分钟喂一次。
   *
   * 只更新时间戳，不动任何数值 —— 「人在」不等于「理我」，
   * 这正是加这条的意义。
   */
  onSeen() {
    this.lastSeen = Date.now();
    this._rollDay();
  }

  /**
   * 翻篇：今天是不是新的一天，连着来了几天。
   *
   * **挂在 onSeen 上，不能挂 tick。** tick 只要桌宠开着就跑 ——
   * 电脑常年不关机的人出差一周，streak 会白涨到 7，
   * 「你连着七天来找我了」在她根本没见到人的情况下响出来。
   *
   * 跨日一律**字符串比较**，不许算天数差：tick 是 unref 的一分钟一拍，
   * 机器休眠/合盖会一次跳过好几天，算差值能把 streak 一口气加 3。
   */
  _rollDay() {
    const today = dayKey();
    if (today === this.lastDay) return;
    // 昨天见过 → 接上；隔了一天以上 → 从 1 重新数
    this.streak = this.lastDay === dayKey(Date.now() - 86400000) ? this.streak + 1 : 1;
    this.daysSeen += 1;

    // 新的一天（早上 5 点日界线）：
    // · 精力睡醒重置 —— 昨晚再累，今天也从 86 起步（本来就更高就不动）。
    //   这一条就是「永远不会死在 0」的保证书
    // · 亲近自然回落一点 —— 高位是**维护**出来的才有意义；地板由羁绊撑着，
    //   处得越深回落越有底
    this._bondCache = null; // 先失效：见面天数刚 +1，下面的地板要按今天的算（评审抓的顺序）
    // 新的一天，工作账翻篇：昨天出多少岔子都过去了，今天重新开始
    this.day = { key: today, tasks: 0, ok: 0, fails: 0, errors: 0, troubles: 0, workedMin: 0 };
    if (this.lastDay !== '') { // 第一次建档不算「新的一天」
      this.energy = clamp(Math.max(this.energy, 86));
      this._coolDown(1.5);
    }

    this.lastDay = today;
    this.save();
  }

  /**
   * 到日子了没有。返回命中的那条或者 null。
   *
   * 三道闸挡着别烦人：手上有活在跑不响、专注期间（番茄钟/小游戏）不响、
   * 同一天已经响过不响。响过的记进 hit，永不重复。
   */
  _milestone() {
    if (this.busy || this.quiet) return null;
    const today = dayKey();
    if (this.lastHitDay === today) return null;

    let jt = null;
    try { jt = this.getTotals ? this.getTotals() : null; } catch (_) { /* 账本坏了不拦里程碑 */ }
    const s = {
      days: Math.floor((Date.now() - this.firstMet) / 86400000),
      tasks: this.tasksDone,
      streak: this.streak,
      aff: this.affection,
      nights: this.nights,
      usd: jt ? Math.floor(jt.costUsd || 0) : 0,
      turns: jt ? jt.turns || 0 : 0,
    };

    const reached = [];
    for (const m of MILESTONES) {
      const id = typeof m.id === 'function' ? m.id(s) : m.id;
      if (this.hit.has(id) || !m.test(s)) continue;
      reached.push({ id, state: m.state, line: pick(m.lines) });
    }
    if (!reached.length) return null;

    /**
     * 【一次够到好几条 = 老存档头一回升级，别按顺序补发。】
     *
     * 表是从小到大排的。一个已经处了半年的人升级上来，`hit` 是空的，
     * 于是他会连着好几天听到「欸…我们认识一周了诶」「第十个活了」——
     * 而实际早就过去了。那不是惊喜，那是她犯傻。
     *
     * 所以头一回（hit 还是空的）就一次对齐：够到的全部记上，
     * 只说**最有分量的那条**。往后正常跑，一天一条慢慢来。
     */
    const win = this.hit.size === 0 ? reached[reached.length - 1] : reached[0];
    if (this.hit.size === 0) reached.forEach((r) => this.hit.add(r.id));
    else this.hit.add(win.id);

    this.lastHitDay = today;
    return win;
  }

  snapshot() {
    const b = this.bond();
    return {
      state: this.state,
      energy: Math.round(this.energy),
      mood: Math.round(this.mood),
      affection: Math.round(this.closeness),
      closeness: Math.round(this.closeness),
      bond: { level: b.level, title: b.title, xp: b.xp, next: b.next },
      busy: this.busy,
      errorStreak: this.errorStreak,
      // 记日子的那几个，面板上「今天」那一栏要用
      days: Math.floor((Date.now() - this.firstMet) / 86400000),
      tasks: this.tasksDone,
      streak: this.streak,
      daysSeen: this.daysSeen,
    };
  }

  dispose() {
    clearInterval(this.timer);
    clearTimeout(this._flashTimer);
    this.save();
  }
}

module.exports = { Mood, LINES, MILESTONES, dayKey };
