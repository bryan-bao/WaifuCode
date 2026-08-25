'use strict';

// 「关于你」的小本子。
//
// 私聊里随口说过的事（讨厌 BOM、猫叫什么、周三要交房租），她听到了就
// 顺手记一行。几周后聊天、搭话时自然带出来 —— 陪伴感的核心就这一件事：
// **她记得你**。
//
// 【怎么攒 · 关键是不另花钱】不跑「总结一下他这个人」那种独立调用 ——
// 那要每天额外花钱。她在**回复的同一口气里**附一行 <<MEM:...>> 标记
// （跟动作指令 <<ACT:>> 一个路数），记忆这件事就是免费的。
//
// 【明文可翻可删】存的是 markdown，一行一条，托盘菜单能直接打开。
// 一份你看不见也改不了的「她的记忆」是危险的：错了就一直错下去 ——
// 小抄（notes.js）当年就是这么定的规矩，这儿照抄。

const fs = require('fs');
const path = require('path');

const KEEP = 60;      // 最多记这么多条，攒满了挤掉最老的
const LINE_MAX = 60;  // 一条最长（这是「一件事」，不是一段话）

function aboutStore(file) {
  const load = () => {
    try {
      return fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .map((l) => /^- (\d{4}-\d{2}-\d{2}) · (.+)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ at: m[1], text: m[2] }));
    } catch (_) { return []; }
  };
  const save = (list) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file,
        '# 她记的关于你的事\n\n' +
        '> 一行一条，她在聊天里听到就记。**想删哪条直接删那行**，她就忘了。\n\n' +
        list.map((e) => '- ' + e.at + ' · ' + e.text).join('\n') + '\n', 'utf8');
    } catch (_) { /* 写不进就只活在内存里 */ }
  };
  // 判重用的归一：去空白去标点，「他讨厌BOM」和「他讨厌 BOM。」是同一条
  const norm = (s) => String(s).replace(/[\s。，！？!?,.、～~]/g, '').toLowerCase();

  return {
    add(text, now = Date.now()) {
      let t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
      if (t.length < 2) return { ok: false };
      const list = load();
      if (list.some((e) => norm(e.text) === norm(t))) return { ok: false, dup: true };
      const d = new Date(now);
      const p = (n) => String(n).padStart(2, '0');
      list.push({ at: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()), text: t });
      save(list.slice(-KEEP));
      return { ok: true, text: t };
    },

    list() { return load(); },

    /** 喂给聊天系统提示词的那份（最近 n 条）。空着就返回 ''，别占提示词 */
    forPrompt(n = 12) {
      const list = load().slice(-n);
      if (!list.length) return '';
      return list.map((e) => '- ' + e.text + '（' + e.at + ' 记的）').join('\n');
    },

    /** 随机抽几条给搭话用 —— 「几周后自然提起」的那个自然 */
    sample(n = 2) {
      const list = load();
      const out = [];
      for (let i = 0; i < n && list.length; i++) {
        out.push(list.splice(Math.floor(Math.random() * list.length), 1)[0].text);
      }
      return out;
    },

    file,
  };
}

module.exports = { aboutStore, KEEP, LINE_MAX };
