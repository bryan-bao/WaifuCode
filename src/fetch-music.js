'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * 本地没有的歌，去网上找。
 *
 * 只连**明确授权免费下载**的曲库。目前接的是魔王魂（maou.audio）——
 * 个人商用都免费、不用注册、不用报备，规约见 https://maou.audio/rule/。
 *
 * 说清楚这里的边界，免得以后有人来加源：
 * 这个模块不会去碰视频站抽音轨，也不会接盗版聚合站。想要正版商业单曲，
 * 那是去 mora / Amazon 日区买了丢进 music 文件夹的事，不归这儿管。
 * 所以「她找不到紅蓮華」不是 bug —— 免费曲库里本来就不会有。
 */

const HOST = 'https://maou.audio';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 曲库目录变化很慢（一个月上新一两首），存下来别每次点歌都去爬一遍
const CATALOG_TTL_MS = 3 * 24 * 3600 * 1000;

// 每个分类最多翻几页。魔王魂 BGM 分类页数不少，但越往后越冷门，
// 翻太多只是在拖慢第一次点歌。
const MAX_PAGES = 4;

const CATEGORIES = ['song', 'bgm', 'game'];

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        // 直链下载会被 403 挡掉，必须带上「我是从歌曲页点进来的」
        ...(opts.referer ? { Referer: opts.referer } : {}),
      },
      timeout: opts.timeoutMs || 30000,
    }, (res) => {
      // 跟一次跳转就够了，免费曲库不会绕更多层
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && !opts._redirected) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(get(next, { ...opts, _redirected: true }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' ' + url));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks), url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('超时: ' + url)); });
  });
}

/** 关键词比对前先抹平差异：大小写、空格、各种标点、全角半角 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[-_~・.,!?'"「」『』（）()【】\[\]]/g, '');
}

class MusicFetcher {
  constructor({ log, storeDir } = {}) {
    this.log = log || (() => {});
    this.cacheFile = path.join(storeDir || __dirname, 'maou-catalog.json');
    this.catalog = null;
  }

  _loadCatalog() {
    if (this.catalog) return this.catalog;
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c && Array.isArray(c.items) && Date.now() - c.at < CATALOG_TTL_MS) {
        this.catalog = c.items;
        return this.catalog;
      }
    } catch (_) {
      /* 没缓存或者过期了，等下现爬 */
    }
    return null;
  }

  _saveCatalog(items) {
    this.catalog = items;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ at: Date.now(), items }, null, 2), 'utf8');
    } catch (err) {
      this.log('[fetch] 曲库目录存不下来: ' + err.message);
    }
  }

  /** 爬一遍分类页，拿到「歌名 -> 歌曲页地址」的对照表 */
  async _buildCatalog() {
    const seen = new Map();

    for (const cat of CATEGORIES) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = page === 1
          ? `${HOST}/category/${cat}/`
          : `${HOST}/category/${cat}/page/${page}/`;

        let html;
        try {
          html = (await get(url)).body.toString('utf8');
        } catch (_) {
          break; // 翻到没有了，这个分类就到此为止
        }

        // 列表项长这样：<a href="https://maou.audio/49_piece_maker/" title="Piece Maker">
        const re = /href="(https:\/\/maou\.audio\/[0-9a-z_]+\/)"\s+title="([^"]*)"/g;
        let m;
        let added = 0;
        while ((m = re.exec(html))) {
          if (seen.has(m[1])) continue;
          seen.set(m[1], { page: m[1], title: m[2], cat });
          added++;
        }
        if (!added) break; // 这一页没有新东西，说明翻到头了
      }
    }

    const items = [...seen.values()];
    this.log('[fetch] 魔王魂曲库目录: ' + items.length + ' 首');
    if (items.length) this._saveCatalog(items);
    return items;
  }

  async catalogue() {
    return this._loadCatalog() || (await this._buildCatalog());
  }

  /** 按关键词在曲库里找，返回最像的那几首 */
  async search(keyword) {
    const k = norm(keyword);
    if (!k) return [];

    const items = await this.catalogue();
    const scored = [];

    for (const it of items) {
      const t = norm(it.title);
      const slug = norm(it.page.replace(HOST, '').replace(/\//g, ''));
      let score = 0;

      if (t && t === k) score = 100;
      else if (t && t.includes(k)) score = 80;
      else if (t && k.includes(t) && t.length >= 2) score = 70;
      else if (slug.includes(k)) score = 50;

      if (score) scored.push({ ...it, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  /**
   * 把某一首下载到指定目录，返回落地的文件路径。
   *
   * 歌曲页上同一首会挂四个版本（原曲 / 伴奏 inst / 短版 short / 短版伴奏），
   * 要的是原曲，所以把带 inst、short 的都筛掉。
   */
  async download(item, destDir) {
    const html = (await get(item.page)).body.toString('utf8');

    const urls = [...html.matchAll(/https:\/\/maou\.audio\/sound\/[^"'\s]+?\.mp3/g)]
      .map((m) => m[0]);
    const full = urls.find((u) => !/_inst_|_short_|\/maou_inst|\/maou_short/.test(u));
    if (!full) throw new Error('这首在页面上没找到可下载的音频');

    const safe = String(item.title || 'song').replace(/[\\/:*?"<>|]/g, '_').trim() || 'song';
    const out = path.join(destDir, safe + '.mp3');

    // 下载必须带 Referer，不然魔王魂一律 403
    const { body } = await get(full, { referer: item.page, timeoutMs: 120000 });
    if (body.length < 20000) throw new Error('下回来的文件不像是音频（' + body.length + ' 字节）');

    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(out, body);
    this.log('[fetch] 下好了《' + item.title + '》-> ' + path.basename(out) +
             '（' + Math.round(body.length / 1024) + 'KB）');

    return { file: out, title: item.title, source: '魔王魂' };
  }

  /** 搜 + 下，一步到位。找不到返回 null（不是错误，调用方该说「没有这首」） */
  async find(keyword, destDir) {
    const hits = await this.search(keyword);
    if (!hits.length) return null;
    return this.download(hits[0], destDir);
  }
}

module.exports = { MusicFetcher };
