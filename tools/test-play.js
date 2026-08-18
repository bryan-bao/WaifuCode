'use strict';

// 「一起玩」那几个玩法，一局一局跑一遍。
//
// 最要紧的两条：
//   1. **一分钱都不能花。** 一局三题，每题出题+反馈，要是走 claude 就是六次调用。
//      这里从头到尾没有 spawn，题目、干扰项、对错台词全是本地生成的 ——
//      这个自检本身就是那条约束的证据（它跑得起来就说明不需要网络和 claude）。
//   2. **题目和答案要对得上。** 四个选项里必须**恰好一个**是正确答案，
//      而且正确答案得真的在选项里 —— 出一道自己都答不对的题是最丢人的 bug。
//
// 不花钱、不出声、不开窗口，一秒跑完（pace 给 0，各处停顿直接跳过）。

const { Play, EMOTIONS } = require('../src/play');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

// 必须是 setTimeout(1) 不能是 setImmediate。
// pace=0 时那些停顿变成 setTimeout(0)，而 Node 的 setTimeout 最小实际就是 1ms ——
// 五十次 setImmediate 能在同一毫秒里跑完，时间根本没往前走，
// 定时器一个都不会到期，题目永远等不来（这坑踩过了）。
const tick = () => new Promise((r) => setTimeout(r, 1));

// 假歌单
const fakeSongs = (n) => Array.from({ length: n }, (_, i) => ({
  file: 'song' + i + '.mp3', title: '第' + i + '首', artist: '某人', tooBig: false,
}));

function makePlay(songCount = 6) {
  const said = [];
  const performed = [];
  const clips = [];
  const quiet = [];
  const done = [];

  const p = new Play({
    pace: 0,
    log: () => {},
    songs: () => fakeSongs(songCount),
    loadSong: (file) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg', file }),
  });
  p.on('say', (e) => said.push(e));
  p.on('perform', (e) => performed.push(e));
  p.on('clip', (e) => clips.push(e));
  p.on('quiet', (e) => quiet.push(e.on));
  p.on('done', (e) => done.push(e));
  return { p, said, performed, clips, quiet, done };
}

// 一直等到出现带选项的那句话（题目），最多等 50 拍
async function waitQuestion(said, from = 0) {
  for (let i = 0; i < 50; i++) {
    for (let k = from; k < said.length; k++) {
      if (said[k].options && said[k].options.length) return { at: k, q: said[k] };
    }
    await tick();
  }
  return null;
}

(async () => {
  console.log('\n[1] 菜单：歌不够就别把「猜歌」摆出来给人点空');
  {
    const few = makePlay(2);
    const many = makePlay(8);
    const ids = (x) => x.p.menu().map((m) => m.id);
    console.log('    只有 2 首歌时: ' + ids(few).join(', '));
    console.log('    有 8 首歌时:   ' + ids(many).join(', '));
    check(!ids(few).includes('song'), '歌少的时候「猜歌」不出现');
    check(ids(many).includes('song'), '歌够了才出现');
    check(ids(few).includes('emotion') && ids(few).includes('pomodoro'), '另外两个一直都在');
  }

  console.log('\n[2] 猜情绪：出题、选项、记分');
  {
    const { p, said, performed } = makePlay();
    p.start('emotion');
    const first = await waitQuestion(said);
    check(Boolean(first), '出了第一题');

    if (first) {
      const q = first.q;
      console.log('    题目：「' + q.text + '」 选项：' + q.options.map((o) => o.label).join(' / '));
      check(q.options.length === 4, '四个选项');
      check(q.hold === 0, '题目挂着不自动收（不然你还在想它就没了）');

      const ids = q.options.map((o) => o.id);
      check(new Set(ids).size === 4, '四个选项互不重复');
      check(ids.includes(p.answer), '**正确答案真的在选项里**');
      check(ids.every((id) => EMOTIONS.some((e) => e.id === id)), '选项都是真实存在的情绪');

      // 出题前她得先把那个表情和动作做出来，否则这题没法看
      const shown = performed.find((x) => x.face === p.answer);
      check(Boolean(shown), '出题前先做了对应的表情');
      check(Boolean(shown && shown.gesture), '身体动作也配上了（不然好几个情绪长得一样）');

      // 故意答错
      const wrong = ids.find((id) => id !== p.answer);
      const n = said.length;
      p.choose(wrong);
      await tick();
      check(p.score === 0, '答错了不加分');
      check(said.length > n, '有反馈');
      console.log('    答错她说：「' + said[said.length - 1].text + '」');
    }
  }

  console.log('\n[3] 猜情绪：一路答对，三题后收工');
  {
    const { p, said, done } = makePlay();
    p.start('emotion');

    let from = 0;
    for (let round = 1; round <= 3; round++) {
      const got = await waitQuestion(said, from);
      if (!got) { check(false, '第 ' + round + ' 题出得来'); break; }
      from = got.at + 1;
      p.choose(p.answer); // 每题都答对
      await tick();
    }
    for (let i = 0; i < 20 && !done.length; i++) await tick();

    check(p.score === 3, '三题全对，记了 3 分（实际 ' + p.score + '）');
    check(done.length === 1, '一局结束时报了一次成绩');
    check(!p.busy, '结束之后不再占着，可以开下一局');
    console.log('    收尾她说：「' + said[said.length - 1].text + '」');
  }

  console.log('\n[4] 猜歌：放一小段，但绝不能报歌名');
  {
    const { p, said, clips } = makePlay(6);
    p.start('song');
    const got = await waitQuestion(said);
    check(Boolean(got), '出了题');

    if (got) {
      console.log('    选项：' + got.q.options.map((o) => o.label).join(' / '));
      check(clips.length === 1, '放了一段音频');
      check(clips[0].seconds > 0 && clips[0].seconds <= 15, '只放一小段（' + clips[0].seconds + ' 秒）');
      check(clips[0].at > 0, '从中间开始放（前奏往往认不出来，而且很多歌开头都差不多）');
      check(got.q.options.some((o) => o.id === p.answer), '正确答案在选项里');

      // 题面和选项里都不能出现「答案是哪首」之外的泄露
      const answerTitle = '第' + p.answer.replace(/\D/g, '') + '首';
      check(!got.q.text.includes(answerTitle), '**题面里没把歌名说出来**');
      check(clips[0].audio && !clips[0].title, 'clip 事件不带 title（带了 stage 那边会念出来）');
    }
  }

  console.log('\n[5] 番茄钟：用绝对时间算，不是数 tick');
  {
    const { p, said, quiet } = makePlay();
    p.start('pomodoro');
    check(p.busy, '开始了');
    check(quiet[0] === true, '进入安静模式（她不再主动说话）');
    check(typeof p.endsAt === 'number', '记的是绝对结束时刻');

    const mins = (p.endsAt - Date.now()) / 60000;
    console.log('    还有 ' + mins.toFixed(1) + ' 分钟');
    check(mins > 24 && mins <= 25, '25 分钟');
    console.log('    她说：「' + said[0].text + '」');

    // 中途放弃
    p.stop();
    check(!p.busy, '中断之后不占着了');
    check(quiet[quiet.length - 1] === false, '**安静模式跟着解除** —— 忘了这步她会从此哑巴');
  }

  console.log('\n[6] 一局没结束时不许开新的');
  {
    const { p } = makePlay();
    p.start('emotion');
    const again = p.start('song');
    check(again.ok === false, '第二局被挡下来了（' + again.error + '）');
    p.stop();
    check(p.start('song').ok === true, '结束之后可以开别的');
    p.stop();
  }

  console.log('\n[7] 答案还没出来的时候乱点不该崩');
  {
    const { p } = makePlay();
    p.choose('happy');          // 还没开局
    p.start('emotion');
    p.choose('happy');          // 题还没出
    p.choose(null);
    p.choose(undefined);
    check(true, '各种乱点都没炸');
    p.stop();
  }

  console.log('');
  console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
  process.exit(bad === 0 ? 0 : 1);
})();
