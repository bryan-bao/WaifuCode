'use strict';

const { Application, Ticker } = PIXI;
const { Live2DModel } = PIXI.live2d;

// 不注册 ticker 的话，模型加载出来是一尊静止的雕像 ——
// 物理摆动、自动眨眼、待机动作全都不会跑。
Live2DModel.registerTicker(Ticker);

// 模型自带的配音一律不放。
//
// 官方样例里有的模型（Izumi 十个动作全是）在 model3.json 的动作条目上挂了 `Sound`，
// 加载器默认会跟着动作一起播 —— 于是她一做待机动作就冒出一个陌生的日语女声，
// 跟她自己那把 TTS 抢着说话，口型也对不上（口型是照着我们合成的音量走的）。
// 她的嗓子只有一个来源，就是 voice 那条链。
if (PIXI.live2d.config) PIXI.live2d.config.sound = false;

const canvas = document.getElementById('stage');
const bubbleEl = document.getElementById('bubble');
const bubbleTextEl = document.getElementById('bubble-text');
const bubbleOfferEl = document.getElementById('bubble-offer');
const moodEl = document.getElementById('mood');
const gearEl = document.getElementById('gear');

gearEl.addEventListener('click', () => window.waifu.openSettings());

/**
 * 齿轮的显隐。
 *
 * 收起来必须**拖一会儿**再收：从她身上挪到右下角那一路要跨过一片空白，
 * 立刻就藏的话，你还在半路它就没了。留两秒，够走过去了。
 */
let gearTimer = null;
function showGear(on) {
  clearTimeout(gearTimer);
  if (on) {
    gearEl.classList.add('show');
  } else if (gearEl.classList.contains('show')) {
    gearTimer = setTimeout(() => gearEl.classList.remove('show'), 2000);
  }
}

let app = null;
let model = null;
let profile = null; // 当前模型的适配信息，见 src/profiles.js
let dancer = null;  // 编舞引擎，见 dance.js
let look = null;    // 眼神和色调，见 look.js
// 设置面板「她」那页的「情绪动作」开关。以前这个值压根没传到渲染层来，
// 所以那个勾选框勾不勾都一样 —— 现在 pet:get-config 会带过来了。
let gestureOn = true;
let marksOn = true; // 情绪符号（头顶冒 💢/💧/❓…），设置「她」那页可关

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
// file:// 协议下资源能不能读，是这类 Electron + Live2D 项目最常见的翻车点。
// 加载器内部失败往往是静默的（promise 永远不 resolve），所以先自己探一枪。
function probe(url) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = () => resolve('HTTP ' + xhr.status + ', ' + (xhr.responseText || '').length + ' bytes');
    xhr.onerror = () => resolve('网络层失败 (status=' + xhr.status + ')');
    xhr.ontimeout = () => resolve('超时');
    try {
      xhr.send();
    } catch (e) {
      resolve('抛异常: ' + e.message);
    }
  });
}

async function boot() {
  const cfg = await window.waifu.getConfig();
  const modelUrl = '../../' + cfg.modelPath;
  // 贴图归属判断要用它，见 atlasFitsModel
  modelDir = normPath(cfg.modelPath).split('/').slice(0, -1).join('/');
  profile = cfg.profile;
  gestureOn = !(cfg.gesture && cfg.gesture.enabled === false);
  marksOn = !(cfg.gesture && cfg.gesture.marks === false);

  console.log('[stage] 模型: ' + (profile && profile.name) + ' <- ' + modelUrl);
  console.log('[stage] 自检 model3.json -> ' + (await probe(modelUrl)));

  app = new Application({
    view: canvas,
    resizeTo: window,
    backgroundAlpha: 0, // 关键：0 才能透出桌面，给 1 会是黑底
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  console.log('[stage] PIXI Application 就绪，开始加载模型…');

  // autoInteract 关掉 —— 它内部会自己绑 pointer 事件做视线跟随和点击，
  // 那套逻辑跟我们的鼠标穿透会互相打架（它假设窗口一直接收事件）。
  // 套一层超时：加载器卡死时不能让整个启动流程无声地悬在这里。
  model = await Promise.race([
    Live2DModel.from(modelUrl, { autoInteract: false }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('模型加载超过 20 秒未完成，八成是资源读不到')), 20000)
    ),
  ]);

  console.log('[stage] 模型加载成功，原始尺寸 ' +
    model.internalModel.width + 'x' + model.internalModel.height);

  app.stage.addChild(model);
  layout();
  wireMouse();

  window.addEventListener('resize', layout);

  initLipSync();

  if (window.WaifuDancer) {
    dancer = new window.WaifuDancer(model, (m) => console.log(m));
    // 唱到副歌脸上也得有反应 —— 光身体嗨、表情不变，看着像两个人
    dancer.onSection = (s) => {
      const want = s === 'hype' ? 'excited' : (s === 'calm' ? 'shy' : 'happy');
      const f = faceFor(want);
      if (f) setExpression(f);
    };
  }

  // 现在就把编舞的钩子挂上，而不是等第一次 start() 时才懒挂。
  // 为的是**把钩子顺序钉死**：编舞的 beforeModelUpdate 必须排在眼神那层前面，
  // 因为编舞是覆盖式写入、眼神是叠加式偏移 —— 反过来的话，
  // 眼神的偏移会被编舞当场抹掉。不花性能：闲着的时候它第一行就 return 了。
  if (dancer) dancer._hook();

  if (window.WaifuLook) {
    look = new window.WaifuLook.Look(model, (m) => console.log(m));
    look.apply(cfg.look || {});
  }

  // 上次选的发型和配色，重启后接着用
  if (cfg.look && cfg.look.hair) setHairStyle(cfg.look.hair);
  // 换过的整套贴图。**必须在这儿记下原装那几张** —— setAtlas 第一次被调用时
  // 才存底的话，「换回原样」拿到的就是换过之后的那张了。
  //
  // 用的是 cfg.atlas（主进程给的、已经摊平成一串 url），**不是 cfg.look.atlas**。
  // 后者是「按模型分开存的一张表」，这儿原来直接把整张表塞进来，String() 出来是
  // "[object Object]"，归属判断当场判否 → **每次开机都退回原装**，
  // 你上次选的皮肤白选，还一句提示都没有。
  baseTextures = model.textures && model.textures.slice();
  if (cfg.atlas) setAtlas(cfg.atlas);

  model.motion((profile && profile.idleMotion) || 'Idle');
  say('我在的。有活儿随时叫我～', 3200);
}

// 心情状态 -> 这个模型该用哪张脸。
// faceMap 为 null 表示表情名跟状态名一致（我们自己生成的那套就是这样），
// 为空对象表示这个模型没做过情绪映射，那就干脆不切表情。
function faceFor(state) {
  if (!profile) return null;
  if (profile.faceMap === null || profile.faceMap === undefined) return state;
  return profile.faceMap[state] || null;
}

// 窗口顶部留出来专门给气泡站的一条空带（单位 px）。
// 以前角色是照着整个窗口居中的，头顶紧贴上边缘，气泡往那儿一浮就正好糊她一脸。
// 主进程那边把窗口相应加高了，所以让出这一条不会把她压小。
const BUBBLE_ZONE = 150;

function layout() {
  if (!model || !app) return;
  const W = app.renderer.width / app.renderer.resolution;
  const H = app.renderer.height / app.renderer.resolution;

  // 窗口要是被压得很矮（小屏、缩放拉满），让气泡少占点，别把她挤没了
  const zone = Math.min(BUBBLE_ZONE, H * 0.3);
  const availH = H - zone;

  // internalModel 的宽高是模型的原始画布尺寸，用它算适配比例
  const scale = Math.min(
    W / model.internalModel.width,
    availH / model.internalModel.height
  ) * 0.92;

  model.scale.set(scale);
  model.anchor.set(0.5, 0.5);
  // 在空带**下面**那块地方居中，于是头顶正好顶着气泡的底边
  model.position.set(W / 2, zone + availH / 2);
}

// ---------------------------------------------------------------------------
// 视线
//
// 「眼睛跟着鼠标走」这件事，本来就只在鼠标**不在她身上**的时候才看得出来。
// 所以两个来源都要接：窗口内走 mousemove，窗口外靠主进程按 120ms 问一次
// 全局光标位置推过来（pet:cursor）。
//
// 还有一条同样要紧：**你不动了，她的注意力也该飘走。** 一直用同一个角度
// 死盯着一个不动的鼠标，比压根不跟随还渗人 —— 那不是在看你，那是在瞪着虚空。
// ---------------------------------------------------------------------------
const GAZE_IDLE_MS = 8000;   // 鼠标静止多久之后她开始走神
let gazeMovedAt = 0;
let gazeWanderAt = 0;
let gazeNextWander = 0;

// 她正在想事情的那一两秒，视线别被鼠标拽回来 —— 想事情的人不会一直盯着你
let gazeLockUntil = 0;

function gazeAt(x, y) {
  gazeMovedAt = performance.now();
  if (!model) return;
  if (gazeMovedAt < gazeLockUntil) return;

  // 跳舞的时候把视线收回正中间。
  //
  // 这条不是审美问题是安全问题：updateFocus 是**加法**，它会往 AngleX/AngleY/
  // AngleZ 上再叠最多 ±30°、BodyAngleX 上 ±10°。编舞本身最猛的一段已经到 34°，
  // 再叠一个满幅的视线就直接把她甩出屏幕了。跳舞时身体归编舞管，视线让位。
  if (dancer && dancer.on) {
    model.focus(window.innerWidth / 2, window.innerHeight / 2);
    return;
  }

  // focusController 自带平滑插值，不用我们逐帧喂 —— 给个目标点就够了。
  // 而且 updateFocus 天生跑在 physics 之前，所以视线一动，头发也跟着有惯性。
  model.focus(x, y);
}

setInterval(() => {
  if (!model) return;
  const now = performance.now();
  if (now - gazeMovedAt < GAZE_IDLE_MS) return;      // 你还在动，她还看着你
  if (now - gazeWanderAt < gazeNextWander) return;

  gazeWanderAt = now;
  gazeNextWander = 4000 + Math.random() * 5000;      // 每次发呆的长短不一样

  // 在窗口范围里随便挑个点看过去。偏上、偏中间，别让她一直盯着地板
  const W = window.innerWidth;
  const H = window.innerHeight;
  model.focus(W * (0.12 + Math.random() * 0.76), H * (0.08 + Math.random() * 0.5));
}, 1000);

// ---------------------------------------------------------------------------
// 鼠标：穿透判定 + 拖动 + 视线跟随 + 摸头
//
// 窗口是一整块透明画布，默认必须让鼠标穿透过去，否则会挡住桌面图标。
// 只有当指针压在角色身上时才临时关掉穿透，这样她才点得到、拖得动。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 摸着不放。
//
// 跟「点一下」是两种完全不同的体感，这也是它值得单独一套逻辑的原因：
// 点击是个瞬时事件，你按下松开、她演一个动作；而摸是**持续**的 ——
// 手一直在她头上，她就一直眯着眼往你手的方向蹭，你一松手才慢慢回来。
// 前者像在按按钮，后者才像在摸一只猫。
//
// 三个门槛都是调出来的：
//   350ms  —— 短于这个算「点一下」，不然点她一下姿态也会闪一下，很脏
//   6.5s   —— 摸这么久还不撒手，她开始躲（一直舒服就没有层次了）
//   拖动   —— 手一移开就取消，别让「挪个位置」变成「摸了半天」
// 全程走 react 那条路，**一分钱不花**。
// ---------------------------------------------------------------------------
const PET_HOLD_MS = 350;
const PET_TOO_LONG_MS = 6500;

let petHoldTimer = null;
let petLongTimer = null;

function stopPetHold() {
  clearTimeout(petHoldTimer);
  clearTimeout(petLongTimer);
  petHoldTimer = null;
  petLongTimer = null;
  if (tempPosture === 'pet' || tempPosture === 'petAway') setTempPosture(null);
}

function startPetHold(x, y) {
  stopPetHold();

  petHoldTimer = setTimeout(() => {
    setTempPosture('pet');
    // 往你手的方向蹭。锁一下视线，否则手指一抖 mousemove 就把头拽回去了
    if (model) {
      gazeLockUntil = performance.now() + 900;
      model.focus(x, y);
    }
    window.waifu.react('pet-hold');
  }, PET_HOLD_MS);

  petLongTimer = setTimeout(() => {
    setTempPosture('petAway');
    window.waifu.react('pet-long');
  }, PET_TOO_LONG_MS);
}

function hitModel(x, y) {
  if (!model) return false;
  const b = model.getBounds();
  if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) return false;

  // 立绘是竖长的，外接矩形四角全是空气。用一个内切椭圆再筛一道，
  // 能去掉大部分误判，代价只有几次浮点运算。
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const nx = (x - cx) / (b.width / 2);
  const ny = (y - cy) / (b.height / 2);
  return nx * nx + ny * ny <= 1.0;
}

// 摸到头没有。
// 模型自带 HitArea Head 的就用官方判定；没给的（比如 Hiyori 只定义了 Body）
// 用几何兜底：外接框顶部 headRatio 那一段算头。
function hitHead(x, y) {
  if (!model) return false;
  const areas = model.hitTest(x, y);
  if (areas && areas.includes('Head')) return true;
  const ratio = profile && profile.headRatio;
  if (!ratio) return false;
  const b = model.getBounds();
  return hitModel(x, y) && y <= b.y + b.height * ratio;
}

function wireMouse() {
  let dragging = false;
  let dragReacted = false; // 这一次拖动已经「欸」过一声了，别每帧都喊
  let lastX = 0;
  let lastY = 0;
  let moved = 0;
  let through = null; // null 表示还没同步过，第一次一定会下发

  function setThrough(v) {
    if (v === through) return; // 去抖，避免每次 mousemove 都打 IPC
    through = v;
    window.waifu.setClickThrough(v);
  }

  // 她提议做点什么时气泡下面那两个按钮。
  function hitOfferButtons(x, y) {
    if (!bubbleEl.classList.contains('has-offer')) return false;
    const r = bubbleOfferEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /**
   * 鼠标在不在气泡上。
   *
   * 气泡以前是整块穿透的（怕挡住桌面图标），但那样「点气泡接着聊」就无从谈起。
   * 折中：**只有她真的说着话的那几秒**才收事件 —— 三个点转着的时候
   * （thinking）不收，气泡收起来之后 .show 一掉也不收。
   * 所以挡住桌面的时间窗口很短，而且那块地方本来就在角色窗口底下。
   */
  function hitBubble(x, y) {
    if (!bubbleEl.classList.contains('show')) return false;
    if (bubbleEl.classList.contains('thinking')) return false;
    const r = bubbleEl.getBoundingClientRect();
    if (!r.width) return false;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /**
   * 鼠标在不在右下角那个齿轮附近。
   *
   * **千万别判断它当前显不显示。** 第一版就是那么写的，结果是个死锁：
   * 齿轮只在「鼠标在角色上或在齿轮上」时才显示，可你要移到齿轮上，
   * 必须先经过既不是角色也不是齿轮的空白区 —— 那一刻齿轮已经藏了，
   * 判定跟着返回 false，窗口恢复穿透，鼠标事件直接穿到桌面去，
   * 于是永远够不着它。
   *
   * 位置是 CSS 钉死在右下角的，隐藏时（opacity:0）也还在布局里，
   * 所以拿几何位置判断就够了。外扩一圈是为了好瞄准。
   */
  function hitGear(x, y, pad = 16) {
    const r = gearEl.getBoundingClientRect();
    if (!r.width) return false; // 还没渲染出来
    return x >= r.left - pad && x <= r.right + pad &&
           y >= r.top - pad && y <= r.bottom + pad;
  }

  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      // 用 screenX/screenY：窗口正在被拖着跑，clientX 是相对窗口的，会自己抵消掉位移
      window.waifu.drag(e.screenX - lastX, e.screenY - lastY);
      moved += Math.abs(e.screenX - lastX) + Math.abs(e.screenY - lastY);
      lastX = e.screenX;
      lastY = e.screenY;

      // 被拎起来了 —— 吓一跳，喊一声。
      // 门槛设在 12 像素：手一抖就喊的话，点她一下都会「欸」半天。
      // 走的是 react 不是 interact：**这条永远不花钱**。
      if (!dragReacted && moved > 12) {
        dragReacted = true;
        // 手开始移了，那就是在挪位置不是在摸她 —— 把摸头那套撤掉
        stopPetHold();
        window.waifu.react('drag');
        // 被拎着的时候头发裙子该甩起来。focus 天生写在物理上游，
        // 借它的道最省事 —— 视线往下一甩，身体跟着带出惯性。
        // 走 gazeAt 而不是直接 focus：顺手把「刚刚有动静」这个时间戳也刷了，
        // 否则拖久一点她会一边被你拎着一边开始走神
        gazeAt(window.innerWidth / 2, window.innerHeight);
      }
      return;
    }

    const onModel = hitModel(e.clientX, e.clientY);
    const onGear = hitGear(e.clientX, e.clientY);

    // 够到她身上、或者手已经伸到齿轮那边了，就把齿轮亮着
    showGear(onModel || onGear);

    // 齿轮那一小块必须一直可点 —— 哪怕这会儿它还没浮出来。
    // （穿透状态下也收得到 mousemove，因为主进程开了 forward:true）
    setThrough(!onModel && !onGear &&
               !hitOfferButtons(e.clientX, e.clientY) &&
               !hitBubble(e.clientX, e.clientY));

    // 视线跟着鼠标转。**不再要求鼠标压在她身上** ——
    // 以前只有 onModel 时才 focus，于是你的鼠标一离开她的身体，
    // 她的眼睛就当场冻在最后那个方向上，比不跟随还怪。
    gazeAt(e.clientX, e.clientY);
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (hitOfferButtons(e.clientX, e.clientY)) return; // 按钮自己有 onclick，别当成拖动
    if (hitBubble(e.clientX, e.clientY)) return;       // 气泡也有自己的 onclick
    if (hitGear(e.clientX, e.clientY)) return;
    if (!hitModel(e.clientX, e.clientY)) return;
    dragging = true;
    dragReacted = false;
    moved = 0;
    lastX = e.screenX;
    lastY = e.screenY;

    // 手压在头上不动 = 在摸她。压在身上不算 —— 摸肚子那是另一回事
    if (hitHead(e.clientX, e.clientY)) startPetHold(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    stopPetHold(); // 松手了，姿态自己慢慢回到心情那层

    // 位移很小才算「点击」而不是「拖动」，否则拖完手一松就触发摸头很出戏
    if (moved < 5 && model) {
      const onHead = hitHead(e.clientX, e.clientY);
      model.motion((profile && profile.tapMotion) || 'Tap');

      // 她正卡在「等你确认」上（身体已经转过来看着你了）—— 这时候你点她，
      // 要的显然是去看那边一眼，不是让她现想一句话。
      // 顺带还省一次搭话的钱（约 1.5 分）
      if (workTermId) {
        window.waifu.focusTerminal(workTermId);
        return;
      }
      // 摸头交给心情系统去反应 —— 她说什么取决于当下什么情绪，
      // 而不是写死一句台词
      window.waifu.interact(onHead ? 'pet' : 'poke');
    }
  });

  // 点一下气泡 = 把她刚说的这句带进私聊窗口接着聊。
  // 用 mouseup 而不是 click：click 在拖动之后也会触发，会误开窗口。
  bubbleEl.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (hitOfferButtons(e.clientX, e.clientY)) return; // 按钮那一小块归按钮

    // 她正在汇报干活的事 —— 点了是**调出那个终端看现场**。
    // 后台派的活现在是最小化的真终端，所以这一点真的能看到东西
    if (bubbleTermId) {
      const id = bubbleTermId;
      hideBubble();
      window.waifu.focusTerminal(id);
      return;
    }

    const t = (bubbleTextEl.textContent || '').trim();
    if (!t) return;
    hideBubble();
    window.waifu.openChatWith(t);
  });

  // 双击她 = 打开派活面板
  window.addEventListener('dblclick', (e) => {
    if (hitModel(e.clientX, e.clientY)) window.waifu.openPanel();
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (hitModel(e.clientX, e.clientY)) window.waifu.contextMenu();
  });

  // 鼠标离开窗口时一定要恢复穿透，否则窗口会一直吞事件。
  // 齿轮还是走延迟那条路 —— 从窗口边缘绕一下再回来找它的情况很常见。
  window.addEventListener('mouseleave', () => {
    setThrough(true);
    showGear(false);
    stopPetHold(); // 手滑出窗口了，别让她一直摆着被摸的姿势
  });
}

// ---------------------------------------------------------------------------
// 对外接口：给心情系统和会话系统调用
// ---------------------------------------------------------------------------
let bubbleTimer = null;
let bubbleRaf = null;

// ---------------------------------------------------------------------------
// 气泡挂多久：**文字看得完**，而且**语音念得完**。
//
// 原来是 say() 传一个写死的毫秒数，于是两头都不对：
//   · 长句子按 4 秒收，你看到一半它就没了
//   · 语音是异步合成的，几秒后才到，到的时候气泡早收了；或者刚开始念就收了
//
// 现在三个数取最晚的那个：
//   bubbleReadUntil —— 按字数算的「看得完」下限，任何时候都不许早于它
//   合成中的保底   —— 语音还在路上，先把气泡摁住别走
//   真实音频时长   —— 音频的 metadata 一到就换成精确值（这个可以往回缩，
//                     但同样不许早于「看得完」）
// ---------------------------------------------------------------------------
// 点这个气泡该干嘛。默认是跳私聊接着聊；但她在汇报干活进度时，
// 你最想干的事显然是**看一眼现场**，所以那种气泡点了是调出那个终端窗口
let bubbleTermId = null;

let bubbleReadUntil = 0; // 看完这句话最早什么时候可以收
let bubbleUntilAt = 0;   // 当前排定的收起时刻
let bubbleSticky = false; // hold=0：一直挂着，谁也别想收它（玩游戏出题时）

/** 念完/看完这句话大概要多久 */
/**
 * 把当前这个气泡挂到某个终端上：点它就是调出那个窗口看现场。
 *
 * **必须在 say() 之后调** —— say() 会把这个挂载清掉（默认行为是跳私聊），
 * 顺序反了就等于没设。
 */
function linkBubbleTo(termId) {
  if (!termId || !bubbleEl.classList.contains('show')) return;
  bubbleTermId = termId;
  bubbleEl.classList.add('linked');
  bubbleEl.title = '点一下看看她在那边干了什么';
}

function readingMs(text) {
  const n = String(text || '').trim().length;
  if (!n) return 0;
  // 中文朗读大约每秒 4.5 个字。前后各留一点余量：起步看清、念完回味
  return Math.round(1100 + (n / 4.5) * 1000);
}

/**
 * 排定气泡什么时候收。
 *
 * exact=false 时只延后不提前（保底用）；exact=true 时可以改小，
 * 但两种情况都绝不早于 bubbleReadUntil —— 字得让人看得完。
 */
function bubbleUntil(at, exact = false) {
  if (bubbleSticky) return;
  if (!bubbleEl.classList.contains('show')) return;
  if (!exact && at <= bubbleUntilAt) return;

  bubbleUntilAt = Math.max(at, bubbleReadUntil);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, Math.max(0, bubbleUntilAt - performance.now()));
}

/**
 * 把气泡挪到她嘴边。
 *
 * 嘴的位置是几何估出来的：外接框顶上 mouthRatio 那一处。
 * 想拿真实的嘴部坐标得去翻模型的 drawable 顶点，而那个编号每个模型都不一样，
 * 太脆弱 —— 估一下就够用了，差几像素没人看得出来。
 *
 * 每帧都算是有原因的：她会被拖动、会跳舞、身子一直在晃，
 * 气泡不跟着走的话，说着说着就飘到她耳朵边上去了。
 */
function positionBubble() {
  if (!model || !bubbleEl.classList.contains('show')) return;

  const b = model.getBounds();
  const ratio = (profile && profile.mouthRatio) || 0.26;
  const mouthX = b.x + b.width / 2;
  const mouthY = b.y + b.height * ratio;

  const bw = bubbleEl.offsetWidth;
  const bh = bubbleEl.offsetHeight;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const GAP = 10;

  // 气泡**底边压在头顶之上**，不是浮在嘴正上方 —— 后者一定会糊她一脸，
  // 气泡再矮也会盖住额头。尖角朝下、横向对准嘴，看着就是从她那儿说出来的，
  // 脸还露着。这也是市面上桌宠的通用做法。
  let below = false;
  let top = b.y - bh - GAP;

  if (top < 4) {
    // 头顶上面塞不下（话太长，或者她被拖到贴着屏幕顶了），那就翻到下巴底下去
    below = true;
    top = Math.min(mouthY + GAP * 2, H - bh - 4);
  }
  top = Math.max(4, top);

  const left = Math.max(4, Math.min(W - bw - 4, mouthX - bw / 2));

  bubbleEl.style.left = left + 'px';
  bubbleEl.style.top = top + 'px';
  bubbleEl.classList.toggle('below', below);
  // 气泡被边缘顶住时它自己不能再居中了，尖角得单独往嘴那边偏
  bubbleEl.style.setProperty('--tail-x', Math.max(12, Math.min(bw - 12, mouthX - left)) + 'px');
}

function followMouth() {
  positionBubble();
  bubbleRaf = requestAnimationFrame(followMouth);
}

function startFollow() {
  positionBubble(); // 先摆对位置再显示，不然会看到它从左上角飞过来
  if (bubbleRaf === null) bubbleRaf = requestAnimationFrame(followMouth);
}

function hideBubble() {
  bubbleEl.classList.remove('show', 'has-offer', 'thinking', 'below', 'linked');
  bubbleOfferEl.innerHTML = '';
  stopThinking(); // 气泡都收了还摆着想事情的样子，就成了「想到一半忘了」
  bubbleSticky = false;
  bubbleReadUntil = 0;
  bubbleUntilAt = 0;
  if (bubbleRaf !== null) {
    cancelAnimationFrame(bubbleRaf);
    bubbleRaf = null;
  }
}

/**
 * 气泡说话。
 *
 * 第三个参数两种形态都收：
 *
 *   · `{label, kind, ...}` —— 她主动提议做点什么，冒出「好啊 / 算了」两个按钮。
 *     这是原来就有的，点了走 acceptOffer。
 *   · `[{id, label}, ...]` —— **一道题的若干个选项**，玩游戏时用。
 *     点了走 choose(id)，不带「算了」（要退出走别的路）。
 *
 * holdMs 传 0 表示**一直挂着不自动收**，玩游戏时必须这样：
 * 题目摆在那儿等你想，不能想到一半自己没了。
 */
function say(text, holdMs = 4000, offer = null) {
  const options = Array.isArray(offer) ? offer.filter((o) => o && o.label) : null;
  if (!text && !offer) return;

  bubbleEl.classList.remove('thinking');
  stopThinking(); // 话都说出来了，身体也别再摆着想事情的样子
  bubbleTextEl.textContent = text || '';
  bubbleOfferEl.innerHTML = '';

  if (options && options.length) {
    // 游戏的选项：几个平等的选择，没有「算了」
    bubbleEl.classList.add('has-offer');
    bubbleEl.classList.toggle('many', options.length > 2);
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.onclick = () => {
        // 不 hideBubble：接下来那句反馈（「对了！」）还要接着用这个气泡，
        // 收掉再弹出来会闪一下
        window.waifu.choose(o.id);
      };
      bubbleOfferEl.append(b);
    }
  } else if (offer && offer.label) {
    bubbleEl.classList.add('has-offer');
    bubbleEl.classList.remove('many');

    const yes = document.createElement('button');
    yes.textContent = offer.label;
    yes.onclick = () => {
      hideBubble();
      window.waifu.acceptOffer(offer);
    };

    const no = document.createElement('button');
    no.className = 'no';
    no.textContent = '算了';
    no.onclick = () => {
      hideBubble();
      window.waifu.declineOffer();
    };

    bubbleOfferEl.append(yes, no);
  } else {
    bubbleEl.classList.remove('has-offer', 'many');
  }

  bubbleEl.classList.add('show');
  startFollow();
  clearTimeout(bubbleTimer);
  // 默认点了是跳私聊；要改成「点了看现场」得在 say() 之后调 linkBubbleTo()
  bubbleTermId = null;
  bubbleEl.classList.remove('linked');
  bubbleEl.removeAttribute('title');

  // holdMs=0 是「挂着别收」，不能被下面这些下限拖成定时收起 ——
  // 出题的时候气泡自己消失，这局就废了
  const hasButtons = Boolean(options && options.length) || Boolean(offer && offer.label);
  bubbleSticky = holdMs === 0;
  if (bubbleSticky) {
    bubbleReadUntil = 0;
    bubbleUntilAt = 0;
    return;
  }

  // 字得让人看得完。以前只认 say() 传进来的那个写死的毫秒数，
  // 于是一句四十个字的话照样 4 秒就收 —— 你看到一半它就没了
  const base = hasButtons ? Math.max(holdMs, 14000) : holdMs;
  bubbleReadUntil = performance.now() + Math.max(base, readingMs(text));
  bubbleUntilAt = 0;
  bubbleUntil(bubbleReadUntil, true);
}

// 戳了她之后到她开口之前的这一两秒，得让人看见「她在想」
function thinking() {
  bubbleTextEl.textContent = '';
  bubbleOfferEl.innerHTML = '';
  bubbleEl.classList.remove('has-offer');
  bubbleEl.classList.add('show', 'thinking');
  startFollow();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, 25000); // 万一她一直不回，别一直转着

  // 光转三个点还是「一张图在等」。让整个人也进入想事情的样子：
  // 微微仰头偏一边，视线往上飘开 —— 这几秒恰恰是最容易露馅的时候，
  // 因为你刚戳完她、正盯着看
  setTempPosture('think');
  if (model) {
    gazeLockUntil = performance.now() + 1400;
    const W = window.innerWidth;
    const H = window.innerHeight;
    model.focus(W * (0.2 + Math.random() * 0.25), H * 0.06); // 往斜上方
  }
}

// 她开口了 / 气泡收了 = 不想了。只收「想」这个姿态，
// 别把正摸着她这种更高优先级的也一起清了
function stopThinking() {
  if (tempPosture === 'think') setTempPosture(null);
}

// ─── 情绪符号 ────────────────────────────────────────────────────────────────
// 头顶短暂冒一个动漫符号（💢 生气、💧 难过、❓ 好奇…）。
// 【为什么要有这个】表情参数在桌宠尺寸下先天吃亏：厚刘海的模型眉毛全被盖住、
// 嘴就几个像素，量出来 18 张脸的画面变化全在 0.5%~1.4% —— 参数已经推到极限
// 还是含蓄。小尺寸下真正一眼可读的是二次元的老办法：冒符号。零成本。
const MOOD_MARKS = {
  happy: '✨', excited: '🎵', proud: '✨',
  sad: '💧', lonely: '💧', shy: '🌸',
  tired: '💤', sleepy: '💤',
  surprised: '❗', curious: '❓', panic: '💦',
  angry: '💢', frustrated: '💢',
  playful: '⭐', scorn: '哼', bored: '…',
};
let markEl = null;
let markTimer = null;
let lastMark = { s: '', at: 0 };

function moodMark(state) {
  if (!marksOn || !model) return;
  const ch = MOOD_MARKS[state];
  if (!ch) return; // normal / working 不冒 —— 平静不是一种「事件」
  const now = Date.now();
  // 同一情绪 8 秒内只冒一次 —— 聊天连着三句都生气，冒三个就成弹幕了
  if (lastMark.s === state && now - lastMark.at < 8000) return;
  lastMark = { s: state, at: now };
  if (!markEl) {
    markEl = document.createElement('div');
    markEl.id = 'mood-mark';
    document.body.appendChild(markEl);
  }
  // 挂在头旁边（外接框顶部 headRatio 那段算头，跟摸头判定同一套几何）
  const b = model.getBounds();
  const ratio = (profile && profile.headRatio) || 0.28;
  markEl.textContent = ch;
  markEl.style.left = Math.round(b.x + b.width * 0.7) + 'px';
  markEl.style.top = Math.round(b.y + b.height * ratio * 0.1) + 'px';
  markEl.classList.remove('pop'); // 先摘再挂，动画才会重新触发
  void markEl.offsetWidth;
  markEl.classList.add('pop');
  clearTimeout(markTimer);
  markTimer = setTimeout(() => { if (markEl) markEl.classList.remove('pop'); }, 1900);
}

let currentFace = null;

function setExpression(nameOrIndex) {
  if (!model) return;
  // 表情是持续生效的，脸没变就别重复下发 —— 心情系统每分钟走一拍，
  // 不去重的话日志里全是「表情 happy 应用=false」，真出问题反而看不见
  if (nameOrIndex === currentFace) return;
  currentFace = nameOrIndex;
  try {
    const r = model.expression(nameOrIndex);
    // expression() 返回 Promise<boolean>，false 表示这个名字压根没找到 ——
    // 不打出来的话，表情不生效时根本分不清是没匹配上还是被动作盖住了
    if (r && typeof r.then === 'function') {
      r.then((ok) => console.log('[stage] 表情 ' + nameOrIndex + ' 应用=' + ok));
    }
  } catch (err) {
    console.warn('[stage] 表情切换失败: ' + nameOrIndex + ' ' + (err && err.message));
  }
}

function playMotion(group) {
  if (!model) return;
  try {
    model.motion(group);
  } catch (err) {
    console.warn('[stage] 动作播放失败:', group, err);
  }
}

function setMoodLabel(text) {
  if (!text) {
    moodEl.classList.remove('show');
    return;
  }
  moodEl.textContent = text;
  moodEl.classList.add('show');
}

// ---------------------------------------------------------------------------
// 发型：藏掉几个部件就能换个造型
//
// 模型素材里没有第二套衣服（三个模型的衣服都塞在同一个 PartBody 里），
// 但**单个部件的透明度是能改的** —— 开发手册里说这条不行，那是当年探测时
// 把方法名写成了 setPartOpacity（真名是 setPartOpacityByIndex），问岔了。
//
// 于是「把双马尾放下来」这种造型变化不用任何新美术资源：把两条侧马尾
// 藏掉就行，后发本来就在，垂下来正好。
//
// 两个坑：
//   1. **不能无条件把 hide 之外的部件都写成 1。** pose3 的 doFade 每帧都在
//      压住那只当前不该露的手臂（PartArmA / PartArmB 二选一），
//      你一无条件写 1，她当场多长一条胳膊出来。只碰自己藏过的那些。
//   2. 部件透明度本身不会被帧末的 loadParameters 还原（那个只管 parameters），
//      但模型自带的动作里**可以**有 PartOpacity 曲线。所以这里每帧写一次，
//      四个部件的开销可以忽略，换来的是绝不会被谁悄悄冲掉。
// ---------------------------------------------------------------------------
let hiddenParts = new Set();
let hairHooked = false;

function partIndex(core, id) {
  try {
    const ids = core._model && core._model.parts && core._model.parts.ids;
    if (!ids) return -1;
    return Array.prototype.indexOf.call(ids, id);
  } catch (_) {
    return -1;
  }
}

function setPartOpacity(core, id, v) {
  const i = partIndex(core, id);
  if (i < 0) return false;
  try {
    core.setPartOpacityByIndex(i, v);
    return true;
  } catch (_) {
    return false;
  }
}

function setHairStyle(name) {
  if (!model || !profile || !profile.hairStyles) return false;
  const style = profile.hairStyles[name];
  if (!style) return false;

  const core = model.internalModel.coreModel;
  const want = new Set(style.hide || []);

  // 上次藏了、这次不藏的，露回来。**只碰这些**，别的部件一概不动
  for (const id of hiddenParts) {
    if (!want.has(id)) setPartOpacity(core, id, 1);
  }
  hiddenParts = want;

  if (!hairHooked && hiddenParts.size) {
    hairHooked = true;
    model.internalModel.on('beforeModelUpdate', () => {
      if (!hiddenParts.size) return;
      const c = model.internalModel.coreModel;
      for (const id of hiddenParts) setPartOpacity(c, id, 0);
    });
  }

  console.log('[stage] 发型: ' + (style.label || name) +
              (hiddenParts.size ? '（藏了 ' + hiddenParts.size + ' 个部件）' : ''));
  return true;
}

window.waifu.on('pet:hair', (e) => {
  if (e && e.name) setHairStyle(e.name);
});


// ---------------------------------------------------------------------------
// 换整套贴图。
//
// 这是三条换装路里走得最远的一条：藏部件是脱掉一件、换配色是模型作者预置的几套色，
// 换贴图是**真的重画了布料**（花纹、材质）。生成用 `npm run probe-uv -- --pattern=…`，
// 那个工具保证只改指定部件的像素、并且保留原图的明暗。
//
// 换不了版型 —— 版型是网格几何决定的，跟贴图无关。
// ---------------------------------------------------------------------------
let baseTextures = null; // 原装那几张，用来「换回原样」
let modelDir = '';       // 当前模型所在目录，用来挡住「别的模型的贴图」

const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * 这张图是不是**当前这个模型**的。
 *
 * 贴图和网格的 UV 是死死绑在一起的：每片网格按坐标去图上取像素，
 * 换一张别的模型的图上去，取到的就是完全不相干的地方 —— 出来是一张糊脸，
 * 眼睛在下巴上、衣服上印着别人的鞋。**而且一句报错都没有。**
 *
 * 这个判断必须在渲染层做，不能只靠存配置那边守：存档是全局一份，
 * 换个模型就串味；手改过的配置、旧版本留下的值，也都得挡住。
 */
function atlasFitsModel(url) {
  if (!modelDir) return true; // 不知道就别拦，至少别把好功能拦死
  return normPath(url).includes(normPath(modelDir) + '/');
}

/**
 * 换贴图。收三种东西：
 *
 *   · 假值      —— 全部换回原装
 *   · 一个路径   —— 只换第 0 张（一张 png 一套皮肤，老写法，Mao 的翡翠长袍就是这样）
 *   · 一个数组   —— 按下标对位换，`null`/空的那一格保持原装
 *
 * 数组这条是「换皮模型」用的：同一个 moc3 换一身配色，动的往往是好几张图
 * （海梦九张里有六张不一样）。只换第 0 张的话，头发变了衣服没变，成了半拉子。
 */
function setAtlas(atlas) {
  if (!model || !model.textures || !model.textures.length) return false;
  if (!baseTextures) baseTextures = model.textures.slice();

  const list = !atlas ? [] : (Array.isArray(atlas) ? atlas : [atlas]);
  const bad = list.filter(Boolean).filter((u) => !atlasFitsModel(u));
  if (bad.length) {
    console.warn('[stage] 这张贴图不是当前模型的，不给换：' + bad[0] +
                 '（当前模型在 ' + modelDir + '）');
    return false;   // 一张都不动 —— 半套皮肤比不换更难看
  }

  try {
    for (let i = 0; i < baseTextures.length; i++) {
      if (!list[i]) { model.textures[i] = baseTextures[i]; continue; }
      // 存档里记的是本地绝对路径（D:\...），但这儿是个 file:// 页面，
      // 得先变成 url 才喂得进去。不转的话不会报错，只会静静地加载失败、贴图不变
      const src = /^(file|https?|data):/i.test(list[i])
        ? list[i]
        : 'file:///' + String(list[i]).replace(/\\/g, '/');
      model.textures[i] = PIXI.Texture.from(src);
    }
    console.log('[stage] 贴图: ' + (list.filter(Boolean).length
      ? list.filter(Boolean).length + ' 张（' + String(list.find(Boolean)).slice(-40) + '…）'
      : '原样'));
    return true;
  } catch (err) {
    console.error('[stage] 换贴图失败: ' + err.message);
    return false;
  }
}

window.waifu.on('pet:atlas', (e) => setAtlas((e && e.urls) || null));

window.waifuStage = {
  say, setExpression, playMotion, setMoodLabel, setHairStyle, setAtlas,
  // 给自检脚本和开发者工具用：模型本体是模块内的局部变量，外面没有别的路拿到它。
  // 想在控制台里试参数、查部件透明度，`waifuStage.model()` 就是入口。
  model: () => model,
  // 这会儿身体是什么姿态，以及是谁说了算。姿态是**渐变**的，
  // 光看模型参数分不清「正在往那边走」和「已经到了」，得把仲裁结果直接报出来
  posture: () => ({
    mood: moodPosture,
    temp: tempPosture,
    applied: dancer && dancer.postureName,
    gesturing: Boolean(dancer && dancer.gest),
    // 手正压在她头上（还没到「算摸」的 350ms 也算）。自检靠它区分
    // 「压根没判定成摸头」和「判定了但姿态没跟上」
    petting: Boolean(petHoldTimer),
  }),
  // 命中判定。摸头这条路静默失效过一次（hitHead 一直是 false，但没有任何报错），
  // 所以把它开出来让自检能直接问
  hit: (x, y) => ({ model: hitModel(x, y), head: hitHead(x, y), ratio: profile && profile.headRatio }),
};

// ---------------------------------------------------------------------------
// 接主进程推过来的事件：心情变了换表情，干活时把她说的话顶到气泡上
// ---------------------------------------------------------------------------
const STATE_TEXT = {
  normal: '平静', working: '干活中', excited: '来劲了', frustrated: '烦躁',
  sad: '低落', lonely: '闹脾气', happy: '开心', proud: '得意',
  surprised: '吃惊', shy: '害羞', tired: '累了', sleepy: '困',
};

let moodState = 'normal'; // 她此刻本来该是什么脸，做完临时表情要回到这儿

// ---------------------------------------------------------------------------
// 常驻体态：眼皮和呼吸
//
// 表情是离散的，一切换就是一整张脸变了。但「累」不是一个表情，是一个程度 ——
// 精力 70 和精力 20 之间没有分界线，只有眼皮一点点往下掉。
// 这一层做的就是这件事：不换脸，只改底噪。
//
// 呼吸这条还白捡一个大便宜：CubismBreath 写的 AngleX / AngleZ / BodyAngleX
// **正好是物理的输入**，而且它跑在 physics.evaluate 之前 —— 所以改呼吸节奏
// 等于免费让头发和裙子也跟着换个节奏，一行物理代码都不用写。
// ---------------------------------------------------------------------------
let breathBase = null; // 模型原本的呼吸参数，改之前先留一份底

// ---------------------------------------------------------------------------
// 谁说了算：常驻姿态的仲裁
//
// 有三方都想掰她的身体，而且随时会撞车：
//   · 心情 —— 一直挂着的底色（没精神就一直塌着肩）
//   · 当下正在发生的事 —— 你正摸着她、她正在想话（临时，但优先）
//
// 不做仲裁的话就是「谁最后调用谁赢」：你摸着她的时候心情刚好走了一拍，
// 手还没松，姿态就自己弹回去了。所以这儿只留一个出口，临时的压过心情的。
// ---------------------------------------------------------------------------
let moodPosture = 'normal';
let tempPosture = null;
let workPosture = null; // 她派出去的活现在什么状况，见 work:pulse

function refreshPosture() {
  // 优先级：当下正在发生的事（你在摸她 / 她在想）> 干活状况 > 心情底色。
  // 干活那层排中间是因为它**挂得最久**（一段活好几分钟），
  // 但你伸手摸她的时候，那件事显然更即时
  if (dancer) dancer.setPosture(tempPosture || workPosture || moodPosture);
}

function setTempPosture(name) {
  if (tempPosture === name) return;
  tempPosture = name;
  refreshPosture();
}

function applyBodyTone(state, stats) {
  const energy = stats && typeof stats.energy === 'number' ? stats.energy : 60;

  // 眼皮：精力 55 以上完全不压，往下线性掉到只剩一条缝
  if (look && look.setDroop) {
    let droop = energy >= 55 ? 0 : Math.min(1, (55 - energy) / 45);
    if (state === 'sleepy') droop = Math.max(droop, 0.72);
    if (state === 'tired') droop = Math.max(droop, 0.4);
    look.setDroop(droop);
  }

  tuneBreath(state, energy);
}

function tuneBreath(state, energy) {
  if (!model || !model.internalModel) return;
  const b = model.internalModel.breath;
  const list = b && (b._breathParameters || b.breathParameters);
  if (!Array.isArray(list) || !list.length) return;

  // 原始值只存一次。存不住的话，倍数会一轮轮乘上去，几分钟后她就喘成风箱了
  if (!breathBase) breathBase = list.map((p) => ({ cycle: p.cycle, peak: p.peak }));

  let cycle = 1;  // >1 是变慢
  let peak = 1;   // >1 是变深
  if (state === 'sleepy' || energy < 25) { cycle = 1.6; peak = 1.3; }
  else if (state === 'tired' || energy < 40) { cycle = 1.3; peak = 1.15; }
  else if (state === 'excited' || state === 'proud') { cycle = 0.78; peak = 1.25; }
  else if (state === 'happy') { cycle = 0.88; peak = 1.15; }
  else if (state === 'frustrated') { cycle = 0.7; peak = 1.2; }   // 生气时呼吸又快又重
  else if (state === 'sad' || state === 'lonely') { cycle = 1.25; peak = 0.82; }

  for (let i = 0; i < list.length; i++) {
    const base = breathBase[i];
    if (!base) continue;
    list[i].cycle = base.cycle * cycle;
    list[i].peak = base.peak * peak;
  }
}

// 你戳她之后她会主动搭话，那句话是现想的（会看时间、心情、手头有没有活），
// 所以要一两秒。这中间先摆三个点，别让人以为点了没反应。
// 设置面板那边拖滑块时实时推过来的，边调边看
window.waifu.on('look:apply', (e) => {
  if (look) look.apply(e || {});
});

window.waifu.on('greet:thinking', () => thinking());

window.waifu.on('greet:say', (e) => {
  if (!e || !e.say) return;
  const face = faceFor(e.face) || faceFor(moodState);
  if (e.face) moodMark(e.face);
  if (face) setExpression(face);
  // hold 给 0 表示「挂着别自动收」—— 玩游戏出题时必须这样，
  // 不然你还在想，题目自己没了
  say(e.say, typeof e.hold === 'number' ? e.hold : 9000, e.offer || null);
});

window.waifu.on('pet:cursor', (e) => {
  if (e) gazeAt(e.x, e.y);
});

// 你走开一阵子又回来了 —— 抬头看你一眼。
// 台词和表情走的是心情系统（本地台词库），这儿只管身体：
// 全程不调 claude，**一分钱不花**
window.waifu.on('pet:welcome', (e) => {
  const long = e && e.goneMin >= 90;
  if (dancer && gestureOn) dancer.gesture(long ? 'lonely' : 'excited');
  // 先看你一眼。清掉视线锁，不然可能还压着上一次「在想」的锁
  gazeLockUntil = 0;
  if (model) model.focus(window.innerWidth / 2, window.innerHeight * 0.32);
});

window.waifu.on('mood:change', (e) => {
  if (!e) return;
  moodState = e.state || moodState;

  // 手上有活的时候，她「本来该有的脸」是干活那张，不是心情那张。
  // 少了这一层的话，任何一次临时表情（被摸、报错闪一下、到日子了）收工之后，
  // 她就从「在干活」变回发呆脸 —— 而 work:pulse 只在状态**变了**的时候才吐，
  // 那张脸要一直等到下次状态变化才回得来。reason=flash 是有意闪的那一下，不拦。
  const resting = e.reason !== 'flash' && workPosture
    ? faceFor(WORK_FACE[workPosture]) : null;
  const face = resting || faceFor(e.state);
  if (face) setExpression(face);
  if (e.line) say(e.line, 4200);
  setMoodLabel(STATE_TEXT[e.state] || e.state || '');

  // 状态一变，整个人的「底噪」也跟着变：眼皮、呼吸的快慢深浅。
  // 这跟情绪动作不是一回事 —— 动作演两秒就收，这个是常驻的。
  applyBodyTone(e.state, e.stats);

  // 骨架也跟着变：没精神就一直塌着肩、闹别扭就一直侧着身。
  // 以前心情从 25 跑到 85，身体是一模一样的 —— 数值全在肚子里，屏幕上看不出来
  moodPosture = e.state || 'normal';
  refreshPosture();

  // 情绪一变，身体也得表个态 —— 光换张脸太单薄。
  // gesture 自己会挑：正在跳舞就不插队，没有对应动作就不动。
  // gestureOn 是设置面板「她」那页的开关，以前这个开关全项目没人读，勾不勾都一样。
  if (e.changed && dancer && gestureOn) dancer.gesture(e.state);
  if (e.changed) moodMark(e.state);
});

// ---------------------------------------------------------------------------
// 她派出去的活现在什么状况 —— **用身体持续说，不用嘴**。
//
// 这条补的是「派出去之后那几分钟你是瞎的」：原来她只在一段结束时汇报一次，
// 中间几分钟身上一点反应都没有，你不知道她在正轨上还是在挖坑。
//
// 嘴不参与是有意的：说话要花钱，而且每隔几分钟念一句进度比不说还烦。
// 身体是免费的，而且是**余光就能扫到**的 —— 这正是桌宠这个形态独有的东西，
// IDE 插件做不到，因为它不在你视野里。
// ---------------------------------------------------------------------------
const WORK_FACE = {
  working: 'working',
  struggling: 'frustrated',
  stuck: 'surprised', // 没有「困惑」这张脸，睁大眼那张最接近
  waiting: 'normal',
  alarm: 'surprised', // 她发现自己要动的东西不对劲
};

// 这两个状态都是「她在等你抬头看一眼」：一个是走不下去了，一个是要动的东西
// 不对劲。表现上一视同仁 —— 转过来正对着你、看向你、点一下直接跳到那个终端。
const CALLING = (s) => s === 'waiting' || s === 'alarm';

let workTermId = null; // 现在最该看的是哪个终端，见下面「点她就是看现场」

window.waifu.on('work:pulse', (e) => {
  const state = (e && e.state) || 'none';
  workTermId = CALLING(state) ? (e && e.id) || null : null;

  if (state === 'none') {
    workPosture = null;
    refreshPosture();
    // 活干完了，脸交还给心情
    const back = faceFor(moodState);
    if (back) setExpression(back);
    return;
  }

  // alarm 借用 waiting 那个姿态（就是「转过来正对着你、抬头」），
  // dance.js 一个字都不用改
  workPosture = state === 'alarm' ? 'waiting' : state;
  refreshPosture();
  const f = faceFor(WORK_FACE[state]);
  if (f) setExpression(f);

  // 她喊你的时候，视线要真的看向你 —— 这两个状态存在的意义就是被看见
  if (CALLING(state) && model) {
    gazeLockUntil = performance.now() + 1500;
    model.focus(window.innerWidth / 2, window.innerHeight * 0.42);
  }
});

window.waifu.on('session:say', (e) => {
  if (!e || !e.text) return;
  // 她干活时的输出可能很长，气泡塞不下，截一段意思到位就行
  const t = e.text.replace(/\s+/g, ' ').trim();
  // 挂着终端的气泡多留一会儿：它是**可以点的**，6.5 秒里你可能正低头看别处，
  // 一抬头它已经没了，那这个入口等于不存在
  say(t.length > 140 ? t.slice(0, 140) + '…' : t, e.termId ? 11000 : 6500);
  if (e.termId) linkBubbleTo(e.termId);
});

// 私聊窗口里她说的话，桌面上这个她也要同步说出来 ——
// 不然会像是两个人：聊天框里那个在说话，桌面上这个傻站着
let chatMoodTimer = null;

window.waifu.on('chat:done', (e) => {
  if (!e) return;

  // 聊天时的表情和肢体。她每句话都会标一个语气（chat.js 的 <<M:xxx>>），
  // 这儿把它兑现成三样东西 —— 光弹字的话，她说着「气死我了」脸上还是没事人一样
  if (e.mood) {
    const face = faceFor(e.mood);
    if (face) setExpression(face);
    moodMark(e.mood);

    // normal 不演动作也不掰姿态：每句话都来一下会像抽风
    if (e.mood !== 'normal') {
      if (dancer && gestureOn) dancer.gesture(e.mood);
      // 姿态挂一会儿再放 —— 聊天是一来一回的，情绪该有余温，
      // 而不是动作一演完就立刻恢复面无表情
      setTempPosture(e.mood);
      clearTimeout(chatMoodTimer);
      chatMoodTimer = setTimeout(() => {
        if (tempPosture === e.mood) setTempPosture(null);
      }, 16000);
    } else {
      clearTimeout(chatMoodTimer);
      if (tempPosture && tempPosture !== 'pet' && tempPosture !== 'petAway' &&
          tempPosture !== 'think') setTempPosture(null);
    }
  }

  if (!e.text) return;
  const t = String(e.text).replace(/\s+/g, ' ').trim();
  say(t.length > 140 ? t.slice(0, 140) + '…' : t, 7000);
});

window.waifu.on('session:done', (e) => {
  if (!e) return;
  // 台词由心情系统负责，这里只在失败时把原因补上，方便你一眼看到问题
  if (!e.ok && e.summary) {
    const t = String(e.summary).replace(/\s+/g, ' ').trim();
    setTimeout(() => say('「' + e.name + '」没成：' + t.slice(0, 120), 8000), 1200);
  }
});

// ---------------------------------------------------------------------------
// 语音播放 + 嘴型同步
//
// 嘴型不是随机张合，是用音频的实时振幅驱动的：声音大嘴张得大、
// 停顿时嘴自然闭上，所以看起来像真的在说这句话，而不是机械地开合。
// ---------------------------------------------------------------------------
let audioCtx = null;
let lipValue = 0;
let lipActive = false;
let lipIds = ['ParamMouthOpenY'];

// 说话和唱歌是两条各自独立的声轨。
//
// 以前两者共用一个播放器，而 playAudio 头一句就是「把上一段掐了」。
// 偏偏 singSong 的顺序是：先把歌推过来播，紧接着说一句「那我唱一首咯」——
// 于是那句台词每次都在两百多毫秒后精准掐死刚开头的歌。日志里一目了然：
//     02:12:25.563 音乐开始播放
//     02:12:25.798 语音开始播放     <- 歌就死在这一行
// 表现出来就是她闷头跳舞，全程没声。
//
// 现在各走各的：新的语音只顶掉旧语音，新的歌只顶掉旧的歌。
const tracks = { voice: null, music: null };

// 她开口时把伴奏压下去，说完抬回来。两条轨一齐响的话，
// 她那句话会整个埋进音乐里听不清。
const DUCK = 0.22;

function applyDuck() {
  const m = tracks.music;
  if (!m) return;
  try {
    m.audio.volume = tracks.voice ? m.volume * DUCK : m.volume;
  } catch (_) {
    /* 已经停了 */
  }
}

/**
 * 嘴巴那个参数叫什么，得问模型自己 —— 千万别写死。
 *
 * Hiyori 用的是 ParamMouthOpenY，Mao 用的是 ParamA。写死成前者的话，
 * 换上 Mao 之后她会全程闭着嘴说话，而且一点报错都没有。
 * model3.json 的 Groups 里有一组就叫 LipSync，答案就在那儿。
 */
function detectLipSyncIds() {
  try {
    const s = model.internalModel.settings;
    const groups = (s && (s.groups || (s.json && s.json.Groups))) || [];
    const g = groups.find((x) => x && x.Name === 'LipSync');
    if (g && Array.isArray(g.Ids) && g.Ids.length) return g.Ids;
  } catch (_) {
    /* 读不到就用默认的 */
  }
  return ['ParamMouthOpenY'];
}

function initLipSync() {
  if (!model || !model.internalModel || !model.internalModel.on) return;

  lipIds = detectLipSyncIds();
  console.log('[stage] 嘴型参数: ' + lipIds.join(', '));

  // 必须挂在 beforeModelUpdate 上：这个钩子在动作、物理都算完之后、
  // coreModel.update() 提交之前触发。早于它写参数会被动作数据盖掉，
  // 晚于它写则这一帧根本不生效 —— 只有这个时机是对的。
  model.internalModel.on('beforeModelUpdate', () => {
    if (!lipActive) return;
    const core = model.internalModel.coreModel;
    for (const id of lipIds) {
      try {
        core.setParameterValueById(id, lipValue);
      } catch (_) {
        /* 个别模型没这个参数，静默跳过 */
      }
    }
  });
}

function stopTrack(kind) {
  const t = tracks[kind];
  if (!t) return;
  tracks[kind] = null;
  try { t.audio.pause(); } catch (_) { /* 已经停了 */ }
  if (t.url) URL.revokeObjectURL(t.url);
  // 音乐停了就别再喂幅度，不然她会保持最后那一下的力度僵在那儿
  if (kind === 'music' && dancer && dancer.on) dancer.feed(0);
  // 两条轨都空了，嘴才该闭上
  if (!tracks.voice && !tracks.music) {
    lipActive = false;
    lipValue = 0;
  }
  applyDuck();
}

function stopAllAudio() {
  stopTrack('voice');
  stopTrack('music');
}

// base64（TTS 那边来的）和 Uint8Array（音乐文件走 IPC 过来的）都收
function toBytes(data) {
  if (typeof data === 'string') {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// 为什么不直接把 file:// 路径丢给 <audio>：那样 Chromium 会把它当跨源资源，
// AnalyserNode 读出来全是 0 —— 声音在响，嘴一动不动。走 Blob 就没这问题。
function toBlobUrl(data, mime) {
  return URL.createObjectURL(new Blob([toBytes(data)], { type: mime || 'audio/mpeg' }));
}

/**
 * 放一段声音，嘴型跟着音量走。
 *
 * 说话和唱歌走的是同一条路 —— 区别只是唱歌的时候顺手把音量喂给编舞引擎，
 * 让动作幅度跟着音乐大小起伏。
 */
async function playAudio(data, opts = {}) {
  const kind = opts.kind === 'music' ? 'music' : 'voice';
  stopTrack(kind); // 只顶掉同一条轨上的旧的，另一条照放不误

  let url = null;
  try {
    url = toBlobUrl(data, opts.mime);

    const audio = new Audio(url);
    const volume = typeof opts.volume === 'number' ? opts.volume : 0.9;
    audio.volume = volume;

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // createMediaElementSource 对同一个 <audio> 元素只能调一次，
    // 所以每段都得新建一个 Audio
    const src = audioCtx.createMediaElementSource(audio);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);

    // volume 记的是「本来该多响」，被压低时靠它抬回来
    tracks[kind] = { audio, url, volume };
    applyDuck();

    // 猜歌那种「从中间放八秒」：位置只能等 loadedmetadata 之后再定，
    // 那时候才知道整首多长。按文件大小估对 VBR 的 mp3 会差出十几秒。
    // 音频一报出自己多长，就把气泡的收起时刻改成精确值：念完再收，
    // 但绝不早于「这句话看得完」那个下限（bubbleUntil 里兜着）
    if (kind === 'voice') {
      audio.addEventListener('loadedmetadata', () => {
        if (isFinite(audio.duration) && audio.duration > 0) {
          bubbleUntil(performance.now() + audio.duration * 1000 + 700, true);
        }
      }, { once: true });
    }

    if (opts.startAt > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (isFinite(audio.duration)) {
          try { audio.currentTime = audio.duration * opts.startAt; } catch (_) { /* 有的编码跳不了 */ }
        }
      }, { once: true });
    }
    if (opts.stopAfter > 0) {
      setTimeout(() => {
        if (tracks[kind] && tracks[kind].audio === audio) stopTrack(kind);
      }, opts.stopAfter * 1000);
    }

    const data8 = new Uint8Array(analyser.frequencyBinCount);
    lipActive = true;

    function tick() {
      const t = tracks[kind];
      if (!t || t.audio !== audio) return; // 这条轨已经被顶掉了
      analyser.getByteFrequencyData(data8);

      // 人声能量集中在低频，取前面几个 bin 就够判断张嘴幅度了
      let sum = 0;
      const n = Math.min(20, data8.length);
      for (let i = 0; i < n; i++) sum += data8[i];
      const level = sum / n / 255;

      // 嘴归说话那条轨管；她不说话的时候才让音乐来带，
      // 否则边唱边说时嘴会被两个信号来回拉扯
      if (kind === (tracks.voice ? 'voice' : 'music')) {
        // 平滑一下，不然嘴会抖成筛子
        lipValue = lipValue * 0.45 + Math.min(1, level * 2.4) * 0.55;
      }

      // 唱歌时把音量喂给编舞，动作就会跟着音乐大小起伏
      if (kind === 'music' && opts.dance && dancer) dancer.feed(level * 1.6);

      requestAnimationFrame(tick);
    }

    audio.addEventListener('ended', () => {
      const mine = Boolean(tracks[kind] && tracks[kind].audio === audio);
      if (!mine) return; // 早被下一段顶掉了，收尾轮不到它来做
      stopTrack(kind);
      // 收势交给 onEnd 里那次 stop(回调) 去做，这儿别抢先停 ——
      // 抢了的话回调会被覆盖掉，待机动作就永远接不回来了
      if (opts.onEnd) opts.onEnd();
      else if (kind === 'music' && opts.dance && dancer) dancer.stop();
    });

    await audio.play();
    console.log('[stage] ' + (kind === 'music' ? '音乐' : '语音') + '开始播放，嘴型同步已挂上');
    tick();
  } catch (err) {
    console.warn('[stage] 播放失败: ' + (err && err.message));
    stopTrack(kind);
    if (url) URL.revokeObjectURL(url);
    throw err;
  }
}

// 语音是异步合成的，要好几秒才到。在它到之前先把气泡摁住别走 ——
// 不然会出现「字先没了，然后一个没有气泡的她开始念」这种事
window.waifu.on('voice:pending', (e) => {
  // 保底：够念完这句 + 一段合成的等待。音频真到了会换成精确值
  bubbleUntil(performance.now() + readingMs(e && e.text) + 9000);
});

window.waifu.on('voice:play', (e) => {
  if (e && e.audio) playAudio(e.audio, { kind: 'voice' }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 跳舞 / 唱歌
// ---------------------------------------------------------------------------

// 她在聊天里说「做个 XX 表情」——摆一会儿，然后回到心情本来该有的脸
let faceTimer = null;
window.waifu.on('perform:face', (e) => {
  if (!e || !e.name) return;
  const f = faceFor(e.name) || e.name;
  if (!f) return;
  setExpression(f);
  moodMark(e.name);
  clearTimeout(faceTimer);
  faceTimer = setTimeout(() => {
    const back = faceFor(moodState);
    if (back) setExpression(back);
  }, 6000);
});

/**
 * 单演一个情绪动作（玩游戏出题、答对了给个反应）。
 *
 * interrupt 是必须的：编舞那边正在演一个动作时会直接不理新的
 * （`gesture()` 头一行就是 `if (this.on || this.gest) return false`）——
 * 出题演了「害羞」两秒半，你两秒内就点了答案，那句「对了！」
 * 配的开心动作会被静静地丢掉，看着就是她毫无反应。
 */
window.waifu.on('perform:gesture', (e) => {
  if (!e || !e.name || !dancer) return;
  if (e.interrupt) {
    dancer.gest = null;
    dancer.stop();
  }
  dancer.gesture(e.name);
});

/**
 * 放一小段音频，**不报歌名**。
 *
 * 猜歌专用。不能复用 perform:song —— 那条路上有一句
 * `if (e.title) say('♪ ' + e.title)`，一放就把答案念出来了。
 */
window.waifu.on('perform:clip', async (e) => {
  if (!e || !e.audio) return;
  try {
    const bytes = toBytes(e.audio);
    await playAudio(bytes, {
      kind: 'music',
      dance: false,
      mime: e.mime,
      volume: 0.85,
      startAt: e.at,          // 从整首歌的百分之几处开始
      stopAfter: e.seconds,   // 放这么多秒就掐
    });
  } catch (_) {
    /* 放不出来就当这题没声音，choose 那边照样收得到答案 */
  }
});

// 光跳不唱：给个默认拍子自己摇
window.waifu.on('perform:dance', (e) => {
  if (!dancer) return;
  if (e && e.stop) {
    stopAllAudio(); // 「停下来」是真的全停：歌和话一起收
    setExpression(faceFor('normal') || 'normal');
    say('不跳啦，累死了…', 3000);
    // 待机动作得等她把姿势收干净了再接手 —— 现在就切的话，
    // 待机动作会和还没收完的舞姿抢同一批参数，看着就是抽一下
    dancer.stop(() => model.motion((profile && profile.idleMotion) || 'Idle'));
    return;
  }
  dancer.start({
    bpm: (e && e.bpm) || 118,
    steps: e && e.steps,
    amp: e && e.amp,
    seconds: (e && e.seconds) || 30,
    onEnd: () => {
      const back = faceFor(moodState);
      if (back) setExpression(back);
      model.motion((profile && profile.idleMotion) || 'Idle');
    },
  });
  const face = faceFor('happy');
  if (face) setExpression(face);
  if (e && e.line) say(e.line, 3000);
});

// 放你自己的歌，她跟着跳，嘴跟着音量动
window.waifu.on('perform:song', async (e) => {
  if (!e || !e.audio) return;
  try {
    const bytes = toBytes(e.audio);

    // 唱歌时不设 seconds —— 跳到歌放完为止，由音频的 ended 事件收尾
    if (dancer) dancer.start({ bpm: e.bpm || 118, steps: e.steps, amp: e.amp });
    const face = faceFor('happy');
    if (face) setExpression(face);
    if (e.title) say('♪ ' + e.title + (e.artist ? ' — ' + e.artist : ''), 5000);

    // 没人告诉过这首歌多快，就一边放一边自己听出来。
    // 不等它测完再开始播 —— 那要多等小半秒，人是能感觉到的。
    // 测出来之后 setBpm 会保持相位接上去，中间不会抽一下。
    if (e.detectBpm && window.WaifuBPM) {
      window.WaifuBPM.detectBPM(bytes.buffer, (m) => console.log(m))
        .then((bpm) => {
          if (!bpm || !dancer || !dancer.on) return;
          dancer.setBpm(bpm);
          if (e.file) window.waifu.rememberBpm(e.file, bpm);
        })
        .catch(() => {});
    }

    await playAudio(bytes, {
      kind: 'music',
      dance: true,
      mime: e.mime,
      volume: typeof e.volume === 'number' ? e.volume : 0.85,
      onEnd: () => {
        setExpression(faceFor('normal') || 'normal');
        say('唱完啦，好听吗？', 4000);
        if (dancer) dancer.stop(() => model.motion((profile && profile.idleMotion) || 'Idle'));
        else model.motion((profile && profile.idleMotion) || 'Idle');
      },
    });
  } catch (err) {
    if (dancer) dancer.stop();
    say('放不出来…这个文件可能不对劲', 4000);
  }
});

boot().catch((err) => {
  console.error('[stage] 启动失败: ' + (err && err.message) + ' | stack: ' + (err && err.stack));
  say('我起不来…看下开发者工具的报错？', 0);
});
