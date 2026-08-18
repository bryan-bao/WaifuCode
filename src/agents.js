'use strict';

// 终端里跑哪个 AI CLI —— codex 那一侧的适配。
//
// 【为什么有这个文件】派活的整条链里，真正认得「claude」三个字的只有两处：
// 启动参数怎么拼、去哪儿找可执行文件。窗口管理（开/关/心跳/任务栏/置顶）
// 全在我们自己的壳（hooks/term-shell.js）里，跟里面跑什么无关。
// 把 codex 的差异收在这一个文件里，别的 CLI 以后照样往这儿加。
//
// 【谁在用】term-shell.js（拼参数）和 main.js（找 bin、判装没装）。
// term-shell 是另起的 node 进程 require 进来的，所以这儿**只许用 node 自带模块**，
// 绝不能碰 electron 或项目里会连电的东西（journal、paths 那些）。
//
// 【claude 侧不在这儿】resolveClaudeBin / claudeInstalled 留在 sessions.js
// （chat/greet/sessions 一直从那儿拿），claude 的参数留在 term-shell 里
// （test-termlife 钉着它的引号处理，不挪窝）。

const fs = require('fs');
const path = require('path');

/** 在 PATH 里找一个命令，返回**带扩展名的全路径**（找不到给 null）。
 * 必须要全路径：npm 装的是 .cmd，spawn 不带扩展名、又没开 shell 就是 ENOENT。 */
function onPath(name) {
  const exts = ['.exe', '.cmd', '.bat', ''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch (_) { /* 这个目录读不了，翻下一个 */ }
    }
  }
  return null;
}

function resolveCodexBin() {
  const envBin = process.env.WAIFU_CODEX_BIN;
  try {
    if (envBin && fs.existsSync(envBin)) return envBin;
  } catch (_) { /* 探测失败当没设 */ }
  return onPath('codex') || 'codex'; // 兜底交给 PATH（多半起不来，guard 会先拦）
}

function codexInstalled() {
  return resolveCodexBin() !== 'codex';
}

/**
 * 权限映射：claude 的模式名 → codex 的两个旋钮。
 *
 * codex 把「问不问」（-a）和「管多严」（-s）拆成两个开关：
 *   -a untrusted | on-request | never        问的频率
 *   -s read-only | workspace-write | danger-full-access   沙箱边界
 *
 * 映射原则：宁紧勿松。`--dangerously-bypass-approvals-and-sandbox` 和
 * danger-full-access **永远不映射** —— claude 那边最松的 dontAsk 也只是
 * 「别问了」，沙箱还在项目目录里圈着。
 */
const PERM = {
  auto:        ['-a', 'on-request', '-s', 'workspace-write'],
  acceptEdits: ['-a', 'on-request', '-s', 'workspace-write'],
  plan:        ['-a', 'untrusted', '-s', 'read-only'],
  dontAsk:     ['-a', 'never', '-s', 'workspace-write'],
  manual:      ['-a', 'untrusted', '-s', 'workspace-write'],
};

/**
 * 拼 codex 的启动参数。跟 claude 那份（term-shell 里的 claudeArgs）的差别：
 *
 *   · **没有 --session-id / --resume** —— codex 的会话 id 自己生成，不收外派的。
 *     所以 spec.sessionId 只当我们内部的线号用，不上命令行；「接着聊」在
 *     codex 线上等于开条新的（第二期从 ~/.codex/sessions 捞回 uuid 才有得接）。
 *   · **没有 -n 标题** —— 窗口标题靠 term-shell 的心跳一直按着，不受影响。
 *   · **小抄没有参数可传**（claude 走 --append-system-prompt-file）——
 *     改成把小抄内容拼进开场 prompt。只在真有活派的时候拼：没任务时递个
 *     prompt 过去等于替用户开跑一轮，那是花钱的事。
 */
function codexArgs(spec) {
  const args = [];
  args.push(...(PERM[spec.permissionMode] || PERM.auto));
  // 模型：面板上 codex 线不选模型（跟 ~/.codex/config.toml 走），
  // 但管道留着 —— 哪天要选了只用改面板
  if (spec.model) args.push('-m', spec.model);

  let task = spec.task && spec.task.trim() ? spec.task : '';
  if (task && spec.notesFile) {
    try {
      const memo = fs.readFileSync(spec.notesFile, 'utf8').replace(/^\uFEFF/, '').trim();
      if (memo) task = '【项目备忘，动手前先看一眼】\n' + memo + '\n\n【这次的活】\n' + task;
    } catch (_) { /* 小抄读不到就不带，跟全新项目一个样 */ }
  }
  if (task) args.push(task);
  return args;
}

module.exports = { onPath, resolveCodexBin, codexInstalled, codexArgs, PERM };
