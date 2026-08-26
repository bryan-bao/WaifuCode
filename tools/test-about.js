'use strict';
// 「她记得你这个人」那批的自检：小本子（攒/去重/上限/明文可删）、
// MEM 标记的提取、周记的数据（几周不值得写、最忙哪天）、接线检查。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aboutStore } = require('../src/about');
const diary = require('../src/diary');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

console.log('[1] 小本子：攒得下、翻得开、删得掉');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'about-'));
  const f = path.join(dir, 'about.md');
  const a = aboutStore(f);

  check(a.add('他讨厌带 BOM 的文件').ok, '记一条');
  check(a.add('他讨厌带BOM的文件。').dup === true, '「他讨厌BOM。」和「他讨厌 BOM」是同一条 —— 标点空白不算区别');
  check(!a.add('x').ok, '太短的不记（一个字说明不了什么）');
  a.add('他的猫叫年糕');
  check(a.list().length === 2, '现在两条');

  const txt = fs.readFileSync(f, 'utf8');
  check(txt.includes('想删哪条直接删那行'), '文件头上写明白了怎么删 —— 明文可翻可删是规矩');
  // 用户手删一行 = 她忘了
  fs.writeFileSync(f, txt.split('\n').filter((l) => !l.includes('BOM')).join('\n'), 'utf8');
  check(a.list().length === 1 && a.list()[0].text === '他的猫叫年糕', '手删那行她就真忘了');

  for (let i = 0; i < 70; i++) a.add('第 ' + i + ' 条流水');
  check(a.list().length <= 60, '攒满 60 条挤掉最老的（不许无限长）');

  check(a.forPrompt(3).split('\n').length === 3, 'forPrompt 只给最近几条');
  check(aboutStore(path.join(dir, '没有.md')).forPrompt() === '', '空本子返回空串，不占提示词');
  const s = a.sample(2);
  check(s.length === 2 && s[0] !== s[1], '随机抽两条不重样');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[2] MEM 标记提取（回复里那行 <<MEM:...>> 摘干净）');
{
  // extractMemory 没导出的话就从源码断言（它在两处收尾都被调）
  const chat = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat.js'), 'utf8');
  check(chat.includes('function extractMemory'), 'extractMemory 在');
  check((chat.match(/extractMemory\(stripped\)/g) || []).length === 2,
        'claude 和 codex 两处收尾**都**过了 extractMemory —— 少一处那张嘴就哑记忆');
  check(chat.includes("this.emit('memory'"), '摘出来的条目往外报（main 那头接）');
  check(/tagStart[\s\S]{0,200}<<MEM:/.test(chat),
        '流式防漏也认 MEM —— 不认的话标记会半截漏进聊天气泡');
  check(chat.includes('绝对不记'), '提示词里明说了敏感信息不记');
  check(chat.includes('_aboutBlock'), '已记的喂回提示词（防重复记，也才谈得上自然提起）');
}

console.log('\n[3] 周记的数据');
{
  const mk = (recs) => recs; // 让下面的表好读
  const week = {
    '2026-08-18': mk([{ type: 'turn' }, { type: 'turn', errors: 5 }, { type: 'report', brief: '把支付页修好了' }]),
    '2026-08-20': mk([{ type: 'turn' }, { type: 'turn' }, { type: 'turn' }, { type: 'task-done' }, { type: 'term-cost', costUsd: 2.5 }]),
  };
  const now = new Date('2026-08-24T12:00:00').getTime(); // 周一
  const dayKeyOf = (ts) => {
    const d = new Date(ts - 5 * 3600000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const facts = diary.weekFacts({ readDay: (k) => week[k] || [], dayKeyOf, now });
  check(facts && facts.total.turns === 5, '七天流水都算上了（' + (facts && facts.total.turns) + ' 轮）');
  check(facts.busiest.day === '2026-08-20', '最忙的是哪天算得出来');
  check(facts.roughest.day === '2026-08-18', '最较劲（报错最多）的是哪天也算得出来');
  check(facts.briefs.includes('把支付页修好了'), '她汇报过的原话进了素材');
  check(diary.weekFacts({ readDay: () => [], dayKeyOf, now }) === null,
        '一周没干什么就不写 —— 硬写就是没话找话');
  const p = diary.prompt('人设', facts, ['他的猫叫年糕']);
  check(p.includes('第一人称') && p.includes('年糕') && p.includes('把支付页修好了'),
        '提示词里有人设、有小本子、有她自己的汇报原话');
  check(p.includes('别编'), '嘱咐了别编数据之外的事');
}

console.log('\n[4] 接线');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check(main.includes("require('./about')") && main.includes("require('./diary')"),
        'about/diary 在 main 里 require 过（「用而不引」那个死法）');
  check(main.includes("chat.on('memory'"), 'chat 报的记忆有人收');
  check(main.includes('getAbout:'), '小本子喂回给聊天');
  check(/case 'diary'/.test(main), '「看看周记」按钮有人接');
  check(main.includes('她记的关于你的事…'), '托盘菜单能翻小本子');
  check(/markDay\('diary'\)[\s\S]{0,220}await diary\.write/.test(main),
        '动笔**之前**先记号 —— 失败也别同一周反复烧钱重试');
  check(/getDay\(\) !== 1/.test(main), '只在周一写');
  const greet = fs.readFileSync(path.join(__dirname, '..', 'src', 'greet.js'), 'utf8');
  check(greet.includes('ctx.about'), '搭话也带上记忆（随机两条）');
  const d = fs.readFileSync(path.join(__dirname, '..', 'src', 'diary.js'), 'utf8');
  check(d.includes('--max-budget-usd'), '周记那笔有预算上限');
  check(d.includes("--setting-sources', ''") || d.includes('--setting-sources'), '不加载设置源（不带 hooks、不稀释人设）');
  check(d.includes("stdin.on('error'"), 'codex 那张嘴的 stdin EPIPE 有人接（不接会崩主进程，chat 踩过）');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
