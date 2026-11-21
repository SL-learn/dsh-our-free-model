; Node 及完整许可证随安装包分发；进程检查交给 Tauri 的标准安装器。
; 不按名称强杀进程、不删除其它服务的锁、不覆盖已有配置。

; PREINSTALL：清空模型清单 web 目录里的全部旧 .js bundle。
; 背景（2026-11-21）：NSIS 安装是累积式的，前端构建产物是内容哈希文件名
; （channels-D3icEJp-.js 等，每次构建改名），旧文件永远不会被覆盖，安装目录
; 只增不减（实测堆了 6+ 个死 bundle）。新构建的完整 .js 集合（app.js +
; 各 hash chunk）紧随本钩子由安装器写入，所以"先清后写"幂等且零误删风险；
; app.css / index.html / splash.html / assets.json 不带 .js 后缀、会被覆盖或保留。
; 极端情况（安装中途失败）下 web 目录会缺文件，重新运行安装器即自愈。
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  FindFirst $R0 $R1 "$INSTDIR\service\packages\standalone\web\*.js"
ofmJsSweep:
  StrCmp $R1 "" ofmJsSweepDone
  Delete "$INSTDIR\service\packages\standalone\web\$R1"
ofmJsSweepNext:
  FindNext $R0 $R1
  Goto ofmJsSweep
ofmJsSweepDone:
  FindClose $R0
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 运行数据（配置、账号等）现在存放在安装目录下的 data，不再使用用户目录。
  ; 历史数据由桌面程序首次启动时从 ~/.our-free-model 一次性迁移。
  CreateDirectory "$INSTDIR\data"
!macroend
