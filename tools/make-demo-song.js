'use strict';

// 生成一段试唱用的音频丢进 music/。
//
// 装好之后 music 文件夹是空的，点「唱首歌」什么都不会发生 —— 那样根本看不出
// 这功能长什么样。所以用她自己的声音哼一段，让你开箱就能看到跳舞和口型同步。
//
// 用的是 TTS 哼「啦」，纯粹是段占位的哼唱，不涉及任何现成曲子或歌词。
// 看腻了直接把文件删掉就行。

const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { MUSIC_DIR } = require('../src/perform');

// 分句是为了让声音有起伏 —— 一口气念完一长串「啦」听起来像蜂鸣
const HUM = '啦啦啦，啦啦啦，啦啦啦啦啦。啦啦啦，啦啦啦，啦啦啦啦啦。' +
            '啦啦，啦啦，啦啦啦啦。啦啦啦啦，啦啦啦啦啦～';

const OUT = path.join(MUSIC_DIR, '她随口哼的 [120].mp3');

(async () => {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });

  const tts = new MsEdgeTTS();
  await tts.setMetadata('zh-CN-XiaoyiNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // 音调拉高、语速放慢一点，听着更像在哼而不是在念
  const res = tts.toStream(HUM, { rate: '-10%', pitch: '+30Hz' });
  const stream = res.audioStream || res;

  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('合成超时')), 20000);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => { clearTimeout(timer); resolve(); });
    stream.on('close', () => { clearTimeout(timer); resolve(); });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  const buf = Buffer.concat(chunks);
  if (buf.length < 1000) throw new Error('合成出来是空的');

  fs.writeFileSync(OUT, buf);
  console.log('生成好了: ' + OUT);
  console.log('大小 ' + Math.round(buf.length / 1024) + 'KB');
  console.log('');
  console.log('右键角色 → 唱首歌，就能看到她跟着这段哼唱跳。');
  console.log('不想要了直接删掉这个文件。');
  process.exit(0);
})().catch((err) => {
  console.error('没生成出来: ' + err.message);
  process.exit(1);
});
