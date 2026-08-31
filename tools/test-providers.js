'use strict';
// 「接入点」的自检。全离线，cipher 用替身。
//
// 守的是一条铁律：**不碰用户自己的登录和模型**。
//   · 官方 = env 空对象，一个变量都不加
//   · 认不出的接入点 → 官方，绝不拿一把不对的钥匙去撞
//   · 钥匙不进公开名单、不进 spec、不进日志；解不开就当官方
//   · 模型只认白名单：官方认 claude-*，第三方只认它自己名单里的
const fs = require('fs');
const path = require('path');
const P = require('../src/providers');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

// 替身 cipher：可逆但一眼看得出是「密文」
const stub = {
  available: () => true,
  encrypt: (s) => 'ENC:' + Buffer.from(s, 'utf8').toString('base64'),
  decrypt: (b) => { if (!String(b).startsWith('ENC:')) throw new Error('bad'); return Buffer.from(String(b).slice(4), 'base64').toString('utf8'); },
};
P.useCipher(stub);

const KEY = 'sk-deepseek-1234567890abcdef';
let cfg = { providers: [], dispatch: { provider: 'official', model: 'claude-sonnet-5' } };

console.log('[1] 官方那档：什么都不加');
{
  check(JSON.stringify(P.envFor(cfg, 'official', 'claude')) === '{}', '官方 → env 空对象（用户自己的登录原样）');
  check(JSON.stringify(P.envFor(cfg, '', 'claude')) === '{}', '没选 → 官方');
  check(JSON.stringify(P.envFor(cfg, '不存在的', 'claude')) === '{}', '**认不出的接入点 → 官方**，绝不瞎给一把钥匙');
  const r = P.resolve(cfg, 'official', 'claude-sonnet-5', 'claude');
  check(r.provider === 'official' && r.model === 'claude-sonnet-5', '官方的模型走白名单');
  check(P.resolve(cfg, 'official', 'gpt-99', 'claude').model === undefined, '官方不认的模型名当没选');
  check(P.resolve(cfg, 'official', 'claude-opus-5', 'codex').model === undefined, 'codex 不认 claude 的模型名');
  check(P.publicList(cfg).length === 1 && P.publicList(cfg)[0].id === 'official', '名单里永远有官方且排第一');
}

console.log('\n[2] 加一条 DeepSeek：钥匙进去是密文');
{
  cfg.providers = P.upsert(cfg, {
    name: 'DeepSeek', kind: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic/',
    models: 'deepseek-v4-flash\ndeepseek-v4-pro\n\ndeepseek-v4-flash', key: KEY, priceIn: 3, priceOut: 9,
  });
  const p = cfg.providers[0];
  check(cfg.providers.length === 1 && p.id.startsWith('p_'), '存进去了，自动发了个 id');
  check(p.keyEnc && p.keyEnc.startsWith('ENC:') && !p.keyEnc.includes(KEY), '**存的是密文**，不是明文');
  check(p.keyTail === 'cdef', '末四位留着方便认');
  check(p.baseUrl === 'https://api.deepseek.com/anthropic', '地址尾巴的斜杠去掉');
  check(p.models.length === 2 && p.models[0] === 'deepseek-v4-flash', '模型名单去空去重');
  const pub = JSON.stringify(P.publicList(cfg));
  check(!pub.includes(KEY) && !pub.includes('ENC:') && pub.includes('cdef'), '**公开名单里没有钥匙、连密文都没有**，只有末四位');
  check(P.publicList(cfg)[1].priced === true, '填了单价 → priced');
}

console.log('\n[3] 选了 DeepSeek：env 只多那两个变量，钥匙现解');
{
  const id = cfg.providers[0].id;
  const env = P.envFor(cfg, id, 'claude');
  check(Object.keys(env).filter((k) => k !== 'CLAUDE_CODE_EFFORT_LEVEL').sort().join(',') === 'ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,API_TIMEOUT_MS',
        '只加 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + API_TIMEOUT_MS（+ 档位压制），别的一个不碰');
  check(env.API_TIMEOUT_MS === '3000000', '第三方口把单次请求超时拉长（智谱文档要求的值），不然长回复被掐断');
  check(env.ANTHROPIC_AUTH_TOKEN === KEY && env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic', '钥匙解开了、地址对');
  const r = P.resolve(cfg, id, 'deepseek-v4-pro', 'claude');
  check(r.provider === id && r.model === 'deepseek-v4-pro', '模型只认它自己名单里的');
  check(P.resolve(cfg, id, 'claude-opus-5', 'claude').model === 'deepseek-v4-flash',
        '给了名单外的模型 → 用名单第一个（第三方端点认不得 claude-* 默认名）');
  check(P.resolve(cfg, id, '', 'codex').provider === 'official',
        '**口对不上就当官方**：anthropic 兼容口不给 codex 用');
  check(JSON.stringify(P.envFor(cfg, id, 'codex')) === '{}', '同上，env 也是空的');
  // 切回官方：没有任何要撤销的东西
  check(JSON.stringify(P.envFor(cfg, 'official', 'claude')) === '{}', '**切回官方 = 那两个变量不再出现**，用户的登录从头到尾没被动过');
}

console.log('\n[4] OpenAI 兼容口给 codex');
{
  cfg.providers = P.upsert(cfg, { name: '本机 Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3.7'], key: '' });
  const o = cfg.providers.find((p) => p.name === '本机 Ollama');
  check(o && !o.keyEnc, '不给钥匙的（本机）存空');
  const env = P.envFor(cfg, o.id, 'codex');
  check(env.OPENAI_BASE_URL === 'http://127.0.0.1:11434/v1' && env.OPENAI_API_KEY === 'local',
        'codex 那对变量；没钥匙的给个占位（CLI 没 token 会去要登录）（' + JSON.stringify(Object.keys(env)) + '）');
  check(JSON.stringify(P.envFor(cfg, o.id, 'claude')) === '{}', 'openai 口不给 claude');
  check(P.priceUsdOf(cfg, o.id) === null && P.publicList(cfg).find((x) => x.id === o.id).priced === false,
        '没填单价 → null（面板显示「未计价」，不显示 $0）');
}

console.log('\n[5] 钱按第三方单价算，缓存全按输入价（宁可报高）');
{
  const id = cfg.providers[0].id;
  const price = P.priceUsdOf(cfg, id);
  check(Math.abs(price[0] - 3 / 7.2) < 1e-9 && Math.abs(price[1] - 9 / 7.2) < 1e-9, '元/百万 → 美元/百万');
  const usd = P.priceUsage({ input_tokens: 1000000, cache_read_input_tokens: 1000000, output_tokens: 1000000 }, price);
  check(Math.abs(usd - (2 * 3 + 9) / 7.2) < 1e-9, '输入 + 缓存读都按输入价，输出按输出价');
  check(P.priceUsage({ input_tokens: 5 }, null) === 0, '没单价 → 0');
}

console.log('\n[6] 解不开的钥匙 / 坏存档：当官方，不炸');
{
  const broken = { providers: [{ id: 'p_bad', name: '坏的', kind: 'anthropic', baseUrl: 'https://x', models: ['m'], keyEnc: '不是密文' }, null, 3, { id: 'official' }] };
  check(JSON.stringify(P.envFor(broken, 'p_bad', 'claude')) === '{}', '密文解不开 → 官方（不拿乱码当钥匙）');
  check(P.publicList(broken).length === 2, '存档里的垃圾条目直接扔（null / 数字 / 冒充 official 的）');
  P.useCipher({ available: () => false, encrypt: () => '', decrypt: () => '' });
  let threw = false;
  try { P.upsert(cfg, { name: 'x', baseUrl: 'https://x', models: ['m'], key: 'sk-1' }); } catch (_) { threw = true; }
  check(threw, '**safeStorage 不可用时拒绝存钥匙**，绝不落明文');
  check(JSON.stringify(P.envFor(cfg, cfg.providers[0].id, 'claude')) === '{}', '解不了钥匙 → 官方');
  P.useCipher(stub);
}

console.log('\n[7] 校验：地址、模型');
{
  const bad1 = (() => { try { P.upsert(cfg, { name: 'x', baseUrl: 'api.deepseek.com', models: ['m'] }); return false; } catch (_) { return true; } })();
  const bad2 = (() => { try { P.upsert(cfg, { name: 'x', baseUrl: 'https://x', models: '' }); return false; } catch (_) { return true; } })();
  const bad3 = (() => { try { P.upsert(cfg, { id: 'official', name: 'x', baseUrl: 'https://x', models: ['m'] }); return false; } catch (_) { return true; } })();
  check(bad1 && bad2 && bad3, '没 http 前缀 / 没模型 / 冒充 official 都拒');
  const before = cfg.providers.length;
  const id = cfg.providers[0].id;
  const updated = P.upsert(cfg, { id, name: 'DeepSeek 改名', models: ['a', 'b'] });
  const p = updated.find((x) => x.id === id);
  check(updated.length === before && p.name === 'DeepSeek 改名' && p.keyEnc && p.baseUrl.includes('deepseek'), '改名不动钥匙和地址');
  cfg.providers = P.upsert(cfg, { id, key: '' });
  check(!cfg.providers.find((x) => x.id === id).keyEnc, 'key 传空串 = 明确清掉');
  cfg.providers = P.remove(cfg, id);
  check(!cfg.providers.find((x) => x.id === id), '删得掉');
}

console.log('\n[8] 陪聊那张嘴：跟派活一样 / 单独指定');
{
  cfg.providers = P.upsert(cfg, { name: 'DeepSeek', kind: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-v4-flash'], key: KEY, priceIn: 3, priceOut: 9 });
  const id = cfg.providers.find((p) => p.name === 'DeepSeek').id;
  cfg.dispatch = { provider: id };
  cfg.chat = { provider: 'same' };
  const c = P.forChat(cfg, 'claude');
  check(c.id === id && c.env.ANTHROPIC_AUTH_TOKEN === KEY && c.model === 'deepseek-v4-flash' && c.price, '「跟派活一样」→ 跟着 dispatch.provider');
  cfg.chat = { provider: 'official' };
  const o = P.forChat(cfg, 'claude');
  check(o.id === 'official' && JSON.stringify(o.env) === '{}' && o.model === undefined, '陪聊单独指定官方 → 干活用国产、聊天走订阅，互不影响');
  check(P.redact('报错: Bearer ' + KEY + ' 401', cfg) === '报错: Bearer *** 401', '日志里的钥匙抹掉');
}

console.log('\n[9] 接线：钥匙不进 spec、不进手机端、四处 spawn 都带 env');
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const main = read('src/main.js');
  const term = read('src/terminals.js');
  const shell = read('hooks/term-shell.js');
  check(main.includes("require('./providers')") && main.includes('providers.useCipher('), 'main 引了 providers 并把 safeStorage 注进去');
  check(term.includes("phase === 'env'") || term.includes("case 'env'"), 'term-shell 开 CLI 前向桌宠要 env（wt 的标签页不继承 spawn 的 env，launcher 也不许写钥匙）');
  check(shell.includes("phase: 'env'") && shell.includes('...extraEnv'), 'term-shell 拿到就合进 CLI 的 env');
  check(!term.includes('keyEnc') && !shell.includes('AUTH_TOKEN'), 'terminals / term-shell 里不出现钥匙字段（钥匙只在 providers.envFor 那一刻解开）');
  check(main.includes('providers.publicList('), '给面板/手机端的是 publicList（没钥匙）');
  const mobileState = main.slice(main.indexOf('function mobileState'), main.indexOf('function mobileState') + 2500);
  check(mobileState.includes('publicList'), '手机端拿的也是 publicList');
  for (const f of ['src/chat.js', 'src/greet.js', 'src/diary.js', 'src/sessions.js']) {
    const s = read(f);
    check(/\.\.\.(this\.)?(extraEnv|env|pv\.env|prov\.env)\b|getProvider\(\)|\.env\b/.test(s) && s.includes('WAIFU_SELF'),
          f + ' 的 spawn 带上接入点 env');
  }
  const ck = read('CLAUDE.md');
  check(ck.includes('test-providers.js'), '进了 CLAUDE.md 的自检清单');
}

console.log('\n[10] 思考档位：第三方口只认 low / high / max');
{
  // 用户全局 effortLevel: xhigh → 智谱 400 [1210]「请使用 low、high 或 max」（2026-08-31 实拍）。
  // 环境变量压得过 settings.json（2.1.251 用假接口实测），所以塞 CLAUDE_CODE_EFFORT_LEVEL 就够
  const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const restore = () => { if (saved === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL; else process.env.CLAUDE_CODE_EFFORT_LEVEL = saved; };
  const tryLv = (lv) => { process.env.CLAUDE_CODE_EFFORT_LEVEL = lv; return P.effortEnv().CLAUDE_CODE_EFFORT_LEVEL; };
  check(tryLv('xhigh') === 'high', 'xhigh → high（xhigh 是 Claude 5 才有的档）');
  check(tryLv('medium') === 'high', 'medium → high（智谱明说不认 medium）');
  check(tryLv('low') === 'low' && tryLv('max') === 'max' && tryLv('high') === 'high', 'low / high / max 原样');
  const c = { providers: [], dispatch: { provider: 'official' } };
  c.providers = P.upsert(c, { name: '智谱', kind: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: 'glm-5.3', key: KEY });
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'xhigh';
  check(P.envFor(c, c.providers[0].id, 'claude').CLAUDE_CODE_EFFORT_LEVEL === 'high', '第三方 Anthropic 口带着压过的档位');
  check(!('CLAUDE_CODE_EFFORT_LEVEL' in P.envFor(c, 'official', 'claude')), '官方线不压：官方认 xhigh，压了反而是降级');
  c.providers = P.upsert(c, { name: '本机', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: 'qwen3.7' });
  const ol = c.providers.find((p) => p.kind === 'openai');
  check(!('CLAUDE_CODE_EFFORT_LEVEL' in P.envFor(c, ol.id, 'codex')), 'OpenAI 口（codex）不带这个变量，它不认');
  restore();
}

console.log('\n[11] 钥匙怎么到终端窗口：term-shell 问一句，桌宠回一包 env');
(function () {
  // ① server.js：/term 收到 phase=env 时把 onTermEvent 回的 {env} 当响应体。
  //    只看源码不真起服务 —— Windows 上 node 的 listen 不带 SO_EXCLUSIVEADDRUSE，
  //    自检起的服务会跟正开着的桌宠**共用同一个端口**，请求打到谁头上全凭运气（实测撞过）
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    check(src.includes('reply && (reply.line || reply.env)'), '/term 的 env 那一问有响应体（原来只有 close 的总账一行才回）');
  }
  const os = require('os');
  step2();

  // ② terminals.onShellEvent：phase=env 回 envFor(rec)，钥匙不在 rec/spec 里
  function step2() {
    const { TerminalManager } = require('../src/terminals');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-pv2-'));
    const seen = [];
    const tm = new TerminalManager({
      storeDir: tmp2, getConfig: () => ({}), log: () => {},
      envFor: (rec) => { seen.push(rec.provider); return rec.provider === 'p_ds' ? { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 'sk-abc' } : {}; },
    });
    const spec = { id: 'w7', name: 'x', dir: tmp2, task: '', sessionId: 's7', windowName: 'w', title: 'WaifuCode · x', agent: 'claude', provider: 'p_ds', providerName: 'DeepSeek' };
    fs.mkdirSync(path.join(tmp2, 'terminals'), { recursive: true });
    fs.writeFileSync(path.join(tmp2, 'terminals', 'w7.json'), JSON.stringify(spec), 'utf8');
    const rec = tm._makeRecord(spec, { pid: 1, status: 'idle' });
    tm.items.set('w7', rec);
    const r = tm.onShellEvent({ termId: 'w7', phase: 'env' });
    check(r && r.env && r.env.ANTHROPIC_AUTH_TOKEN === 'sk-abc' && seen[0] === 'p_ds',
          'onShellEvent(env) 回 envFor(rec) 的结果，按这条线的接入点');
    check(!JSON.stringify(spec).includes('sk-abc') && !fs.readFileSync(path.join(tmp2, 'terminals', 'w7.json'), 'utf8').includes('sk-'),
          '**spec 文件里没有钥匙**，只有接入点 id');
    const r2 = tm.onShellEvent({ termId: 'w7', phase: 'beat' });
    check(r2 === undefined, '别的 phase 照旧不回东西');
    const noP = tm._makeRecord({ ...spec, id: 'w8', provider: undefined }, { pid: 1, status: 'idle' });
    tm.items.set('w8', noP);
    const r3 = tm.onShellEvent({ termId: 'w8', phase: 'env' });
    check(r3 && r3.env && Object.keys(r3.env).length === 0, '没选接入点的线 → 空 env（官方原样）');
    tm.dispose();
    try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (_) { /* 留着也无妨 */ }
    finishAll();
  }

  function finishAll() {
    console.log('');
    console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
    process.exit(bad === 0 ? 0 : 1);
  }
})();
return;
console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
