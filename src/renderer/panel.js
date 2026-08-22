'use strict';

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  normal: '平静',
  working: '干活中',
  excited: '来劲了',
  frustrated: '烦躁',
  sad: '低落',
  lonely: '闹脾气',
  happy: '开心',
  proud: '得意',
  surprised: '吃惊',
  shy: '害羞',
  tired: '累了',
  sleepy: '困',
};

const STATE_HINT = {
  frustrated: '　连着报错好几次了，让她缓缓',
  sleepy: '　精力见底了，歇会儿吧',
  lonely: '　你好久没搭理她了',
  tired: '　连轴转挺久了',
  proud: '　一遍就过，她正得意',
};

function setMood(s) {
  if (!s) return;
  $('v-energy').textContent = s.energy;
  $('v-mood').textContent = s.mood;
  $('v-aff').textContent = s.affection;
  $('b-energy').style.width = s.energy + '%';
  $('b-mood').style.width = s.mood + '%';
  $('b-aff').style.width = s.affection + '%';
  $('state').textContent = STATE_TEXT[s.state] || s.state;
  $('hint').textContent = STATE_HINT[s.state] || '';
}

let msgTimer = null;

/**
 * 面板上那行提示。
 *
 * **必须会自己消失。** 它说的是「你刚才那一下的结果」，几秒之后就变成误导了 ——
 * 你早就在干别的，它还挂着上一次的报错，看着像是这会儿又出错了。
 */
function msg(text, kind, holdMs, action) {
  const el = $('msg');
  clearTimeout(msgTimer);
  el.textContent = text || '';
  el.className = kind || '';
  if (!text) return;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = action.run;
    el.appendChild(b);
  }
  // 报错留久一点（你可能要照着它去查），普通提示看一眼就够
  const hold = holdMs || (kind === 'err' ? 9000 : 5000);
  msgTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, hold);
}

// 报错带按钮：guard 拦下来的结果里有 missing（claude/codex）就长出「帮我装」
function showErr(r, fallback) {
  if (r && r.missing) {
    msg(r.error, 'err', 60000, { label: '帮我装', run: () => startInstall(r.missing) });
  } else {
    msg((r && r.error) || fallback || '出错了', 'err');
  }
}

function startInstall(agent) {
  window.waifu.installAgent(agent).then((r) => {
    if (r && r.ok) msg('装着呢……装好她会喊你，一般一两分钟，网络慢会更久', 'ok', 600000);
    else msg((r && r.error) || '没装上', 'err');
  });
}

// --- 运行中的会话列表 -------------------------------------------------------

function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}

// 美元换人民币。差 5% 不影响判断，为它加个配置项不值
const USD_CNY = 7.2;

function money(usd) {
  if (!usd) return null; // 「花了 还没花钱」很怪，交给调用方换个说法
  const y = usd * USD_CNY;
  return y < 0.01 ? '不到 1 分' : '¥' + y.toFixed(2);
}

async function refreshRunning() {
  const list = await window.waifu.listSessions();
  const box = $('running');

  if (!list.length) {
    box.innerHTML = '<div class="empty">没有（后台派活默认开的是最小化终端，在上面那栏）</div>';
    return;
  }

  box.innerHTML = '';
  for (const j of list) {
    const el = document.createElement('div');
    el.className = 'job';

    const head = document.createElement('div');
    head.className = 't';
    const name = document.createElement('span');
    name.className = 'n';
    name.textContent = j.name;
    const stop = document.createElement('button');
    stop.textContent = '停';
    stop.onclick = async () => {
      await window.waifu.stopSession(j.key);
      refreshRunning();
    };
    head.append(name, stop);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      fmtDur(j.elapsedMs) + ' · 动了 ' + j.toolCount + ' 次工具' +
      (j.errorCount ? ' · 报错 ' + j.errorCount + ' 次' : '');

    const desc = document.createElement('div');
    desc.className = 'd';
    desc.textContent = j.task;
    desc.title = j.task;

    el.append(head, meta, desc);
    box.appendChild(el);
  }
}

// --- 开着的终端 -------------------------------------------------------------
//
// 这一块回答的是「我到底同时开了几个终端在干活」。
// 点一条就把那个终端窗口捞到最前面来 —— 开多了之后一个个去任务栏里翻很痛苦。

const TERM_STATUS = {
  running: { cls: 'run', text: '干着呢' },
  waiting: { cls: 'wait', text: '在等你确认' },
  idle: { cls: 'idle', text: '这轮完事了' },
  // 活干完了，但窗口还开着等你看结果。窗口一关这条就自己没了。
  done: { cls: 'idle', text: '干完了，窗口还开着' },
  // 窗口都关了、活也结束了。这条**留着**是为了你回头能看到结果 ——
  // 以前窗口一关整条就没了，干成什么样再也查不到
  closed: { cls: 'closed', text: '已完成' },
};

async function refreshTerms() {
  const list = await window.waifu.listTerminals();
  const box = $('terms');
  const badge = $('term-count');

  const live = list.filter((t) => t.status !== 'done' && t.status !== 'closed');
  badge.textContent = live.length;
  badge.className = 'count' + (live.length ? '' : ' zero');

  if (!list.length) {
    box.innerHTML = '<div class="empty">还没派活。点一条就能把那个终端调出来看现场</div>';
    return;
  }

  box.innerHTML = '';
  for (const t of list) {
    const st = TERM_STATUS[t.status] || TERM_STATUS.idle;

    const el = document.createElement('div');
    el.className = 'term ' + st.cls;
    el.title = t.dir + (t.laneName ? '\n这条线：' + t.laneName : '') + '\n' +
      (t.status === 'closed'
        ? (t.laneId
            ? (t.agent === 'codex'
                ? (t.codexSessionId
                    // 认领到会话文件了，codex resume 能真接上
                    ? '点一下重开这条线（接上上次那条 Codex 会话）'
                    : '点一下照这条线重开一个 Codex 终端（上次的会话没认领到，是新开一条）')
                : '点一下重开这条线，她还记得你们之前聊到哪儿')
            : '这条已经结束了')
        : '点一下把这个终端窗口调到最前面');

    el.onclick = async () => {
      if (t.status === 'closed') {
        // 线还留着就能回去 —— 重开一个终端，--resume 那条线自己的会话
        if (!t.laneId) { msg('这个活已经干完了，窗口也关了', 'ok'); return; }
        msg('正在把「' + (t.laneName || t.name) + '」那条线捡回来…');
        const r = await window.waifu.openTerminal({
          projectPath: t.dir, laneId: t.laneId, laneName: t.laneName, task: '',
          // **必须带这条线自己的 agent**，不带就回落到「记住的全局默认」——
          // 你切过一次 codex 之后，claude 老线会被当成全新 codex 会话打开，
          // 明明能 --resume 的记忆就这么丢了（评审抓出来的）
          agent: t.agent || 'claude',
        });
        if (r && r.ok) {
          // **说实话**：撞上一个还开着的窗口时是「调过去」，不是「重开并接上」。
          // 而且要说清是**哪条线**的窗口 —— 第二道闸（按真实会话判重）命中时，
          // 调出来的往往是另一条线：你在那条线的窗口里 /resume 到了这条会话
          msg(r.focused
            ? (r.otherLane
                ? '这条会话正被「' + (r.focusedLane || '另一条线') + '」那个窗口写着，给你调过去了'
                : '这条线的窗口本来就开着，给你调到最前面了')
            : t.agent === 'codex'
              ? (t.codexSessionId
                  ? '回到「' + (t.laneName || t.name) + '」了，接上了上次那条 Codex 会话'
                  : '照「' + (t.laneName || t.name) + '」重开了一条 Codex 的线（上次的会话没认领到，这是新开的）')
              : '回到「' + (t.laneName || t.name) + '」了，她还记得你们聊到哪儿', 'ok');
          refreshTerms();
        } else {
          msg((r && r.error) || '这条线捡不回来了', 'err');
        }
        return;
      }
      const r = await window.waifu.focusTerminal(t.id);
      if (!r || !r.ok) msg((r && r.error) || '没找到那个窗口', 'err');
    };

    const head = document.createElement('div');
    head.className = 't';

    const led = document.createElement('span');
    led.className = 'led';

    // 项目名 + 线名分开显示。同目录几条线的项目名是一样的，
    // **线名才是你用来区分它们的东西**，所以单独给个色块拎出来
    const name = document.createElement('span');
    name.className = 'n';
    name.textContent = t.project || t.name;
    if (t.laneName) {
      const lane = document.createElement('span');
      lane.className = 'lane';
      lane.textContent = t.laneName;
      lane.title = t.laneName;
      name.appendChild(lane);
    }

    const go = document.createElement('span');
    go.className = 'go';
    // 已完成但那条线还留着 → 点它是「回到那条线接着聊」，不是「调窗口」
    go.textContent = t.status === 'closed'
      ? (t.laneId ? '接着聊 ↻' : '')
      : '调到最前 ↗';

    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = '从列表里去掉（不会关掉那个窗口）\n窗口关掉的话这条会自己消失';
    x.onclick = async (e) => {
      e.stopPropagation();
      await window.waifu.forgetTerminal(t.id);
      refreshTerms();
    };

    head.append(led, name, go);

    // 干完的活「照这个再来一次」。目录和当初派的活都还记着，不用重敲一遍 ——
    // 同一件事跑第二遍（换个分支、改完再验一次）是最常见的重复劳动。
    // **开的是全新一条线**，不是接着上次那条：要接着聊，点整条走「接着聊 ↻」
    if (t.status === 'closed' && t.dir && t.task) {
      const again = document.createElement('button');
      again.className = 'x again';
      again.textContent = '再来';
      again.title = '照这条原样再派一次（新开一条线）：\n' + t.task;
      again.onclick = async (e) => {
        e.stopPropagation();
        const r = await window.waifu.openTerminal({
          projectPath: t.dir, task: t.task, laneName: t.laneName || '',
          permissionMode: $('perm').value || undefined,
          // 不带 model 这个键：主进程回落到记住的默认。带面板此刻的值是错的 ——
          // 面板停在 codex 档时下拉被清成空，会把记住的模型洗掉（评审抓出来的）
          agent: t.agent || 'claude',
        });
        if (r && r.ok) {
          msg('照「' + (t.laneName || t.name) + '」又派了一次', 'ok');
          refreshTerms();
        } else {
          showErr(r, '没派出去');
        }
      };
      head.appendChild(again);
    }

    head.appendChild(x);

    const meta = document.createElement('div');
    meta.className = 'meta';
    // 已完成的那条要把"干成什么样"摆出来 —— 窗口都没了，这是唯一的痕迹
    meta.textContent =
      st.text + ' · ' + fmtDur(t.elapsedMs) +
      (t.turns ? ' · 聊了 ' + t.turns + ' 轮' : '') +
      (t.toolCount ? ' · 动了 ' + t.toolCount + ' 次工具' : '') +
      (t.errorCount ? ' · 报错 ' + t.errorCount + ' 次' : '');

    // codex 的线打个小牌。汇报、金额、接着聊都有了（靠读它的会话档案）；
    // 还缺的只有护栏 —— 那要在她动手**之前**报警，档案是干完才写的，拦不了
    if (t.agent === 'codex') {
      const b = document.createElement('span');
      b.className = 'cost';
      b.textContent = 'codex';
      b.title = 'Codex 开的线：做完一段她会来汇报，金额按 OpenAI 官方单价折算。\n' +
        (t.codexSessionId || t.costUsd > 0
          ? '护栏（动手前的报警）只有 Claude 线有 —— 档案是干完才写的，拦不了'
          : '这条线还没认领到 Codex 的会话档案：汇报和金额都要等认领到才有');
      meta.appendChild(b);
    }

    // 这条线烧了多少钱。claude 读它自己的会话记录；codex 读 rollout 里的
    // 累计 token（认领到文件才有数，认领不到就是 0，不显示 —— 不编数）
    const cost = money(t.costUsd);
    if (cost) {
      const c = document.createElement('span');
      c.className = 'cost';
      c.textContent = cost;
      c.title = '这条线到现在烧了多少（按官方 API 单价折算）';
      meta.appendChild(c);
    }

    el.append(head, meta);

    /**
     * 她动过哪些文件。
     *
     * 「动了 8 次工具」你没法验证，「改了 profiles.js、stage.js」你可以 ——
     * 这一排是她干了什么最硬的证据，点一下还能直接跳到那个文件。
     * 改得最多的排在前面，那个通常就是这轮的主角。
     */
    if (t.files && t.files.length) {
      const box = document.createElement('div');
      box.className = 'files';
      for (const f of t.files) {
        const chip = document.createElement('span');
        chip.className = 'f';
        chip.textContent = f.name + (f.hits > 1 ? ' ×' + f.hits : '');
        chip.title = f.path + '\n点一下在资源管理器里打开';
        chip.onclick = async (e) => {
          e.stopPropagation(); // 别顺带把整条的「调窗口」也触发了
          const r = await window.waifu.revealFile(f.path);
          if (r && !r.ok) msg(r.error || '打不开这个文件', 'err');
        };
        box.appendChild(chip);
      }
      if (t.fileCount > t.files.length) {
        const more = document.createElement('span');
        more.className = 'f more';
        more.textContent = '还有 ' + (t.fileCount - t.files.length) + ' 个';
        box.appendChild(more);
      }
      el.appendChild(box);
    }

    // 最近一次阶段汇报。没有的话就显示当初派的活，总比空着强。
    const line = t.lastReport || t.task;
    if (line) {
      const p = document.createElement('div');
      p.className = 'phase';
      p.textContent = line;
      el.appendChild(p);
    }

    box.appendChild(el);
  }
}

/**
 * 「今天」那一栏 —— 全是本地算出来的，**看一百遍也不花钱**。
 *
 * 这一栏以前只报得出三笔（私聊、主动搭话、后台派活），因为她开出去的终端是
 * 独立的 claude 进程，hook 事件里一个成本字段都没有。现在连终端里那笔也算进来了
 * —— 去读 Claude Code 自己写的会话记录（src/cost.js）。
 *
 * 「还有几轮没算钱」那句留着：真有算不出来的时候（没装 Claude Code、
 * 记录还没落盘），宁可摆明少算，也不编一个数字。
 */
// 项目名和线名是**你自己敲进去的**，里面可能有 < & 这种字符。
// 这一栏是 innerHTML 拼的，不转义的话轻则显示错乱、重则往面板里注入标签
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function refreshToday() {
  const box = $('today');
  if (!box) return;
  const r = await window.waifu.journalToday();
  const t = r && r.today;
  if (!t) { box.textContent = '今天还没开工。'; return; }

  const bits = [];
  if (t.terms) bits.push('<b>' + t.terms + '</b> 摊活');
  if (t.turns) bits.push('<b>' + t.turns + '</b> 轮');
  if (t.tools) bits.push('<b>' + t.tools + '</b> 次工具');
  if (t.errors) bits.push('报错 <b>' + t.errors + '</b> 次');
  if (t.projects.length) bits.push(esc(t.projects.slice(0, 3).join('、')));

  const head = bits.length ? '今天：' + bits.join(' · ') : '今天还没开工。';

  const day = money(t.costUsd);
  const mon = r.month ? money(r.month.costUsd) : null;
  const cost = day
    ? '今天花了 <span class="money">' + day + '</span>' +
      (mon ? '，本月 <span class="money">' + mon + '</span>' : '')
    : '今天还没花钱' + (mon ? '，本月 <span class="money">' + mon + '</span>' : '');

  const note = (t.unpriced ? '另有 ' + t.unpriced + ' 轮没算出钱来（那几条线的记录还没落盘）。' : '') +
               // days 是 0 也要显示（装好第一天就是「认识第 1 天」），
               // 写成 `r.days ?` 的话 0 被当假值整条吞掉
               (r.days != null ? '认识第 ' + (r.days + 1) + ' 天。' : '');
  const stuck = t.stuck
    ? '　卡得最凶：' + esc(t.stuck.lane || t.stuck.project) + '（报错 ' + t.stuck.errors + ' 次）'
    : '';

  box.innerHTML = head + stuck + '<br>' + cost +
                  (note ? '<span class="note">' + note + '</span>' : '') +
                  (t.milestones || []).map((m) => '<span class="mark">🎉 ' + esc(m) + '</span>').join('');
}

async function refreshRecent() {
  const projects = await window.waifu.listProjects();
  const box = $('recent');
  box.innerHTML = '';
  // 最近用过的排前面，只留 6 个免得挤爆
  projects
    .sort((a, b) => String(b.lastRun || '').localeCompare(String(a.lastRun || '')))
    .slice(0, 6)
    .forEach((p) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = p.name;
      c.title = p.path + '（聊过 ' + p.turns + ' 轮）';
      c.onclick = () => { $('dir').value = p.path; refreshGit(); };

      // 小抄入口。一份你看不见也改不了的「她的记忆」是危险的 —— 错了会一直错下去
      const n = document.createElement('span');
      n.textContent = ' 📝';
      n.style.cssText = 'opacity:.55';
      n.title = '打开这个项目的小抄 —— 她攒的，你能改、能清';
      n.onclick = (e) => { e.stopPropagation(); window.waifu.openNotes(p.path); };
      c.appendChild(n);

      box.appendChild(c);
    });
}

// --- 派活 -------------------------------------------------------------------

/**
 * 从任务描述里挑个线名。
 *
 * 同一个目录能同时开好几条线，任务栏里全靠这个名字区分。你开好几个终端
 * 本来就是为了问不同的问题，**问题本身就是最好的名字** —— 所以默认不让你
 * 多敲一个字，名字框自动跟着任务描述走。你想改随时改，改过之后就不再自动覆盖。
 *
 * 这份逻辑跟主进程 laneNameFromTask() 是同一套规则。之所以两边都有：
 * 这边管的是**你看得见的那个值**（要边打字边变），主进程那份只是兜底 ——
 * 有些入口（右键直接开终端）根本没经过这个面板。
 */
function deriveLaneName(task) {
  const first = String(task || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return first.replace(/^(帮我|请|麻烦|你|能不能|可以|然后)+/g, '').trim().slice(0, 14);
}

// 你手动改过名字之后就别再自动覆盖了 —— 打了一半的名字被冲掉最气人
let laneTouched = false;

function syncLaneName() {
  if (laneTouched) return;
  $('lane').value = deriveLaneName($('task').value);
}

function readForm() {
  const dir = $('dir').value.trim();
  const task = $('task').value.trim();
  if (!dir) { msg('先指定项目目录', 'err'); return null; }
  if (!task) { msg('还没说要干什么活', 'err'); return null; }
  return {
    projectPath: dir,
    task,
    laneName: $('lane').value.trim(),
    // 空 = 用设置里的默认值。**只影响这一次**，不动 config.json
    permissionMode: $('perm').value || undefined,
    // 模型跟权限不一样：**选一次就记住**（主进程存进 config），
    // 后台干 / 开终端 / 右键菜单派活从此都默认用它
    model: $('model').value,
    // 用谁来干（claude / codex），同样是选一次就记住
    agent: $('agent').value,
  };
}

/**
 * 「用谁来干」一换，模型下拉跟着变脸：codex 不认 claude 的模型名，
 * 模型跟它自己的 ~/.codex/config.toml 走 —— 下拉灰掉、第一项换个说法。
 * 切回来时把你之前选的模型还回去（不然摸一下 codex 就把记住的模型洗没了）。
 *
 * 权限那四条也得换脸，但**不是灰掉，是改说法** —— 它在 codex 上是真生效的
 * （命令行逐键压过 config.toml），只是四档的含义跟 claude 对不上：
 *   · 「改文件不问」在 codex 上**跟「自己判断」一模一样** —— 它的 -a 只有
 *     untrusted / on-request / never 三档，拆不出「改文件不问但跑命令要问」。
 *     不写清楚的话，你照着说明去分辨这两档，只会得出「选哪个都没区别」。
 *   · 「先出方案」在 codex 上是「什么都问你 + 一个字不许写」，codex 没有
 *     plan 模式。歪的不止一条，所以四条一起换。
 */
const PERM_CODEX = {
  '': '按设置里的默认',
  auto: '自己判断 · 拿不准的才问你，只能改这个项目目录',
  acceptEdits: '跟「自己判断」完全一样 · Codex 拆不出这一档',
  plan: '只读 · 一个字都不许改，而且干什么都先问你',
  dontAsk: '全都别问 · 但仍然只能改这个项目目录',
};
let modelBeforeCodex = '';
function syncAgentUi() {
  const codex = $('agent').value === 'codex';
  const model = $('model');
  if (codex && !model.disabled) { modelBeforeCodex = model.value; model.value = ''; }
  if (!codex && model.disabled) model.value = modelBeforeCodex;
  model.disabled = codex;
  model.options[0].text = codex
    ? '跟 Codex 自己的设置走（config.toml 里选）'
    : '跟 Claude Code 自己的设置走';
  model.title = codex ? 'Codex 用哪个模型在它自己的配置里选，这儿管不着' : '';

  const perm = $('perm');
  for (const o of perm.options) {
    if (!o.dataset.claude) o.dataset.claude = o.text; // 头一回把原文收起来
    o.text = codex ? (PERM_CODEX[o.value] || o.dataset.claude) : o.dataset.claude;
  }
  perm.title = codex
    ? '这一档会盖过你 ~/.codex/config.toml 里的设置，只管这一次。\n开出来的窗口里会印一行告诉你具体给了什么'
    : '';
}
/**
 * 这个目录现在在哪个分支、有几个文件没提交。
 *
 * 派活之前最该知道的就是这个 —— 在错的分支上让她开工，或者在一堆没提交的
 * 改动上再叠一层，事后收拾起来都很麻烦。不是 git 仓库就整条不显示。
 *
 * 防抖是因为这一栏跟着你打字走：每敲一个字母就 fork 一次 git 太蠢了。
 */
let gitTimer = null;
let gitSeq = 0;

function refreshGit() {
  clearTimeout(gitTimer);
  gitTimer = setTimeout(async () => {
    const box = $('gitinfo');
    if (!box) return;
    const dir = $('dir').value.trim();
    if (!dir) { box.textContent = ''; box.className = 'gitinfo'; return; }

    // 你可能在结果回来之前又改了目录 —— 只认最后一次问的那个答案
    const mine = ++gitSeq;
    const s = await window.waifu.projectStatus(dir);
    if (mine !== gitSeq) return;

    if (!s) { box.textContent = ''; box.className = 'gitinfo'; return; }
    box.className = 'gitinfo' + (s.dirty ? ' dirty' : '');
    box.textContent = s.dirty
      ? '⎇ ' + s.branch + ' · ' + s.dirty + ' 个文件没提交'
      : '⎇ ' + s.branch + ' · 干净';
  }, 400);
}

/**
 * 派完活把输入清干净。
 *
 * 名字框必须跟着一起清、`laneTouched` 也必须复位 —— 不然你下一条活敲进去，
 * 名字框还挂着上一条的名字（因为你上次改过它，自动填就永远不再接管了），
 * 两条线在任务栏里就是同一个名字，正好毁掉这个功能的全部意义。
 */
function clearTask() {
  $('task').value = '';
  $('lane').value = '';
  laneTouched = false;
}

async function doDispatch() {
  const form = readForm();
  if (!form) return;

  $('go').disabled = true;
  msg('正在叫她…');

  const r = await window.waifu.dispatch(form);
  $('go').disabled = false;

  if (r.ok) {
    msg(r.terminal
      // 后台派的活现在是**最小化的真终端** —— 不弹出来烦你，但现场全在。
      // 这句得说清楚，不然你不知道去哪儿看
      ? '她在「' + r.name + '」开工了。终端是最小化开的，想看现场就点下面那条，' +
        '或者在她身上右键 →「看看她在干嘛」'
      : '她已经在「' + r.name + '」里开工了，这条会话跟你当前窗口完全隔离', 'ok');
    clearTask();
    refreshRunning();
    refreshTerms();
    refreshRecent();
  } else {
    showErr(r, '没派出去');
  }
}

async function doTerminal() {
  const dir = $('dir').value.trim();
  if (!dir) { msg('先指定项目目录', 'err'); return; }

  // 开终端时任务描述可以留空 —— 那就只是把窗口开到那个目录，你自己接着聊
  const r = await window.waifu.openTerminal({
    projectPath: dir,
    task: $('task').value.trim(),
    laneName: $('lane').value.trim(),
    permissionMode: $('perm').value || undefined,
    model: $('model').value,
    agent: $('agent').value,
  });

  if (r.ok) {
    // Codex 线三期之后两边待遇一样了，不再分开说
    msg('终端开好了，在「' + r.name + '」目录下。她会盯着，做完一段就来告诉你', 'ok');
    clearTask();
    refreshRecent();
    refreshTerms();
  } else {
    showErr(r, '没派出去');
  }
}

// --- 绑定 -------------------------------------------------------------------

$('close').onclick = () => window.waifu.closePanel();
$('min').onclick = () => window.waifu.minimizePanel();
$('chat').onclick = () => window.waifu.openChat();
$('go').onclick = doDispatch;
$('term').onclick = doTerminal;

$('browse').onclick = async () => {
  const d = await window.waifu.pickFolder();
  if (d) { $('dir').value = d; msg(''); refreshGit(); }
};

// 分支状态跟着目录走（打字、点最近项目、浏览选目录，三条路都要刷）
$('dir').addEventListener('input', refreshGit);

// 名字框跟着任务描述走，直到你自己动它
$('task').addEventListener('input', syncLaneName);
$('lane').addEventListener('input', () => { laneTouched = true; });

// Ctrl+Enter 直接派活，省得每次都去够按钮
$('task').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    doDispatch();
  }
});

window.waifu.on('mood:change', (e) => setMood(e.stats ? { ...e.stats, state: e.state } : e));
window.waifu.on('session:start', () => refreshRunning());
window.waifu.on('session:tool', () => refreshRunning());
window.waifu.on('session:done', (e) => {
  msg(
    '「' + e.name + '」' + (e.ok ? '干完了' : '没干成') +
    '，用时 ' + fmtDur(e.elapsedMs),
    e.ok ? 'ok' : 'err'
  );
  refreshRunning();
});

// 终端那边有任何风吹草动都立刻反映到列表上
window.waifu.on('term:change', () => refreshTerms());
window.waifu.on('agent:install-done', (p) => {
  msg(p.ok ? '装好了！再点一次「派活 / 开终端」就能用'
           : '没装上，原因在她的气泡里', p.ok ? 'ok' : 'err', 20000);
});
window.waifu.on('term:report', (e) => {
  if (e && e.text) msg('「' + e.name + '」' + e.text, 'ok');
  refreshTerms();
});

(async () => {
  // 上次选的模型和皮肤。选项里没有的值（老存档里的脏数据）赋过去会自动
  // 落回空串 / 默认，正好就是「跟设置走」
  try {
    const st = await window.waifu.getSettings();
    const cfg = (st && st.config) || {};
    $('model').value = (cfg.dispatch || {}).model || '';
    modelBeforeCodex = $('model').value;
    $('agent').value = (cfg.dispatch || {}).agent === 'codex' ? 'codex' : 'claude';
    syncAgentUi();
    $('agent').onchange = () => {
    syncAgentUi();
    // 换一下就记住（跟皮肤一个套路，增量合并只碰这一个键）。
    // 特意不放在派活时记：guard 拦下的失败尝试不该改写记住的默认
    window.waifu.saveSettings({ dispatch: { agent: $('agent').value } }).catch(() => {});
  };
    const theme = (cfg.panel || {}).theme;
    if (theme && theme !== 'deep') {
      document.body.dataset.theme = theme;
      $('skin').value = theme;
    }
  } catch (_) { /* 读不到就用默认 */ }

  // 换皮肤：当场生效，顺手记住。saveSettings 底层是 config.patch（增量合并），
  // 只带 panel.theme 这一个键，不会碰配置里别的东西
  $('skin').onchange = () => {
    const v = $('skin').value;
    if (v === 'deep') delete document.body.dataset.theme;
    else document.body.dataset.theme = v;
    window.waifu.saveSettings({ panel: { theme: v } }).catch(() => {});
  };

  setMood(await window.waifu.getMood());
  refreshRecent();
  refreshRunning();
  refreshTerms();
  refreshToday();
  // 在跑的时候刷新耗时显示。「今天」那栏跟着一起刷 —— 它是本地读文件，
  // 不新开定时器也不新开 IPC 广播频道（少一条频道就少一个「忘了加白名单」的雷）
  setInterval(() => { refreshRunning(); refreshTerms(); refreshToday(); }, 3000);
})();
