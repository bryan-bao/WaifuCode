'use strict';

// 把流水账捏成「她开口说的那句话」。
//
// 这一批全是**不花钱**的：料是 journal 里现成的（她汇报过的话、几轮、几个活、
// 多少钱），缺的只是「在对的时间端出来」。所以这个模块只做纯文本组装 ——
// 不读盘、不发请求、不碰 Electron，什么时候说、说不说，是 main 的事。
//
// 三个场景一个提醒：
//   welcome   你走开一阵回来了 —— 汇报你不在时她们干了什么
//   opener    隔天第一次见面 —— 「昨天那条线还挂着一半，接着弄吗？」
//   windDown  深夜收工 —— 打个哈欠带一句今日总结
//   SIT_LINES 久坐提醒的台词

/** 42 → '42 分钟'，95 → '1 个半小时' 这种人话 */
function fmtMin(min) {
  const m = Math.round(min);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  if (r < 15) return h + ' 个小时';
  if (r < 45) return h + ' 个半小时';
  return (h + 1) + ' 个小时';
}

/**
 * 你走的这段时间里发生了什么。
 *
 * records 是流水账原始记录（main 负责把跨天的两份拼起来），只看 sinceTs 之后的。
 * 返回 null = 没什么可说的，调用方退回原来那句「你回来啦」—— 宁可不说，
 * 也不说「你走的 40 分钟里什么都没发生」这种废话。
 */
function welcome(records, sinceTs, goneMin) {
  const after = (records || []).filter((r) => r && (Date.parse(r.at) || 0) >= sinceTs);
  const briefs = after.filter((r) => r.type === 'report' && r.brief);
  const tasks = after.filter((r) => r.type === 'task-done').length;
  let errors = 0;
  for (const r of after) if (r.type === 'turn') errors += r.errors || 0;

  if (!briefs.length && !tasks && !errors) return null;

  const bits = [];
  // 最新的一两句汇报原话 —— 这是她真说过的话，不是编的
  for (const b of briefs.slice(-2).reverse()) {
    const who = b.project ? '「' + b.project + '」' : '有条线';
    bits.push(who + '干完一段：' + String(b.brief).slice(0, 48));
  }
  if (!briefs.length && tasks) bits.push('收尾了 ' + tasks + ' 个活');
  if (errors) bits.push('报错 ' + errors + ' 次，还在较劲');

  return {
    say: '你走的 ' + fmtMin(goneMin) + ' 里：' + bits.join('；') + '。',
    face: briefs.length || tasks ? 'proud' : 'frustrated',
  };
}

/**
 * 隔天开场白。lane 是 main 从 sessions 登记簿里挑出来的
 * 「昨天动过、今天还没碰、会话还活着」的那条线。
 */
function opener(lane) {
  if (!lane) return null;
  const name = lane.name || lane.project || '那条线';
  return {
    say: '早呀。昨天「' + name + '」干到一半就搁下了' +
         (lane.turns ? '（聊了 ' + lane.turns + ' 轮）' : '') + '，要接着弄吗？',
    face: 'curious',
    offer: { kind: 'resume', label: '接着弄' }, // dir/laneId 由 main 补上
  };
}

/**
 * 深夜收工那句。t 是 journal.today() 的结果。
 * 返回 null = 今天没干什么正事，不值得专门道一句晚安总结。
 */
function windDown(t) {
  if (!t || (!t.turns && !t.tasks && !t.chats)) return null;
  const bits = [];
  if (t.spanMin >= 60) bits.push('陪你干了 ' + fmtMin(t.spanMin));
  if (t.turns) bits.push(t.turns + ' 轮活');
  if (t.tasks) bits.push(t.tasks + ' 个收了尾');
  // 一分钱没花就别提钱 —— 「烧了 $0.00」听着像讽刺
  if (t.costUsd >= 0.01) bits.push('花了 $' + t.costUsd.toFixed(2));
  return {
    say: '呼啊…今天到这吧？' + (bits.length ? bits.join('、') + '。' : '') + '剩下的明天再说。',
    face: 'sleepy',
  };
}

// 久坐台词。轮着用，别每次都同一句 —— 同一句催第三遍就成闹钟了
const SIT_LINES = [
  '都坐了一个半钟头了，起来倒杯水吧，我看着这边。',
  '欸，你多久没站起来了？活动一下，代码又跑不掉。',
  '起来伸个懒腰嘛，你脖子都要跟我的物理引擎一样僵了。',
];

module.exports = { welcome, opener, windDown, fmtMin, SIT_LINES };
