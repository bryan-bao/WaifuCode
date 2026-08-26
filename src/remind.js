'use strict';

// 口头交代的提醒：「三点提醒我开会」。
//
// 她在聊天里听到这种话，附一行 <<ACT:{"act":"remind",...}>>，main 转手存进
// 这里；到点了她在桌面上喊你。落盘是必须的 —— 你中午交代的事，
// 下午重启过桌宠也得记得。
//
// 做成工厂而不是单例：测试要指到临时目录，不能碰真数据。

const fs = require('fs');
const path = require('path');

const MAX_PENDING = 20; // 攒不到这么多，纯粹是防有人拿它当日历用
const TEXT_MAX = 80;

function remindStore(file) {
  const load = () => {
    try {
      const l = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(l) ? l : [];
    } catch (_) { return []; }
  };
  const save = (list) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(list), 'utf8');
    } catch (_) { /* 写不进就只活在内存里，重启会丢 —— 比抛错打断聊天强 */ }
  };

  /**
   * 「几点」两种给法，二选一：
   *   at:    'HH:MM'（24 小时制）。已经过了就算明天的 —— 下午四点说
   *          「三点提醒我」多半是说明天
   *   inMin: 多少分钟后。「20 分钟后叫我」这种
   */
  const whenOf = ({ at, inMin }, now) => {
    if (typeof inMin === 'number' && isFinite(inMin)) {
      const m = Math.round(inMin);
      if (m < 1 || m > 24 * 60) return null;
      return now + m * 60000;
    }
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    const d = new Date(now);
    d.setHours(h, mi, 0, 0);
    let t = d.getTime();
    if (t <= now + 30000) t += 86400000;
    return t;
  };

  return {
    add(a, now = Date.now()) {
      const text = String((a && a.text) || '').trim().slice(0, TEXT_MAX);
      if (!text) return { ok: false, error: '提醒什么没说清' };
      const when = whenOf(a || {}, now);
      if (!when) return { ok: false, error: '时间没看懂' };
      const list = load();
      if (list.length >= MAX_PENDING) return { ok: false, error: '记的太多了，先清清' };
      list.push({ when, text, at: new Date(now).toISOString() });
      save(list);
      return { ok: true, when, text };
    },

    /** 到点的都拿走（含错过的 —— 桌宠关着时到点的，开机第一拍就冒出来） */
    due(now = Date.now()) {
      const list = load();
      const fire = list.filter((r) => r.when <= now);
      if (fire.length) save(list.filter((r) => r.when > now));
      return fire;
    },

    list() { return load().sort((a, b) => a.when - b.when); },
  };
}

module.exports = { remindStore, MAX_PENDING, TEXT_MAX };
