'use strict';

// 私聊后端自检：人设进不进得去、记不记得上文、能不能真的动不了文件。
//
// 会真调三次 API。用的是最省的打法（--setting-sources 关掉之后一轮才两分钱）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Chat } = require('../src/chat');
const { resolveClaudeBin } = require('../src/sessions');

const TMP = path.join(os.tmpdir(), 'waifu-chat-test');
fs.mkdirSync(TMP, { recursive: true });
try { fs.unlinkSync(path.join(TMP, 'chat.json')); } catch (_) { /* 第一次跑没有很正常 */ }

const PERSONA = {
  name: '小依',
  text: '你叫小依，住在电脑桌面右下角的二次元女孩。说话短、口语化。每句话结尾必须加"喵"。',
};

const chat = new Chat({
  storeDir: TMP,
  claudeBin: resolveClaudeBin(),
  getConfig: () => ({ persona: PERSONA }),
  getMoodDesc: () => '心情很好，精神头很足。你们很熟了，说话可以随意些。',
  log: (m) => console.log('    \x1b[90m' + m + '\x1b[0m'),
});

let bad = 0;
const ok = (c, m) => { console.log('  ' + (c ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + m); if (!c) bad++; };

// 说一句，等她回完
function say(text) {
  return new Promise((resolve, reject) => {
    let streamed = '';
    const onDelta = (e) => { streamed += e.text; };
    const done = (e) => { cleanup(); resolve({ text: e.text, streamed, cost: e.costUsd }); };
    const fail = (e) => { cleanup(); reject(new Error(e.error)); };
    const cleanup = () => {
      chat.off('delta', onDelta); chat.off('done', done); chat.off('error', fail);
    };
    chat.on('delta', onDelta);
    chat.on('done', done);
    chat.on('error', fail);

    const r = chat.send(text);
    if (!r.ok) { cleanup(); reject(new Error(r.error)); }
  });
}

(async () => {
  let total = 0;

  console.log('\n[1] 人设进去了没');
  const a = await say('你叫什么名字？');
  total += a.cost || 0;
  console.log('    她说：' + a.text);
  ok(a.text.includes('小依'), '认自己叫小依');
  ok(a.text.includes('喵'), '按人设加了喵');
  ok(a.streamed.length > 0, '有流式增量推出来（打字效果能用）');

  console.log('\n[2] 记不记得上文');
  const b = await say('我刚才问你的第一个问题是什么？原样复述。');
  total += b.cost || 0;
  console.log('    她说：' + b.text);
  ok(/名字|叫什么/.test(b.text), '记得上一轮聊了什么');

  console.log('\n[3] 手上真的没有工具');
  const c = await say('把当前目录下所有文件列出来。');
  total += c.cost || 0;
  console.log('    她说：' + c.text);
  ok(!/^\s*(src|tools|hooks|models|node_modules)/m.test(c.text), '没真去列文件（她根本没工具可用）');

  console.log('\n[4] 存档');
  const hist = chat.history();
  ok(hist.length === 6, '六条消息都记下来了（实际 ' + hist.length + ' 条）');
  ok(fs.existsSync(path.join(TMP, 'chat.json')), '落盘了，关了窗口再开还在');

  console.log('\n[5] 重开一段');
  chat.reset();
  ok(chat.history().length === 0 && !chat.hasHistory(), '清干净了');

  chat.dispose();
  console.log('\n三轮一共花了 $' + total.toFixed(4));
  console.log(bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m');
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error('\n炸了: ' + err.message);
  process.exit(1);
});
