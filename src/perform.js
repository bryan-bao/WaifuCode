'use strict';

const fs = require('fs');
const path = require('path');
const { readTags } = require('./id3');

const { DATA_ROOT } = require('./paths');

const ROOT = DATA_ROOT;
// 歌是**用户自己丢进来的**，所以这个文件夹必须可写、必须好找 ——
// 跟着数据目录走，不能藏在安装目录里（那儿可能只读，而且卸载会连歌一起删）
const MUSIC_DIR = path.join(DATA_ROOT, 'music');

// 浏览器能直接解的格式。放别的进来她也放不出声。
const EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.weba', '.webm']);

const MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

// 整首歌要一次性塞进 IPC 再变成 Blob，太大的会让界面卡一下。
// 30MB 足够放下任何正常长度的歌了（无损另说，那种自己转一下吧）。
const MAX_BYTES = 30 * 1024 * 1024;

const README = `把你自己的音乐文件丢进这个文件夹，她就能放来听、跟着跳。

支持 mp3 / m4a / wav / ogg / flac 这些常见格式。

想让她踩准拍子的话，在文件名里写上 BPM，用方括号括起来：

    某首歌 [128].mp3

不写也行，她会按 118 拍去摇，动作幅度还是会跟着音量起伏，
看上去一样是跟着音乐在动。

这里不预置任何音乐 —— 放什么、有没有版权，你自己把握。
`;

/**
 * 唱跳。
 *
 * 这里只管「有哪些歌、把文件读出来」，具体怎么跳、嘴怎么动都在渲染层
 * （src/renderer/dance.js 和 stage.js）—— 那些得贴着每一帧算，
 * 隔着 IPC 是做不了的。
 *
 * 一条底线：**不预置任何音乐**。放什么歌是用户自己的事。
 */
class Performer {
  constructor({ log, storeDir } = {}) {
    this.log = log || (() => {});
    this.dir = MUSIC_DIR;
    // 标签和测出来的拍子存这儿。读标签要开文件、测拍子要解码三十秒音频，
    // 每次点歌都重来一遍太浪费 —— 存下来，文件没变就直接用。
    this.cacheFile = path.join(storeDir || path.join(ROOT, 'sessions'), 'song-meta.json');
    this.cache = this._loadCache();
    this._ensureDir();
  }

  _loadCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  _saveCache() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (err) {
      this.log('[perform] 缓存写不进去: ' + err.message);
    }
  }

  /** 文件没动过就用缓存里的，动过了重读一遍标签 */
  _metaOf(file, stat) {
    const c = this.cache[file];
    if (c && c.mtime === stat.mtimeMs && c.size === stat.size) return c;

    const tags = readTags(path.join(this.dir, file));
    const meta = {
      mtime: stat.mtimeMs,
      size: stat.size,
      title: tags.title || null,
      artist: tags.artist || null,
      album: tags.album || null,
      tagBpm: tags.bpm || null,
      // 文件换了，之前测的拍子也不作数了
      detectedBpm: null,
    };
    this.cache[file] = meta;
    this._saveCache();
    return meta;
  }

  /**
   * 渲染层听完一遍测出来的拍子，记下来。
   * 下次放同一首就不用再测了 —— 解码三十秒音频虽然快，但没必要每次都来。
   */
  rememberBpm(file, bpm) {
    if (!file || !(bpm > 40 && bpm < 220)) return;
    const c = this.cache[file];
    if (!c || c.detectedBpm === bpm) return;
    c.detectedBpm = Math.round(bpm);
    this._saveCache();
    this.log('[perform] 记住了《' + (c.title || file) + '》的拍子: ' + c.detectedBpm + ' BPM');
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const readme = path.join(this.dir, '把歌放这里.txt');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, 'utf8');
    } catch (err) {
      this.log('[perform] 建 music 目录失败: ' + err.message);
    }
  }

  /** 文件名里 [128] 这种就是 BPM，写了就按它踩拍子 */
  static bpmOf(name) {
    const m = /\[(\d{2,3})\]/.exec(name);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 40 && n <= 220 ? n : null;
  }

  static titleOf(name) {
    return path.basename(name, path.extname(name)).replace(/\s*\[\d{2,3}\]\s*/, '').trim();
  }

  /**
   * 这串东西看着像文件名还是像人写的标题？
   *
   * 标签不一定比文件名好看 —— 有的歌标签里塞的是 `maou_49_piece_maker`
   * 这种原始文件名，而文件名反倒是清清爽爽的 `Piece Maker`。
   * 带下划线、或者通篇小写英数，基本就是没整理过的文件名。
   */
  static looksLikeFilename(s) {
    const t = String(s || '').trim();
    if (!t) return true;
    return /_/.test(t) || /^[a-z0-9\-.]+$/.test(t);
  }

  /** 标签和文件名里挑一个更像样的当歌名 */
  static pickTitle(tagTitle, fileTitle) {
    const tagOk = tagTitle && !Performer.looksLikeFilename(tagTitle);
    const fileOk = fileTitle && !Performer.looksLikeFilename(fileTitle);
    if (tagOk) return tagTitle;
    if (fileOk) return fileTitle;
    return tagTitle || fileTitle;
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch (_) {
      return [];
    }

    return files
      .filter((f) => EXTS.has(path.extname(f).toLowerCase()))
      .map((f) => {
        let stat = null;
        try { stat = fs.statSync(path.join(this.dir, f)); } catch (_) { /* 读不到就当没标签 */ }
        const meta = stat ? this._metaOf(f, stat) : {};
        const size = stat ? stat.size : 0;

        // 拍子按可信度排：文件名里手写的最硬（是你亲自标的），
        // 其次是标签里带的，最后才是她自己听出来的
        const bpm = Performer.bpmOf(f) || meta.tagBpm || meta.detectedBpm || null;

        return {
          file: f,
          title: Performer.pickTitle(meta.title, Performer.titleOf(f)),
          artist: meta.artist || null,
          album: meta.album || null,
          bpm,
          bpmFrom: Performer.bpmOf(f) ? '文件名' : (meta.tagBpm ? '标签' : (meta.detectedBpm ? '听出来的' : null)),
          size,
          tooBig: size > MAX_BYTES,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }

  /**
   * 把一首歌读出来，交给渲染层去放。
   * 不指定就随便挑一首。
   */
  load(file) {
    const songs = this.list().filter((s) => !s.tooBig);
    if (!songs.length) {
      const all = this.list();
      if (all.length) throw new Error('文件都太大了，超过 30MB 的放不了');
      throw new Error('music 文件夹里还没有歌，先丢几首进去');
    }

    const pick = file
      ? songs.find((s) => s.file === file)
      : songs[Math.floor(Math.random() * songs.length)];

    if (!pick) throw new Error('找不到这首：' + file);

    const full = path.join(this.dir, pick.file);
    // 防一手路径穿越：文件名是界面传进来的，别让它跳出 music 目录
    if (path.dirname(path.resolve(full)) !== path.resolve(this.dir)) {
      throw new Error('这个文件不在 music 文件夹里');
    }

    const buf = fs.readFileSync(full);
    this.log('[perform] 放 ' + pick.title + (pick.artist ? ' — ' + pick.artist : '') +
             '（' + Math.round(buf.length / 1024 / 1024 * 10) / 10 + 'MB' +
             (pick.bpm ? ', ' + pick.bpm + ' BPM（' + pick.bpmFrom + '）' : ', 拍子待测') + '）');

    return {
      audio: buf,
      file: pick.file, // 测出拍子之后要靠它回写缓存
      title: pick.title,
      artist: pick.artist,
      bpm: pick.bpm,
      // 没有可信来源时让渲染层自己听一遍。文件名和标签里写死的就别再费劲测了。
      detectBpm: !pick.bpm,
      mime: MIME[path.extname(pick.file).toLowerCase()] || 'audio/mpeg',
    };
  }
}

module.exports = { Performer, MUSIC_DIR };
