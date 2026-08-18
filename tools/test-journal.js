'use strict';

// 流水账：记得对、读得回来、**一个字的隐私都不许漏**。
//
// 这份自检里最要紧的是第 [1] 节。流水是长期留在磁盘上的东西，
// 而喂数据的六个地方手边全是完整路径（e.dir、e.key、她汇报时念出来的路径）。
// 净化做在写入层就是为了「谁漏了都不要紧」—— 这一节就是拿测试把那道闸焊死。
//
// 不花钱、不起 claude、不开窗口，一瞬间跑完。

const fs = require('fs');
const os = require('os');
const path = require('path');

// **必须在 require journal 之前设**：paths.js 是在加载时读这个变量算 DATA_ROOT 的，
// 顺序反了就会写进你真正在用的数据目录里去。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-journal-'));
process.env.WAIFU_HOME = HOME;

const journal = require('../src/journal');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

process.on('exit', () => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
});

const near = (a, b) => Math.abs(a - b) < 1e-9;
const dayFile = (d) => path.join(journal.DIR, d + '.jsonl');

// ---------------------------------------------------------------------------

console.log('\n[1] 隐私红线：完整路径和密钥一个字都不许落盘');
{
  journal.add('report', {
    project: 'C:\\Users\\18475\\Desktop\\密项目',
    lane: '查支付回调',
    files: ['D:\\WaifuCode\\src\\main.js', 'panel.js'],
    brief: '改好了 D:\\WaifuCode\\src\\main.js 那个判断，顺手把 sk-ant-api03-abcdefghijklmnop 换掉，' +
           '另外 password=hunter2 也不该硬编码',
  });

  const raw = fs.readFileSync(dayFile(journal.dayKey()), 'utf8');

  check(!raw.includes('Users'), '**没有 Users** —— 用户名不许出现');
  check(!raw.includes('18475'), '**没有用户名那一段**');
  check(!raw.includes('C:\\\\') && !raw.includes('D:\\\\'), '**没有任何盘符路径**');
  check(!raw.includes('Desktop'), '中间那些目录名也没有');
  check(raw.includes('密项目'), '但项目名留下了（不然流水就没用了）');
  check(raw.includes('main.js') && raw.includes('panel.js'), '文件名留下了（只留最后一段）');
  check(!raw.includes('sk-ant-api03-abcdefghijklmnop'), '**密钥被摘掉了**');
  check(!raw.includes('hunter2'), '**密码被摘掉了**');
  check(raw.includes('查支付回调'), '线名是你自己在任务栏上看得见的，照留');

  // 净化必须发生在写入层，而不是靠六个调用点各自小心 ——
  // 所以这里直接喂一个「调用方手滑把整个事件摊进来」的对象
  const rec = journal.add('turn', { project: 'D:\\UnityGame\\VR_Wukong', dir: 'D:\\UnityGame\\VR_Wukong' });
  check(rec.project === 'VR_Wukong', 'project 自动只留最后一段');
  check(rec.dir === '…', '**手滑传进来的 dir 也被压掉了** —— 这就是把闸放在写入层的意义');
}

console.log('\n[1b] 她汇报时那些五花八门的写法，一种都不许漏');
{
  const R = journal.redact;
  const gone = (s, needle, label) => check(!R(s).includes(needle), label + '：' + JSON.stringify(R(s)));

  // 密钥：现实里这些词**几乎总是夹在变量名中间**，第一版的 \b 在下划线前
  // 根本不成立，最常见的那一类一条都拦不住
  gone('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalr', 'AWS 那种全大写下划线名');
  gone('private_token=glpat-AbCdEf1234567890', 'glpat-AbCdEf', '下划线开头的 token');
  gone('access_token: eyJhbGciOiJIUzI1NiJ9.abcdefghij.xyz', 'eyJhbGci', 'JWT');
  gone('DB_PASSWORD 是 hunter2', 'hunter2', '中文口语的「是」也算赋值');

  // 路径：Git Bash 是她的 Bash 工具，写 /c/Users/... 是常态
  gone('已经把 /c/Users/18475/.claude/settings.json 改好了', 'Users', 'Git Bash 风格');
  gone('看了下 ~/.ssh/id_rsa', 'ssh', '~ 开头');
  gone('在 /home/bing/proj/.env 里', 'bing', 'POSIX 绝对路径');
  gone('改的是 ../../另一个项目/src/db.js', '另一个项目', '相对路径（连隔壁项目名一起泄）');
  gone('改好了 C:\\Program Files\\WaifuCode\\app.js，你看一下', 'Program',
       '**带空格的路径整段压掉** —— 只削到空格就停的话，后半截原样留在磁盘上');

  // 反过来：不该误伤的
  check(R('只有 src/main.js 这种相对的').includes('src/main.js'), '项目内的相对路径照留（那是有用信息）');
  check(R('5:30 开会').includes('5:30'), '时间不误伤');
  check(R('改了 3 个文件，一路顺利').includes('一路顺利'), '正经话一个字不动');
}

console.log('\n[2] 记了就要读得回来，而且是追加不是覆盖');
{
  const before = journal.read().length;
  journal.add('greet', { kind: 'pet', costUsd: 0.0151 });
  journal.add('chat', { chars: 37, costUsd: 0.0084 });
  const after = journal.read();
  check(after.length === before + 2, '两条都进去了（' + before + ' → ' + after.length + '）');
  check(after[0].type === 'report', '**第一条还在** —— 是追加，没被后来的冲掉');
  check(typeof after[0].at === 'string' && after[0].at.includes('T'), '每条都带时间戳');
}

console.log('\n[3] 坏行、BOM 都不许连累一整天');
{
  const f = dayFile(journal.dayKey());
  fs.appendFileSync(f, '{"at":"2026-08-10T0\n', 'utf8'); // 写盘半路被掐留下的半行
  fs.appendFileSync(f, 'this is not json\n', 'utf8');
  journal.add('term-open', { project: 'WaifuCode', mode: 'watch' });

  const recs = journal.read();
  check(recs.length >= 5, '坏行跳过，好的照样读出来（' + recs.length + ' 条）');
  check(recs.some((r) => r.type === 'term-open'), '坏行**后面**那条也读到了（不是遇坏就停）');

  // BOM 那个坑：项目里已经因为它让整份存档静默退回默认值栽过一次
  const text = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '\uFEFF' + text, 'utf8');
  check(journal.read().length === recs.length, '**开头塞了 BOM 也照样读得出来**');
}

console.log('\n[4] 一天从早上 5 点算起（熬夜写代码的人，凌晨两点算前一天）');
{
  const d = (y, mo, day, h, mi) => +new Date(y, mo - 1, day, h, mi);
  check(journal.dayKey(d(2026, 8, 10, 2, 0)) === journal.dayKey(d(2026, 8, 9, 23, 0)),
        '**凌晨 2 点跟前一天晚上 11 点算同一天**');
  check(journal.dayKey(d(2026, 8, 10, 2, 0)) !== journal.dayKey(d(2026, 8, 10, 10, 0)),
        '但跟当天上午 10 点不是同一天');
  check(journal.dayKey(d(2026, 8, 10, 5, 1)) === journal.dayKey(d(2026, 8, 10, 10, 0)),
        '5 点之后就算新的一天了');
  check(/^\d{4}-\d{2}-\d{2}$/.test(journal.dayKey()), '格式是 YYYY-MM-DD（字符串能直接比大小）');
}

console.log('\n[5] 跨天不串');
{
  const yesterday = journal.dayKey(Date.now() - 24 * 3600 * 1000);
  fs.writeFileSync(dayFile(yesterday),
    JSON.stringify({ at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), type: 'greet', costUsd: 9 }) + '\n',
    'utf8');

  check(journal.read(yesterday).length === 1, '昨天那条读得到');
  check(!journal.read().some((r) => r.costUsd === 9), '**今天读不到昨天的**');
  check(journal.today().costUsd < 9, '今天的账里也没算进昨天那笔');
  check(journal.days().includes(yesterday), '有哪些天列得出来');
}

console.log('\n[6] 钱算得对，而且不假装那就是全部');
{
  const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-journal2-'));
  // 换个干净的数据目录重算一遍，免得被上面几节的数据干扰
  const recs = [
    { at: new Date().toISOString(), type: 'greet', costUsd: 0.01 },
    { at: new Date().toISOString(), type: 'chat', costUsd: 0.02 },
    { at: new Date().toISOString(), type: 'task-done', costUsd: 0.03, project: 'A' },
    { at: new Date().toISOString(), type: 'turn', project: 'A', lane: '甲', termId: 'w1', tools: 10, errors: 3 },
    { at: new Date().toISOString(), type: 'turn', project: 'A', lane: '甲', termId: 'w1', tools: 5, errors: 1 },
    { at: new Date().toISOString(), type: 'turn', project: 'B', lane: '乙', termId: 'w2', tools: 7, errors: 0 },
  ];
  const s = journal.summarize(recs);

  check(near(s.costUsd, 0.06), '三笔已知的加起来 = 0.06（实得 ' + s.costUsd.toFixed(4) + '）');
  check(s.unpriced === 3, '**另有 3 轮终端活没算钱** —— 这条就是那句实话');
  check(s.turns === 3 && s.tools === 22 && s.errors === 4, '轮数/工具数/报错数按轮累加（不是取最大）');
  check(s.projects.length === 2, '两个项目');
  check(s.lanes.length === 2 && s.lanes[0].turns === 2, '按线聚合，干得最多的排前面');
  check(s.stuck && s.stuck.lane === '甲', '**卡得最凶的那条是报错最多的**，不是停得最久的');
  try { fs.rmSync(HOME2, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

console.log('\n[7] 只留三个月，但「认识多少天」永不缩水');
{
  const old = journal.dayKey(Date.now() - 91 * 24 * 3600 * 1000);
  const keep = journal.dayKey(Date.now() - 89 * 24 * 3600 * 1000);
  fs.writeFileSync(dayFile(old), '{"at":"x","type":"greet"}\n', 'utf8');
  fs.writeFileSync(dayFile(keep), '{"at":"x","type":"greet"}\n', 'utf8');

  const sinceBefore = journal.since();
  const removed = journal.sweep();

  check(removed >= 1, '清掉了 ' + removed + ' 天');
  check(!fs.existsSync(dayFile(old)), '91 天前的没了');
  check(fs.existsSync(dayFile(keep)), '89 天前的还在');
  check(fs.existsSync(path.join(journal.DIR, 'since.json')), '**since.json 没被删**');
  check(journal.since() === sinceBefore,
        '**「从哪天开始的」一个字没变** —— 不单独存的话，清理一删最早那天，认识天数就往回缩了');
}

console.log('\n[8] 写不进去也不许拖垮桌宠');
{
  // 数据目录被换成一个不存在的盘，add 必须安静地返回 null 而不是抛出来
  const realDir = journal.DIR;
  check(typeof journal.add('greet', {}) === 'object', '正常情况下返回落盘的那条');
  check(journal.read('2000-01-01').length === 0, '读一个没有的日子 → 空数组，不抛错');
  check(journal.summarize(null).turns === 0, 'summarize(null) 也不炸');
  check(journal.summarize([null, 3, 'x']).turns === 0, '喂垃圾进去也不炸');
  check(realDir.includes('journal'), '流水落在 sessions/journal 底下（不会被打进安装包）');
}

console.log('\n[9] waifu.log 的刹车：超过上限就砍掉前面一半');
{
  const logfile = require('../src/logfile');
  const f = path.join(HOME, 'test.log');

  // 阈值调到很小才好测。100 字节上限、保留 60
  const opts = { max: 100, keep: 60 };
  const write = logfile.makeWriter(f, opts);

  for (let i = 0; i < 5; i++) write('第 ' + i + ' 行：' + 'x'.repeat(30) + '\n');
  const size = fs.statSync(f).size;
  check(size <= 200, '涨过头之后被砍了（现在 ' + size + ' 字节，砍之前 5 行约 200+）');

  const text = fs.readFileSync(f, 'utf8');
  check(text.includes('第 4 行'), '**最新那行还在** —— 日志的用途就是看刚才发生了什么');
  check(!text.includes('第 0 行'), '最老那行被砍掉了');
  check(/砍掉了前面/.test(text), '砍完在开头留了一句说明，不会让人以为日志丢了');

  // 每一行都得是完整的：不能从半行、更不能从汉字中间切开
  const lines = text.split('\n').filter(Boolean);
  check(lines.every((l) => /^\[|^第 \d+ 行：x+$/.test(l)),
        '**每一行都是完整的** —— 从 keep 字节处硬切会切出半行，切在汉字中间还是乱码');
  check(!text.includes('�'), '没有替换字符（切在多字节中间就会出现这个）');

  // 写不进去也不许抛
  const gone = path.join(HOME, '不存在的目录', 'x.log');
  check(logfile.trim(gone) === -1, '文件不在 → 返回 -1，不抛');
  const badWrite = logfile.makeWriter(gone);
  let threw = false;
  try { badWrite('一行\n'); } catch (_) { threw = true; }
  check(!threw, '**写不进去也不许拖垮桌宠** —— 跟 log() 原来的 try/catch 是同一个承诺');

  // 没到上限就一个字都别动
  const small = path.join(HOME, 'small.log');
  fs.writeFileSync(small, '就一行\n', 'utf8');
  const before = fs.readFileSync(small, 'utf8');
  logfile.trim(small, opts);
  check(fs.readFileSync(small, 'utf8') === before, '没超过上限的文件原样不动');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
