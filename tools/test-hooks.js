'use strict';
// 装 hook 那条路的自检。全离线：settings.json 指到临时目录，绝不碰你真的那份。
//
// 守的是「开机自己装」这件事的四条命：
//   1. 幂等 —— 第二次装一个字节都不写、不多一个备份文件（开机调用的前提）
//   2. 认得出自己的旧条目 —— 装到不叫 WaifuCode 的目录也认得出，路径变了换新不堆积
//   3. 别人的 hook 一个不动，statusLine 那些字段一个不动
//   4. 没真 node 时写 .cmd 垫片把 electron 掰成 node，垫片落在数据目录
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { install, isOurs, EVENTS } = require('../hooks/install');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-hooks-'));
const S = path.join(TMP, 'settings.json');
const NOTIFY = 'D:\\Apps\\xiaoyi\\resources\\app\\hooks\\notify.js'; // 故意不叫 WaifuCode
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const backups = () => fs.readdirSync(TMP).filter((f) => f.includes('.waifu-backup-')).length;
const read = () => JSON.parse(fs.readFileSync(S, 'utf8'));

console.log('[1] 全新机器：没有 settings.json');
{
  const r = install({ settingsPath: S, nodeBin: NODE, notify: NOTIFY });
  check(!r.error && r.changed && r.added === EVENTS.length, '装上 ' + EVENTS.length + ' 条（' + JSON.stringify(r.error) + '）');
  check(fs.existsSync(S), '文件建出来了');
  check(backups() === 0, '本来没文件，不该有备份');
  const s = read();
  check(EVENTS.every((ev) => Array.isArray(s.hooks[ev]) && s.hooks[ev].length === 1), '每个事件一条');
  check(s.hooks.PreToolUse[0].matcher === '*' && s.hooks.PostToolUse[0].matcher === '*', 'Pre/PostToolUse 带 matcher *（不带对所有工具不生效）');
  check(s.hooks.Stop[0].hooks[0].command === '"' + NODE + '" "' + NOTIFY + '" Stop', '命令是 "node" "notify.js" 事件名');
  check(s.hooks.Stop[0].hooks[0].timeout === 5, 'timeout 显式给 5 秒（hook 是阻塞的）');
}

console.log('\n[2] 幂等：再装一次一个字节都不动');
{
  const before = fs.readFileSync(S, 'utf8');
  const r = install({ settingsPath: S, nodeBin: NODE, notify: NOTIFY });
  check(!r.error && !r.changed && r.added === 0, '第二次 changed=false');
  check(fs.readFileSync(S, 'utf8') === before, '文件内容一字不差');
  check(backups() === 0, '**没多一个备份文件** —— 开机调用每次多一个的话一年几百个');
}

console.log('\n[3] 别人的东西一个不动；我们的旧条目认得出、换得掉');
{
  const s = read();
  s.statusLine = { type: 'command', command: 'my-status' };
  s.enabledPlugins = { 'foo@bar': true };
  s.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'some-other-tool --stop' }] });
  // 旧安装目录留下的条目（路径里没有 WaifuCode 字样）
  s.hooks.PreCompact.push({ hooks: [{ type: 'command', command: '"E:\\old\\node.exe" "E:\\old\\app\\hooks\\notify.js" PreCompact', timeout: 5 }] });
  fs.writeFileSync(S, JSON.stringify(s, null, 2), 'utf8');

  const r = install({ settingsPath: S, nodeBin: NODE, notify: NOTIFY });
  check(r.changed && r.removed === EVENTS.length + 1, '旧条目全清掉（含旧目录那条），换成新的');
  check(backups() === 1, '真要改才备份一次');
  const t = read();
  check(t.statusLine && t.statusLine.command === 'my-status' && t.enabledPlugins['foo@bar'] === true, 'statusLine / enabledPlugins 一个字没动');
  check(t.hooks.Stop.length === 2 && t.hooks.Stop[0].hooks[0].command === 'some-other-tool --stop', '别人的 Stop hook 还在、还在前面');
  check(t.hooks.PreCompact.length === 1 && t.hooks.PreCompact[0].hooks[0].command.includes(NOTIFY), '旧目录那条没了，只剩当前目录这条');
  check(isOurs({ hooks: [{ type: 'command', command: '"C:\\x\\node.exe" "D:\\anything\\hooks\\notify.js" Stop' }] }),
        '认自己靠「notify.js 事件名」这个尾巴，不靠路径里有没有 WaifuCode');
  check(!isOurs({ hooks: [{ type: 'command', command: '"C:\\x\\node.exe" "D:\\other\\notify.js" --stop' }] }),
        '别人家也叫 notify.js 但尾巴不是我们的事件名 → 不认');
}

console.log('\n[4] 卸：只摘我们的');
{
  const r = install({ settingsPath: S, remove: true });
  check(r.changed && r.removed === EVENTS.length, '摘掉 ' + EVENTS.length + ' 条');
  const t = read();
  check(t.hooks.Stop.length === 1 && t.hooks.Stop[0].hooks[0].command === 'some-other-tool --stop', '别人的留着');
  check(!t.hooks.PreCompact && !t.hooks.PreToolUse, '只剩我们的那些事件整个删掉，不留空数组');
  check(t.statusLine.command === 'my-status', 'statusLine 还在');
  const r2 = install({ settingsPath: S, remove: true });
  check(!r2.changed && backups() === 2, '再卸一次没东西可卸，不写不备份');
}

console.log('\n[5] 坏掉的 settings.json：一个字不碰');
{
  const S2 = path.join(TMP, 'broken.json');
  fs.writeFileSync(S2, '{ "hooks": [1,2', 'utf8');
  const r = install({ settingsPath: S2, nodeBin: NODE, notify: NOTIFY });
  check(r.error && r.error.includes('解析不了') && !r.changed, '报错不写（' + r.error + '）');
  check(fs.readFileSync(S2, 'utf8') === '{ "hooks": [1,2', '原文件原样');
  // 带 BOM 的要能读（PowerShell 5.1 写出来的就是这样）
  const S3 = path.join(TMP, 'bom.json');
  fs.writeFileSync(S3, '\uFEFF{"statusLine":{"type":"command","command":"x"}}', 'utf8');
  const r3 = install({ settingsPath: S3, nodeBin: NODE, notify: NOTIFY });
  check(!r3.error && r3.changed && JSON.parse(fs.readFileSync(S3, 'utf8')).statusLine.command === 'x', '带 BOM 的读得了，写回去没 BOM');
}

console.log('\n[6] 没真 node：写 .cmd 垫片，命令指向垫片');
{
  const S4 = path.join(TMP, 'asnode.json');
  const WRAP = path.join(TMP, 'data', 'hooks');
  const EXE = 'D:\\Apps\\xiaoyi\\WaifuCode.exe';
  const r = install({ settingsPath: S4, nodeBin: EXE, asNode: true, notify: NOTIFY, wrapperDir: WRAP });
  check(!r.error && r.changed, '装上了（' + JSON.stringify(r.error) + '）');
  const cmdFile = path.join(WRAP, 'notify.cmd');
  check(fs.existsSync(cmdFile), '垫片落在数据目录（安装目录可能只读）');
  const body = fs.readFileSync(cmdFile, 'utf8');
  check(body.includes('set ELECTRON_RUN_AS_NODE=1') && body.includes('"' + EXE + '" "' + NOTIFY + '" %*'),
        '垫片：set ELECTRON_RUN_AS_NODE=1 + electron.exe notify.js %*');
  check(body.startsWith('@echo off'), '@echo off —— 回显会进 hook 的 stdout，而某些 hook 的 stdout 会回灌给模型');
  const t = JSON.parse(fs.readFileSync(S4, 'utf8'));
  check(t.hooks.Stop[0].hooks[0].command === '"' + cmdFile + '" Stop', '命令指向垫片 + 事件名');
  check(isOurs(t.hooks.Stop[0]), '垫片形态的条目也认得出是自己的');
  const r2 = install({ settingsPath: S4, nodeBin: EXE, asNode: true, notify: NOTIFY, wrapperDir: WRAP });
  check(!r2.changed, '垫片形态同样幂等');

  // 垫片真的能把 electron 掰成 node 吗 —— 有本地 electron 就实跑一次
  const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(electron)) {
    const probe = path.join(TMP, 'probe.js');
    fs.writeFileSync(probe, 'process.stdout.write("argv=" + process.argv.slice(2).join(",") + " node=" + process.versions.node)', 'utf8');
    install({ settingsPath: path.join(TMP, 'real.json'), nodeBin: electron, asNode: true, notify: probe, wrapperDir: path.join(TMP, 'real') });
    let out = '';
    try { out = execFileSync('cmd.exe', ['/c', path.join(TMP, 'real', 'notify.cmd'), 'Stop'], { encoding: 'utf8', timeout: 20000 }); }
    catch (err) { out = 'ERR ' + err.message; }
    check(/argv=Stop node=\d+/.test(out), '实跑：electron.exe 被垫片掰成 node，事件名透传到了（' + out.trim().slice(0, 40) + '）');
  } else {
    console.log('  （本机没有 node_modules/electron，跳过实跑）');
  }
}

console.log('\n[7] 主进程接线');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check(main.includes("require('../hooks/install')"), 'main.js 引了 hooks/install');
  check(main.includes("ensureHooks('开机')"), '**开机就装** —— 原来只有开发机手动 npm run install-hooks，发出去的包一次都没装过');
  check(main.indexOf("ensureHooks('开机')") < main.indexOf('startServer({'), '装在起 hook 服务之前');
  check(main.includes("ensureHooks('刚装好 claude')"), '「帮我装」装完 claude 也装一次（开机那次因为没装 claude 跳过了）');
  const fn = main.slice(main.indexOf('function ensureHooks'), main.indexOf('function ensureHooks') + 1200);
  check(fn.includes('if (!claudeInstalled())'), '没装 Claude Code 的机器不装（那份 settings.json 是人家 Claude Code 的）');
  check(fn.includes('terminals.node') && fn.includes('asNode'), 'node 用 terminals.findNode 那套（没真 node 就走垫片）');
  check(fn.includes("path.join(DATA_ROOT, 'hooks')"), '垫片放数据目录');
  check(fn.includes('try {') && fn.includes('catch (err)'), '出错只记一行，绝不把桌宠拖死');
  const inst = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'install.js'), 'utf8');
  check(inst.includes('if (require.main === module) cli();'), 'install.js 既是模块也是脚本，npm run install-hooks 照旧');
  check(!/process\.exit/.test(inst.slice(0, inst.indexOf('function cli'))), 'install() 里不许 process.exit（主进程调它）');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 临时目录留着也无妨 */ }
console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
