'use strict';
// 桌面感知那批的自检：拖文件分流、读日志尾巴、git 值日生的三小时线、
// 全屏判定的去抖，外加接线检查（新频道进没进白名单这类静默死角）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const desk = require('../src/desk');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

console.log('[1] 拖过来的东西认得对');
{
  const st = (dir, size = 100) => ({ isDirectory: () => dir, size });
  check(desk.kindOf('D:\\proj', st(true)) === 'dir', '文件夹 → 派活');
  check(desk.kindOf('a.MP3', st(false)) === 'music', '歌（大小写无所谓）→ 歌单');
  check(desk.kindOf('shot.png', st(false)) === 'image', '图 → 剪贴板');
  check(desk.kindOf('err.log', st(false)) === 'text', '日志 → 拿去问她');
  check(desk.kindOf('big.log', st(false, 5 * 1024 * 1024)) === 'nope',
        '超过 2MB 的文本不硬塞（尾巴那点内容对不起那么大个文件的误会）');
  check(desk.kindOf('app.exe', st(false)) === 'nope', '看不懂的老实说看不懂');
}

console.log('\n[2] 读尾巴：报错永远在日志屁股上');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, '开头的废话\n'.repeat(500) + '最后的报错：TypeError 炸了', 'utf8');
  const t = desk.tailOf(f, 200);
  check(t.includes('TypeError 炸了'), '尾巴上的报错在');
  check(t.length < 400, '开头没整个搬进来（只要尾巴那 200 字）');
  check(t.startsWith('…'), '掐过头要标出来（「前面略」）');
  const small = path.join(dir, 's.log');
  fs.writeFileSync(small, '就一行', 'utf8');
  check(desk.tailOf(small, 200) === '就一行', '小文件原样给，不加省略号');
  // 中文 3 字节一个字，切半个字符不许出现乱码替代符开头
  const cn = path.join(dir, 'c.log');
  fs.writeFileSync(cn, '中文内容'.repeat(300), 'utf8');
  check(!desk.tailOf(cn, 100).includes('\uFFFD'), '中文不切出半个乱码字');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] 收歌不打架');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-m-'));
  check(desk.freshName(dir, '歌.mp3') === '歌.mp3', '没重名就用原名');
  fs.writeFileSync(path.join(dir, '歌.mp3'), 'x');
  check(desk.freshName(dir, '歌.mp3') === '歌(2).mp3', '重名了加 (2) —— **绝不覆盖**（可能是首不同的歌）');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[4] git 值日生：三小时线');
{
  const st = {};
  const t0 = 1000000;
  check(desk.gitNagCheck(st, 'p', 3, t0) === false, '第一次看见脏：只记时刻，不念叨');
  check(desk.gitNagCheck(st, 'p', 5, t0 + 60 * 60000) === false, '一小时：还不到时候');
  check(desk.gitNagCheck(st, 'p', 5, t0 + 3 * 3600000) === true, '满三小时：该念叨了');
  check(desk.gitNagCheck(st, 'p', 0, t0 + 4 * 3600000) === false, '提交干净了：闭嘴');
  check(desk.gitNagCheck(st, 'p', 2, t0 + 4 * 3600000) === false, '又脏了：从头计时，不是接着上次');
}

console.log('\n[5] 全屏去抖：进要两拍，出一拍就出');
{
  const st = {};
  check(desk.fsDebounce(st, true) === false, '第一拍全屏：先不信（切窗口会闪）');
  check(desk.fsDebounce(st, true) === true, '第二拍还全屏：信了，闭嘴');
  check(desk.fsDebounce(st, false) === false, '一拍不全屏：立刻放开（多憋一秒都是浪费）');
  check(desk.fsDebounce(st, true) === false, '再进又要从两拍数起');
}

console.log('\n[6] 接线：静默死角逐个钉');
{
  const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  check(pre.includes("'chat:ask'") && pre.includes("'panel:prefill'"),
        '两个新推送频道进了 preload 白名单（不进的话 on() 静默空转）');
  check(pre.includes('webUtils.getPathForFile'),
        '拖放路径用 webUtils 换 —— Electron 32 起 File.path 没了，渲染层拿不到');
  const stage = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'stage.js'), 'utf8');
  check(/dragover[\s\S]{0,80}preventDefault/.test(stage),
        'dragover 必须 preventDefault，不然 drop 被内核吞了');
  check(/pet:cursor[^]{0,200}setThrough/.test(stage),
        '穿透状态吃 pet:cursor 轮询 —— OS 拖拽期间没有 mousemove，不吃轮询的话拖放整个是死的');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check(main.includes("require('./desk')"), 'desk 在 main 里 require 过（「用而不引」那个死法）');
  check(/case 'commitmsg'/.test(main), '「拟一条」按钮有人接');
  check(main.includes('先别真的提交'), '拟提交信息的任务里写明了先别真提交');
  check(/hotkeyState\.clip/.test(main), '剪贴板求助键有回执（被占了要告诉用户）');
  check(/clipboard\.readText\(\)/.test(main.slice(main.indexOf('剪贴板求助键'))),
        '只在按键那一刻读剪贴板 —— 不做后台偷看');
  check(main.includes('CoreWindow'),
        '全屏判定排除系统壳层（锁屏/开始菜单是 CoreWindow，天生满屏，实机踩过）');
  check(/fsProbing/.test(main), '探针不叠发（上一发没回来不发下一发）');
  check(/function hushed\(\)/.test(main) && main.includes('hushed() ?'),
        '闭嘴只从 hushed() 一个口问（quiet 和全屏勿扰分开存、一起判）');
  const setj = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.js'), 'utf8');
  check(setj.includes("'hk-clip'"), '设置页能录第三个键');
  check(/HK\[/.test(setj), '键位映射走表 —— 原来 panel/shot 二选一的写法会把第三个键悄悄归到 shot');
  const conf = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  check(/clip:\s*''/.test(conf), '求助键默认不占键（跟截图同一个理由）');
  const chatr = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat.js'), 'utf8');
  check(chatr.includes("'chat:ask'"), '聊天窗口接了 chat:ask（替你打字并发送）');
  const panelr = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.js'), 'utf8');
  check(panelr.includes("'panel:prefill'"), '面板接了 panel:prefill（拖文件夹预填目录）');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
