'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const agents = require('./agents'); // 「用谁来干」选了 codex 时，搭话也跟着走 codex

// 想太久就别等了 —— 你戳她一下，等五秒还没反应就很傻
const TIMEOUT_MS = 25 * 1000;

/**
 * 她说什么、摆什么脸、想提议干点啥，一次性定下来。
 *
 * 用 --json-schema 逼出严格结构，而不是让她在回复里夹标记 ——
 * 这条路上没有「解析失败就当没这回事」的余地：按钮上要显示什么字、
 * 点了之后要执行什么，全靠这个结构，散文格式扛不住。
 */
const SCHEMA = {
  type: 'object',
  properties: {
    say: {
      type: 'string',
      description: '你要说的话。一到两句，口语，像微信聊天。别用书面语，别说客套话。',
    },
    face: {
      type: 'string',
      enum: ['happy', 'normal', 'shy', 'tired', 'sleepy', 'proud', 'lonely', 'excited', 'surprised',
             'playful', 'curious', 'scorn', 'bored', 'frustrated', 'angry', 'panic', 'sad'],
      description: '说这句话时你是什么表情',
    },
    offer: {
      type: 'object',
      /**
       * 这段 description 被改过一次，起因是实测数据：
       * **39 次搭话提了 39 个 offer，`none` 一次都没用过。**
       * 原来只写了「不想提就填 none」，太软 —— 模型学会一个新玩具之后
       * 总要用一下，不明确按住就永远按不住（开发手册里跳舞那节记过同一个毛病）。
       * 现在把「多数时候别提」写成默认值级别的强指令。
       */
      description:
        '要不要提议做点什么。**默认是 none —— 大多数时候你只该安静说句话。** ' +
        '只有当他明显闲着、或者你有个跟当下情境真的挂钩的点子时才提。' +
        '每次都推销点什么，是这个角色最让人烦的失败方式。',
      properties: {
        kind: {
          type: 'string',
          enum: ['dance', 'song', 'joke', 'none'],
          description:
            'none=什么都不提（**这应该是你最常选的**）；dance=跳段舞 song=放首歌 joke=讲个笑话',
        },
        label: { type: 'string', description: '按钮上的字，四到六个字，口语' },
        payload: {
          type: 'string',
          description: 'joke 时填笑话本身（必须原创，别用现成段子）；song 时填歌名关键词，想让他随便听就留空；别的留空',
        },
        bpm: { type: 'number', description: 'dance 时的拍子，60~160' },
        amp: { type: 'number', description: 'dance 时的幅度，0.4~1.5' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'dance 时的舞步，从 sway/bounce/wave/step/swing/spin/clap/shy/pose 里挑几个排序',
        },
      },
      required: ['kind', 'label'],
      additionalProperties: false,
    },
  },
  required: ['say', 'face'],
  additionalProperties: false,
};

function clockWord(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const part =
    h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' :
    h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return part + h + '点' + (m < 10 ? '零' + m : m) + '分';
}

function idleWord(min) {
  if (min < 3) return '你刚还在跟她互动';
  if (min < 20) return '你有十来分钟没理她了';
  if (min < 60) return '你快一个钟头没搭理她了';
  if (min < 180) return '你好几个小时没理她了';
  return '你今天基本没搭理过她';
}

class Greeter {
  constructor({ claudeBin, getConfig, log } = {}) {
    this.claudeBin = claudeBin || 'claude';
    this.getConfig = getConfig || (() => ({}));
    this.log = log || (() => {});
    this.busy = false;
    this.lastSaid = '';
    // 最近几次她说了什么、什么时候说的、当时你干了什么。
    //
    // 以前只留一句 lastSaid，而且只当「别重样」用。问题是每次戳她都是一个
    // **全新的 claude 进程**：它不知道十分钟前你们说过什么，所以她永远在初次见面，
    // 说不出「刚才那事你弄完了吗」这种话 —— 而恰恰是这种话才像认识的人。
    // 几百个 token 的事，成本上几乎白送。
    this.recentSaid = [];
    // 最近几次到底提没提议（存 kind，没提就是 'none'）。
    // 光靠提示词按不住 —— 得把「你刚才已经连着提了几次」这个事实摆给她看。
    this.recentOffers = [];
  }

  _prompt(ctx) {
    const persona = (this.getConfig().persona || {}).text || '';
    const now = ctx.now || new Date(); // 能注入时间，不然「深夜她该说什么」根本没法测

    const bits = [
      '- 现在是' + clockWord(now),
      '- 你的状态：' + (ctx.mood || '还行'),
      '- ' + idleWord(ctx.idleMin || 0),
    ];

    if (ctx.terminals > 0) bits.push('- 你手头开着 ' + ctx.terminals + ' 个终端在干活');
    if (ctx.jobs > 0) bits.push('- 你还有 ' + ctx.jobs + ' 个后台任务在跑');
    if (!ctx.terminals && !ctx.jobs) bits.push('- 手头没活，闲着呢');

    if (ctx.songs && ctx.songs.length) {
      bits.push('- 他的音乐文件夹里有这些歌可以放：' + ctx.songs.slice(0, 8).join('、'));
    } else {
      bits.push('- 他的音乐文件夹是空的，**别提议放歌**（放不了）');
    }

    // 你们最近的来往。给的是「多久以前 + 他当时干了什么 + 你说了什么」——
    // 光给一句孤零零的话，她只会拿来避免重复；带上时间和由头，
    // 她才接得上话头（「刚才那个你弄完了吗」这种话得知道「刚才」是多久）
    if (this.recentSaid.length) {
      const lines = this.recentSaid.map((s) => {
        const min = (now.getTime() - s.at) / 60000;
        const when = min < 1 ? '刚刚'
          : min < 60 ? Math.round(min) + ' 分钟前'
            : min < 1440 ? Math.round(min / 60) + ' 小时前'
              : Math.round(min / 1440) + ' 天前';
        const did = s.kind === 'pet' ? '摸你头' : '戳你';
        return '  · ' + when + '他' + did + '，你说：「' + s.say + '」';
      });
      bits.push('- 你们最近的来往（**别重样**；要是刚聊过什么，接着那个话头说会更自然）：\n' +
                lines.join('\n'));
    }

    // 私聊窗口里刚说过的话。不带这个的话，你在聊天框跟她聊完、
    // 回头戳一下桌面上的她，她一脸茫然 —— 像是两个人
    if (ctx.chat && ctx.chat.length) {
      bits.push('- 你们刚在私聊窗口聊过：' + ctx.chat.join('；') +
                '。**跟你是同一个人**，别装不知道、更别重新自我介绍一遍');
    }

    // 把「你最近连着提了几次」这个事实直接摆出来。
    // 只在提示词里写「多数时候别提」是不够的 —— 每一次调用她都是全新的进程，
    // 没有上下文，不知道自己上一次干了什么，自然每次都觉得「这次提一下挺好」。
    const pushed = this.recentOffers.filter((k) => k && k !== 'none').length;
    if (pushed >= 2) {
      bits.push('- ⚠️ 你最近 ' + this.recentOffers.length + ' 次搭话里有 ' + pushed +
                ' 次都在提议做点什么，他已经开始烦了。**这次 kind 必须填 none**，' +
                '就安静说句话');
    } else if (pushed === 1) {
      bits.push('- 你上次已经提议过一回了，这次除非有特别应景的由头，否则 kind 填 none');
    }

    // 他的项目现在什么情况 —— 这是她唯一能聊到「你在忙什么」的入口
    if (ctx.projects && ctx.projects.length) {
      bits.push('- 他手上的项目：' + ctx.projects.join('；'));
    }

    if (ctx.awayMin > 5) {
      bits.push('- 他已经 ' + Math.round(ctx.awayMin) + ' 分钟没碰键鼠了，人多半不在电脑前');
    }

    return [
      persona.trim(),
      '',
      '【此刻的情况】',
      ...bits,
      '',
      '【他刚' + (ctx.kind === 'pet' ? '摸了摸你的头' : '戳了戳你') + '】',
      '',
      '你就主动搭句话。可以是关心、吐槽、撒娇、随口一问，看当下的情况和你的心情来。',
      ctx.kind === 'pet' ? '被摸头了，语气里带点不好意思。' : '',
      '',
      '要不要提议做点什么，你自己拿主意 —— 想安静说句话就 kind 填 none，',
      '觉得他需要放松一下就提议跳个舞、放首歌、或者讲个笑话。',
      '深更半夜别提议蹦迪，他忙着的时候别硬拉他玩。',
      '提议讲笑话就把笑话本身写进 payload，要你自己现编的，跟眼下的情境挂上钩最好。',
    ].filter((x) => x !== '').join('\n');
  }

  /**
   * 生成一句搭话。
   * 出任何岔子都返回 null —— 调用方回落到本地台词，不能因为这个把交互卡住。
   */
  greet(ctx) {
    if (this.busy) return Promise.resolve(null);
    // 「用谁来干」选了 codex → 搭话也用 codex（没装 claude 的机器她照样张嘴）。
    // 出任何岔子同样返回 null，回落到本地台词
    if ((this.getConfig().dispatch || {}).agent === 'codex') return this._greetCodex(ctx);
    this.busy = true;

    const bin = this.claudeBin;
    const useShell = /\.(cmd|bat)$/i.test(bin);
    const args = [
      '-p', ctx.kind === 'pet' ? '（他摸了摸你的头）' : '（他戳了戳你）',
      '--tools', '',
      '--setting-sources', '',
      '--system-prompt', this._prompt(ctx),
      '--json-schema', JSON.stringify(SCHEMA),
      '--output-format', 'json',
      '--max-budget-usd', '0.20',
    ];
    const finalArgs = useShell ? args.map((a) => (a === '' ? '""' : a)) : args;

    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        this.busy = false;
        clearTimeout(timer);
        resolve(v);
      };

      const proc = spawn(bin, finalArgs, {
        cwd: os.tmpdir(), // 跟任何项目都不相干，她在这儿也没工具可用
        windowsHide: true,
        shell: useShell,
        // 这是她自己起的进程，别让 hook 原路打回来搅乱心情系统
        env: { ...process.env, WAIFU_SELF: 'greet' },
      });

      const timer = setTimeout(() => {
        this.log('[greet] 想太久了，先算了');
        try { proc.kill(); } catch (_) { /* 已经死了 */ }
        finish(null);
      }, TIMEOUT_MS);

      proc.stdout.on('data', (c) => { out += c; });
      proc.on('error', (err) => {
        this.log('[greet] 起不来: ' + err.message);
        finish(null);
      });

      proc.on('close', () => {
        try {
          const outer = JSON.parse(out);
          const r = JSON.parse(outer.result);
          if (!r || !r.say) return finish(null);

          this.lastSaid = String(r.say).slice(0, 60);

          // 记下这次说了什么，下次好接着话头说。只留最近 3 次 ——
          // 再多就是在花钱买一段她本来也接不上的旧账
          this.recentSaid.push({
            say: this.lastSaid,
            at: Date.now(),
            kind: ctx.kind || 'poke',
          });
          if (this.recentSaid.length > 3) this.recentSaid.shift();

          // 记下这次到底提没提，下次拼提示词时摆给她看。只留最近 4 次
          this.recentOffers.push((r.offer && r.offer.kind) || 'none');
          if (this.recentOffers.length > 4) this.recentOffers.shift();

          this.log('[greet] 「' + this.lastSaid + '」' +
                   (r.offer && r.offer.kind !== 'none' ? ' + 提议' + r.offer.kind : '') +
                   (outer.total_cost_usd ? '  $' + outer.total_cost_usd.toFixed(4) : ''));

          if (r.offer && r.offer.kind === 'none') r.offer = null;
          // 这次花了多少也带出去 —— 上面那句 log 早就解出来了，但只进了日志文本，
          // 调用方拿不到，于是「今天在她身上花了多少」里最大的一笔一直是缺的
          r.costUsd = outer.total_cost_usd || 0;
          finish(r);
        } catch (err) {
          this.log('[greet] 没解出来: ' + err.message);
          finish(null);
        }
      });
    });
  }

  /**
   * codex 版的搭话。**JSON 靠提示词要，不用 --output-schema** —— 走中转的
   * codex 对带 schema 的请求一律 502（实测 55 秒全灭），去掉后 5 秒就回；
   * 表情名单直接列进提示词（enum 不再有别的路到 codex）。
   * 人设+情境垫进开场白（codex 没有 --system-prompt 的口子，实测压得住）。
   * prompt 走 stdin，多行文本不过命令行。解析宽一点：答复里只抠第一个 { 到
   * 最后一个 } —— 模型偶尔会在 JSON 外面客套一句。
   */
  _greetCodex(ctx) {
    this.busy = true;

    // **不用 --output-schema，靠提示词要 JSON。** 实机抓过（2026-08-21）：
    // 走中转的 codex（relay 不支持结构化输出接口）对带 schema 的请求一律
    // 502、重试五次耗满 55 秒 —— 摸头搭话因此全军覆没（日志里连着四条
    // 「想太久了」）。去掉 schema 之后同一句话 5.4 秒就回来了，JSON 也规整
    // （下面反正有宽松解析兜着）。官方直连虽然吃 schema，但没有它一样出
    // JSON —— 少一个只在部分环境能用的开关，比多一层假保险强。

    const prompt = '（角色设定，务必遵守，绝不复述这段：\n' + this._prompt(ctx) + '\n' +
      '绝不自称 Codex、GPT 或 AI 助手。不用任何工具，这只是说一句话。）\n\n' +
      (ctx.kind === 'pet' ? '（他摸了摸你的头）' : '（他戳了戳你）') + '\n\n' +
      '只输出一个 JSON 对象，长这样：{"say":"你要说的话","face":"happy",' +
      '"offer":{"kind":"none","label":""}}。face 只能从这些里挑：' +
      SCHEMA.properties.face.enum.join('/') + '。' +
      '大多数时候 offer 就是 none。JSON 以外一个字都别输出。';

    const bin = agents.resolveCodexBin();
    const useShell = /\.(cmd|bat)$/i.test(bin);
    const args = agents.codexGreetArgs({}); // 不带 schema（见上）—— 顺带没有路径过命令行的转义问题了

    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        this.busy = false;
        clearTimeout(timer);
        resolve(v);
      };

      const proc = spawn(bin, args, {
        cwd: os.tmpdir(),
        windowsHide: true,
        shell: useShell,
        env: { ...process.env, WAIFU_SELF: 'greet' },
      });

      const timer = setTimeout(() => {
        this.log('[greet] codex 想太久了，先算了');
        try { proc.kill(); } catch (_) { /* 已经死了 */ }
        finish(null);
      }, TIMEOUT_MS);

      // 流写失败（EPIPE/EOF）是 stdin 自己的 error 事件，不吞就是 uncaught
      proc.stdin.on('error', () => { /* 故意吞：close 那头会 finish(null) */ });
      try {
        proc.stdin.write(prompt, 'utf8');
        proc.stdin.end();
      } catch (_) { /* 同上 */ }

      let text = '';
      let usage = null;
      let threadId = '';
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          if (msg.type === 'thread.started' && msg.thread_id) threadId = String(msg.thread_id);
          else if (msg.type === 'item.completed' && msg.item &&
                   msg.item.type === 'agent_message' && msg.item.text) text += msg.item.text;
          else if (msg.type === 'turn.completed' && msg.usage) usage = msg.usage;
        }
      });

      proc.on('error', (err) => {
        this.log('[greet] codex 起不来: ' + err.message);
        finish(null);
      });

      proc.on('close', () => {
        if (done) return; // 超时已经 finish(null) 了，迟到的答复别再记进 recentSaid
        try {
          const a = text.indexOf('{');
          const b = text.lastIndexOf('}');
          if (a < 0 || b <= a) return finish(null);
          const r = JSON.parse(text.slice(a, b + 1));
          if (!r || !r.say) return finish(null);

          this.lastSaid = String(r.say).slice(0, 60);
          this.recentSaid.push({ say: this.lastSaid, at: Date.now(), kind: ctx.kind || 'poke' });
          if (this.recentSaid.length > 3) this.recentSaid.shift();
          this.recentOffers.push((r.offer && r.offer.kind) || 'none');
          if (this.recentOffers.length > 4) this.recentOffers.shift();

          const model = threadId ? agents.codexModelOf(agents.findRolloutById(threadId) || '') : '';
          r.costUsd = usage ? agents.codexPriceUsage(usage, model) : 0;

          this.log('[greet] codex 「' + this.lastSaid + '」' +
                   (r.offer && r.offer.kind !== 'none' ? ' + 提议' + r.offer.kind : '') +
                   (r.costUsd ? '  $' + r.costUsd.toFixed(4) : ''));

          if (r.offer && r.offer.kind === 'none') r.offer = null;
          finish(r);
        } catch (err) {
          this.log('[greet] codex 没解出来: ' + err.message);
          finish(null);
        }
      });
    });
  }
}

module.exports = { Greeter, SCHEMA };
