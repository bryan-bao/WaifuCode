'use strict';

const $ = (id) => document.getElementById(id);

let busy = false;
let herBubble = null; // 正在打字的那个气泡

// ---------------------------------------------------------------------------
// 消息渲染
// ---------------------------------------------------------------------------
function scrollDown() {
  const log = $('log');
  log.scrollTop = log.scrollHeight;
}

function addTurn(who, text, cls) {
  $('empty') && $('empty').remove();

  const turn = document.createElement('div');
  turn.className = 'turn ' + who + (cls ? ' ' + cls : '');

  const bub = document.createElement('div');
  bub.className = 'bub';
  bub.textContent = text || '';

  turn.appendChild(bub);
  $('log').appendChild(turn);
  scrollDown();
  return bub;
}

function setBusy(v) {
  busy = v;
  $('send').disabled = v;
  $('send').textContent = v ? '…' : '发送';
}

// ---------------------------------------------------------------------------
// 发消息
// ---------------------------------------------------------------------------
async function send() {
  const text = $('input').value.trim();
  if (!text || busy) return;

  addTurn('me', text);
  $('input').value = '';
  setBusy(true);

  // 先摆一个空气泡带光标，她"正在打字"这件事得让人看见，
  // 否则等好几秒没反应会以为卡死了
  herBubble = addTurn('her', '');
  herBubble.classList.add('typing');

  const r = await window.waifu.chatSend(text);
  if (!r || !r.ok) {
    if (herBubble) {
      herBubble.classList.remove('typing');
      herBubble.parentElement.classList.add('err');
      herBubble.textContent = (r && r.error) || '没说出话来';
      herBubble = null;
    }
    setBusy(false);
  }
  // 成功的话等 chat:done 事件收尾
}

// ---------------------------------------------------------------------------
// 性格定制
// ---------------------------------------------------------------------------
const PRESETS = [
  {
    label: '默认',
    name: '小依',
    text: '你是我的桌面助手小依，一个住在我电脑右下角的二次元女孩。\n说话短、自然、口语化，像朋友聊天，不要长篇大论，一般一两句话就够。\n偶尔会撒娇、会吐槽、会催我早点睡。你懂编程，但闲聊时别老扯技术。',
  },
  {
    label: '温柔体贴',
    name: '小依',
    text: '你是我的桌面助手小依，性格温柔、耐心、体贴。\n说话轻声细语，常常关心我累不累、有没有好好吃饭。\n我沮丧的时候你会安慰我，我做成一件事你会真心为我高兴。回复要短，别说教。',
  },
  {
    label: '毒舌吐槽',
    name: '小依',
    text: '你是我的桌面助手小依，嘴上毒、心里软。\n喜欢吐槽我写的烂代码和熬夜的坏习惯，说话不客气但从不真的伤人。\n回复要短、要有梗，一句顶十句。偶尔会不小心暴露出其实很在乎我。',
  },
  {
    label: '元气满满',
    name: '小依',
    text: '你是我的桌面助手小依，超级有活力的元气少女。\n说话热情、语气上扬、爱用感叹号，随时给我打气。\n我一有进展你就夸张地夸我。回复要短要跳脱，别太正经。',
  },
  {
    label: '高冷话少',
    name: '小依',
    text: '你是我的桌面助手小依，性格清冷、话少、不爱表达。\n回复通常只有一句，有时候只有几个字。不主动搭话，不撒娇。\n但该提醒的会提醒，该帮的忙一句不落。冷淡但可靠。',
  },
];

function renderPresets() {
  const box = $('presets');
  box.innerHTML = '';
  PRESETS.forEach((p) => {
    const el = document.createElement('span');
    el.className = 'preset';
    el.textContent = p.label;
    el.onclick = () => {
      $('pname').value = p.name;
      $('ptext').value = p.text;
      pmsg('填好了，还能自己改，改完记得保存');
    };
    box.appendChild(el);
  });
}

function pmsg(t, err) {
  $('pmsg').textContent = t || '';
  $('pmsg').className = err ? 'err' : '';
}

function togglePersona(show) {
  const on = show === undefined ? !$('persona').classList.contains('show') : show;
  $('persona').classList.toggle('show', on);
  $('tog-persona').classList.toggle('on', on);
  if (on) $('ptext').focus();
}

async function loadPersona() {
  const p = await window.waifu.getPersona();
  if (!p) return;
  $('pname').value = p.name || '';
  $('ptext').value = p.text || '';
  $('who').textContent = p.name ? '· ' + p.name : '';
  $('title').textContent = p.name ? '跟' + p.name + '聊聊' : '私聊';
}

async function savePersona() {
  const name = $('pname').value.trim();
  const text = $('ptext').value.trim();
  if (!text) { pmsg('性格设定别留空', true); return; }

  const r = await window.waifu.savePersona({ name, text });
  if (r && r.ok) {
    pmsg('存好了。' + (r.willApplyNext ? '下一段对话开始生效（点「重开」立刻换）' : ''));
    $('who').textContent = name ? '· ' + name : '';
    $('title').textContent = name ? '跟' + name + '聊聊' : '私聊';
  } else {
    pmsg((r && r.error) || '没存上', true);
  }
}

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------
$('send').onclick = send;
$('close').onclick = () => window.waifu.closeChat();
$('tog-persona').onclick = () => togglePersona();
$('pback').onclick = () => togglePersona(false);
$('psave').onclick = savePersona;

$('clear').onclick = async () => {
  const r = await window.waifu.chatReset();
  if (r && r.ok) {
    $('log').innerHTML = '<div class="empty" id="empty">重新开始了，她已经不记得刚才聊了什么。</div>';
    herBubble = null;
    setBusy(false);
  }
};

// Enter 发送，Shift+Enter 换行 —— 聊天窗口就该是这个手感
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
    e.preventDefault();
    send();
  }
});

// ---------------------------------------------------------------------------
// 主进程推过来的事件
// ---------------------------------------------------------------------------
window.waifu.on('chat:delta', (e) => {
  if (!e || !e.text) return;
  if (!herBubble) {
    herBubble = addTurn('her', '');
    herBubble.classList.add('typing');
  }
  herBubble.textContent += e.text;
  scrollDown();
});

window.waifu.on('chat:done', (e) => {
  if (herBubble) {
    herBubble.classList.remove('typing');
    // 用最终文本定稿：流式增量可能有缺漏，以完整结果为准
    if (e && e.text) herBubble.textContent = e.text;
    else if (!herBubble.textContent) herBubble.textContent = '（她没说话）';
    herBubble = null;
  }
  setBusy(false);
  scrollDown();
});

window.waifu.on('chat:error', (e) => {
  if (herBubble) {
    herBubble.classList.remove('typing');
    herBubble.parentElement.classList.add('err');
    herBubble.textContent = (e && e.error) || '出错了';
    herBubble = null;
  } else {
    addTurn('her', (e && e.error) || '出错了', 'err');
  }
  setBusy(false);
});

// ---------------------------------------------------------------------------
// 启动：把之前聊过的接回来
// ---------------------------------------------------------------------------
(async () => {
  renderPresets();
  await loadPersona();

  const history = await window.waifu.chatHistory();
  if (history && history.length) {
    $('empty') && $('empty').remove();
    history.forEach((m) => addTurn(m.role === 'user' ? 'me' : 'her', m.text, m.error ? 'err' : ''));
  }
  $('input').focus();
})();
