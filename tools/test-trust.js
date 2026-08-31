'use strict';
// 守 src/trust.js：预先信任目录。碰的是用户核心配置 ~/.claude.json，一步错就毁全部项目状态，
// 所以这里把「绝不覆盖坏文件 / 只加一个字段 / 幂等 / key 跟 claude 对齐」逐条钉死。
// 全程用临时文件，绝不碰真的 ~/.claude.json。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trust = require('../src/trust');

const TMP = path.join(os.tmpdir(), 'waifu-trust-test-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });
const CJ = path.join(TMP, 'claude.json');
let n = 0;
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const write = (obj, indent) => fs.writeFileSync(CJ, indent === 0 ? JSON.stringify(obj) : JSON.stringify(obj, null, indent == null ? 2 : indent));
const read = () => JSON.parse(fs.readFileSync(CJ, 'utf8'));

console.log('[1] trustKey：正斜杠 + 真实大小写 + 去尾斜杠');
{
  // process.cwd() 一定存在，realpath 能拿真值
  const here = trust.trustKey(process.cwd());
  assert(!here.includes('\\'), '不许有反斜杠');
  assert(!/\/$/.test(here), '末尾不许有斜杠');
  assert(here === fs.realpathSync.native(process.cwd()).replace(/\\/g, '/'), '跟 realpath 正斜杠版一致');
  ok('cwd → ' + here);
  // 脏输入：反斜杠、错大小写、尾斜杠 → 归一到同一个 key（大小写敏感的坑就靠这个躲）
  const a = trust.trustKey(process.cwd().replace(/\//g, '\\'));
  assert(a === here, '反斜杠输入归一到同一个 key');
  ok('反斜杠输入也归一');
  // 不存在的目录：realpath 失败 → 退回 resolve，不抛、格式仍是正斜杠
  const ghost = trust.trustKey('D:\\this\\does\\not\\exist\\waifu' + n);
  assert(!ghost.includes('\\') && ghost.length > 0, '不存在的目录退回 resolve，不抛、正斜杠');
  ok('不存在的目录退回 resolve：' + ghost);
}

console.log('[2] 新目录 → 加 hasTrustDialogAccepted，别的一个不碰');
{
  write({ numStartups: 7, projects: { 'C:/other': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } }, oauthAccount: { x: 1 } });
  const r = trust.ensureTrusted(process.cwd(), { file: CJ });
  assert(r.changed === true, '改动了');
  const j = read();
  assert(j.projects[r.key] && j.projects[r.key].hasTrustDialogAccepted === true, '目标目录信任了');
  assert(j.numStartups === 7 && j.oauthAccount.x === 1, '顶层别的字段原样');
  assert(j.projects['C:/other'].allowedTools[0] === 'Bash' && j.projects['C:/other'].hasTrustDialogAccepted === true, '别的 project 原样');
  ok('只加了目标目录的一个字段，其余整份 JSON 不动');
}

console.log('[3] 幂等：已信任就不碰盘');
{
  const before = fs.readFileSync(CJ, 'utf8');
  const r = trust.ensureTrusted(process.cwd(), { file: CJ });
  assert(r.changed === false && r.reason === 'already', '第二次不改');
  assert(fs.readFileSync(CJ, 'utf8') === before, '文件一字未动');
  ok('第二次 changed=false，文件没被重写');
}

console.log('[4] 坏 JSON / 文件不存在：绝不覆盖、绝不创建');
{
  fs.writeFileSync(CJ, '{ this is not json ');
  const r = trust.ensureTrusted(process.cwd(), { file: CJ });
  assert(r.changed === false && r.reason === 'bad-json', '坏 JSON → bad-json');
  assert(fs.readFileSync(CJ, 'utf8') === '{ this is not json ', '坏文件原样，没被我写坏');
  ok('坏 JSON 不覆盖');
  const gone = path.join(TMP, 'nope.json');
  const r2 = trust.ensureTrusted(process.cwd(), { file: gone });
  assert(r2.changed === false && r2.reason === 'no-file', '文件不存在 → no-file');
  assert(!fs.existsSync(gone), '没凭空造出一个残缺的 claude.json');
  ok('文件不存在不创建');
}

console.log('[5] 缩进跟随原文件（不把人家格式搅了）');
{
  write({ projects: {} }, 2);                    // 2 空格
  trust.ensureTrusted(process.cwd(), { file: CJ });
  assert(/\n  "/.test(fs.readFileSync(CJ, 'utf8')), '2 空格进 → 2 空格出');
  ok('2 空格缩进保住');
  write({ projects: {} }, 0);                    // 紧凑单行
  trust.ensureTrusted(process.cwd() + '/tools', { file: CJ }); // 换个 key，确保会写
  const raw = fs.readFileSync(CJ, 'utf8');
  assert(!raw.includes('\n'), '紧凑进 → 紧凑出（没被撑成多行）');
  ok('紧凑格式保住');
  assert(trust.detectIndent('{"a":1}') === 0 && trust.detectIndent('{\n  "a":1}') === 2 && trust.detectIndent('{\n\t"a":1}') === '\t', 'detectIndent 认得 0/2/tab');
  ok('detectIndent 三种都认');
}

console.log('[6] 原子写：写完仍是合法 JSON，没有半个文件');
{
  write({ projects: { 'C:/a': { hasTrustDialogAccepted: true } } }, 2);
  trust.ensureTrusted(process.cwd(), { file: CJ });
  const j = read();                              // 能 parse 就说明没写出半个
  assert(j.projects['C:/a'].hasTrustDialogAccepted === true, '老的还在');
  assert(!fs.existsSync(CJ + '.waifu-tmp'), '临时文件收干净了');
  ok('写后是合法 JSON、临时文件已清');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 留着也无妨 */ }
console.log('\n\x1b[32m✓ 全过\x1b[0m');
