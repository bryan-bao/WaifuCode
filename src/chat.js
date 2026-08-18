'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// 派活那边早就有的「这条会话还在不在磁盘上」判断，这儿直接复用同一个
const { sessionExists } = require('./sessions');

/**
 * 告诉她「除了说话，你还能真的动起来」。
 *
 * 做成让她在回复末尾附一行指令，而不是另开一次 API 调用去解析意图 ——
 * 那样每句话的成本翻倍，而且会出现「嘴上答应了，身体没动」的割裂。
 * 一次调用把话和动作一起定下来，她说「那我跳个慢的」和她真的跳慢的，是同一个决定。
 */
const ACTION_GUIDE = [
  '【你还能真的动起来】',
  '想做动作时，在回复的**最后**单独加一行（前面照常说话）：',
  '',
  '<<ACT:{"act":"dance","bpm":95,"steps":["sway","wave"],"amp":1,"seconds":30}>>',
  '',
  '可用的 act：',
  '- dance 跳舞。bpm 60~160（慢歌 70-90、一般 100-120、嗨 130-150）；',
  '  steps 从这些里挑几个排个顺序：sway 左右摇摆、bounce 上下弹跳、',
  '  wave 手臂波浪、step 踏步转身、swing 甩头（幅度最大）、spin 转身、',
  '  clap 拍手、shy 小碎步（收着跳）、pose 定格摆造型；',
  '  amp 幅度 0.4~1.5；seconds 跳多久，默认 30',
  '- sing 唱歌。song 填歌名关键词，会去他自己的 music 文件夹里找。',
  '  **他说「随便来一首」这种没指定歌名的，song 就留空字符串**，别填 random 或者「随便」——',
  '  那会被当成歌名去找，然后一首都匹配不上。',
  '  只能放他已经有的文件，找不到会告诉你有哪些。',
  '- hum 即兴哼唱。lyrics 填你**自己现编的**几句词，会用你的声音哼出来、同时跟着跳。',
  '  必须是你原创的，绝对不要写现成歌曲的歌词。',
  '- face 做个表情。name 从 happy/proud/shy/sad/surprised/excited/sleepy/tired/normal 里挑',
  '- stop 停下别跳了',
  '',
  '规矩：',
  '- 只有他确实想让你动的时候才加这一行，平时聊天绝对不要加',
  '- 这一行必须放在最后，一次只加一个',
  '- 风格自己拿捏：他说「跳个温柔的」你就慢 bpm、小 amp、用 shy 和 wave；',
  '  说「嗨一点」就快 bpm、大 amp、用 swing 和 bounce',
].join('\n');

/**
 * 每句话都要带上此刻的情绪。
 *
 * 跟上面那个 ACT 不是一回事：ACT 是「她决定去做一件事」（跳个舞、唱首歌），
 * 偶尔才有；这个是**每句话都有**的语气标注，驱动桌面上她的表情和身体。
 *
 * 不做这个的话，你在聊天框跟她聊得再热闹，桌面上那个她**始终是同一张脸**
 * 在弹字 —— 明明说着「气死我了」，脸上跟没事人一样。
 *
 * 做成一个极短的标记而不是再开一次 API 调用：多这一行的代价是几个 token，
 * 而单独调一次「分析这句话的情绪」是整整一次请求。
 */
const MOOD_GUIDE = [
  '【每句话都要标上你此刻的情绪】',
  '回复的**最后**单独加一行，就这个格式：',
  '',
  '<<M:happy>>',
  '',
  '可选：happy 开心 / excited 来劲 / proud 得意 / shy 害羞 / sad 低落 /',
  'tired 累 / sleepy 困 / surprised 吃惊 / frustrated 烦 / lonely 闹别扭 / normal 平常',
  '',
  '这一行不会显示给他看 —— 它驱动的是桌面上你的**表情和身体动作**。',
  '每句都要带。挑最贴近这句语气的那个，别一路 normal 到底。',
].join('\n');

// 她想太久就别等了 —— 聊个天等两分钟不如当她没听见
const REPLY_TIMEOUT_MS = 90 * 1000;

// 回复里那行动作指令
const ACT_RE = /<<ACT:\s*(\{[\s\S]*?\})\s*>>/;

// 语气标注。认不出来的词一律当没标 —— 她偶尔会自己发明一个情绪名，
// 那种情况下宁可不动表情，也别把一个不存在的表情名塞给渲染层
// 里面故意收得很宽（`[^>]*`），不是只认字母。她偶尔会写 `<<M:狂喜>>` 这种
// 自创的情绪名 —— 只认字母的话这个正则压根匹配不上，那一整行标记就会
// **原样漏进气泡**。宽着匹配、再拿 MOODS 校验，认不出来就只丢掉标记不换表情
const MOOD_RE = /<<M:\s*([^>]*?)\s*>>/;
const MOODS = new Set([
  'happy', 'excited', 'proud', 'shy', 'sad',
  'tired', 'sleepy', 'surprised', 'frustrated', 'lonely', 'normal',
]);

function extractMood(text) {
  const m = MOOD_RE.exec(text);
  if (!m) return { text, mood: null };
  const name = String(m[1]).toLowerCase();
  return {
    text: text.replace(MOOD_RE, '').trim(),
    mood: MOODS.has(name) ? name : null,
  };
}

/** 这段文字里第一个「给程序看的标记」从哪儿开始（没有就是 -1） */
function tagStart(s) {
  const a = s.indexOf('<<ACT');
  const b = s.indexOf('<<M:');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** 把动作指令从回复里摘出来，剩下的才是要显示给人看的话 */
function extractAction(text) {
  const m = ACT_RE.exec(text);
  if (!m) return { text, action: null };

  let action = null;
  try {
    action = JSON.parse(m[1]);
  } catch (_) {
    /* 她 JSON 写错了就当没这回事，话照样显示 */
  }
  return { text: text.replace(ACT_RE, '').trim(), action };
}
// 存档留多少条。留太多没意义，真正的记忆在 claude 那条会话里
const KEEP_MSGS = 300;

/**
 * 私聊。
 *
 * 跟「派活」的根本区别不是技术上的，是性质上的：那边是让她干活，
 * 这边就是聊天。所以这条会话：
 *
 *   · 单独一个 session，跟任何项目都不沾边，也不占派活的记忆
 *   · 不干活 —— 人设里明说了不要动工具，权限也没放开
 *   · 人设可以随时改（config.json 的 persona）
 *   · **她此刻的心情会写进人设**，所以她烦躁的时候说话真的不一样
 *
 * 每句话起一个新的 claude 进程、靠 --resume 接上一条会话。
 * 不用常驻进程是有意的：闲聊本来就是一句一句来的，常驻反而要处理
 * 半天没人说话时进程怎么办、崩了怎么恢复，得不偿失。
 */
class Chat extends EventEmitter {
  constructor({ storeDir, claudeBin, getConfig, getMoodDesc, log }) {
    super();
    this.file = path.join(storeDir, 'chat.json');
    this.claudeBin = claudeBin;
    this.getConfig = getConfig || (() => ({}));
    this.getMoodDesc = getMoodDesc || (() => '');
    this.log = log || (() => {});

    this.sessionId = null;
    this.turns = 0;
    this.msgs = [];
    this.proc = null;

    // 桌面上刚说过、但这条会话还不知道的那句话。见 seed()。
    this.pending = null;

    this._load();
  }

  /**
   * 把她刚在桌面气泡里说的那句话带进这条会话。
   *
   * 用在「点一下气泡就跳到私聊接着聊」上。要解决的是一个很别扭的断层：
   * 气泡上那句是 greet 进程（另一个 claude）现想的，私聊这条会话
   * **压根不知道自己说过这句话** —— 你点进来接一句「为什么呀」，
   * 她会一脸茫然地反问你在说什么。
   *
   * 做法是两件事分开：
   *   · 那句话立刻 push 进 msgs —— 聊天窗口一打开就能看到它，接得上下文
   *   · 同时记成 pending，**下一次**你说话时悄悄垫在前面告诉她背景，
   *     用完即清。不是每轮都带，所以不会在会话历史里越滚越长。
   */
  seed(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;

    // 已经是最后一条了就别重复塞（连点两下气泡）
    const last = this.msgs[this.msgs.length - 1];
    if (last && last.role === 'her' && last.text === t) {
      this.pending = t;
      return true;
    }

    this.msgs.push({ role: 'her', text: t, ts: Date.now() });
    this.pending = t;
    this._save();
    return true;
  }

  // --- 存档 -----------------------------------------------------------------

  _load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.sessionId = s.sessionId || null;
      this.turns = s.turns || 0;
      this.msgs = Array.isArray(s.msgs) ? s.msgs : [];
    } catch (_) {
      /* 第一次聊，没有存档很正常 */
    }
  }

  _save() {
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          {
            sessionId: this.sessionId,
            turns: this.turns,
            msgs: this.msgs.slice(-KEEP_MSGS),
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (err) {
      this.log('[chat] 存档写不进去: ' + err.message);
    }
  }

  history() {
    return this.msgs.slice(-KEEP_MSGS);
  }

  hasHistory() {
    return this.turns > 0;
  }

  // --- 会话接不接得上 -------------------------------------------------------

  /** 她起进程的地方。会话文件按这个目录归档。 */
  _cwd() {
    return path.dirname(this.file);
  }

  /**
   * 这条会话还能不能接着聊。
   *
   * **不能只看 turns > 0 就去 --resume。** 磁盘上那个 .jsonl 是会没的 ——
   * claude 自己清理、你手滑删了、换了机器同步过来的存档，都会让它消失。
   * 而 resume 一旦接不上，claude 只吐一行：
   *
   *     No conversation found with session ID: f040e980-…
   *
   * 这在私聊里比派活恶劣得多：派活是你主动点一次才发生，而私聊是**每说一句
   * 都撞一次**，她会永远卡在这句报错里自己爬不出来 —— 因为 sessionId 从来
   * 不会被改掉。所以这里先去磁盘上看一眼，不在就换条新的重开。
   *
   * 记忆是断了，但界面上的聊天记录还在（那是 chat.json，跟会话是两回事），
   * 所以顺手把最近几句话垫进新会话，让她至少接得上话头，而不是彻底失忆。
   */
  _resumeState() {
    if (!(this.turns > 0 && this.sessionId)) return { resume: false, carry: null };
    if (sessionExists(this._cwd(), this.sessionId)) return { resume: true, carry: null };

    this.log('[chat] 上次那条会话（' + this.sessionId.slice(0, 8) +
             '）不在磁盘上了，换条新的重开，把最近几句垫过去');
    const carry = this._carryOver();
    this.sessionId = null;
    this.turns = 0;
    this._save();
    return { resume: false, carry };
  }

  /**
   * 把界面上还留着的最近几句话，写成一段交代给新会话。
   *
   * 只带最近三轮：再多就是在用钱买一个本来就已经断掉的记忆，不划算，
   * 而且长了她反而会照着复述。
   */
  _carryOver(rounds = 3) {
    const tail = this.msgs.filter((m) => !m.error && m.text).slice(-rounds * 2);
    if (!tail.length) return null;

    const lines = tail.map((m) => {
      const t = String(m.text).replace(/\s+/g, ' ').trim();
      return (m.role === 'user' ? '他' : '你') + '：' + (t.length > 120 ? t.slice(0, 120) + '…' : t);
    });
    return [
      '[背景：你们之前聊过下面这几句，但你的会话记录断了。',
      '别提这件事、也别复述，看一眼接着聊就行。]',
      ...lines,
    ].join('\n');
  }

  // --- 人设 -----------------------------------------------------------------

  setPersona() {
    // 人设存在 config 里，这儿不用缓存 —— 每次说话现取，改完立刻能生效。
    // 但已经开着的那条会话里，system prompt 是开场时定死的，
    // 所以真正「换个人」得点重开。
  }

  _systemPrompt() {
    const p = this.getConfig().persona || {};
    const mood = this.getMoodDesc();

    return [
      String(p.text || '').trim(),
      '',
      mood ? '【你此刻的状态】' + mood + '这会影响你说话的语气，但别把状态本身念出来。' : '',
      '',
      '【怎么说话】',
      '- 现在是闲聊，不是干活。你手上也确实没有任何工具，别说要去看文件、跑命令。',
      '- 回复要短，一般一到三句。别写 markdown 标题、列表、代码块 —— 这是聊天框不是文档。',
      '- 用口语，像微信上聊天那样。别客套，别总结，别问「还有什么可以帮你」。',
      '- 他要是让你真去干活，告诉他用桌宠上的「派个活」，你在这儿只陪聊。',
      '',
      MOOD_GUIDE,
      '',
      ACTION_GUIDE,
    ]
      .filter((x) => x !== null && x !== undefined)
      .join('\n')
      .trim();
  }

  // --- 说话 -----------------------------------------------------------------

  /**
   * 发一句过去。
   *
   * 立刻返回 { ok: true }，回复通过 delta / done / error 事件推出去 ——
   * 不能让 IPC 那头挂在这儿等好几十秒。
   */
  send(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: '说点什么吧' };
    if (this.proc) return { ok: false, error: '她还在想上一句呢，等一下' };

    // 会话还接不接得上，要在 push 之前判断 —— 这样万一要垫背景，
    // 垫过去的是「之前聊的」，不含这句（这句本来就是 prompt）
    const { resume, carry } = this._resumeState();

    this.msgs.push({ role: 'user', text: t, ts: Date.now() });
    this._save();

    // 有些话这条会话还不知道，垫在前面交代一下背景。都只垫这一次，
    // 之后 claude 自己的会话历史里就有了。
    // 存档里 push 的是原始的 t，所以聊天界面上看不到这些方括号。
    const notes = [];
    if (carry) notes.push(carry);
    if (this.pending) {
      notes.push('[背景：你刚在桌面上跟他说了「' + this.pending +
                 '」，他点了那条气泡跳过来接着聊。别复述这句，直接接着说。]');
      this.pending = null;
    }
    const prompt = notes.length ? notes.join('\n') + '\n' + t : t;

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',

      // 闲聊不给工具。比在提示词里写「别用工具」硬得多 —— 她根本没有工具可用，
      // 所以绝不可能在你跟她扯闲篇的时候顺手改了你的代码。
      '--tools', '',

      // 不加载任何设置源。三个好处，每一个都实打实：
      //   1. 人设不被全局 CLAUDE.md 稀释
      //   2. 少塞一大坨系统提示词，实测一轮从 $0.014 降到 $0.002
      //   3. **不加载 hooks** —— 否则她自己聊天会触发桌宠的 hook 打回自己身上，
      //      心情系统会被自己的聊天行为带着跑
      '--setting-sources', '',
    ];

    // 接得上就接（她得记得你们刚才聊了什么），接不上就老老实实开条新的
    if (resume) {
      args.push('--resume', this.sessionId);
    } else {
      this.sessionId = crypto.randomUUID();
      args.push('--session-id', this.sessionId);
    }

    // 必须是 --system-prompt（整个替换）不能是 --append-system-prompt（追加）。
    // 实测过：追加的人设压不住 Claude Code 自带的那套身份，问她叫什么，
    // 她照样答「我是 Claude」。整个换掉才真的变成她。
    args.push('--system-prompt', this._systemPrompt());

    const bin = this.claudeBin || 'claude';
    const useShell = /\.(cmd|bat)$/i.test(bin); // npm 装的是 .cmd，得靠 shell 才拉得起来
    // 走 shell 时空字符串参数会被直接吞掉（--tools 后面那个空值就没了，
    // 参数一错位整条命令就废了），得显式补一对引号
    const finalArgs = useShell ? args.map((a) => (a === '' ? '""' : a)) : args;

    const proc = spawn(bin, finalArgs, {
      cwd: path.dirname(this.file), // 一个不相干的目录，她在这儿本来也不该碰文件
      windowsHide: true,
      shell: useShell,
      env: { ...process.env, WAIFU_SELF: 'chat' },
    });
    this.proc = proc;

    let reply = '';
    let stderr = '';
    let buf = '';
    let costUsd = 0;
    let pushed = 0;      // 已经流式推给界面的字数
    let sawAct = false;  // 开始吐动作指令了，后面的都别往界面上推

    const timer = setTimeout(() => {
      this.log('[chat] 想太久了，掐掉');
      try { proc.kill(); } catch (_) { /* 已经死了 */ }
    }, REPLY_TIMEOUT_MS);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      // stream-json 是 JSONL，一行一个完整对象；半行留着等下一块补齐
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }

        if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              reply += block.text;

              // 那两行标记（<<ACT 和 <<M:）是给程序看的，别让它们在聊天框里闪一下 ——
              // 一旦开始吐就停止往界面推，只把它前面的话补完
              if (!sawAct) {
                const at = tagStart(reply);
                if (at >= 0) {
                  sawAct = true;
                  if (at > pushed) this.emit('delta', { text: reply.slice(pushed, at) });
                  pushed = at;
                } else {
                  this.emit('delta', { text: block.text });
                  pushed = reply.length;
                }
              }
            }
          }
        } else if (msg.type === 'result') {
          if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
          if (typeof msg.result === 'string' && msg.result.trim()) reply = msg.result;
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      this.proc = null;
      this._fail('她张不开嘴: ' + err.message);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      this.proc = null;

      const { text: stripped, action } = extractAction(reply.trim());
      const { text: said, mood } = extractMood(stripped);

      if (!said && !action) {
        const err = stderr.trim();

        // 预检没拦住的漏网之鱼：文件躺在那儿，但 claude 就是不认（存档损坏、
        // 版本对不上）。把 id 作废掉，下一句自动重开 —— 不在这儿直接重试，
        // 是因为再起一个进程要几十秒，让她卡着不动比报一句话更难受。
        if (/No conversation found/i.test(err)) {
          this.log('[chat] 会话 ' + String(this.sessionId).slice(0, 8) + ' 接不上，作废重开');
          this.sessionId = null;
          this.turns = 0;
          this._save();
          this._fail('刚才那条会话接不上了，你再说一句就好 —— 之前聊的她记不得了');
          return;
        }

        this._fail(err.slice(-300) || '她没说话（退出码 ' + code + '）');
        return;
      }

      this.turns += 1;
      this.msgs.push({ role: 'her', text: said, ts: Date.now() });
      this._save();

      this.log('[chat] 第 ' + this.turns + ' 轮，' + said.length + ' 字' +
               (costUsd ? '，$' + costUsd.toFixed(4) : '') +
               (mood ? '，' + mood : '') +
               (action ? '，还要 ' + action.act : ''));

      // 先把话吐出去再动 —— 顺序反了就成了「先跳起来才说要跳」
      this.emit('done', { text: said, costUsd, action, mood });
      if (action) this.emit('action', action);
    });

    return { ok: true };
  }

  _fail(error) {
    this.log('[chat] ' + error);
    this.msgs.push({ role: 'her', text: error, ts: Date.now(), error: true });
    this._save();
    this.emit('error', { error });
  }

  /** 重开一段。之前聊的她就不记得了 —— 换人设时最常用。 */
  reset() {
    if (this.proc) {
      try { this.proc.kill(); } catch (_) { /* 已经死了 */ }
      this.proc = null;
    }
    this.sessionId = null;
    this.turns = 0;
    this.msgs = [];
    this.pending = null;
    this._save();
  }

  dispose() {
    if (this.proc) {
      try { this.proc.kill(); } catch (_) { /* 已经死了 */ }
      this.proc = null;
    }
    this._save();
  }
}

module.exports = { Chat, extractAction, extractMood, tagStart, MOODS };
