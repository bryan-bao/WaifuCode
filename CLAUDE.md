# WaifuCode 项目规则

## 文档：改完必须同步（最高优先级）

这个项目有两份文档，**分工不同，每次改动都要看一眼要不要补**：

| 文件 | 给谁看 | 什么时候必须更新 |
|---|---|---|
| `玩法说明.md` | **给用户看的** —— 她会什么、怎么玩、哪些花钱 | **只要用户能感觉到的行为变了，就必须补**（新互动、新反应、花钱变了、操作方式变了） |
| `docs/开发手册.md` | 给改代码的看 —— 实现、踩过的坑、为什么这么做 | 结构变了、踩了新坑、加了新自检 |
| `README.md` | **GitHub 门面** —— 简介、截图、快速开始 | 大功能上线、截图过时了才动；**别把实现细节写进去**，那些归开发手册 |

**规矩：**

1. 一轮改动做完，**在汇报之前**先问自己：用户能感觉到什么不一样？
   能感觉到的，就得进 `玩法说明.md`。
2. `玩法说明.md` 用**大白话**写，不出现函数名、文件名、参数名。
   它是「说明书」不是「技术文档」—— 判断标准是：不写代码的人能不能照着玩。
3. 每次更新把文件头部的「最后更新」日期改掉，并在末尾「更新记录」里加一行。
4. 新功能要标清楚**花不花钱**。这个项目里「她说什么」要调 claude、
   「她怎么动」不用，用户最关心的就是这条线在哪儿。

## 干活时的几条硬约束

- **终端那条链（`hooks/term-shell.js`）绝对不能传 `--setting-sources project`。**
  桌宠的 5 个 hook 是用户级的，加了这个参数监督会静默失效。
- **不做任何从音乐平台下载/抓取音频的功能。** 用户提过，已经明确拒绝并写进
  开发手册和玩法说明。只支持用户自己丢进 `music/` 的文件。
- **改完要跑自检。** 离线的那批几秒钟跑完，没有理由不跑：
  ```
  npm test && node tools/test-wiring.js && node tools/test-context.js
  node tools/test-posture.js && node tools/test-termlife.js && node tools/test-dance.js
  node tools/test-lanes.js             # 同目录多条线不许共用会话
  node tools/test-journal.js           # 流水里绝不许出现完整路径和密钥
  node tools/test-notes.js             # 小抄：你写的那半段不许动、参数里不许有 --setting-sources
  node tools/test-milestone.js         # 记日子：老存档不许被当成今天刚认识
  node tools/test-profiles.js          # 角色档案：表情名/动作组名对不上模型就红
  node tools/test-cost.js              # 算钱：单价、增量读不许重复计、半行不许算
  node tools/test-update.js            # 局域网更新：文件名名单=防穿越的全部、校验不过必删包
  node tools/test-agents.js            # codex 线：权限映射宁紧勿松、小抄拼 prompt、关窗去留
  npx electron tools/test-stage.js     # 真模型，约 1 分钟
  ```

- **`vendor/live2dcubismcore.min.js` 末尾那段兼容垫片，换 Core 的时候必须带上。**
  Core 6.0.1 把 `drawables.renderOrders` 挪到了 `model.renderOrders`，而
  pixi-live2d-display 打包的 Framework 还是 Cubism 4 时代的，每帧去读旧位置 →
  读到 undefined → **每帧抛一次 TypeError**。表现极具迷惑性：人还在、还会动，
  但自检里跟渲染沾边的断言成片地挂（视线、眼皮、藏部件），错误只在 renderer
  控制台里躺着一行 `Cannot read properties of undefined (reading '0')`。
  非用 6.0.1 不可的原因：Ren 是 moc3 v6，5.1.0 打不开它，而官方 SDK 从 5.1.0
  直接跳到 6.0.1，中间没有两头都占的版本。
- **换皮的模型不许当新角色收。** 同一个 moc3 换一身贴图（海梦那三种配色、
  Hiyori 的薄荷、官方那两只猫），是**一个角色的两身衣服**，不是两个角色。
  收成两份模型目录的话：设置里冒出两个同名同脸的人，十几 MB 的 moc3 和动作
  重复存一遍，每加一身还得再抄一份档案。放法是
  `models/<本体>/skins/<这身叫什么>/texture_NN.png`，号对着模型第几张贴图，
  没放的那号保持原装。`node tools/test-profiles.js` 第 7 节守着：
  **两个目录共用同一个 moc3 就报红。**
- **表情不许照名字猜，必须量。** 跑
  `npx electron tools/expression-sheet.js --model=…`，它把所有表情排成一张联络表，
  每张标一个 Δ（跟「不加表情」比画面差多少）。**Δ 0.0% 就是这张表情什么都没干。**
  海梦那七个 `expression1~7` 就是这么栽的：照名字配进 faceMap，脸从头到尾不动，
  日志里一个字都没有（**切表情失败是静默的**），量完才发现四个其实是「叉腰」。
  模型没有能用的表情就 `node tools/make-expressions.js <模型名>` 自己生成一套。
  **反过来也要防**：联络表的取景框取的是各张表情变化区域的并集，而「会动胳膊」
  的表情（海梦的 proud 是叉腰）会把框撑成全身，于是每张脸的 Δ 都被稀释成 0.3%、
  全被标成「几乎没变化」—— 量具自己把结论量反了。现在按面积中位数剔除离群的那张，
  改这块记得别退回去。
- **新加模型不许拍脑袋填 `headRatio` / `mouthRatio`**，跑
  `npx electron tools/probe-parts.js --face --model=...` 量。它还会报「人占画布
  纵向百分之几」——**超出 0%~100% 的模型别收**（构图、气泡、点击判定全按画布算）。
  改完 `src/profiles.js` 跑 `node tools/test-profiles.js`：表情名写错是**静默失效**，
  脸一直不变、日志里一个字都没有。
- **测「改代码页」这类东西，必须开独立窗口，绝不能用 `cmd /c`。**
  工具跑的 PowerShell **跟你的 Claude Code 共用同一个控制台**（`GetConsoleWindow()`
  拿得到句柄）。`chcp` 改的是整个控制台的属性 —— 你在 `cmd /c` 里跑一个设 936
  的脚本，**当场就把用户正在看的这个界面搞成乱码**。
  踩过一次：为了做「不还原」的对照组，直接 `cmd /c` 跑了个设 936 不还的 bat，
  用户界面立刻花了。正确做法是 `wt -w <名字> new-tab <脚本>` 开独立窗口，
  让脚本把结果写进文件，再去读那个文件。
- **改 `config.json` / `mood.json` 用 `node -e` 写，别用 PowerShell 的
  `Set-Content -Encoding utf8`。** PS 5.1 的那个带 BOM，而带 BOM 的 UTF-8 会让
  `JSON.parse` 抛错 → 被 `catch` 静默吞掉 → **整个文件退回默认值**，
  一句提示都没有。踩过一次，查了半天。（读取那边已经加了摘 BOM，但别再制造它。）
- **同一个目录现在可以开多个终端**（各问各的），但**同一条线只能有一个**。
  分线走 `--resume 主会话 --fork-session --session-id <我们发的>` ——
  三个开关能一起用是实测的，`--session-id` 那个尤其关键：**id 由我们定，
  「下次回到那条线」才有的谈**。改这块之前先跑 `tools/test-lanes.js`。
- **Windows 的 pid 是回收复用的，「pid 探测说活着」不能全信。** term-shell 一死，
  号码可能立刻发给别的进程，`process.kill(pid, 0)` 就一直误报「还活着」——
  面板上关掉的终端因此挂过好几分钟。判「窗口没了」现在是三条腿（都汇到
  `_windowGone`）：SIGHUP 临终报的 gone（亚秒）、pid 探测（3 秒）、
  心跳断超 16 秒且连三拍（pid 被顶号时唯一的出路）。改这块跑
  `node tools/test-termlife.js`，第 16 节守着。
- **别再假设「一个目录一个终端」。** 凡是按目录名 / 项目名找终端的代码都是错的，
  必须按 `id` 或 `laneId` 找。已经因此删掉过一个 `liveTerminalFor(name)`，
  它的兜底分支会在名字没匹配上时**随便返回一个正在跑的终端**。
- **新加一个 IPC 频道，必须同时加进 `src/preload.js` 的白名单。**
  不在名单上的频道 `on()` 会**静默返回空函数** —— 不报错、不警告、日志里也没有，
  表现就是「功能点了没反应」。一次加四个新频道全忘了加，四个功能全是死的，
  而 test-stage 全过（它用 mock-preload，没白名单，还直接调函数绕过了整条 IPC）。
  `npm run test:wiring` 就是专门守这个的，改完顺手跑一下。
- **凡是量「画面变了没」的地方，先把整套参数冻住。** 她一直在呼吸眨眼、物理一直在摆，
  不冻的话噪声底 3~6%，而你要量的信号可能才 1% —— 直接被淹掉，还会给出
  「变化遍布全身」的假象。只冻被测那一个不够，眨眼呼吸物理输出全都是参数。
  **但量表情时不能用这一招**：那个钩子挂在 `beforeModelUpdate` 上，而表情是在它
  **之前**应用的 —— 冻了就等于每张脸都被抹回中性，量出来一排一模一样，
  你还会以为「这个模型的表情根本没区别」。量表情要掐的是噪声源本身：
  `motionManager.stopAllMotions()` + `groups.idle = ''`（待机动作会自己再起来）、
  `eyeBlink/breath/physics/pose = undefined`、`updateFocus/updateNaturalMovements`
  覆盖成空函数（**鼠标静止 8 秒她会走神**），再把气泡藏掉（开场那句 3.2 秒后消失）。
  照抄 `tools/expression-sheet.js` 就行。
- **量「动作僵不僵硬」看加速度，不看速度。** 速度大只是快（甩头本来就快），
  **速度突变**才是肉眼读成「顿了一下」的东西。一次性动作的包络一律用
  `envelope(t, attack, release)`（两头套 ease），**别再写 `Math.min(1, t*4)` 那种直线**——
  直线的两头就是两个加速度尖峰。另外**动作演完不能当场撒手**：`cur` 带着
  0.055 秒惯性，还差一点没到中性，当场停就是把残余瞬间抹掉（实测每个动作的
  加速度峰值都正好落在它结束那一刻）。`tools/test-smooth.js` 第 7 节守着。
- **`capturePage()` 的位图尺寸不等于窗口尺寸**（按设备像素比出图）。拿窗口宽度
  去算 x/y 会全错，而且看着挺像那么回事。用 `img.getSize().width`。
- **写 Electron 自检时，窗口必须关掉后台节流**（`backgroundThrottling: false`）。
  不关的话被遮住/失焦时 rAF 会被掐到近乎停止，逐帧的断言就成了随机挂。
- **别在测试里写死「外接框往下 N%」当点击落点。** 待机动作一直在动她的头，
  用 `waifuStage.hit(x, y)` 扫出一个真命中的点。

- **codex 的权限映射永远不许产出 danger-full-access / --dangerously-bypass。**
  陪聊那条（chat/greet 的 codex 分支）prompt 必须走 stdin（参数表末尾的 '-'），
  多行文本不过命令行；`exec resume` 不认 -s，沙箱走 -c sandbox_mode=read-only。
  CLI 差异全收在 `src/agents.js`（term-shell 只按 `spec.agent` 分岔，窗口那套壳
  与 CLI 无关）；agents.js 只许用 node 自带模块 —— term-shell 是另起的 node
  进程 require 它的。`node tools/test-agents.js` 第 2 节守着映射。

## 花钱的边界（改之前先想清楚）

真实成本（翻了 43 小时日志量出来的，不是估的）：
主动搭话 **$0.0151/次**、私聊 **$0.0084/轮**。拆开是缓存写 56%、输出 40%、缓存读 3%。

**终端里那笔现在也算得出来了**（`src/cost.js`）—— 去读 Claude Code 自己写的会话记录，
按官方 API 单价折算。量级完全不同：一场长开发会话轻松几十美元，比上面那两笔高两个数量级。
改这块要记住两条：**会话 id 必须是我们自己发的**（不然会把用户自己开的窗口算到她头上），
**增量读不许重复计钱**（面板 3 秒问一次，重复一次账就翻倍）。两条都有自检守着。

所以：**省钱的主战场是让她少说、说短，不是换便宜模型**
（实测 Haiku 反而更贵：$0.0193 vs $0.0128，还慢 40 秒）。

跳舞、小游戏、摸头、姿态、视线这些**一分钱不花**，加这类功能不用犹豫。
