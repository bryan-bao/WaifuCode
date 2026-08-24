'use strict';

// 把桌宠的 hook 装进（或卸出）~/.claude/settings.json。
//
// 这个文件是你 Claude Code 的总配置，里面还有状态栏、插件之类的东西，
// 所以这里的原则是：只增不改、先备份、可幂等、可完整卸载。
// 任何一步看着不对就直接罢工，绝不硬写。
//
//   装:  node hooks/install.js
//   卸:  node hooks/install.js --remove

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const NOTIFY = path.join(__dirname, 'notify.js');
const NODE = process.execPath; // hook 的执行环境未必有 node 在 PATH 上，写死绝对路径最稳

// 这几个事件足够拼出「她在干什么」的全貌了，再多只会拖慢你敲代码。
//
// SessionEnd 是后补的：src/terminals.js 里早就写好了处理它的分支，
// 但这张表里一直没有它 —— 于是那段代码从来没被执行过，
// 「你把终端窗口关了」这件事她其实是靠心跳超时慢慢猜出来的。
// 装了它之后窗口一关就立刻知道。
// PreCompact 是后补的：上下文压缩 = 她开始忘事 + 账单大头的信号点，
// 装上它那一刻她才提醒得了你「该收尾开新线了」
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd', 'PreCompact'];

const REMOVE = process.argv.includes('--remove');

function isOurs(group) {
  if (!group || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (h) => typeof h.command === 'string' && h.command.includes('WaifuCode') && h.command.includes('notify.js')
  );
}

function entryFor(event) {
  const cmd = '"' + NODE + '" "' + NOTIFY + '" ' + event;
  const group = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] };
  // PreToolUse / PostToolUse 需要 matcher 才会对所有工具生效
  if (event === 'PreToolUse' || event === 'PostToolUse') group.matcher = '*';
  return group;
}

function main() {
  let settings = {};
  let existed = false;

  if (fs.existsSync(SETTINGS)) {
    existed = true;
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      console.error('✗ settings.json 解析不了，我不敢动它：' + err.message);
      console.error('  请先自己修好 ' + SETTINGS + ' 再来。');
      process.exit(1);
    }

    // 备份。改别人的总配置之前，永远先留条退路。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = SETTINGS + '.waifu-backup-' + stamp;
    fs.writeFileSync(backup, raw, 'utf8');
    console.log('已备份原配置 -> ' + backup);
  } else if (REMOVE) {
    console.log('settings.json 不存在，没什么可卸的。');
    return;
  }

  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

  let added = 0;
  let removed = 0;

  for (const ev of EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];

    // 先把我们自己的旧条目摘掉 —— 重复装不该越装越多
    const cleaned = list.filter((g) => {
      if (isOurs(g)) { removed++; return false; }
      return true;
    });

    if (!REMOVE) {
      cleaned.push(entryFor(ev));
      added++;
    }

    if (cleaned.length) settings.hooks[ev] = cleaned;
    else delete settings.hooks[ev];
  }

  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  if (REMOVE) {
    console.log('✓ 已卸载 ' + removed + ' 条 WaifuCode hook。你原有的配置一个字没动。');
  } else {
    console.log('✓ 已装上 ' + added + ' 条 hook' + (removed ? '（顺手清掉 ' + removed + ' 条旧的）' : ''));
    console.log('  监听事件: ' + EVENTS.join(', '));
    console.log('  转发脚本: ' + NOTIFY);
    if (!existed) console.log('  （原本没有 settings.json，新建了一个）');
    console.log('');
    console.log('注意：新开的 Claude Code 会话才会生效，当前正在跑的窗口不受影响。');
    console.log('不想要了随时 npm run uninstall-hooks。');
  }
}

main();
