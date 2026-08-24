'use strict';

// 她在终端里烧了多少钱，算得对不对。
//
// 这块必须有自检的理由：**算错了没人会发现**。金额是个数字，偏 3 倍和准确
// 长得一模一样，你只会觉得「哦今天有点贵」。而它又直接影响你要不要多派一个活。
//
// 三件事必须守住：
//   · 单价和倍率（缓存写 1.25 / 2 倍、缓存读 0.1 倍）不许写错
//   · 增量读不许重复计钱 —— 面板每 3 秒问一次，重复一次账就翻一倍
//   · 半行不许当成一行算 —— jsonl 是边跑边追加的，读到的最后一行经常是断的
//
// 不起会话、不联网、一瞬间跑完。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-cost-'));
process.env.CLAUDE_HOME = HOME;

const cost = require('../src/cost');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

process.on('exit', () => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
});

// ---------------------------------------------------------------------------

console.log('\n[1] 单价和那三个倍率');
{
  // Opus 5 是 $5 进 / $25 出（每百万 token）
  check(near(cost.usdOf({ input_tokens: 1e6 }, 'claude-opus-5'), 5), '输入 100 万 token = $5');
  check(near(cost.usdOf({ output_tokens: 1e6 }, 'claude-opus-5'), 25), '输出 100 万 token = $25');
  check(near(cost.usdOf({ cache_read_input_tokens: 1e6 }, 'claude-opus-5'), 0.5),
        '缓存读是输入价的 0.1 倍 → $0.5');
  check(near(cost.usdOf({ cache_creation_input_tokens: 1e6 }, 'claude-opus-5'), 6.25),
        '缓存写（没细分）按 1.25 倍 → $6.25');

  // 细分字段在就得用细分的：5 分钟 1.25 倍、1 小时 2 倍
  const split = cost.usdOf({
    cache_creation_input_tokens: 2e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
  }, 'claude-opus-5');
  check(near(split, 5 * 1.25 + 5 * 2), '5 分钟档 1.25 倍、1 小时档 2 倍，分开算 → $11.25');

  check(near(cost.usdOf({ input_tokens: 1e6 }, 'claude-sonnet-5'), 3), 'Sonnet 5 输入 $3');
  check(near(cost.usdOf({ input_tokens: 1e6 }, 'claude-haiku-4-5'), 1), 'Haiku 4.5 输入 $1');
  check(near(cost.usdOf({ input_tokens: 1e6 }, 'claude-haiku-4-5-20251001'), 1),
        '带日期后缀的也认得出来（按前缀找）');
  check(near(cost.usdOf({ input_tokens: 1e6 }, 'claude-什么鬼-9'), 5),
        '**没见过的模型按 Opus 算** —— 宁可报高，报低会让你放心地多派活');
  check(cost.usdOf(null, 'claude-opus-5') === 0, '没有 usage 就是 0，不炸');
}

console.log('\n[2] 增量读：同一份记录问两遍，钱不许翻倍');
{
  const dir = path.join(HOME, '.claude', 'projects', 'D--Fake');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  const file = path.join(dir, sid + '.jsonl');

  const row = (out) => JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: { output_tokens: out } },
  }) + '\n';

  fs.writeFileSync(file, row(1e6), 'utf8');
  const a = cost.ofSession(sid);
  check(near(a.total, 25), '第一次问：$25');

  const b = cost.ofSession(sid);
  check(near(b.total, 25) && near(b.delta, 0),
        '**第二次问还是 $25，增量 0** —— 面板每 3 秒问一次，这条错了账就一直翻倍');

  fs.appendFileSync(file, row(1e6), 'utf8');
  const c = cost.ofSession(sid);
  check(near(c.total, 50) && near(c.delta, 25), '又干了一轮：总额 $50，增量 $25');
}

console.log('\n[3] 半行不许算 —— 记录是边跑边写的，最后一行经常是断的');
{
  const dir = path.join(HOME, '.claude', 'projects', 'D--Half');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = path.join(dir, sid + '.jsonl');

  const full = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: { output_tokens: 1e6 } },
  }) + '\n';

  // 先写一半
  fs.writeFileSync(file, full.slice(0, 40), 'utf8');
  check(near(cost.ofSession(sid).total, 0), '只写了半行 → 一分钱都不算');

  // 补完
  fs.writeFileSync(file, full, 'utf8');
  check(near(cost.ofSession(sid).total, 25), '写完了 → $25，而且只算一遍');
}

console.log('\n[4] 文件被换掉（清过、或者 id 撞了）');
{
  const dir = path.join(HOME, '.claude', 'projects', 'D--Reset');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '99999999-8888-7777-6666-555555555555';
  const file = path.join(dir, sid + '.jsonl');
  const row = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: { output_tokens: 1e6 } },
  }) + '\n';

  fs.writeFileSync(file, row + row, 'utf8');
  check(near(cost.ofSession(sid).total, 50), '两轮 → $50');

  fs.writeFileSync(file, row, 'utf8'); // 变短了
  check(near(cost.ofSession(sid).total, 25),
        '文件变短 = 换了一份，从头重算（不能拿老的偏移量接着读）');
}

console.log('\n[5] 不是她的东西一律不算');
{
  check(near(cost.ofSession('这个-会话-根本-不存在').total, 0), '找不到记录就是 0');
  check(near(cost.ofSession(null).total, 0), '没有会话 id 也不炸');

  const dir = path.join(HOME, '.claude', 'projects', 'D--Noise');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    '不是 json 的一行',
    '{"type":"assistant","message":{"model":"claude-opus-5"}}', // 没有 usage
    '',
  ].join('\n'), 'utf8');
  check(near(cost.ofSession(sid).total, 0),
        '你说的话、坏行、没有 usage 的行，都不算钱');
}

console.log('\n[+] 四桶拆账与按模型分桶（同一遍扫描出的，账要能对上）');
{
  const dir = path.join(HOME, '.claude', 'projects', 'D--Buckets');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: {
      input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 3000 } } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: {
      input_tokens: 100, output_tokens: 200 } } }),
    '',
  ].join('\n'), 'utf8');
  const r = cost.ofSession(sid);
  const sum = r.parts.input + r.parts.output + r.parts.cacheRead + r.parts.cacheWrite;
  check(near(sum, r.total), '四桶加起来 = 总数（差一分钱都是账错了）');
  check(r.tokens.input === 1100 && r.tokens.cacheRead === 2000 && r.tokens.cacheWrite === 3000,
        'token 也按桶数着（input 1100 / read 2000 / write 3000）');
  check(near(r.byModel['claude-opus-5'] + r.byModel['claude-sonnet-5'], r.total),
        '按模型分桶的钱加起来也 = 总数');
  // 命中率分母必须含 cacheWrite —— 不含的话真实会话永远 ~100%（input 只是
  // 「既没读也没写缓存」的零头），仪表就是死的（评审实测抓的）
  check(cost.cacheHit(r.tokens) === 33, '缓存命中 33%（2000 / 6100，分母含 cacheWrite）');
  check(cost.cacheHit({ input: 2, cacheRead: 27265, cacheWrite: 20177 }) === 57,
        '真实量级（input 个位数）也算得出有意义的数，不是恒 100%');
  check(cost.cacheHit(null) === null && cost.cacheHit({}) === null, '没数据就 null，不编');
}

console.log('\n[+] 自动线名：从会话尾巴抠「你最后说的话」');
{
  const dir = path.join(HOME, '.claude', 'projects', 'D--Hint');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '把支付回调修一下' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: '好' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>杂音</system-reminder>' } }),
    '',
  ].join('\n'), 'utf8');
  check(cost.lastUserPrompt(sid) === '把支付回调修一下',
        '抠出的是人话，工具结果和 <> 开头的杂音都跳过');
  check(cost.lastUserPrompt('没有这条会话') === '', '找不到就空着，不编');
}

console.log('');
console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
