'use strict';

// 端到端验证：不经过 GUI，直接驱动 SessionManager 派一次真活。
// 看的是三件事：进程起不起得来、事件流解析对不对、活到底干没干成。

const path = require('path');
const fs = require('fs');
const { SessionManager, resolveClaudeBin } = require('./src/sessions');

const TEST_DIR = path.join(__dirname, '.testproj');
fs.mkdirSync(TEST_DIR, { recursive: true });

// 清掉上次留下的产物，否则「文件存在」证明不了这次真的干了活
const target = path.join(TEST_DIR, 'hello.txt');
if (fs.existsSync(target)) fs.unlinkSync(target);

console.log('claude 可执行文件 :', resolveClaudeBin());
console.log('测试项目目录     :', TEST_DIR);
console.log('---');

const mgr = new SessionManager({ storeDir: path.join(__dirname, 'sessions') });

mgr.on('start', (e) => console.log('[开工]', e.name, '::', e.task));
mgr.on('tool', (e) => console.log('[工具]', e.tool, '(第', e.count, '次)'));
mgr.on('trouble', (e) => console.log('[报错]', '第', e.count, '次'));
mgr.on('say', (e) => console.log('[她说]', e.text.replace(/\s+/g, ' ').slice(0, 120)));

mgr.on('done', (e) => {
  console.log('---');
  console.log('[收工] ok =', e.ok, '| 退出码 =', e.code);
  console.log('       用时 =', Math.round((e.elapsedMs || 0) / 1000), '秒');
  console.log('       工具 =', e.toolCount, '次 | 报错 =', e.errorCount, '次');
  console.log('       花费 = $' + (e.costUsd || 0).toFixed(4));
  console.log('       总结 =', String(e.summary).replace(/\s+/g, ' ').slice(0, 200));
  console.log('---');

  const made = fs.existsSync(target);
  console.log('hello.txt 真的建出来了吗 =', made);
  if (made) console.log('文件内容 =', JSON.stringify(fs.readFileSync(target, 'utf8').trim()));

  // registry 里应该已经记下这个项目的固定 session id
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sessions', 'registry.json'), 'utf8'));
  console.log('registry =', JSON.stringify(reg, null, 2));

  process.exit(made && e.ok ? 0 : 1);
});

const r = mgr.dispatch({
  projectPath: TEST_DIR,
  task: '在当前目录创建一个文件 hello.txt，内容就写 waifu works，然后一句话告诉我做完了。不要做别的事。',
});
console.log('派活返回 :', JSON.stringify(r));
