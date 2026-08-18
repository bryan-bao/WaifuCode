'use strict';

// 先验一下 msedge-tts 到底能不能用：API 长什么样、国内网络通不通、
// 出来的音频是不是真能播。集成之前先把这些问题问清楚，别写完一大堆才发现跑不通。

const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const OUT = path.join(__dirname, '..', 'sessions', 'tts-test.mp3');

(async () => {
  console.log('可用的 OUTPUT_FORMAT 里带 MP3 的:');
  Object.keys(OUTPUT_FORMAT).filter((k) => /MP3/i.test(k)).forEach((k) => console.log('  ' + k));
  console.log('');

  const tts = new MsEdgeTTS();
  console.log('MsEdgeTTS 实例方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(tts)).join(', '));
  console.log('');

  const t0 = Date.now();
  await tts.setMetadata('zh-CN-XiaoyiNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  console.log('setMetadata 用时 ' + (Date.now() - t0) + 'ms');

  const t1 = Date.now();
  const res = tts.toStream('搞定了，你看看行不行？', { rate: '+8%', pitch: '+12Hz' });
  console.log('toStream 返回的字段:', Object.keys(res).join(', '));

  const stream = res.audioStream || res;
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
    setTimeout(() => reject(new Error('合成超过 20 秒没回来')), 20000);
  });

  const buf = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);

  console.log('合成用时 ' + (Date.now() - t1) + 'ms');
  console.log('音频大小 ' + buf.length + ' bytes -> ' + OUT);
  // MP3 帧头是 0xFF 0xFB 之类，ID3 标签则以 "ID3" 开头
  console.log('前 3 字节 = ' + buf.slice(0, 3).toString('hex') + ' (MP3 应该是 fffb/fff3 或 494433)');
  process.exit(buf.length > 1000 ? 0 : 1);
})().catch((err) => {
  console.error('失败:', err.message);
  process.exit(1);
});
