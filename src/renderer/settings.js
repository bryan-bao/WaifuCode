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

  // 她的大小：拖着滑杆窗口当场跟着变（主进程收到预览就调窗口尺寸）
  slider('scale', 'look.scale', { onLive: previewLook, fmt: (v) => '×' + (v / 100).toFixed(2) });

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

  // 版本与更新
  $('up-source').value = get('update.source', '');
  $('up-source').oninput = () => set('update.source', $('up-source').value.trim());
  toggle($('sw-up-serve'), get('update.serve', false), (v) => set('update.serve', v));
  window.waifu.appInfo().then((i) => {
    $('up-cur').textContent = 'v' + i.version;
    $('up-serve-hint').textContent =
      '开了之后：把打好的 WaifuCode-x.y.z-安装版.exe 丢进 ' + i.updateDir +
      '，让朋友在他那边的「更新源」里填 ' +
      // 全列出来：装了 WSL2/VPN 的机器第一块很可能是虚拟网卡，挑错就白填
      ((i.lanIPs && i.lanIPs.length)
        ? i.lanIPs.map((ip) => ip + ':' + i.updatePort).join(' 或 ')
        : '本机IP:' + i.updatePort) +
      '（多个地址就试哪个通）。第一次开 Windows 会问防火墙，选「允许」。开关保存后生效。';
  }).catch(() => {});
  // ── 快捷键：按下什么就录什么 ──────────────────────────────────────
  // 让人手敲 'CommandOrControl+Alt+S' 这种写法是不现实的（写错了还静默不生效），
  // 所以做成录制：点「改」→ 按组合键 → 当场显示。
  // Electron 那头认的是 'Control+Alt+S' 这种串，这儿负责把 KeyboardEvent 翻成它
  const KEYNAME = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
  function accelOf(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    let k = e.key;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null; // 光按修饰键不算
    if (KEYNAME[k]) k = KEYNAME[k];
    else if (/^F\d{1,2}$/.test(k)) { /* F1~F12 原样 */ }
    else if (k.length === 1) k = k.toUpperCase();
    else return null; // 认不出来的键不收，免得存进去一个挂不上的串
    // **必须带修饰键**：光一个字母当全局快捷键，你在任何地方打字都会触发
    if (!mods.length) return null;
    return mods.concat(k).join('+');
  }
  const showKey = (id) => {
    const v = get('hotkey.' + (id === 'hk-panel' ? 'panel' : 'shot'), '');
    $(id).value = v ? v.replace(/CommandOrControl/g, 'Ctrl').replace(/Control/g, 'Ctrl') : '';
  };
  let recording = null;
  function stopRec() {
    if (!recording) return;
    $(recording).classList.remove('rec');
    showKey(recording);
    recording = null;
  }
  document.querySelectorAll('.hk-set').forEach((btn) => {
    btn.onclick = () => {
      stopRec();
      recording = btn.dataset.for;
      $(recording).classList.add('rec');
      $(recording).value = '按下你想用的组合键…';
      $('hk-state').textContent = '按 Esc 放弃';
    };
  });
  document.querySelectorAll('.hk-clr').forEach((btn) => {
    btn.onclick = () => {
      stopRec();
      set('hotkey.' + (btn.dataset.for === 'hk-panel' ? 'panel' : 'shot'), '');
      showKey(btn.dataset.for);
      $('hk-state').textContent = '清掉了 —— 保存之后这个快捷键就没了';
    };
  });
  window.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { $('hk-state').textContent = '没改'; stopRec(); return; }
    const acc = accelOf(e);
    if (!acc) { $('hk-state').textContent = '得带上 Ctrl / Alt / Shift 之类 —— 光一个键会在你打字时乱触发'; return; }
    const which = recording === 'hk-panel' ? 'panel' : 'shot';
    const other = which === 'panel' ? 'shot' : 'panel';
    if (get('hotkey.' + other, '') === acc) {
      $('hk-state').textContent = '这个键另一个功能在用了，换一个';
      return;
    }
    set('hotkey.' + which, acc);
    stopRec();
    $('hk-state').textContent = '记下了：' + acc.replace(/Control/g, 'Ctrl') + '。保存之后生效';
  }, true);
  showKey('hk-panel');
  showKey('hk-shot');

  $('up-check').onclick = async () => {
    $('up-state').textContent = '查着呢…';
    // 查**输入框里现在这个**地址（刚粘完还没保存就点查是最自然的操作），
    // 结论也只按主进程真查回来的说，不拿框里有没有字编
    const r = await window.waifu.updateCheck($('up-source').value.trim());
    $('up-state').textContent = !r.ok ? r.error
      : r.hasUpdate ? '有新版 ' + r.latest + '！去派活面板标题旁点一下就能装'
      : (r.latest ? '已经是最新（' + r.current + '）' : '没填更新源，没处查');
  };
}

function fillHer() {
  $('pname').value = get('persona.name', '小依');
  $('pname').oninput = () => set('persona.name', $('pname').value);

  $('ptext').value = get('persona.text', '');
  $('ptext').oninput = () => set('persona.text', $('ptext').value);

  toggle($('sw-gesture'), get('gesture.enabled', true), (v) => set('gesture.enabled', v));
  toggle($('sw-marks'), get('gesture.marks', true), (v) => set('gesture.marks', v));
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
  if (out.dispatch) { delete out.dispatch.model; delete out.dispatch.agent; }
  delete out.panel; // 面板皮肤也归面板自己管，同一个理
  const r = await window.waifu.saveSettings(out);
  $('save').disabled = false;

  if (!r || !r.ok) { msg((r && r.error) || '没存上', true); return; }
  // 快捷键挂没挂上要如实说 —— 被别的软件占了的话按下去毫无反应，
    // 不说的话用户只会以为功能坏了
    const hk = (r && r.hotkey) || {};
    const words = [];
    if (hk.panel === 'taken') words.push('叫面板那个键被别的软件占了');
    if (hk.shot === 'taken') words.push('截图那个键被别的软件占了');
    if (words.length) { msg(words.join('；') + ' —— 换一个吧', 'err'); }
    else { msg(dirtyModel ? '存好了，她这就换个人出来' : '存好了'); }
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
