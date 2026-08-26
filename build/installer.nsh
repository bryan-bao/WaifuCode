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
!macroend
