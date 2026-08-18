'use strict';

const { EventEmitter } = require('events');

/**
 * 一起玩。
 *
 * 跟「跳舞」「唱歌」的区别是：那些是**她表演给你看**，你只是观众；
 * 这里有来回、有输赢、有一局的概念 —— 她出题你答，答完她有反应，记着分，
 * 一局结束报成绩。差别就在这个「回合」上。
 *
 * 三条硬约束，决定了这里能玩什么：
 *
 *   1. **一分钱都不能花。** 一局游戏来回好几轮，每轮都调一次 claude 的话，
 *      玩十分钟就是好几块。所以题目、干扰项、反馈台词全是本地生成的。
 *   2. **交互只有气泡上那几个按钮。** 桌面上没有输入框（整个窗口是块透明画布），
 *      所以能玩的必须是「几选一」的形态 —— 猜数字那种要打字的做不了。
 *   3. **题目要用她的身体出。** 不然跟随便一个小程序有什么区别。
 *      猜情绪用她的表情和动作出题，猜歌用她的音乐库，这两样别处没有。
 *
 * 顺便记一笔**做不了**的：石头剪刀布。模型的 `ParamHandL/R` 是手的**开合量**
 * 不是手势造型，摆不出「剪刀」和「布」的区别 —— 只能靠台词说「我出的是石头」，
 * 那就没意思了。
 */

// 猜情绪：题目从这些里出。
// 挑的原则是**表情和身体动作都得有** —— 只有脸变、身体不动的话，
// 好几个情绪看起来差不多，那题就成了瞎蒙。
// （九个情绪动作见 src/renderer/dance.js 的 GESTURES，这里是它和台词的交集）
const EMOTIONS = [
  { id: 'happy', label: '开心', hint: '整个人蹦了两下' },
  { id: 'proud', label: '得意', hint: '挺胸叉腰' },
  { id: 'shy', label: '害羞', hint: '侧身低头' },
  { id: 'surprised', label: '吃惊', hint: '猛地往后仰' },
  { id: 'frustrated', label: '烦躁', hint: '甩了甩头' },
  { id: 'tired', label: '累了', hint: '垂头塌肩' },
  { id: 'sleepy', label: '犯困', hint: '一点一点地打盹' },
  { id: 'lonely', label: '闹脾气', hint: '扭头不看你' },
  { id: 'excited', label: '来劲了', hint: '往前凑' },
];

const RIGHT = ['对了！', '猜中了，厉害。', '嗯，就是这个。', '答对啦～'];
const WRONG = ['不对哦。', '差得有点远。', '再想想？', '不是这个啦。'];

const shuffle = (a) => {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

class Play extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => object[]} deps.songs   歌单，来自 src/perform.js
   * @param {(file:string) => object} deps.loadSong  读一首歌的字节
   * @param {Function} deps.log
   */
  constructor({ songs, loadSong, log, pace } = {}) {
    super();
    this.songs = songs || (() => []);
    this.loadSong = loadSong || (() => null);
    this.log = log || (() => {});
    // 各处停顿的倍率。存在的理由是自检 —— 一局三题真等下来十几秒，
    // 测试里给 0 就能瞬间跑完，节奏逻辑本身不变
    this.pace = typeof pace === 'number' ? pace : 1;

    this.game = null;    // 'emotion' | 'song' | 'pomodoro'
    this.round = 0;
    this.score = 0;
    this.total = 3;
    this.answer = null;  // 这一题的正确答案 id
    this.timer = null;
  }

  get busy() {
    return Boolean(this.game);
  }

  /** 现在能玩哪些 —— 没有歌就别把「猜歌」摆出来给人点空 */
  menu() {
    const items = [
      { id: 'emotion', label: '猜猜我在想什么' },
      { id: 'pomodoro', label: '陪我专注 25 分钟' },
    ];
    if (this.songs().filter((s) => !s.tooBig).length >= 4) {
      items.splice(1, 0, { id: 'song', label: '猜这是哪首歌' });
    }
    return items;
  }

  start(game) {
    if (this.busy) return { ok: false, error: '这局还没完呢' };

    this.game = game;
    this.round = 0;
    this.score = 0;

    if (game === 'emotion') {
      this.total = 3;
      this.emit('say', { text: '好，我做个表情，你猜我什么心情。一共三题～' });
      this._later(() => this._askEmotion(), 2200);
      return { ok: true };
    }

    if (game === 'song') {
      const usable = this.songs().filter((s) => !s.tooBig);
      if (usable.length < 4) {
        this.game = null;
        return { ok: false, error: '歌太少了，凑不出选项' };
      }
      this.total = 3;
      this.emit('say', { text: '我放一小段，你猜是哪首。三题，听好了～' });
      this._later(() => this._askSong(), 2200);
      return { ok: true };
    }

    if (game === 'pomodoro') return this._startPomodoro();

    this.game = null;
    return { ok: false, error: '没这个玩法' };
  }

  // --- 猜情绪 --------------------------------------------------------------

  _askEmotion() {
    if (this.game !== 'emotion') return;
    this.round += 1;

    const right = pick(EMOTIONS);
    this.answer = right.id;

    // 三个干扰项。**从剩下的里随机取**，不做「难度递增」那种花样 ——
    // 一局才三题，玩家感觉不到，徒增复杂度
    const others = shuffle(EMOTIONS.filter((e) => e.id !== right.id)).slice(0, 3);
    const options = shuffle([right, ...others]).map((e) => ({ id: e.id, label: e.label }));

    // 先做表情和动作，隔一拍再出题 —— 题目和动作同时冒出来的话，
    // 你的注意力会被按钮抢走，根本没看清她做了什么
    this.emit('perform', { face: right.id, gesture: right.id });
    this._later(() => {
      if (this.game !== 'emotion') return;
      this.emit('say', {
        text: '第 ' + this.round + ' 题：我现在是什么心情？',
        options,
        hold: 0, // 挂着别收，等你想
      });
    }, 1400);
  }

  // --- 猜歌 ----------------------------------------------------------------

  _askSong() {
    if (this.game !== 'song') return;
    this.round += 1;

    const usable = this.songs().filter((s) => !s.tooBig);
    const right = pick(usable);
    this.answer = right.file;

    const others = shuffle(usable.filter((s) => s.file !== right.file)).slice(0, 3);
    const options = shuffle([right, ...others]).map((s) => ({
      id: s.file,
      label: s.title.length > 12 ? s.title.slice(0, 11) + '…' : s.title,
    }));

    let song = null;
    try {
      song = this.loadSong(right.file);
    } catch (err) {
      this.log('[play] 这首读不了，跳过: ' + err.message);
      this._later(() => this._askSong(), 300);
      return;
    }

    // 从中间放一小段。从头放的话前奏往往认不出来，而且很多歌开头都差不多。
    // **绝对不能走 perform:song 那条路** —— 那边收到 title 就会念出来
    // （stage.js 里 `if (e.title) say('♪ ' + e.title)`），等于直接报答案。
    this.emit('clip', { audio: song.bytes, mime: song.mime, seconds: 8, at: 0.4 });

    this._later(() => {
      if (this.game !== 'song') return;
      this.emit('say', {
        text: '第 ' + this.round + ' 题：这是哪首？',
        options,
        hold: 0,
      });
    }, 900);
  }

  // --- 收答案 --------------------------------------------------------------

  choose(id) {
    if (!this.busy || this.answer === null) return;
    if (this.game === 'pomodoro') return;

    const ok = id === this.answer;
    if (ok) this.score += 1;
    this.answer = null;

    // 答对了配个开心的动作。**先停掉正在演的，再演新的** ——
    // 编舞那边正在跑一个动作时会直接不理新的（gesture 里 `if (this.on || this.gest) return false`），
    // 不停的话你答对了她一点反应都没有
    this.emit('perform', { face: ok ? 'happy' : 'sad', gesture: ok ? 'happy' : 'shy', interrupt: true });
    this.emit('say', { text: ok ? pick(RIGHT) : pick(WRONG) });

    this._later(() => {
      if (!this.busy) return;
      if (this.round >= this.total) this._finish();
      else if (this.game === 'emotion') this._askEmotion();
      else this._askSong();
    }, 2400);
  }

  _finish() {
    const s = this.score;
    const n = this.total;
    let line;
    if (s === n) line = '全对！你也太懂我了吧。';
    else if (s === 0) line = '一个都没对……你根本不看我对不对。';
    else line = s + ' / ' + n + '，还行吧。';

    this.emit('perform', {
      face: s >= n - 1 ? 'happy' : 'shy',
      gesture: s >= n - 1 ? 'happy' : 'shy',
      interrupt: true,
    });
    this.emit('say', { text: line });
    this.emit('done', { game: this.game, score: s, total: n });
    this.log('[play] ' + this.game + ' 结束，' + s + '/' + n);
    this.game = null;
  }

  // --- 番茄钟 --------------------------------------------------------------

  /**
   * 陪你专注 25 分钟。
   *
   * 这个不是游戏，是「一起做一件事」—— 但它是这里最实用的一条：
   * 开始之后她**安静下来**（不主动搭话、不提议唱跳），到点了才喊你。
   *
   * 计时用的是**绝对时间戳**，不是「数 25 次一分钟的 tick」。
   * 后者在电脑休眠、切用户、系统卡顿时都会漂，25 分钟可能变成 27 分钟 ——
   * 而这个东西的全部意义就是准时。
   */
  _startPomodoro(minutes = 25) {
    this.game = 'pomodoro';
    this.endsAt = Date.now() + minutes * 60 * 1000;
    this.answer = null;

    this.emit('quiet', { on: true });
    this.emit('say', { text: minutes + ' 分钟，我不吵你。专心。' });
    this.emit('perform', { face: 'normal', gesture: null });
    this.log('[play] 番茄钟开始，' + minutes + ' 分钟');

    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.game !== 'pomodoro') { clearInterval(this.timer); return; }
      const left = this.endsAt - Date.now();
      if (left > 0) {
        // 最后一分钟提醒一次，别让人被突然的响动吓一跳
        if (left <= 60000 && !this._warned) {
          this._warned = true;
          this.emit('say', { text: '还有一分钟。' });
        }
        return;
      }
      clearInterval(this.timer);
      this._warned = false;
      this.emit('quiet', { on: false });
      this.emit('perform', { face: 'happy', gesture: 'happy', interrupt: true });
      this.emit('say', { text: '时间到！起来动一动，喝口水。' });
      this.emit('done', { game: 'pomodoro' });
      this.log('[play] 番茄钟结束');
      this.game = null;
    }, 5000); // 5 秒一查：既不会让「到点」拖到一分钟后才发现，也不费什么
    if (this.timer.unref) this.timer.unref();

    return { ok: true };
  }

  // --- 收尾 ----------------------------------------------------------------

  stop() {
    if (!this.busy) return { ok: false };
    const was = this.game;
    this.game = null;
    this.answer = null;
    clearInterval(this.timer);
    clearTimeout(this._t);
    this._warned = false;
    if (was === 'pomodoro') this.emit('quiet', { on: false });
    this.emit('say', { text: was === 'pomodoro' ? '不算了？那算了。' : '不玩啦？' });
    this.log('[play] ' + was + ' 中断');
    return { ok: true };
  }

  _later(fn, ms) {
    clearTimeout(this._t);
    this._t = setTimeout(fn, Math.round(ms * this.pace));
    if (this._t.unref) this._t.unref();
  }

  dispose() {
    clearInterval(this.timer);
    clearTimeout(this._t);
  }
}

module.exports = { Play, EMOTIONS };
