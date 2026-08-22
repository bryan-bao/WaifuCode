'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 渲染层跑在沙箱里，只能通过这座桥碰主进程。
// 暴露面刻意开得很窄 —— 桌宠没有理由需要完整的 Node 权限。
contextBridge.exposeInMainWorld('waifu', {
  // --- 角色窗口 ---
  setClickThrough: (through) => ipcRenderer.send('pet:set-click-through', through),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  interact: (kind) => ipcRenderer.send('pet:interact', kind),
  // 只要个反应、不要她开口的那些（拖动之类）。这条**永远不花钱**，
  // 跟 interact 分开就是为了让这件事在代码里一眼看得见。
  react: (kind) => ipcRenderer.send('pet:react', kind),
  // 点气泡：把她刚说的那句话带进私聊窗口接着聊
  openChatWith: (text) => ipcRenderer.send('chat:open-with', text),
  // 她提议做点什么，你点了「好啊」或者「算了」
  acceptOffer: (offer) => ipcRenderer.send('greet:accept', offer),
  declineOffer: () => ipcRenderer.send('greet:decline'),
  // 一起玩：气泡上那几个选项点了哪个。全程不调 claude，不花钱
  choose: (id) => ipcRenderer.send('play:choose', id),
  startPlay: (game) => ipcRenderer.send('play:start', game),
  stopPlay: () => ipcRenderer.send('play:stop'),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  getConfig: () => ipcRenderer.invoke('pet:get-config'),

  // --- 派活面板 ---
  openPanel: () => ipcRenderer.send('panel:open'),
  closePanel: () => ipcRenderer.send('panel:close'),
  // 收起来，不是关掉 —— 填好的目录和没派完的活都留着
  minimizePanel: () => ipcRenderer.send('panel:minimize'),
  pickFolder: () => ipcRenderer.invoke('panel:pick-folder'),

  dispatch: (opts) => ipcRenderer.invoke('session:dispatch', opts),
  openTerminal: (opts) => ipcRenderer.invoke('session:open-terminal', opts),
  listSessions: () => ipcRenderer.invoke('session:list'),
  listProjects: () => ipcRenderer.invoke('session:projects'),
  // 打开这个项目的小抄（她攒的，你能看能改能清）
  openNotes: (dir) => ipcRenderer.invoke('notes:open', dir),
  stopSession: (key) => ipcRenderer.invoke('session:stop', key),
  getMood: () => ipcRenderer.invoke('mood:get'),
  // 流水账：今天干了什么、花了多少。**问一句答一句，不是推送** ——
  // 所以下面那个 allowed 白名单不用动（它只管 on() 那条广播路）
  journalToday: () => ipcRenderer.invoke('journal:today'),
  journalTotals: () => ipcRenderer.invoke('journal:totals'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // --- 开着的终端 ---
  listTerminals: () => ipcRenderer.invoke('term:list'),
  focusTerminal: (id) => ipcRenderer.invoke('term:focus', id),
  forgetTerminal: (id) => ipcRenderer.invoke('term:forget', id),
  // 点「她动过的文件」里的一条，在资源管理器里定位到它
  revealFile: (file) => ipcRenderer.invoke('term:reveal', file),
  // 派活之前看一眼这个目录在哪个分支、有几个文件没提交
  projectStatus: (dir) => ipcRenderer.invoke('project:status', dir),
  // 「用谁来干」选的 CLI 没装 → 报错旁点「帮我装」，她 npm -g 装好了喊你
  installAgent: (agent) => ipcRenderer.invoke('agent:install', agent),

  // 面板上的「说明书」：打开随包带的功能手册
  openDocs: () => ipcRenderer.send('docs:open'),

  // --- 版本更新（局域网分发）---
  updateCheck: (src) => ipcRenderer.invoke('update:check', src),
  updateApply: () => ipcRenderer.invoke('update:apply'),

  // --- 设置 ---
  openSettings: () => ipcRenderer.send('settings:open'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  // 调外观时立刻推给桌宠预览，不用等保存 —— 看不到效果就没法调
  previewLook: (look) => ipcRenderer.send('settings:preview-look', look),
  tryVoice: (voice) => ipcRenderer.invoke('settings:try-voice', voice),

  // --- 私聊 ---
  openChat: () => ipcRenderer.send('chat:open'),
  closeChat: () => ipcRenderer.send('chat:close'),
  chatSend: (text) => ipcRenderer.invoke('chat:send', text),
  chatHistory: () => ipcRenderer.invoke('chat:history'),
  chatReset: () => ipcRenderer.invoke('chat:reset'),
  getPersona: () => ipcRenderer.invoke('persona:get'),
  savePersona: (p) => ipcRenderer.invoke('persona:save', p),

  // --- 唱跳 ---
  listSongs: () => ipcRenderer.invoke('perform:songs'),
  dance: (bpm) => ipcRenderer.invoke('perform:dance', bpm),
  sing: (file) => ipcRenderer.invoke('perform:sing', file),
  stopPerform: () => ipcRenderer.send('perform:stop'),
  openMusicFolder: () => ipcRenderer.send('perform:open-music'),
  // 听出这首歌多快之后回报一声，下次就不用再听了
  rememberBpm: (file, bpm) => ipcRenderer.send('perform:bpm', { file, bpm }),

  // --- 主进程推过来的事件 ---
  // 只转发白名单频道，避免渲染层能监听任意 IPC
  on: (channel, cb) => {
    const allowed = [
      'mood:change',
      'session:start',
      'session:tool',
      'session:trouble',
      'session:say',
      'session:done',
      'voice:play',
      'term:change',
      'term:report',
      'agent:install-done', // 「帮我装」装完了（成没成都吱一声）
      'update:available',   // 探到新版了（面板把版本号变成更新按钮）
      'chat:delta',
      'chat:done',
      'chat:error',
      'perform:dance',
      'perform:song',
      'perform:face',
      'greet:thinking',
      'greet:say',
      'look:apply',
      'pet:cursor',
      'pet:hair',
      'pet:atlas',     // 换整套贴图
      'pet:welcome',   // 你走开一阵子回来了
      'work:pulse',    // 派出去的活现在什么状况（持续，用身体表达）
      'voice:pending', // 语音在合成路上，先把气泡摁住别走
      'perform:gesture',
      'perform:clip',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
