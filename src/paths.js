'use strict';

// 「代码在哪儿」和「数据写哪儿」，这是两件事。
//
// 开发的时候它们是同一个文件夹（就是项目目录），所以这个区分一直不存在，
// 到处都是 `path.join(__dirname, '..')`。**一打包这就全塌了**：
//
//   · 装到 `C:\Program Files\` 底下 → 普通用户没有写权限，
//     写 config.json / waifu.log / sessions 全部 EPERM，
//     而这些写操作大多包在 try/catch 里 —— 于是**不报错，只是什么都不保存**。
//   · 打进 app.asar → 那是个只读归档，连目录都建不出来。
//
// 所以这里把两件事拆开：
//
//   APP_ROOT   代码、模型、hooks、vendor —— 只读，跟着安装包走
//   DATA_ROOT  config.json / sessions / waifu.log / music —— 要写，跟着人走
//
// 开发模式下两个值**完全相同**，所以现有的自检和工具一行都不用改。

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');

/** 这个目录能建、能写吗。不能光看存不存在 —— Program Files 是存在但写不进去的 */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 拿 electron 的 app 对象 —— 拿不到就算了。
 *
 * 这里必须防一手：**在普通 node 里 `require('electron')` 是成功的**，
 * 它导出的是 electron.exe 的路径字符串，不是那套 API。
 * 所以不能只判断 require 成不成功，得看 `.app` 在不在。
 * （所有自检都跑在普通 node 里，判错了就会走进打包分支。）
 */
function electronApp() {
  try {
    const e = require('electron');
    return e && e.app ? e.app : null;
  } catch (_) {
    return null;
  }
}

function resolveDataRoot() {
  // 想放哪儿放哪儿，最高优先级
  if (process.env.WAIFU_HOME) return process.env.WAIFU_HOME;

  const app = electronApp();

  // 没打包 = 开发 / 跑自检，一切照旧：数据就在项目目录里
  if (!app || !app.isPackaged) return APP_ROOT;

  // 打包之后**优先便携**：数据放 exe 旁边的 data\。
  // 好处是整个文件夹拷到 U 盘就能搬走，也不会在系统盘留东西。
  const portable = path.join(path.dirname(process.execPath), 'data');
  if (canWrite(portable)) return portable;

  // 装进了 Program Files 这类写不了的地方，才退回系统给的用户数据目录
  return app.getPath('userData');
}

const DATA_ROOT = resolveDataRoot();

// 现在就建出来。日志是**第一个**往这儿写的东西，而它的写失败是被吞掉的
// （日志自己写不进去不该拖垮桌宠）—— 等它去建目录的话，什么都不会发生，
// 只是从此一行日志都没有，出了事你两眼一抹黑。
try {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
} catch (_) {
  /* 真建不出来，下面每一处写盘各自会报各自的错 */
}

/** 数据目录下的某个东西（父目录会自动建好） */
function dataPath(...parts) {
  const p = path.join(DATA_ROOT, ...parts);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch (_) {
    /* 建不出来的话，调用方那边自己会报错，这里不抢着报 */
  }
  return p;
}

/** 安装目录下的某个东西（只读） */
function appPath(...parts) {
  return path.join(APP_ROOT, ...parts);
}

module.exports = { APP_ROOT, DATA_ROOT, dataPath, appPath, canWrite };
