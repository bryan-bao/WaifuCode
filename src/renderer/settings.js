'use strict';

const $ = (id) => document.getElementById(id);

let cfg = null;    // 当前编辑中的配置（改动先落在这儿，点保存才写盘）
let meta = null;   // 模型列表、色调选项、眼神预设这些
let dirtyModel = false;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function msg(t, err) {
  $('msg').textContent = t || '';
  $('msg').className = 'msg' + (err ? ' err' : '');
  if (t) setTimeout(() => { if ($('msg').textContent === t) $('msg').textContent = ''; }, 4000);
}

// 深取 / 深设，省得到处写 cfg.voice = cfg.voice || {}
function get(path, dflt) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), cfg) ?? dflt;
}
function set(path, v) {
  const ks = path.split('.');
  let o = cfg;
  for (let i = 0; i < ks.length - 1; i++) {
    if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = v;
}

function chips(box, items, current, onPick) {
  box.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('span');
    el.className = 'chip' + (it.id === current ? ' on' : '');
    el.textContent = it.label;
    el.onclick = () => {
      box.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
      el.classList.add('on');
      onPick(it.id);
    };
    box.appendChild(el);
  }
}

function toggle(el, on, onChange) {
  el.classList.toggle('on', Boolean(on));
  el.onclick = () => {
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next);
    onChange(next);
  };
}

/** 滑块：内部存 -100~100 的整数，对外是 -1~1 的小数 */
function slider(id, path, { scale = 100, fmt, onLive } = {}) {
  const k = $('k-' + id);
  const v = $('v-' + id);
  const show = () => { v.textContent = fmt ? fmt(Number(k.value)) : (Number(k.value) / scale).toFixed(2); };

  k.value = String(Math.round((get(path, 0) || 0) * scale));
  show();

  k.oninput = () => {
    show();
    set(path, Number(k.value) / scale);
    if (onLive) onLive();
  };
  return k;
}

// 外观类的改动立刻推给桌宠预览，不用等保存 —— 调滑块看不到效果就没法调
function previewLook() {
  window.waifu.previewLook(cfg.look || {});
}

// ---------------------------------------------------------------------------
// 各个页
// ---------------------------------------------------------------------------
function fillLook() {
  // 换角色
  const box = $('models');
  box.innerHTML = '';
  for (const m of meta.models) {
    const el = document.createElement('div');
    el.className = 'model' + (m.path === cfg.modelPath ? ' on' : '');
    el.innerHTML = '<div class="n"></div><div class="p"></div>';
    el.querySelector('.n').textContent = m.name;
    el.querySelector('.p').textContent = m.path;
    el.onclick = () => {
      box.querySelectorAll('.model').forEach((c) => c.classList.remove('on'));
      el.classList.add('on');
      cfg.modelPath = m.path;
      dirtyModel = true;
      msg('保存之后她就换成「' + m.name + '」了');
    };
    box.appendChild(el);
  }

  chips($('tints'), meta.tints, get('look.tint', 'none'), (id) => {
    set('look.tint', id);
    previewLook();
  });

  chips($('presets'), meta.presets, get('look.preset', 'default'), (id) => {
    set('look.preset', id);
    previewLook();
  });

  for (const k of ['smile', 'cheek', 'brow', 'browAngle', 'eyeX', 'eyeY']) {
    slider(k, 'look.' + k, { onLive: previewLook });
  }

  $('look-reset').onclick = () => {
    for (const k of ['smile', 'cheek', 'brow', 'browAngle', 'eyeX', 'eyeY']) {
      set('look.' + k, 0);
      $('k-' + k).value = '0';
      $('v-' + k).textContent = '0.00';
    }
    previewLook();
    msg('微调都归零了');
  };
}

function fillVoice() {
  toggle($('sw-voice'), get('voice.enabled', true), (v) => set('voice.enabled', v));

  const sel = $('voiceName');
  sel.innerHTML = '';
  for (const v of meta.voices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    sel.appendChild(o);
  }
  sel.value = get('voice.voiceName', 'zh-CN-XiaoyiNeural');
  sel.onchange = () => set('voice.voiceName', sel.value);

  // 语速和音调在配置里是 "+8%" / "+12Hz" 这种字符串，滑块要来回换算
  const pct = (s) => parseInt(String(s || '0').replace(/[^-\d]/g, ''), 10) || 0;

  const rate = $('k-rate');
  rate.value = String(pct(get('voice.rate', '+8%')));
  $('v-rate').textContent = (rate.value > 0 ? '+' : '') + rate.value + '%';
  rate.oninput = () => {
    $('v-rate').textContent = (rate.value > 0 ? '+' : '') + rate.value + '%';
    set('voice.rate', (rate.value > 0 ? '+' : '') + rate.value + '%');
  };

  const pitch = $('k-pitch');
  pitch.value = String(pct(get('voice.pitch', '+12Hz')));
  $('v-pitch').textContent = (pitch.value > 0 ? '+' : '') + pitch.value + 'Hz';
  pitch.oninput = () => {
    $('v-pitch').textContent = (pitch.value > 0 ? '+' : '') + pitch.value + 'Hz';
    set('voice.pitch', (pitch.value > 0 ? '+' : '') + pitch.value + 'Hz');
  };

  slider('volume', 'voice.volume', { scale: 100, fmt: (n) => n + '%' });

  $('try-voice').onclick = async () => {
    $('try-voice').textContent = '合成中…';
    const r = await window.waifu.tryVoice(cfg.voice || {});
    $('try-voice').textContent = '试听一句';
    if (!r || !r.ok) msg((r && r.error) || '没出声', true);
  };
}

function fillWork() {
  const fill = (id, path, items) => {
    const sel = $(id);
    sel.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.label;
      sel.appendChild(o);
    }
    sel.value = get(path, items[0].id);
    sel.onchange = () => set(path, sel.value);
  };

  fill('dispatchMode', 'dispatch.permissionMode', meta.permissionModes);
  fill('terminalMode', 'terminal.permissionMode', meta.permissionModes);
  fill('terminalApp', 'terminal.app', meta.terminalApps);

  toggle($('sw-supervise'), get('supervise.enabled', true), (v) => set('supervise.enabled', v));
  toggle($('sw-sup-speak'), get('supervise.speak', true), (v) => set('supervise.speak', v));
  toggle($('sw-sup-guard'), get('supervise.guard', true), (v) => set('supervise.guard', v));
  slider('gap', 'supervise.minGapSec', { scale: 1, fmt: (n) => n + '秒' });
}

function fillHer() {
  $('pname').value = get('persona.name', '小依');
  $('pname').oninput = () => set('persona.name', $('pname').value);

  $('ptext').value = get('persona.text', '');
  $('ptext').oninput = () => set('persona.text', $('ptext').value);

  toggle($('sw-gesture'), get('gesture.enabled', true), (v) => set('gesture.enabled', v));
  slider('gestGap', 'gesture.minGapSec', { scale: 1, fmt: (n) => n + '秒' });
}

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------
document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    $('tab-' + b.dataset.tab).classList.add('on');
  };
});

$('close').onclick = () => window.waifu.closeSettings();
$('cancel').onclick = () => window.waifu.closeSettings();

$('save').onclick = async () => {
  $('save').disabled = true;
  // cfg 是**打开窗口那一刻的整份快照**，而 dispatch.model 归派活面板管
  // （它随时会往 config 里写）。整份写回去会把你开着设置窗口期间在面板上
  // 选的模型冲回旧值 —— 这一页没有它的控件，摘掉，别替别人做主
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.dispatch) delete out.dispatch.model;
  delete out.panel; // 面板皮肤也归面板自己管，同一个理
  const r = await window.waifu.saveSettings(out);
  $('save').disabled = false;

  if (!r || !r.ok) { msg((r && r.error) || '没存上', true); return; }
  msg(dirtyModel ? '存好了，她这就换个人出来' : '存好了');
  dirtyModel = false;
};

// ---------------------------------------------------------------------------
(async () => {
  const data = await window.waifu.getSettings();
  cfg = data.config;
  meta = data.meta;

  fillLook();
  fillVoice();
  fillWork();
  fillHer();
})();
