'use strict';

// 她给每个项目攒的一张小抄。
//
// 【为什么有这东西】开终端已经不再 `--resume` 上次那条会话了（你要的：每次
// 都是干净的一条，想接着聊自己敲 /resume）。代价是她每次开局对项目一无所知。
//
// 补法不是把整段对话读回来，而是攒一张**几百字**的小抄：上次干到哪儿、卡在哪儿。
// 差别是数量级的 —— 一段普通会话落盘 2~6 万 token，隔天开必然冷缓存，
// 一次就是三毛到一块五；小抄封顶七百 token，一次约两分钱，而且**是封顶的**。
//
// 【料从哪儿来 · 这是关键】每段活干完她本来就要跟你汇报一句，那句话是现成的、
// 钱早付过了。顺手写进小抄 = **攒小抄这件事一分钱不花**。
// 不去让她「总结一下这个项目」——那要额外花钱，而且她多半会把 CLAUDE.md
// 里已经写着的东西重新推导一遍。
//
// 【上下两段】文件被一行标记切开：**标记以上是你写的，她永远不动**；
// 标记以下是她攒的，每次重建。所以你可以在上半段写「这项目是干嘛的」
// 「我反复强调过的规矩」，不会被她冲掉。
//
// 【绝不把正文当命令行参数传】只传文件路径。npm 装的 claude 是 .cmd，
// term-shell 那边 spawn 走 shell:true，而 Node 在 shell 模式下是把 args
// 用空格拼成一条命令行、**零转义** —— 小抄里的换行会被 cmd 当成第二条命令跑，
// 而内容还是模型生成的。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_ROOT } = require('./paths');
// 打码用流水那边现成的：密钥、绝对路径一套规则，没理由维护两份
const { redact } = require('./journal');

const DIR = path.join(DATA_ROOT, 'sessions', 'notes');

// 全部机关就在这一行上。改它等于把所有人已有小抄的分界线弄丢，别改。
const MARK = '<!-- ▼ 以下由她自动维护，会被覆盖，别在这行下面手写 ▼ -->';

const KEEP = 6;        // 自动段留几条
const TEXT_MAX = 120;  // 她那句汇报截到多少字
const LINE_MAX = 160;  // 整行硬上限

/**
 * 一个项目一份。名字 = 看得懂的前缀 + 整条路径的短哈希。
 *
 * **必须小写归一**：你在面板里敲 `d:\waifucode`、右键菜单进来的是
 * `D:\WaifuCode`，不归一就会各攒一份，你永远只看到一半，而且一声不吭。
 *
 * **但绝不能只靠「把非字母数字折成横线」。** 那是个有损映射，会撞：
 *
 *     D:\项目\登录页  D:\项目\支付页  D:\项目\结算页   →  全都是 d--------.md
 *     D:\work\api     D:\work-api                    →  都是 d--work-api.md
 *
 * 撞了不是显示错乱那么简单：在「支付页」开终端时，「登录页」攒的那份会被当成
 * `--append-system-prompt-file` **发给 Anthropic** —— 另一个项目的进度和原话，
 * 送进一个不相干的会话；而且 append 是整份重写，两个项目的记录互相顶掉。
 * 这个产品面向中文用户，中文目录名一撞一个准。
 *
 * 所以前缀只求可读（能在文件夹里认出是哪个项目），**唯一性交给哈希**。
 */
function notesFile(dir) {
  const full = path.resolve(dir).toLowerCase();
  const readable = path.basename(full).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proj';
  const sig = crypto.createHash('sha1').update(full).digest('hex').slice(0, 10);
  return path.join(DIR, readable.slice(0, 24) + '-' + sig + '.md');
}

function defaultHead(dir) {
  return [
    '# 小抄 · ' + path.basename(path.resolve(dir)),
    '',
    '> 这张小抄每次开终端都会一起递给她（约 2 分钱一次）。',
    '> **上半段是你写的，她永远不动**；下半段是她自己攒的，只留最近 ' + KEEP + ' 条。',
    '> 写脏了、写错了，打开删掉就行。你自己每多写 1000 字，大约再多 3 分钱一次。',
    '',
    '## 你要她记住的',
    '',
    '（这个项目是干嘛的、你反复强调过的规矩，写在这儿。',
    '不写也行 —— 项目里的 CLAUDE.md 她本来就会自己读。）',
    '',
  ].join('\n');
}

/**
 * 读出来，切成「你写的」和「她攒的」两半。
 *
 * 标记找不到时**整份都算你写的** —— 你手滑把那行删了，绝不能因此把你写的
 * 东西整份覆盖掉。下次 append 会把标记和自动段接回文件末尾。
 */
function read(dir) {
  let text = '';
  try {
    text = fs.readFileSync(notesFile(dir), 'utf8').replace(/^\uFEFF/, '');
  } catch (_) {
    return { head: '', lines: [] };
  }
  const i = text.indexOf(MARK);
  if (i < 0) return { head: text, lines: [] };
  const lines = text.slice(i + MARK.length)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));
  return { head: text.slice(0, i), lines };
}

/**
 * 把她那句汇报压平成一行。
 *
 * 她汇报时经常是 markdown（`## 一句话`、`**310MB**`、`---` 分隔线、代码块）。
 * 原样塞进小抄有两个坏处：看着乱，而且那些标记**白占字数** ——
 * 每条只留 120 字，标记吃掉十几个，等于少记十几个字的实际内容。
 */
function flatten(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, ' ')  // 代码块整块扔掉，小抄不是放代码的地方
    .replace(/^[#>\s|-]+/gm, ' ')     // 标题、引用、分隔线、表格线
    .replace(/[*`_~]/g, '')           // 强调标记
    .replace(/\s+/g, ' ')
    .trim();
}

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 记一条。entry 给 null 就只是把默认头部落出来（点「打开小抄」时用）。
 *
 * 永不抛错：小抄是可丢的东西，写不进去不该拖垮任何流程。
 */
function append(dir, entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const cur = read(dir);
    const head = cur.head.trim() ? cur.head : defaultHead(dir);
    const lines = cur.lines.slice();

    if (entry && entry.text) {
      // task 是**你在终端里敲的原话**，同样得过一遍打码 ——
      // 「把 D:\密项目\x 的 token=abc 换掉」这种任务描述天天有
      const task = redact(String(entry.task || '')).replace(/\s+/g, ' ').trim().slice(0, 14);
      const said = flatten(redact(String(entry.text))).slice(0, TEXT_MAX);
      const bad = entry.errorCount ? '；中间报了错' : '';
      const line = ('- ' + stamp(entry.at || Date.now()) +
                    (task ? ' · ' + task : '') + ' → ' + said + bad).slice(0, LINE_MAX);
      lines.push(line);
    }

    const body = [
      head.replace(/\s+$/, ''),
      '',
      MARK,
      '## 最近干到哪儿了',
      '',
      ...lines.slice(-KEEP),
      '',
    ].join('\n');

    fs.writeFileSync(notesFile(dir), body, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 开终端时要多带的参数。没有小抄就**一个参数都不多传** ——
 * 全新项目的行为跟没这个功能时一模一样。
 *
 * `--append-system-prompt-file` 在 `claude --help` 里看不到（隐藏参数），
 * 2.1.225 实测存在（喂空值它会回 "option ... argument missing"）。
 * tools/test-notes.js 里有一条免费探测钉着它，哪天官方拿掉了自检会先红。
 */
function fileFor(dir) {
  const cur = read(dir);
  // **只有真攒下东西了才给。** 判据不能是「文件在不在」：点一下面板上那个 📝
  // 就会给一个从没派过活的项目落出一份只有说明文字的模板 ——
  // 把那段「写给你看的话」塞进她的系统提示，纯属白花钱，对她一点用没有。
  // 你自己在上半段写了规矩的，那当然要带。
  if (!cur.lines.length && cur.head.trim() === defaultHead(dir).trim()) return null;
  if (!cur.lines.length && !cur.head.trim()) return null;
  return notesFile(dir);
}

function argsFor(dir) {
  const f = fileFor(dir);
  return f ? ['--append-system-prompt-file', f] : [];
}

module.exports = { notesFile, fileFor, append, argsFor, read, DIR, MARK, KEEP };
