'use strict';

// 验 src/voice.js 这一层（不是底层库）：并发、串行、断线重连。
//
// 之前线上就是栽在并发上：四句话几乎同时触发，共用一个 WebSocket，
// 结果一起卡到超时，而且连接坏了之后再也没重建过 —— 她从此哑了。
// 这个脚本把那个场景重演一遍。

const { Voice } = require('../src/voice');

const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };

(async () => {
  const voice = new Voice({ enabled: true });
  voice.onLog = (m) => console.log('    · ' + m);

  console.log('\n[1] 一句普通的');
  const one = await voice.speak('搞定了，你看看行不行？');
  if (one && one.audio && one.audio.length > 1000) ok('念出来了，' + Math.round(one.audio.length / 1024) + 'KB');
  else bad('没合成出来');

  console.log('\n[2] 四句同时丢进去（就是原来炸掉的场景）');
  console.log('    带 important 的必须全部念到，不能互相顶掉');
  const t0 = Date.now();
  const many = await Promise.all([
    voice.speak('第一句，项目 A 干完了。', { important: true }),
    voice.speak('第二句，项目 B 也好了。', { important: true }),
    voice.speak('第三句，项目 C 报错了。', { important: true }),
    voice.speak('第四句，全部收工。', { important: true }),
  ]);
  const good = many.filter((r) => r && r.audio && r.audio.length > 1000).length;
  if (good === 4) ok('四句全念到了，用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  else bad('只成了 ' + good + '/4 句 —— 并发还是会互相打架');

  console.log('\n[3] 普通台词该被顶掉（只留最新一句，避免她自言自语堆一堆）');
  const race = await Promise.all([
    voice.speak('旧的一句，应该被丢掉'),
    voice.speak('新的一句，应该只念这句'),
  ]);
  if (race[0] === null && race[1]) ok('旧的丢了，新的留下');
  else bad('仲裁不对：旧=' + (race[0] ? '留' : '丢') + ' 新=' + (race[1] ? '留' : '丢'));

  console.log('\n[4] 连接被掐掉之后能不能自己活过来');
  voice._drop('测试：模拟对面掐断');
  // _drop 之后 tts 是 null，下一句必须能重新建连接
  const after = await voice.speak('断线之后我还能说话吗？', { important: true });
  if (after && after.audio) ok('自己重连上了');
  else bad('断线之后就哑了 —— 重连没生效');

  console.log('\n[5] 文本清洗');
  const dirty = Voice.clean('改完了 `D:\\WaifuCode\\src\\main.js`，详见 https://example.com/x **重要**');
  console.log('    -> ' + dirty);
  if (!/[\\*`]|https?:/.test(dirty)) ok('路径、链接、markdown 都洗掉了');
  else bad('还有没洗干净的：' + dirty);

  voice.dispose();
  console.log('\n' + (process.exitCode ? '有测试没过。' : '全过了。'));
})().catch((err) => {
  console.error('\n炸了:', err.message);
  process.exit(1);
});
