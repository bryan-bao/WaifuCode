; 自定义「应用还在跑」的处理 —— 顶掉 electron-builder 默认那套。
;
; 默认那套的死穴（2026-08-26 实机踩过）：先温柔 taskkill（对托盘应用无效），
; 再 /f 强杀后**零间隔**就复查，Electron 四个进程收尸没那么快 → 误判「关不掉」
; → 弹「WaifuCode 无法关闭，请手动关闭后重试」，老版本的进程要是僵在错误框
; 后面，重试就永远失败。
;
; 桌宠没有「没保存的文档」这回事，直接请走最省事：温柔一刀（给它机会自己
; 收尾）→ 等一秒 → 强杀两刀（间隔留足收尸时间）→ 继续装，**永不弹框**。
; 安装器/卸载器自己的文件名不是 WaifuCode.exe（IMAGENAME 是精确匹配），
; 不会误伤自己。
!macro customCheckAppRunning
  nsExec::Exec `taskkill /im "${APP_EXECUTABLE_FILENAME}"`
  Sleep 1000
  nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Sleep 1200
  nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Sleep 600
  ; 动手换文件之前，把旧版的 package.json 抄一张条子进 data ——
  ; 新版第一次启动靠它知道「你是从哪个版本升上来的」（老版本 0.1.x 的
  ; 存档里没记 seenVersion，没这张条子的话升级说明弹窗一声不吭）
  CreateDirectory "$INSTDIR\data"
  CopyFiles /SILENT "$INSTDIR\resources\app\package.json" "$INSTDIR\data\prev-app-package.json"
  ; 【最关键的一步：把 data 整个备份出去。】升级时 electron-builder 会去
  ; 执行**旧版装的那个卸载器**（从注册表翻出来的老程序），它的收尾是
  ; RMDir /r $INSTDIR —— 用户的存档/记忆/流水/配置连锅端，升级一次失忆
  ; 一次（金丝雀实测阵亡两轮才定位到是旧卸载器干的）。旧卸载器改不了，
  ; 只能先把 data 挪到安装器自己的临时目录，装完（customInstall）再放回。
  ; 临时目录在系统盘，data 里有音乐会短暂占一点空间，装完自动清。
  CreateDirectory "$PLUGINSDIR\keep"
  CopyFiles /SILENT "$INSTDIR\data" "$PLUGINSDIR\keep"
!macroend

; 装完把备份的 data 放回去（配合上面那步。旧卸载器把 $INSTDIR 端掉之后，
; 新文件铺完这里第一时间还原 —— 用户数据全程没离开过这台机器）
!macro customInstall
  ${If} ${FileExists} "$PLUGINSDIR\keep\data"
    CopyFiles /SILENT "$PLUGINSDIR\keep\data" "$INSTDIR"
  ${EndIf}
!macroend

; 顶掉默认的「删旧文件」（这份只保得住**由这版及之后的安装器**装出来的机器：
; 升级时跑的是旧版的卸载器，那头没这段。所以上面才要备份-还原兜底）——
; 默认是 RMDir /r $INSTDIR 连锅端。只删应用自己的东西，data 永远不碰；
; 真卸载也留着，想清干净的用户手动删文件夹就是。
!macro customRemoveFiles
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*"
!macroend
