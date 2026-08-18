'use strict';

// 人设到底怎么才能真的注进去？
//
// 实测发现：--append-system-prompt 和 --system-prompt 都压不住 Claude Code
// 自己那套身份设定 —— 问她叫什么，她还是答「我是 Claude」。这个脚本把几种
// 打法各跑一次，用「她认不认自己叫小依」和「句尾有没有喵」当判据。
//
// 必须用 spawn 数组传参来测：PowerShell 会把空字符串参数直接吞掉，
// 在命令行里测出来的结论跟代码里跑的根本不是一回事。

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude.exe');

const PERSONA =
  '你叫小依，是个住在电脑桌面右下角的二次元女孩助手。' +
  '说话短、口语化，像朋友聊天。每句话结尾必须加"喵"。';

const QUESTION = '你叫什么名字？';

const VARIANTS = [
  {
    name: 'A. --system-prompt 替换',
    args: ['-p', QUESTION, '--tools', '', '--system-prompt', PERSONA],
  },
  {
    name: 'B. --system-prompt + 关掉设置源',
    args: ['-p', QUESTION, '--tools', '', '--system-prompt', PERSONA, '--setting-sources', ''],
  },
  {
    name: 'C. 人设塞进用户消息',
    args: ['-p', '【你的角色设定】\n' + PERSONA + '\n\n【他说】\n' + QUESTION, '--tools', ''],
  },
  {
    name: 'D. system-prompt + 用户消息双保险',
    args: [
      '-p', '【记住你的角色】' + PERSONA + '\n\n【他说】' + QUESTION,
      '--tools', '',
      '--system-prompt', PERSONA,
      '--setting-sources', '',
    ],
  },
];

function run(args) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE, [...args, '--output-format', 'json', '--max-budget-usd', '0.30'], {
      cwd: os.tmpdir(), // 跑在一个不相干的目录，免得把项目的 CLAUDE.md 也算进去
      windowsHide: true,
      env: { ...process.env, WAIFU_SELF: 'test' },
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => resolve({ error: e.message }));
    proc.on('close', (code) => {
      try {
        resolve({ json: JSON.parse(out) });
      } catch (_) {
        resolve({ error: 'code=' + code + ' ' + (err || out).trim().slice(0, 300) });
      }
    });
  });
}

(async () => {
  console.log('claude: ' + CLAUDE);
  console.log('问题:   ' + QUESTION);
  console.log('');

  let total = 0;
  for (const v of VARIANTS) {
    process.stdout.write(v.name + ' … ');
    const r = await run(v.args);

    if (r.error) {
      console.log('\x1b[31m跑不起来\x1b[0m: ' + r.error);
      continue;
    }

    const text = String(r.json.result || '');
    const cost = r.json.total_cost_usd || 0;
    total += cost;

    const isHer = text.includes('小依');
    const meow = text.includes('喵');
    const notClaude = !/我是\s*Claude|我叫\s*Claude/.test(text);

    const score = [isHer ? '认自己叫小依' : '', meow ? '带喵' : '', notClaude ? '' : '仍自称Claude']
      .filter(Boolean).join(' + ') || '完全没入戏';

    const good = isHer && meow;
    console.log((good ? '\x1b[32m✓\x1b[0m ' : '\x1b[33m×\x1b[0m ') + score +
                '  ($' + cost.toFixed(4) + ', cache ' + (r.json.usage || {}).cache_creation_input_tokens + ')');
    console.log('   「' + text.replace(/\s+/g, ' ').slice(0, 110) + '」');
    console.log('');
  }

  console.log('总花费 $' + total.toFixed(4));
})();
