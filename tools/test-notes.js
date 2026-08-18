'use strict';

// 项目小抄：**你写的那半段一个字都不许动**，她那半段只留最近几条。
//
// 两条生死线：
//   · 路径归一 —— 折不对就是同一个项目攒出两份小抄，你永远只看到一半，还一声不吭
//   · 传给 claude 的参数里绝不能出现 --setting-sources（那会让 5 个 hook 静默失效，
//     整个监督功能全废，而且不报任何错）。这条拿测试焊死。
//
// 不花钱、不起会话、一瞬间跑完。

const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require 之前设 —— paths.js 是加载时读这个变量算 DATA_ROOT 的
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-notes-'));
process.env.WAIFU_HOME = HOME;

const notes = require('../src/notes');
const { resolveClaudeBin } = require('../src/sessions');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

process.on('exit', () => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
});

const PROJ = path.join(HOME, 'proj');
fs.mkdirSync(PROJ, { recursive: true });
const textOf = (dir) => fs.readFileSync(notes.notesFile(dir), 'utf8');

// ---------------------------------------------------------------------------

console.log('\n[0] 路径归一：同一个项目只能有一份小抄');
{
  const a = notes.notesFile('D:\\WaifuCode');
  const b = notes.notesFile('d:/waifucode');
  const c = notes.notesFile('D:\\WaifuCode\\');
  check(a === b && b === c,
        '**大小写、斜杠、末尾分隔符都归一** —— 折不对就是攒出两份，你只看得到一半');
  check(!/[^a-z0-9\-.\\/:]/.test(path.basename(a)), '文件名里只有小写字母数字和横线：' + path.basename(a));

  // 反过来那一半：**不同项目绝不能折成同一份**。
  // 这条破了不是显示错乱 —— 在 B 项目开终端时，A 项目攒的进度会被当成
  // system prompt 发给 Anthropic，两个项目的记录还互相顶掉。
  const names = [
    'D:\\项目\\登录页', 'D:\\项目\\支付页', 'D:\\项目\\结算页',
    'D:\\后台', 'D:\\前端',
    'D:\\work\\api', 'D:\\work-api',
    'E:\\chao-tool', 'E:\\chao_tool',
    'D:\\proj\\web-app', 'D:\\proj\\web app', 'D:\\proj\\web.app',
  ];
  const files = names.map(notes.notesFile);
  check(new Set(files).size === names.length,
        '**' + names.length + ' 个不同的项目 → ' + new Set(files).size + ' 份不同的小抄**（中文名、只差标点的名，全都不许撞）');
  check(/登录页|proj/.test('x') || path.basename(files[0]).length > 12,
        '文件名里还留着能认人的前缀：' + path.basename(files[5]));
}

console.log('\n[1] 全新项目：一个参数都不多传');
{
  check(notes.argsFor(PROJ).length === 0,
        '**没有小抄就什么都不传** —— 全新项目的行为跟没这功能时一模一样');

  // 点一下面板上那个 📝 会落出一份只有说明文字的模板。
  // 那段是**写给你看的**，塞进她的系统提示纯属白花钱
  const P0 = path.join(HOME, 'proj0');
  fs.mkdirSync(P0, { recursive: true });
  notes.append(P0, null);
  check(fs.existsSync(notes.notesFile(P0)), '点开小抄 → 文件落出来了（不然打开的是个不存在的文件）');
  check(notes.argsFor(P0).length === 0,
        '**但光有那份空模板不带进终端** —— 那段说明对她一点用没有，白花钱');

  // 你自己在上半段写了规矩 → 那当然要带
  fs.writeFileSync(notes.notesFile(P0),
    '## 你要她记住的\n\n这项目别动 C 盘。\n' + notes.MARK + '\n', 'utf8');
  check(notes.argsFor(P0).length === 2, '你自己写了东西 → 就算她还没攒过，也照样带上');
}

console.log('\n[2] 她攒的那半段：只留最近 6 条');
{
  for (let i = 1; i <= 9; i++) {
    notes.append(PROJ, { task: '第' + i + '件事', text: '干完了第 ' + i + ' 件', at: Date.now() + i * 1000 });
  }
  const lines = textOf(PROJ).split('\n').filter((l) => l.trim().startsWith('- '));
  check(lines.length === 6, '写了 9 条，留下 ' + lines.length + ' 条');
  check(lines.some((l) => l.includes('第 9 件')), '**留下的是最近的**');
  check(!lines.some((l) => l.includes('第 1 件')), '最早的被顶掉了');
  check(lines.every((l) => l.length <= 160), '每行都有硬上限，不会被一句长汇报撑爆');
}

console.log('\n[3] 你写的那半段，一个字都不许动');
{
  const cur = textOf(PROJ);
  const mine = '## 你要她记住的\n\n这项目是 Live2D 桌宠。\n**别再往 C 盘装东西。**\n\n改配置一律用 node 写。\n';
  fs.writeFileSync(notes.notesFile(PROJ),
    cur.slice(0, cur.indexOf(notes.MARK)).split('## 你要她记住的')[0] + mine + '\n' +
    cur.slice(cur.indexOf(notes.MARK)), 'utf8');

  notes.append(PROJ, { task: '又干了点活', text: '这次改了三个文件' });
  const after = textOf(PROJ);
  check(after.includes('**别再往 C 盘装东西。**'), '你写的那句原文还在');
  check(after.includes('改配置一律用 node 写。'), '空行隔开的那段也在');
  check(after.includes('这次改了三个文件'), '她那条也加上了');
}

console.log('\n[4] 标记行被你手滑删了，也不许把你写的吃掉');
{
  const t = textOf(PROJ).replace(notes.MARK + '\n', '');
  fs.writeFileSync(notes.notesFile(PROJ), t, 'utf8');
  notes.append(PROJ, { task: '再来一条', text: '标记没了也得活' });
  const after = textOf(PROJ);
  check(after.includes('**别再往 C 盘装东西。**'),
        '**你写的东西还在** —— 找不到标记就整份当成你写的，绝不覆盖');
  check(after.includes(notes.MARK), '标记被接回去了');
  check(after.includes('标记没了也得活'), '新的一条也进去了');
}

console.log('\n[5] 打码：密钥和绝对路径不许沉淀进去');
{
  const P2 = path.join(HOME, 'proj2');
  fs.mkdirSync(P2, { recursive: true });
  notes.append(P2, {
    task: '接口对接',
    text: '把 sk-ant-api03-abcdefghijklmnop 换掉了，改的是 D:\\WaifuCode\\src\\main.js',
  });
  const t = textOf(P2);
  check(!t.includes('sk-ant-api03-abcdefghijklmnop'), '**密钥摘掉了**');
  check(!t.includes('D:\\WaifuCode\\src\\main.js'), '**绝对路径压掉了**');
  check(t.includes('接口对接'), '正经内容还在');
}

console.log('\n[6a] 她汇报的 markdown 要压平（那些标记白占字数）');
{
  const P4 = path.join(HOME, 'proj4');
  fs.mkdirSync(P4, { recursive: true });
  notes.append(P4, {
    task: '看看能优化啥',
    text: '## 一句话\n\n先别做工具。有 **310MB** 白装进每个包。\n\n---\n\n```js\nconst x = 1;\n```\n\n> 引用的话',
  });
  const line = textOf(P4).split('\n').find((l) => l.trim().startsWith('- ')) || '';
  check(!/[#*`>]/.test(line), '**井号星号反引号全没了**：' + line.slice(0, 60));
  check(!line.includes('const x'), '代码块整块扔掉了（小抄不是放代码的地方）');
  check(line.includes('310MB'), '正经内容还在');
  check(line.split('\n').length === 1, '压成了一行');
}

console.log('\n[6] 报错了要留个记号（下次开局她才知道上次卡哪儿）');
{
  const P3 = path.join(HOME, 'proj3');
  fs.mkdirSync(P3, { recursive: true });
  notes.append(P3, { task: '修那个崩溃', text: '试了两个方向都不行', errorCount: 3 });
  check(textOf(P3).includes('中间报了错'), '带上了「中间报了错」');
}

console.log('\n[7] 有小抄了才传参数，而且绝不能带上那个致命开关');
{
  const args = notes.argsFor(PROJ);
  check(args.length === 2 && args[0] === '--append-system-prompt-file',
        '传的是 ' + args[0]);
  check(args[1] === notes.notesFile(PROJ), '第二个参数是小抄的路径');
  check(!JSON.stringify(args).includes('--setting-sources'),
        '**一个字都不许出现 --setting-sources** —— 终端那条链加了它，5 个 hook 会静默失效，监督全废');
  check(!/\n/.test(args.join('')),
        '**参数里不许有换行** —— term-shell 那边 shell:true 零转义，换行会被 cmd 当成第二条命令跑');
}

console.log('\n[8] claude 还认不认这个参数（隐藏参数，help 里查不到）');
{
  let bin = null;
  try { bin = resolveClaudeBin(); } catch (_) { /* 没装 */ }
  if (!bin) {
    console.log('  \x1b[90m–\x1b[0m 这台机器上没找到 claude，跳过');
  } else {
    let out = '';
    try {
      require('child_process').execFileSync(bin, ['--append-system-prompt-file'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = String((err && (err.stderr || err.stdout)) || '');
    }
    check(/argument missing/i.test(out) && !/unknown option/i.test(out),
          '**参数还在**（缺值报错 = 认识它）。哪天官方拿掉了，这条会先红，' +
          '而不是等你开终端时撞一行红字：' + out.trim().slice(0, 80));
  }
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
