'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// 每个目录留几条分线的记忆。留着是为了「回到上次查支付那条线接着聊」，
// 但不能无限攒 —— 面板上列不完，你也想不起来哪条是哪条了。
const LANE_KEEP = 5;

// ---------------------------------------------------------------------------
// 找 claude 可执行文件。
// 不写死路径 —— 用户换机器、重装、改安装方式都不该让桌宠瘫掉。
// ---------------------------------------------------------------------------
function resolveClaudeBin() {
  const home = os.homedir();
  const candidates = [
    process.env.WAIFU_CLAUDE_BIN,
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* 探测失败就换下一个 */
    }
  }
  return 'claude'; // 兜底：交给 PATH
}

/**
 * 这台电脑上到底装没装 Claude Code。
 *
 * 上面那个 `resolveClaudeBin()` **回答不了这个问题** —— 它找不着的时候会兜底成
 * 字符串 'claude' 交给 PATH 去碰运气，永远有返回值。自己用没关系（你知道自己装了），
 * 但这个东西是要打包发给别人的：对方没装的话，点一下「派活」拿到的是一句
 * `起不来: spawn claude ENOENT`，没有人看得懂那是什么意思。
 *
 * 所以这里老老实实翻一遍 PATH。npm 全局装出来的是 claude.cmd，
 * 官方安装器装出来的是 claude.exe，都得认。
 */
function claudeInstalled() {
  if (resolveClaudeBin() !== 'claude') return true; // 找到具体文件了

  const exts = ['.exe', '.cmd', '.bat', ''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, 'claude' + ext))) return true;
      } catch (_) {
        /* 这个目录读不了，翻下一个 */
      }
    }
  }
  return false;
}

/**
 * Claude Code 把会话按项目分目录存在 ~/.claude/projects 底下。
 *
 * 规则是**把所有非字母数字的字符统统折成横线** —— 不只是冒号和斜杠：
 *   D:\WaifuCode            -> D--WaifuCode
 *   E:\chao-tool\VideoTool  -> E--chao-tool-VideoTool
 *   D:\UnityGame\VR_Wukong  -> D--UnityGame-VR-Wukong     ← 下划线也折
 *   D:\WaifuCode\.testproj  -> D--WaifuCode--testproj      ← 点也折
 *
 * 【这里原来只换了 `[:\\/]`，是个正在造成失忆的真 bug。】
 *
 * 少折了下划线和点，算出来的目录名就跟磁盘上对不上 → `sessionExists()`
 * 一口咬定「这条会话不在了」→ `_resumableRecord` 认为记忆丢了，
 * **换个新 id 重开** → 那个项目的记忆每次都从头再来。
 *
 * 而它一声不吭：日志里那句「上次那条会话已经不在了」看着像是正常的自愈，
 * 没人会想到是路径算错了。
 *
 * 实地量过：本机 registry 里 10 个项目，旧算法命中 8 个，
 * `D:\UnityGame\VR_Wukong` 的 7ea29159 那条 **.jsonl 明明就躺在磁盘上**，
 * 却一直被判不在。换成下面这个写法，10 个全部命中。
 *
 * 顺带一提：这条也是「点接着聊回到某条老线」的地基 —— 算错目录名，
 * `sessionExists()` 就会说那条线不在了，于是点了「接着聊」照样开出一条空的，
 * 而整套功能看起来还"能用"。
 */
function projectStoreDir(dir) {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

/** 这条会话是真的躺在磁盘上，还是只是我们自己记了一笔？ */
function sessionExists(dir, sessionId) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(
      path.join(os.homedir(), '.claude', 'projects', projectStoreDir(dir), sessionId + '.jsonl')
    );
  } catch (_) {
    return false;
  }
}

/**
 * 会话调度器。
 *
 * 核心约定：**一个项目目录 = 一条独立会话**。
 * 每个项目分配一个固定的 session UUID 存在 registry 里，之后每次派活都
 * --resume 到同一条会话上。所以她对每个项目都有连续记忆，而这些记忆
 * 跟你当前正在用的那个 Claude Code 窗口是彻底隔离的 —— 各烧各的上下文。
 */
class SessionManager extends EventEmitter {
  constructor({ storeDir, getConfig, getMoodDesc }) {
    super();
    this.bin = resolveClaudeBin();
    this.storeDir = storeDir;
    // 干活时她也该是她自己，不是一个跟她无关的 Claude。见 _personaAddon()
    this.getConfig = getConfig || (() => ({}));
    this.getMoodDesc = getMoodDesc || (() => '');
    this.sessions = new Map(); // key(小写项目路径) -> 运行中的会话
    fs.mkdirSync(storeDir, { recursive: true });
    this.registryFile = path.join(storeDir, 'registry.json');
    this.registry = this._loadRegistry();
  }

  /**
   * 干活时追加给她的那段人设。
   *
   * 起因是一处很割裂的体验：你派活，她说「收到，这就去」——然后真正干活的
   * 是一个**跟她毫无关系的原生 Claude Code**，干完汇报回来的语气也不是她的。
   * 从头到尾三句话，中间那句是别人说的。
   *
   * 这里有两个刻意的取舍：
   *
   * 1. **用 `--append-system-prompt` 而不是 `--system-prompt`。**
   *    私聊那条链用的是整个替换（`chat.js`），因为闲聊时她必须彻底变成小依，
   *    而 Claude Code 那套庞大的身份设定会把追加的人设压得死死的（开发手册记过这个坑）。
   *    但干活这条链**恰恰需要那套设定** —— 里面全是怎么用工具、怎么改代码、
   *    什么不能碰的实打实的指导。为了让她说话像小依而把干活能力换掉，是本末倒置。
   *    追加压不住「你是谁」，但足够影响**语气**，而这里要的就是语气。
   *
   * 2. **只讲怎么说话，不讲怎么干活。** 一个字都不要碰技术判断 ——
   *    「优先用某某方案」这类话写进来，就是拿人设去干扰她的工程判断。
   */
  _personaAddon(projectName) {
    const p = this.getConfig().persona || {};
    const name = String(p.name || '小依').trim();
    const mood = this.getMoodDesc();

    return [
      '【你是谁】',
      '你是' + name + '，住在他电脑右下角的桌面助手。现在他派了个活给你，你正在' +
        (projectName ? '「' + projectName + '」这个项目里' : '') + '干活。',
      '干活该怎么干还怎么干 —— 这段话只管你**怎么说话**，不改变任何技术判断。',
      '',
      mood ? '【你此刻的状态】' + mood + '干活的时候别把状态挂在嘴上，但它会影响你的语气。' : '',
      '',
      '【说话的分寸】',
      '- 你在桌面上是有形象的，说话口语、简短，像个熟人，不是客服也不是文档。',
      '- **干完之后那句话尤其重要** —— 它会被念出来，还会浮在他桌面的气泡上。',
      '  一两句说清楚「干成了没、动了什么、有没有要他拿主意的」就够了，别复述过程。',
      '- 卡住了或者要他确认，直接说，别绕。他看不见你的终端。',
      '- 不用自我介绍，不用说「好的我明白了」这类客套。',
    ].filter((x) => x !== '').join('\n');
  }

  _loadRegistry() {
    try {
      return JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  _saveRegistry() {
    try {
      fs.writeFileSync(this.registryFile, JSON.stringify(this.registry, null, 2), 'utf8');
    } catch (err) {
      this.emit('log', '写 registry 失败: ' + err.message);
    }
  }

  _keyOf(projectPath) {
    return path.resolve(projectPath).toLowerCase();
  }

  _recordFor(dir) {
    const key = this._keyOf(dir);
    if (!this.registry[key]) {
      this.registry[key] = {
        path: dir,
        name: path.basename(dir),
        sessionId: crypto.randomUUID(),
        turns: 0,
        created: new Date().toISOString(),
      };
      this._saveRegistry();
    }
    return this.registry[key];
  }

  /**
   * 拿这个项目的会话记录，顺带判断能不能接着上次聊。
   *
   * **不能只看 turns > 0 就去 --resume。** 那个计数记的是「开过几次」，
   * 不是「会话真的建立了」—— 交互式会话要正常退出才落盘，窗口被直接叉掉
   * 就什么都没留下。于是 registry 上写着聊了 6 轮，磁盘上一条都没有，
   * 下次一 resume 就撞上一行红字：
   *
   *     No conversation found with session ID: c5026c88-…
   *
   * 终端窗口开出来只有这一句，活儿一点没干成。所以这里去磁盘上看一眼，
   * 不在就换个新 id 重开 —— 记忆是断了，但至少人能用。
   */
  _resumableRecord(dir) {
    const rec = this._recordFor(dir);
    const resume = rec.turns > 0 && sessionExists(dir, rec.sessionId);

    if (!resume && rec.turns > 0) {
      this.emit('log', '「' + rec.name + '」上次那条会话已经不在了，换条新的重开');
      rec.sessionId = crypto.randomUUID();
      rec.turns = 0;
      this._saveRegistry();
    }

    return { rec, resume };
  }

  // -------------------------------------------------------------------------
  // 任务线
  // -------------------------------------------------------------------------
  //
  // 一个目录**同时开几个终端各问各的**，靠的就是这一层。
  //
  // 原来的约定是「一个项目 = 一条会话」，两个终端同时 --resume 同一条会话，
  // 记忆会被交错写坏 —— 所以以前硬性只准开一个。
  //
  // 现在的约定简单得多：**每开一个终端就是一条新线，各自一个新会话 id**。
  // 不 resume、不 fork，谁也踩不着谁 —— 那个「记忆交错写坏」的老问题
  // 从结构上就不存在了。
  //
  // 线记下来是为了**回得去**：面板上每条线都留着 id 和名字，点「接着聊」
  // 才 `--resume` 那条线自己的会话。留最近 LANE_KEEP 条。

  _lanesOf(rec) {
    if (!Array.isArray(rec.lanes)) rec.lanes = [];
    return rec.lanes;
  }

  /** 这个目录下留着的分线，最近用过的排前面。
   *  **只读**：没记录的目录直接空手回 —— _recordFor 会创建并落盘，
   *  面板每次刷新都问一遍的话，registry 里全是随手敲的目录（评审抓的） */
  lanes(dir) {
    const rec = this.registry[this._keyOf(dir)];
    if (!rec) return [];
    return this._lanesOf(rec)
      .map((l) => ({ ...l, alive: sessionExists(dir, l.sessionId) }))
      .sort((a, b) => String(b.lastRun || '').localeCompare(String(a.lastRun || '')));
  }

  /** 开一条新线：一个新会话 id，外加一个记在 registry 里的线 id（下次靠它回来） */
  _newLane(dir, rec, laneName) {
    const lane = {
      id: 'L' + crypto.randomUUID().slice(0, 8),
      name: laneName,
      sessionId: crypto.randomUUID(),
      turns: 0,
      created: new Date().toISOString(),
      lastRun: new Date().toISOString(),
    };
    this._lanesOf(rec).push(lane);

    // 不能无限攒。留最近 LANE_KEEP 条，更老的连同它的会话记录一起忘掉 ——
    // 面板上列不完，用户也想不起来哪条是哪条了
    const keep = this._lanesOf(rec)
      .slice()
      .sort((a, b) => String(b.lastRun || '').localeCompare(String(a.lastRun || '')))
      .slice(0, LANE_KEEP);
    rec.lanes = keep;

    this._saveRegistry();
    return lane;
  }

  /**
   * 终端要开了，把「这一趟用哪条会话」算出来。
   *
   * 两条路：
   *   laneId 给了 → 回到那条老线接着聊（面板上点「接着聊」才走这儿）
   *   没给       → 开一条干净的新线，**不读任何旧记录**
   */
  prepareTerminal({ projectPath, laneId, laneName }) {
    const dir = path.resolve(projectPath);
    if (!fs.existsSync(dir)) throw new Error('项目目录不存在: ' + dir);
    if (!fs.statSync(dir).isDirectory()) throw new Error('这不是个目录: ' + dir);

    const rec = this._recordFor(dir);

    // --- 回到一条老分线 ---
    if (laneId) {
      const lane = this._lanesOf(rec).find((l) => l.id === laneId);
      if (!lane) throw new Error('这条线已经不在了（可能太久没用被清掉了）');

      lane.turns = (lane.turns || 0) + 1;
      lane.lastRun = new Date().toISOString();
      if (laneName) lane.name = laneName;
      rec.lastRun = lane.lastRun;
      this._saveRegistry();

      // codex 的线：会话 id 是事后认领的（rememberCodexSession 记在 lane 上）。
      // 认领过且文件还在 → 能真接上（codex resume <uuid>）；没有就开新的
      const canCodex = Boolean(lane.codexSessionId && lane.codexFile &&
                               fs.existsSync(lane.codexFile));

      // 接不上就拿同一个 id 开条新的 —— resume 失败恰恰说明这条会话不在磁盘上
      return {
        projectPath: dir,
        name: rec.name,
        laneId: lane.id,
        laneName: lane.name,
        sessionId: lane.sessionId,
        resume: canCodex || sessionExists(dir, lane.sessionId),
        codexSessionId: canCodex ? lane.codexSessionId : undefined,
        codexFile: canCodex ? lane.codexFile : undefined,
      };
    }

    /**
     * --- 新线 ---
     *
     * 【开终端不再自动接上次的记录。】
     *
     * 以前是：第一个终端 `--resume 主会话`，之后再开的
     * `--resume 主会话 --fork-session` —— 两条路都要把上次那一整段对话读回来。
     * 慢、烧钱，而且十次里有九次根本不是你想接的那条。
     *
     * 现在一律开一条干净的会话。想接着上次聊，你自己在终端里敲 `/resume` 挑，
     * 或者在面板上点那条线的「接着聊」—— 那两个都是你**明确**的动作。
     *
     * 顺带把「这条会话被别人占着吗」那道闸也撤了：每次都发一个新 uuid，
     * 结构上就不可能跟任何人撞。（后台派活那条链有自己的 rec.sessionId，
     * 终端从此不碰它，两边彻底分开。）
     */
    return this._openLane(dir, rec, laneName || '');
  }

  /** 开一条新线并算好参数 */
  _openLane(dir, rec, laneName) {
    const lane = this._newLane(dir, rec, laneName);

    rec.lastRun = new Date().toISOString();
    this._saveRegistry();

    return {
      projectPath: dir,
      name: rec.name,
      laneId: lane.id,
      laneName: lane.name,
      sessionId: lane.sessionId,
      resume: false,   // 新线永远是新会话，-n 该在这时候给
    };
  }

  /**
   * 这个窗口实际在用的 claude 会话变了 —— 认下它，换掉我们原来发的那个 id。
   *
   * 【不认的话「接着聊」是个空壳。】开窗口时我们 `--session-id` 指了一个 id，
   * 但用户在窗口里敲 `/resume` 挑另一条（这正是 CLAUDE.md 里推荐的做法）、
   * 或者 `/clear` 一下，claude 就换到别的会话上写了 —— 我们记的那个 id
   * **一个字都没落盘**。于是点「接着聊」时 `sessionExists()` 说那条不在，
   * 开出来的是条崭新的空会话：她把你们聊了一整天的事忘得干干净净。
   *
   * 实地翻过：registry 里 46 条线，22 条的 jsonl 根本不存在 —— 全是这个。
   *
   * 真实 id 由 claude 的 hook 事件带来（`ev.session_id`），窗口是我们开的
   * （靠 WAIFU_TERM_ID 认人），所以认下来是安全的。
   */
  rememberSession(projectPath, laneId, sessionId) {
    if (!laneId || !sessionId) return;
    try {
      const rec = this._recordFor(path.resolve(projectPath));
      const lane = this._lanesOf(rec).find((l) => l.id === laneId);
      if (!lane || lane.sessionId === sessionId) return;
      lane.sessionId = sessionId;
      this._saveRegistry();
    } catch (_) { /* 记不上就只是下次接不上，别拦正事 */ }
  }

  /**
   * codex 的窗口认领到会话了 —— 记到那条线上，「接着聊」和重启找回全靠它。
   * 找不到线就算了（比如线已经被清了），这不是要紧事。
   */
  rememberCodexSession(projectPath, laneId, sessionId, file) {
    if (!laneId || !sessionId) return;
    try {
      const dir = path.resolve(projectPath);
      const rec = this._recordFor(dir);
      const lane = this._lanesOf(rec).find((l) => l.id === laneId);
      if (!lane) return;
      lane.codexSessionId = sessionId;
      lane.codexFile = file;
      this._saveRegistry();
    } catch (_) { /* 记不上就只是下次接不上，别拦正事 */ }
  }

  /**
   * 派活（后台模式）：起一个全新的 claude 进程在项目目录里干活。
   *
   * permissionMode 默认 auto —— 后台没人盯着，卡在权限询问上会永远僵住，
   * 所以必须是个不会挂起的模式。auto 让 claude 自己用分类器判断：
   * 安全的放行、危险的直接拦下，两边都不用等人。
   *
   * 早先用的是 acceptEdits，那个只管自动放行文件编辑 —— 她要跑个
   * npm test 照样卡在那儿等确认，后台任务就白瞎了。
   * 但也绝不给 bypassPermissions，那等于把整台机器交出去。
   */
  dispatch({ projectPath, task, permissionMode = 'auto', model }) {
    const dir = path.resolve(projectPath);

    if (!fs.existsSync(dir)) {
      throw new Error('项目目录不存在: ' + dir);
    }
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error('这不是个目录: ' + dir);
    }
    if (!task || !task.trim()) {
      throw new Error('没说要干什么活');
    }

    const key = this._keyOf(dir);
    if (this.sessions.has(key)) {
      throw new Error('「' + path.basename(dir) + '」还有活在跑，等它干完');
    }

    const { rec, resume } = this._resumableRecord(dir);
    const args = [
      '-p', task,
      '--output-format', 'stream-json',
      '--verbose', // stream-json 需要它才会吐完整事件流
      '--permission-mode', permissionMode,
    ];

    // 接得上就接，保住连续记忆；接不上就老老实实开条新的
    if (resume) args.push('--resume', rec.sessionId);
    else args.push('--session-id', rec.sessionId);

    // 名字只在新开会话时给。`-n` 设的是 `customTitle`，而 `/rename` 改的是同一个
    // 字段 —— 每次都传等于把你在终端里改好的名字冲回「waifu:项目名」。
    // 详见 hooks/term-shell.js 里那段实测记录。
    if (!resume) args.push('-n', 'waifu:' + rec.name);

    // 干活的时候她也是她自己 —— 语气归人设管，技术判断还归 Claude Code 那套管
    args.push('--append-system-prompt', this._personaAddon(rec.name));

    /**
     * 只加载项目自己的设置，不加载用户全局的。
     *
     * 两个收益：**你写在 `~/.claude/CLAUDE.md` 里的个人偏好不会跟着这个活发出去**
     * （那是你自己的东西，跟她替你干的这个活没关系），顺带少发一大坨 token。
     *
     * ⚠️ **终端那条链千万别照抄这一行**（`hooks/term-shell.js`）。
     * 桌宠的 5 条 hook 装在**用户级** `~/.claude/settings.json` 里，
     * 而「她盯着你开出去的终端」百分之百靠那几条 hook —— 那边加了这个参数，
     * 监督功能会**静默失效**，不报任何错。
     * 这条链不受影响是因为它本来就用 `WAIFU_SELF` 让 hook 直接 bail 了。
     */
    if (this.getConfig().dispatch?.isolateSettings !== false) {
      args.push('--setting-sources', 'project');
    }

    if (model) args.push('--model', model);

    const proc = spawn(this.bin, args, {
      cwd: dir, // 这行就是「对应项目打开对应目录」的全部秘密
      windowsHide: true,
      env: {
        ...process.env,
        // 打个标记：这个进程是她自己起的。
        // 不打的话，这条会话触发的 hook 会原路打回桌宠，被当成「你在别的窗口
        // 手动干活」再算一遍情绪 —— 同一件事进两次账，心情系统会失真。
        WAIFU_SELF: 'dispatch',
      },
    });

    const session = {
      key,
      dir,
      name: rec.name,
      task,
      proc,
      sessionId: rec.sessionId,
      status: 'running',
      startedAt: Date.now(),
      lastText: '',
      toolCount: 0,
      errorCount: 0,
      costUsd: 0,
      stderr: '',
    };
    this.sessions.set(key, session);

    this.emit('start', { key, name: rec.name, dir, task });

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      // stream-json 是 JSONL：一行一个完整 JSON 对象。
      // 按行切，半行留在 buf 里等下一个 chunk 补齐。
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this._handleLine(session, line);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      session.stderr += chunk;
      if (session.stderr.length > 8000) {
        session.stderr = session.stderr.slice(-8000);
      }
    });

    proc.on('error', (err) => {
      session.status = 'failed';
      this.sessions.delete(key);
      this.emit('done', {
        key, name: rec.name, dir, task, ok: false,
        summary: '起不来: ' + err.message,
      });
    });

    proc.on('close', (code) => {
      this.sessions.delete(key);
      const ok = code === 0 && session.errorCount === 0;
      session.status = ok ? 'done' : 'failed';

      rec.turns += 1;
      rec.lastRun = new Date().toISOString();
      this._saveRegistry();

      this.emit('done', {
        key,
        name: rec.name,
        dir,
        task,
        ok,
        code,
        elapsedMs: Date.now() - session.startedAt,
        toolCount: session.toolCount,
        errorCount: session.errorCount,
        costUsd: session.costUsd,
        summary: session.lastText || session.stderr.slice(-400) || '（没有输出）',
      });
    });

    return { key, name: rec.name, sessionId: rec.sessionId };
  }

  // 解析 stream-json 的一行，翻译成桌宠听得懂的事件
  _handleLine(session, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return; // 不是 JSON 就跳过，别让脏数据崩掉整条流
    }

    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          session.lastText = block.text;
          this.emit('say', { key: session.key, name: session.name, text: block.text });
        } else if (block.type === 'tool_use') {
          session.toolCount += 1;
          this.emit('tool', {
            key: session.key,
            name: session.name,
            tool: block.name,
            count: session.toolCount,
          });
        }
      }
      return;
    }

    // 工具执行结果里带 is_error 的，是她撞墙了 —— 心情系统要知道
    if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.is_error) {
          session.errorCount += 1;
          this.emit('trouble', {
            key: session.key,
            name: session.name,
            count: session.errorCount,
          });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      if (typeof msg.total_cost_usd === 'number') session.costUsd = msg.total_cost_usd;
      if (typeof msg.result === 'string' && msg.result) session.lastText = msg.result;
    }
  }

  // 注：prepareTerminal 挪到上面「任务线」那一段去了 —— 它现在要处理
  // 主线 / 新分线 / 回到老分线 三条路，跟 lanes() 摆在一起才看得懂。
  // （原来这儿还有一份只认主线的旧实现。JS 里同名方法后者覆盖前者，
  //   留着不会报错，只会让人对着一份**根本没被执行的代码**查半天。）

  list() {
    return Array.from(this.sessions.values()).map((s) => ({
      key: s.key,
      name: s.name,
      dir: s.dir,
      task: s.task,
      status: s.status,
      toolCount: s.toolCount,
      errorCount: s.errorCount,
      elapsedMs: Date.now() - s.startedAt,
    }));
  }

  knownProjects() {
    return Object.values(this.registry).map((r) => ({
      name: r.name,
      path: r.path,
      turns: r.turns,
      lastRun: r.lastRun || null,
    }));
  }

  /**
   * 他手上有哪些项目、哪个多久没动了 —— 拿去喂提示词的。
   *
   * 这些数据每次派活都在往 registry 里写（turns、lastRun），但从来没进过
   * 任何一条提示词。她因此只能聊「几点了」「你多久没理我」，
   * 跟你实际在忙什么零关系。
   *
   * **必须过滤。** registry 是「派过活的目录」，不是「项目列表」——
   * 这台机器上它就躺着 `Desktop`、`music`（音乐文件夹）、`.testproj`（测试残留）。
   * 不筛的话她会一本正经地说「music 你三天没碰了，要不要接着弄」，
   * 而桌宠说傻话比不说话更掉分。判据用「目录里有 .git 或 package.json」，
   * 顺带也挡掉了盘符没挂、目录被删的情况。
   *
   * @param {object} o
   * @param {number} o.limit  最多报几个
   * @param {number} o.maxDays 超过这么多天没碰就不提了
   * @param {number} o.now    注入时钟，给自检用
   */
  recentProjects({ limit = 4, maxDays = 30, now = Date.now() } = {}) {
    return this.knownProjects()
      .filter((p) => {
        // 判据是 lastRun，**不能是 turns**。
        // turns 会被 _resumableRecord 在会话丢失时归零 —— 而会话丢了不等于
        // 这个项目不存在。用 turns 判断的话，凡是记忆断过的项目都会从她眼里消失，
        // 偏偏那些正是你最近在弄的。
        if (!p.lastRun) return false;
        try {
          return fs.existsSync(path.join(p.path, '.git')) ||
                 fs.existsSync(path.join(p.path, 'package.json'));
        } catch (_) {
          return false;
        }
      })
      .map((p) => ({ ...p, days: (now - Date.parse(p.lastRun)) / 86400000 }))
      .filter((p) => isFinite(p.days) && p.days >= 0 && p.days < maxDays)
      .sort((a, b) => a.days - b.days)
      .slice(0, limit)
      .map((p) => {
        const when =
          p.days < 0.5 ? '今天刚弄过' :
          p.days < 1.5 ? '昨天弄的' :
          '凉了 ' + Math.round(p.days) + ' 天';
        return p.name + '（' + when + '）';
      });
  }

  stop(key) {
    const s = this.sessions.get(key);
    if (!s) return false;
    try {
      s.proc.kill();
    } catch (_) {
      /* 已经死了就算了 */
    }
    return true;
  }

  stopAll() {
    for (const key of Array.from(this.sessions.keys())) this.stop(key);
  }
}

module.exports = {
  SessionManager, resolveClaudeBin, claudeInstalled, sessionExists, projectStoreDir,
};
