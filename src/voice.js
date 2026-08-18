'use strict';

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

/**
 * 语音合成。用微软 Edge 的在线 TTS —— 免费、不用账号、中文神经网络音色。
 *
 * 两件事值得注意：
 *  1. setMetadata 要建 WebSocket，头一次约 1.7 秒。所以连接必须复用，
 *     不能每句话都重建，否则她说话永远慢一拍。
 *  2. 合成是异步的，用户可能连着触发好几句。用序号做仲裁，
 *     只让最新一句活下来，避免几句话叠在一起同时播。
 */
// 连接闲置超过这个时长就主动丢掉重建。
// 微软那边会静悄悄地掐掉长时间没流量的 WebSocket，本地还以为连着，
// 结果下一句直接卡到超时 —— 与其等它超时，不如闲久了就当它已经死了。
const IDLE_RECONNECT_MS = 3 * 60 * 1000;
const SYNTH_TIMEOUT_MS = 12000;

class Voice {
  constructor(cfg = {}) {
    this.cfg = Object.assign(
      {
        enabled: true,
        voiceName: 'zh-CN-XiaoyiNeural', // 晓伊，年轻女声，比晓晓更活泼
        rate: '+8%',
        pitch: '+12Hz',
      },
      cfg
    );
    this.tts = null;
    this.initing = null;
    this.seq = 0;
    this.lastUsed = 0;
    this._chain = Promise.resolve(); // 合成串行队列，见 speak()
    this.onLog = null; // 主进程塞个日志函数进来，出问题能看见
  }

  _log(m) {
    if (typeof this.onLog === 'function') {
      try { this.onLog(m); } catch (_) { /* 日志不该反过来搞崩语音 */ }
    }
  }

  // 把当前连接彻底丢掉。连接一旦坏了必须走这里，
  // 否则那个死掉的 WebSocket 会被永久缓存，之后每一句都只能等超时。
  _drop(why) {
    if (this.tts) this._log('[voice] 丢弃连接重建（' + why + '）');
    try {
      if (this.tts && this.tts.close) this.tts.close();
    } catch (_) {
      /* 关不掉就算了 */
    }
    this.tts = null;
    this.initing = null;
  }

  async _ensure() {
    // 闲置太久的连接八成已经被对面掐了，别拿它去赌
    if (this.tts && this.lastUsed && Date.now() - this.lastUsed > IDLE_RECONNECT_MS) {
      this._drop('闲置超时');
    }
    if (this.tts) return this.tts;
    if (!this.initing) {
      this.initing = (async () => {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(this.cfg.voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        this.tts = tts;
        return tts;
      })().catch((err) => {
        // 失败要把 initing 清掉，否则这个 rejected promise 会被永久缓存，
        // 网络恢复了也再没机会重连
        this.initing = null;
        throw err;
      });
    }
    return this.initing;
  }

  /**
   * 把要念的文字洗干净。
   *
   * 她干活时的输出里全是代码块、文件路径、markdown 符号和 URL，
   * 原样丢给 TTS 会念出一长串「反斜杠 D 冒号」，非常出戏。
   */
  static clean(text, maxLen = 60) {
    if (!text) return '';
    let t = String(text);

    t = t.replace(/```[\s\S]*?```/g, '，代码就不念了，');   // 整块代码
    t = t.replace(/`([^`]{1,20})`/g, '$1');                  // 短行内代码留内容
    t = t.replace(/`[^`]*`/g, '');                           // 长的直接丢
    t = t.replace(/https?:\/\/\S+/g, '一个链接');
    t = t.replace(/[A-Za-z]:[\\/][^\s，。！？]*/g, '那个文件'); // Windows 路径
    t = t.replace(/[*_#>|~]/g, '');                          // markdown 记号
    t = t.replace(/\s+/g, ' ').trim();

    // 太长的不念完 —— 念三分钟没人受得了，截到一句话为止
    if (t.length > maxLen) {
      const cut = t.slice(0, maxLen);
      const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('！'));
      t = (stop > 12 ? cut.slice(0, stop + 1) : cut) + '…';
    }
    return t;
  }

  /**
   * 合成一句话，返回 base64 的 mp3。
   * 返回 null 表示这次不用出声（被关掉了、文本空、或者已经被更新的一句顶掉）。
   *
   * opts.important = true：这句必须念到（任务播报之类），
   *   不参与「只留最新一句」的仲裁，排队也要排到它。
   * opts.maxLen：截断长度，播报可以放宽一点。
   * opts.rate / opts.pitch：临时覆盖语速和音调 —— 哼唱时要拉高音调、放慢语速，
   *   听起来才不像在念稿子。
   */
  speak(text, opts = {}) {
    if (!this.cfg.enabled) return Promise.resolve(null);

    const clean = Voice.clean(text, opts.maxLen || 60);
    if (!clean) return Promise.resolve(null);

    const mySeq = ++this.seq;
    const tone = { rate: opts.rate || this.cfg.rate, pitch: opts.pitch || this.cfg.pitch };

    // 必须串行。一个 WebSocket 连接同时只能合成一句，
    // 并发丢进去的那几句会**一起**卡死到超时 —— 这是实测踩过的坑：
    // 四句话几乎同时触发，日志里就是四条「合成超时」排在一起。
    const run = this._chain.then(() => this._synth(clean, mySeq, Boolean(opts.important), tone));
    this._chain = run.then(() => {}, () => {}); // 一次失败不能把整条队列掐断
    return run;
  }

  async _synth(clean, mySeq, important, tone) {
    // 排队期间被更新的一句顶掉了。重要播报不吃这套 —— 它必须念出来。
    if (!important && mySeq !== this.seq) return null;

    let lastErr = null;
    // 试两次：第一次撞上死连接是常态（对面会静悄悄掐掉闲置的 WebSocket），
    // 丢掉重连之后第二次基本都能成。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tts = await this._ensure();
        if (!important && mySeq !== this.seq) return null;

        const buf = await this._toBuffer(tts, clean, tone);
        this.lastUsed = Date.now();

        if (!important && mySeq !== this.seq) return null;
        if (!buf || buf.length < 500) throw new Error('音频几乎是空的，没真的合成出来');

        return { audio: buf.toString('base64'), text: clean };
      } catch (err) {
        lastErr = err;
        // 走到这儿说明这条连接已经不可信了，扔掉
        this._drop(err.message);
        if (attempt === 0) this._log('[voice] 第一次没成（' + err.message + '），重连再来一次');
      }
    }
    throw lastErr || new Error('合成失败');
  }

  _toBuffer(tts, text, tone) {
    const t = tone || {};
    const res = tts.toStream(text, {
      rate: t.rate || this.cfg.rate,
      pitch: t.pitch || this.cfg.pitch,
    });
    const stream = res.audioStream || res;
    const chunks = [];

    return new Promise((resolve, reject) => {
      let settled = false;
      // end 和 close 都可能来，而且顺序不定；只认第一个到的
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error('合成超时')), SYNTH_TIMEOUT_MS);

      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => done(resolve, Buffer.concat(chunks)));
      stream.on('close', () => done(resolve, Buffer.concat(chunks)));
      stream.on('error', (e) => done(reject, e));
    });
  }

  setEnabled(v) {
    this.cfg.enabled = Boolean(v);
  }

  dispose() {
    this._drop('退出');
  }
}

module.exports = { Voice };
