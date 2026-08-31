'use strict';
// 守打包名单：运行时 / 隐私数据绝不能被打进发布包。
// build.files 是黑名单（**/* 全收、再用 ! 排除），跟 .gitignore 是两份各自维护的名单、
// 极容易不同步 —— 上一版就漏了 shots/inbox（.gitignore 拦了、build.files 没拦），
// 结果你自己的截图和手机传来的照片会跟着安装包一起发出去。这里把「必须排除」逐条钉死。
// 加了新的运行时目录，记得同时加进 package.json 的 build.files 和下面这张表。

const assert = require('assert');
const pkg = require('../package.json');
const files = (pkg.build && pkg.build.files) || [];
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);

const MUST = [
  ['config.json', '接入点 + 钥匙密文（第三方模型的 key）'],
  ['sessions', '会话 / 小抄 / 记日子 / 小本子 / 心情'],
  ['shots', '她截的屏（你屏幕上什么都可能在里面）'],
  ['inbox', '你手机传给电脑的文件'],
  ['music', '你自己丢进去的音乐'],
  ['workPosture', '工作姿态运行时数据'],
  ['update-download', '更新临时下载'],
  ['.tmp-codexhome', 'codex 临时 home（可能有 token）'],
];

console.log('[1] 运行时 / 隐私数据必须在 build.files 排除（不然打进包发出去）');
for (const [name, why] of MUST) {
  assert(files.includes('!' + name) || files.includes('!' + name + '/**') || files.includes('!' + name + '/'),
    '缺 "!' + name + '" —— ' + why + '，会被打进发布包');
  ok('!' + name + '  · ' + why);
}

console.log('[2] 日志靠 *.log 覆盖');
assert(files.includes('!*.log'), '缺 "!*.log"');
ok('!*.log');

console.log('[3] build.files 不许有重复项（去重后好核对）');
{
  const dup = files.filter((x, i) => files.indexOf(x) !== i);
  assert(dup.length === 0, '有重复: ' + dup.join(', '));
  ok('无重复，共 ' + files.length + ' 条');
}

console.log('\n\x1b[32m✓ 全过\x1b[0m');
