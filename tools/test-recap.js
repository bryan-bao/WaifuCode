'use strict';
// 「有来有回的一天」那批的自检：回来汇报 / 隔天开场 / 收工 / 口头提醒。
// 全是本地纯逻辑，几毫秒跑完。
const fs = require('fs');
const os = require('os');
const path = require('path');
const recap = require('../src/recap');
const { remindStore } = require('../src/remind');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};
const iso = (ts) => new Date(ts).toISOString();

console.log('[1] 你走之后回来 —— 汇报要真材实料');
{
  const t0 = Date.now() - 40 * 60000;
  const recs = [
    { type: 'report', at: iso(t0 - 3600000), project: '老早的', brief: '走之前就汇报过的，不许算进来' },
    { type: 'report', at: iso(t0 + 5 * 60000), project: 'WaifuCode', brief: '把登录页改完了，测试全过' },
    { type: 'turn', at: iso(t0 + 8 * 60000), project: 'WaifuCode', errors: 3 },
    { type: 'task-done', at: iso(t0 + 9 * 60000) },
  ];
  const r = recap.welcome(recs, t0, 40);
  check(r && r.say.includes('WaifuCode') && r.say.includes('登录页'), '汇报里有项目名和她的原话');
  check(r && !r.say.includes('不许算进来'), '走之前的旧汇报不许算进「你走的这段时间」');
  check(r && r.say.includes('报错 3 次'), '报错也如实说');
  check(r && r.say.includes('40 分钟'), '走了多久说得出来');
  check(recap.welcome(recs, Date.now() + 1000, 40) === null, '什么都没发生就返回 null（退回普通那句，不说废话）');
  check(recap.fmtMin(95) === '1 个半小时', '95 分钟说成「1 个半小时」，不说「95 分钟」');
}

console.log('\n[2] 隔天开场白');
{
  const r = recap.opener({ name: '修支付', project: 'shop', turns: 12 });
  check(r && r.say.includes('修支付') && r.say.includes('12 轮'), '线名和轮数都在');
  check(r && r.offer && r.offer.kind === 'resume', '带「接着弄」按钮');
  check(recap.opener(null) === null, '没有挂着的线就不开这个口');
}

console.log('\n[3] 收工那句');
{
  const r = recap.windDown({ turns: 18, tasks: 3, chats: 5, spanMin: 300, costUsd: 2.5 });
  check(r && r.face === 'sleepy' && r.say.includes('18 轮') && r.say.includes('$2.50'), '总结带数据');
  const z = recap.windDown({ turns: 2, tasks: 0, chats: 0, spanMin: 30, costUsd: 0 });
  check(z && !z.say.includes('$'), '一分钱没花就不提钱（「花了 $0.00」听着像讽刺）');
  check(recap.windDown({ turns: 0, tasks: 0, chats: 0 }) === null, '今天没干正事就不专门道晚安总结');
}

console.log('\n[4] 口头提醒 —— 存得下、到点冒、错过也不丢');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-'));
  const store = remindStore(path.join(dir, 'r.json'));
  const now = new Date('2026-08-25T14:00:00').getTime();

  const a = store.add({ at: '15:00', text: '开会' }, now);
  check(a.ok && a.when === now + 3600000, '「三点提醒我」：下午两点说，一小时后响');
  const b = store.add({ at: '13:00', text: '过点的' }, now);
  check(b.ok && b.when > now + 20 * 3600000, '已经过了的钟点算明天的');
  const c = store.add({ inMin: 20, text: '看烤箱' }, now);
  check(c.ok && c.when === now + 20 * 60000, '「20 分钟后」也认');
  check(!store.add({ at: '15:00', text: '' }, now).ok, '没说提醒什么就不记');
  check(!store.add({ at: '25:99', text: 'x' }, now).ok, '瞎写的时间不记');
  check(!store.add({ text: '只有内容' }, now).ok, '没给时间不记');

  const fresh = remindStore(path.join(dir, 'r.json'));
  check(fresh.list().length === 3, '重启（重新 require）之后还在 —— 落了盘');

  const fired = fresh.due(now + 3600000 + 1000);
  check(fired.length === 2 && fired.some((r) => r.text === '开会'), '到点的都冒出来（含 20 分钟那条）');
  check(fresh.list().length === 1, '冒过的就从账上划掉，不会响第二遍');

  const long = store.add({ inMin: 5, text: 'x'.repeat(500) }, now);
  check(long.ok && long.text.length <= 80, '太长的内容掐到 80 字');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[5] 接线：main 里几条不许断的');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check(main.includes("require('./recap')"), 'recap 在 main 里 require 过（cost 那次的教训：用而不引，整条链静默死）');
  check(main.includes("remindStore("), 'remind 在 main 里真的建了实例');
  check(/case 'resume'/.test(main), '开场白的「接着弄」按钮有人接（acceptOffer）');
  check(/case 'remind'/.test(main), '聊天里的 remind 动作有人接（runAction）');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat.js'), 'utf8');
  check(chat.includes('remind'), '聊天提示词里教过她 remind 这个动作');
  const moodSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'mood.js'), 'utf8');
  check(/onReturn\(goneMin, \{ silent = false \}/.test(moodSrc),
        'onReturn 能静音 —— 汇报和「你回来啦」二选一，不能俩气泡打架');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
