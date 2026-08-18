'use strict';

// 每个角色的适配档案（src/profiles.js）跟模型文件对不对得上。
//
// 这里面的东西**写错了不会报错**，只会安静地少一半功能：
//   · 表情名拼错 → setExpression 找不到，脸就一直不变，日志里一个字都没有
//   · 动作组名写错 → 点她没反应，也不报错
//   · 路径写错 → profileFor 落到兜底档案，设置里显示成目录名，表情全没
// 所以拿一个不花钱的自检把它焊死。加新模型的时候顺手跑一下。
//
// 不起 Electron、不加载 moc3，纯读 json，一瞬间跑完。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PROFILES, profileFor } = require('../src/profiles');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------------------

console.log('\n[1] 档案里的每个模型都真的在盘上');
for (const key of Object.keys(PROFILES)) {
  check(fs.existsSync(path.join(ROOT, key)), key);
}

/**
 * 这个程序一共会问她摆哪些脸 —— **从源码里抠，不手抄一份**。
 * 手抄的迟早跟真的对不上，而且对不上的时候这个自检还是绿的。
 *
 * 三个来源，缺一不可：
 *   · mood.js computeState() 的返回值 —— 常驻状态（困、得意、闹脾气…）
 *   · mood.js flash(...) 的第一个参数 —— 临时闪一下（被摸、活干完了）
 *   · stage.js 的 WORK_FACE —— 干活时那几张（专注、卡住…）
 * 只抠第一个的话会漏掉 shy / surprised / working，而那几张恰恰天天出现。
 */
const MOODS = (() => {
  const mood = fs.readFileSync(path.join(ROOT, 'src', 'mood.js'), 'utf8');
  const at = mood.indexOf('computeState()');
  const stage = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'stage.js'), 'utf8');
  const workAt = stage.indexOf('const WORK_FACE');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const grab = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
  return [...new Set([
    ...grab(mood.slice(at, at + 1400), /return '([a-z]+)'/g),
    // flash 的第一个参数可能是三元表达式（`flash(ok ? 'excited' : 'sad', …)`），
    // 所以先切出第一个参数整段、再从里面抠字符串 —— 只认 flash('x' 会漏掉一半
    ...[mood, main].flatMap((t) => [...t.matchAll(/\.flash\(([^,]+),/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]))),
    ...grab(stage.slice(workAt, workAt + 400), /:\s*'([a-z]+)'/g),
  ])];
})();

console.log('\n[2] 表情名、动作组名都对得上模型自己声明的');
console.log('    （这个程序一共会问她摆 ' + MOODS.length + ' 种脸: ' + MOODS.join('、') + '）');
for (const [key, p] of Object.entries(PROFILES)) {
  if (!fs.existsSync(path.join(ROOT, key))) continue;
  const j = readJson(path.join(ROOT, key));
  const fr = j.FileReferences || {};
  const exps = (fr.Expressions || []).map((e) => String(e.Name).replace(/\.exp3\.json$/, ''));
  const groups = Object.keys(fr.Motions || {});

  // faceMap 为 null 是「表情名就等于心情名」—— 那就得**每个心情都有同名表情**。
  // 这儿原来写的是 want = []，等于一个都不查：注释说要查，代码没查。
  // 那正好是最该查的一档 —— 缺一个状态就是「她某种心情下脸不变」，
  // 而切表情失败是静默的，日志里一个字都没有。
  // 为空对象才是「这个模型没脸可换」，跳过。
  const want = p.faceMap === undefined ? []
    : p.faceMap === null ? MOODS
    : [...new Set(Object.values(p.faceMap))];
  const missing = want.filter((n) => !exps.includes(n));
  check(missing.length === 0,
        `${p.name}: 表情 ${want.length} 个都在（缺的: ${missing.join(', ') || '无'}）`);

  const wantMotions = [p.idleMotion, p.tapMotion].filter(Boolean);
  const noGroup = wantMotions.filter((g) => !groups.includes(g));
  check(noGroup.length === 0,
        `${p.name}: 动作组 ${wantMotions.join('/')} 都在（缺的: ${noGroup.join(', ') || '无'}）`);
}

console.log('\n[3] 摸头和气泡那两个比例没写飞');
for (const [, p] of Object.entries(PROFILES)) {
  const okHead = p.headRatio === null || (p.headRatio > 0 && p.headRatio <= 1);
  const okMouth = p.mouthRatio > 0 && p.mouthRatio <= 1;
  // 嘴不可能长在头顶下面 —— 反过来的话气泡会从她胸口冒出来，摸头也摸空
  const ordered = p.headRatio === null || p.mouthRatio <= p.headRatio + 0.05;
  check(okHead && okMouth && ordered,
        `${p.name}: head=${p.headRatio} mouth=${p.mouthRatio}`);
}

console.log('\n[4] models/ 底下每个模型都有档案（新丢进来的会在这儿露头）');
{
  const dir = path.join(ROOT, 'models');
  for (const sub of fs.readdirSync(dir)) {
    if (!fs.statSync(path.join(dir, sub)).isDirectory()) continue;
    const f = fs.readdirSync(path.join(dir, sub)).find((x) => x.endsWith('.model3.json'));
    if (!f) continue; // 不是 Live2D 模型的目录，桌宠也扫不到它
    const rel = 'models/' + sub + '/' + f;
    check(!!PROFILES[rel], rel + (PROFILES[rel] ? '' : ' —— 没档案，会显示成目录名、也不会切表情'));
  }
}

/**
 * [5] 眼神层和编舞的参数名表，能不能对上每个模型真实的参数。
 *
 * 这一节是被真事逼出来的：`look.js` 和 `dance.js` 各有一张「这个东西叫什么」
 * 的候选名表，原来**只写了驼峰**（`ParamEyeLOpen`）。而 Cubism 2.1 时代导出的
 * 模型叫 `PARAM_EYE_L_OPEN` —— 官方样例里的两只猫、汪子、千岁、泉、春伞积木
 * 全是那一套。结果就是切到这些角色之后：
 *
 *   · 视线不跟鼠标、精力见底不垂眼皮、情绪不上脸
 *   · 整支舞是死的：头不转、身子不摆、呼吸不起伏
 *
 * **而且一个字都不报错** —— 那两层的设计就是「认不出来的参数直接跳过」。
 * 唯一露头的地方是 test-stage 里一条「精力见底时眼皮真的垂下来了」偶尔变红，
 * 取决于当时 config 指着谁。
 *
 * 所以拿每个模型的 cdi3（它列了这个模型所有参数的真名）来对一遍。
 */
console.log('\n[5] 眼神和跳舞的参数名，对得上每个模型吗');
{
  const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  const grab = (file, marker) => {
    // 从 look.js / dance.js 里把那张表抠出来。它们是浏览器脚本，没有导出，
    // 不能 require；但表是纯字面量，正则拿到每组的候选名就够了
    const src = read(path.join(ROOT, file));
    // 往前退到行首 —— 下面那个正则要靠 ^\s{2} 认行，从 marker 正中间切开的话
    // 第一组永远匹配不上（表现是「所有模型都漏认 angleX」这种整齐的假阳性）
    const at = src.lastIndexOf('\n', src.indexOf(marker)) + 1;
    const chunk = src.slice(at, at + 2200);
    const out = {};
    for (const m of chunk.matchAll(/^\s{2}(\w+):\s*\[([^\]]+)\]/gm)) {
      out[m[1]] = m[2].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
    }
    return out;
  };

  const look = grab('src/renderer/look.js', 'const LOOK_PARAMS');
  const dance = grab('src/renderer/dance.js', "angleX: ['ParamAngleX'");
  check(Object.keys(look).length >= 10, '抠到了 look.js 的参数表（' + Object.keys(look).length + ' 组）');
  check(Object.keys(dance).length >= 10, '抠到了 dance.js 的参数表（' + Object.keys(dance).length + ' 组）');

  /**
   * 判据是「**这个模型有这个能力，可我们的表没认出来**」，不是「表里的名字它都得有」。
   *
   * 这两件事必须分开：Rice 压根没有 `ParamAngleY`（它只能左右转不能点头），
   * 汪子没有眼球参数（狗眼不会转）—— 那是模型自己的取舍，报红只会教人无视自检。
   * 真正的 bug 长这样：模型明明有 `PARAM_EYE_BALL_X`，而候选名表里只写了驼峰。
   *
   * 所以先用一个宽松的正则去模型的参数表里找「像是这个东西的参数」，
   * 找得到、但候选名一个都对不上 —— 那才是漏了。
   */
  const LOOK_LIKE = {
    eyeX: /^param_?eye_?ball_?x$/i,
    eyeY: /^param_?eye_?ball_?y$/i,
    eyeLOpen: /^param_?eye_?l_?open$/i,
    eyeROpen: /^param_?eye_?r_?open$/i,
    cheek: /^param_?cheek$/i,
    browLAngle: /^param_?brow_?l_?angle$/i,
  };
  const DANCE_LIKE = {
    angleX: /^param_?angle_?x$/i,
    angleY: /^param_?angle_?y$/i,
    angleZ: /^param_?angle_?z$/i,
    bodyX: /^param_?body_?angle_?x$/i,
    bodyY: /^param_?body_?angle_?y$/i,
    bodyZ: /^param_?body_?angle_?z$/i,
    breath: /^param_?breath$/i,
  };

  for (const sub of fs.readdirSync(path.join(ROOT, 'models'))) {
    const dir = path.join(ROOT, 'models', sub);
    if (!fs.statSync(dir).isDirectory()) continue;
    const cdi = fs.readdirSync(dir).find((x) => x.endsWith('.cdi3.json'));
    if (!cdi) continue; // 没有 cdi3 就没法对，跳过（不算错）

    let ids;
    try {
      ids = new Set((JSON.parse(read(path.join(dir, cdi))).Parameters || []).map((p) => p.Id));
    } catch (_) { continue; }

    // 模型身上有、可表里认不出来的，才是漏
    const missOf = (table, like) => Object.entries(like)
      .map(([key, re]) => {
        const real = [...ids].find((id) => re.test(id));
        if (!real) return null;                                  // 模型自己就没有
        if ((table[key] || []).includes(real)) return null;      // 表里认得
        return key + '(' + real + ')';
      })
      .filter(Boolean);

    const ml = missOf(look, LOOK_LIKE);
    const md = missOf(dance, DANCE_LIKE);
    check(ml.length === 0 && md.length === 0,
          sub + '：眼神' + (ml.length ? ' 漏认 ' + ml.join('、') : ' ✓') +
          '，跳舞' + (md.length ? ' 漏认 ' + md.join('、') : ' ✓'));
  }
}

console.log('\n[6] 没档案的模型，名字得是目录名，不能一律叫「未知模型」');
{
  const p = profileFor('models/某个新模型/whatever.model3.json');
  check(p.name === '某个新模型', '兜底档案拿目录名当名字，实际拿到: ' + p.name);
}

/**
 * [7] 换皮的别当新角色收。
 *
 * 同一个 moc3 换一身贴图，是**一个角色的两身衣服**，不是两个角色。当成两份模型目录
 * 收进来的话：角色列表里冒出两个同名同脸的人（海梦一度有三个），每份还把十几 MB 的
 * moc3 和动作重复存一遍，而且每加一身都得再抄一份档案。
 *
 * 正确的放法是 `models/<本体>/skins/<这身叫什么>/texture_NN.png` ——
 * 右键「换套贴图」会自动扫到，NN 对着模型第几张贴图，目录里没有的那号保持原装。
 */
console.log('\n[7] 换皮不许当新角色收，皮肤目录的贴图号也得对得上');
{
  const modelsDir = path.join(ROOT, 'models');
  const byMoc = new Map();     // moc3 内容 -> 哪些目录
  const dirs = fs.readdirSync(modelsDir).filter((d) => {
    try { return fs.statSync(path.join(modelsDir, d)).isDirectory(); } catch (_) { return false; }
  });

  for (const d of dirs) {
    const files = fs.readdirSync(path.join(modelsDir, d));
    const moc = files.find((f) => f.endsWith('.moc3'));
    if (!moc) continue;
    const key = require('crypto').createHash('md5')
      .update(fs.readFileSync(path.join(modelsDir, d, moc))).digest('hex');
    if (!byMoc.has(key)) byMoc.set(key, []);
    byMoc.get(key).push(d);
  }

  const dupes = [...byMoc.values()].filter((v) => v.length > 1);
  check(dupes.length === 0, dupes.length
    ? '这几组是同一个 moc3，只留一个当角色、其余搬进 skins/：' +
      dupes.map((g) => g.join(' = ')).join('；')
    : '没有两个目录共用同一个 moc3（' + byMoc.size + ' 个角色）');

  // 摊平（config.atlasUrls）—— 主进程、渲染层的替身、自检全用这一份
  {
    const { atlasUrls } = require('../src/config');
    const skin = path.join(modelsDir, '海梦', 'skins', '哥特黑');
    if (fs.existsSync(skin)) {
      const u = atlasUrls(skin);
      const has = u.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
      check(has.length === 6 && u[0] === null && /texture_01\.png$/.test(u[1] || ''),
            '一个皮肤目录摊成按号排的 url（动 ' + has.join('、') + ' 号，第 0 号是 null）');
      check(u.every((x) => x === null || x.startsWith('file:///')),
            '摊出来的是 url 不是 `D:\\` 路径 —— 渲染层是个 file:// 页面，喂路径进去会静静地加载失败');
    }
    check(atlasUrls('').length === 0 && atlasUrls(path.join(modelsDir, '不存在')).length === 0,
          '没设过、或者皮肤被删了 → 空的（不能让她的贴图跟着坏）');
    const png = path.join(modelsDir, 'Mao', 'skins', '翡翠长袍.png');
    if (fs.existsSync(png)) {
      check(atlasUrls(png).length === 1, '单张 png 还是只换第 0 张（老写法不许坏）');
    }
  }

  // 皮肤目录里的 texture_NN 必须真的对着模型的第 N 张贴图，多出来的那号是白搬的
  for (const d of dirs) {
    const skinRoot = path.join(modelsDir, d, 'skins');
    let subs = [];
    try {
      subs = fs.readdirSync(skinRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (_) { continue; }
    if (!subs.length) continue;

    const m3 = fs.readdirSync(path.join(modelsDir, d)).find((f) => f.endsWith('.model3.json'));
    if (!m3) continue;
    const n = (((readJson(path.join(modelsDir, d, m3)).FileReferences || {}).Textures) || []).length;

    for (const s of subs) {
      const pngs = fs.readdirSync(path.join(skinRoot, s)).filter((f) => /\.png$/i.test(f));
      const off = pngs.filter((f) => {
        const mm = /^texture_(\d+)\.png$/i.exec(f);
        return !mm || Number(mm[1]) >= n;
      });
      check(pngs.length > 0 && off.length === 0,
            d + '/' + s + '：' + pngs.length + ' 张对着 ' + n + ' 张原装贴图' +
            (off.length ? '，这几张换不上去 → ' + off.join('、') : ''));
    }
  }
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
