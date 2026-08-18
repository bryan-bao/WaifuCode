'use strict';

// 「跟她说跳什么就跳什么」这条链路的自检。
//
// 要验的是三件事：
//   1. 你让她跳，她真的会附上一条能执行的编舞指令，而且风格对得上
//   2. 你让她哼，她自己现编词（不是抄现成的）
//   3. **你只是随便聊天，她绝对不能乱动** —— 这条最容易翻车，
//      模型一旦学会了新玩具就总想用一下
//
// 会真调四次 API，一轮两三分钱。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Chat } = require('../src/chat');
const { resolveClaudeBin } = require('../src/sessions');
const { STEPS } = require('../src/renderer/dance');

const TMP = path.join(os.tmpdir(), 'waifu-action-test');
fs.mkdirSync(TMP, { recursive: true });
try { fs.unlinkSync(path.join(TMP, 'chat.json')); } catch (_) { /* 第一次跑没有 */ }

let bad = 0;
const check = (cond, label) => {
  console.log('    ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const chat = new Chat({
  storeDir: TMP,
  claudeBin: resolveClaudeBin(),
  getConfig: () => ({
    persona: { name: '小依', text: '你叫小依，住在电脑桌面右下角的二次元女孩。说话短、口语化。' },
  }),
  getMoodDesc: () => '心情很好，精神头很足。',
  log: () => {},
});

// 说一句，把她说的话和附带的动作一起收回来
function say(text) {
  return new Promise((resolve, reject) => {
    let action = null;
    let streamed = '';
    const onAction = (a) => { action = a; };
    const onDelta = (e) => { streamed += e.text; };
    const onDone = (e) => { cleanup(); resolve({ text: e.text, action: action || e.action, streamed, cost: e.costUsd }); };
    const onErr = (e) => { cleanup(); reject(new Error(e.error)); };
    const cleanup = () => {
      chat.off('action', onAction); chat.off('delta', onDelta);
      chat.off('done', onDone); chat.off('error', onErr);
    };
    chat.on('action', onAction);
    chat.on('delta', onDelta);
    chat.on('done', onDone);
    chat.on('error', onErr);

    const r = chat.send(text);
    if (!r.ok) { cleanup(); reject(new Error(r.error)); }
  });
}

(async () => {
  let total = 0;

  console.log('\n[1] 「跳个慢一点、温柔一点的舞」');
  const a = await say('跳个慢一点、温柔一点的舞给我看看');
  total += a.cost || 0;
  console.log('    她说：' + a.text);
  console.log('    动作：' + JSON.stringify(a.action));
  check(!!a.action, '带了动作指令');
  if (a.action) {
    check(a.action.act === 'dance', 'act 是 dance');
    check(a.action.bpm > 40 && a.action.bpm <= 110, '慢歌的拍子（' + a.action.bpm + ' BPM，该 ≤110）');
    const steps = a.action.steps || [];
    check(steps.length > 0, '编了舞步：' + steps.join(' → '));
    check(steps.every((s) => STEPS[s]), '每套舞步都是真实存在的');
  }
  check(!a.text.includes('<<ACT'), '指令没漏到聊天框里');
  check(!a.streamed.includes('<<ACT'), '流式输出里也没漏');

  console.log('\n[2] 「嗨一点的」——风格得跟上一次明显不同');
  const b = await say('太温吞了，来个嗨的！');
  total += b.cost || 0;
  console.log('    她说：' + b.text);
  console.log('    动作：' + JSON.stringify(b.action));
  check(!!b.action && b.action.act === 'dance', '还是跳舞');
  if (b.action && a.action) {
    check(b.action.bpm > a.action.bpm, '比刚才快了（' + a.action.bpm + ' → ' + b.action.bpm + '）');
  }

  console.log('\n[3] 「随便哼两句」——词得是她自己编的');
  const c = await say('随便哼两句吧，编个关于加班的');
  total += c.cost || 0;
  console.log('    她说：' + c.text);
  console.log('    动作：' + JSON.stringify(c.action));
  check(!!c.action, '带了动作指令');
  if (c.action) {
    check(c.action.act === 'hum', 'act 是 hum（即兴哼唱）');
    check(String(c.action.lyrics || '').length > 4, '有词：' + c.action.lyrics);
  }

  console.log('\n[4] 只是随便聊聊 —— 这次绝对不能乱动');
  const d = await say('今天天气还不错哈');
  total += d.cost || 0;
  console.log('    她说：' + d.text);
  console.log('    动作：' + JSON.stringify(d.action));
  check(!d.action, '没有动作指令（平时聊天不该乱动）');

  chat.dispose();
  console.log('\n四轮一共 $' + total.toFixed(4));
  console.log(bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m');
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error('\n炸了: ' + err.message);
  process.exit(1);
});
