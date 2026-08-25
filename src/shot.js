'use strict';
// ---------------------------------------------------------------------------
// 截图：按个快捷键 → 屏幕上拖个框 → 图进剪贴板，Ctrl+V 粘哪儿都行。
//
// 解决的是「别的截图工具截完的图，粘进 Claude 终端不认」这件事 ——
// 我们放的是标准位图，终端的输入框直接就能收。**不替用户发**：
// 粘到哪、配什么话、什么时候发，是他自己的事。
//
// 怎么做的：
//   1. 全屏盖一层透明窗口（跨所有显示器），拖出一个矩形
//   2. 收起那层窗口（**必须等它真没了再拍**，不然拍到自己那层灰罩）
//   3. PowerShell 的 CopyFromScreen 抓那块区域，存成 PNG 落在数据目录
//   4. 图落盘 + 写进剪贴板（见 main 的 doShot）
//
// 为什么不用 Electron 自带的 desktopCapturer：它给的是「整块屏幕的缩略图」，
// 分辨率受 thumbnailSize 摆布，截下来的字是糊的 —— 而截图给 AI 看，
// 糊字等于白截。CopyFromScreen 是原生像素。
// ---------------------------------------------------------------------------
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 抓屏幕上的一块（物理像素坐标），存成 PNG。返回文件路径 */
function grab({ x, y, w, h, dir, log }) {
  const file = path.join(dir, 'shot-' + Date.now() + '.png');
  fs.mkdirSync(dir, { recursive: true });

  // 脚本走 -EncodedCommand（base64 的 UTF-16LE）：命令行传脚本要过引号地狱，
  // 而这个项目已经在 PowerShell 的编码上栽过一次（中文变乱码），
  // base64 是这条路上唯一不用猜编码的传法
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    '$b = New-Object System.Drawing.Bitmap ' + w + ', ' + h,
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    '$g.CopyFromScreen(' + x + ', ' + y + ', 0, 0, $b.Size)',
    '$b.Save("' + file.replace(/\\/g, '\\\\') + '", [System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose(); $b.Dispose()',
    'Write-Output "SHOT-OK"',
  ].join('\n');
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { timeout: 15000, windowsHide: true }, (err, out) => {
        if (err && !/SHOT-OK/.test(String(out))) return reject(new Error('截不下来：' + err.message));
        try {
          if (fs.statSync(file).size < 100) throw new Error('截出来是个空文件');
        } catch (e) { return reject(e); }
        if (log) log('[shot] 存好了 ' + file + '（' + w + '×' + h + '）');
        resolve(file);
      });
  });
}

/**
 * 截图攒多了会占地方（一张几百 KB）。留最近 KEEP 张，更老的删掉。
 * 不删的话半年后这个文件夹几个 G —— 而九成的图看过一次就没用了。
 */
function sweep(dir, keep = 40) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^shot-\d+\.png$/.test(f))
      .map((f) => ({ f, at: Number(/^shot-(\d+)\.png$/.exec(f)[1]) }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* 删不掉就下次 */ }
    }
  } catch (_) { /* 目录还没有，无所谓 */ }
}

module.exports = { grab, sweep };
