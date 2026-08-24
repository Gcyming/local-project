; installer.nsh — 自定义 NSIS 安装选项（electron-builder include）
; 1) 安装向导追加「开机自启」复选框；勾选则写入 HKCU Run 注册表。
;    页面放在「选择安装目录之后、开始安装之前」（customPageAfterChangeDir），
;    而不是 customHeader（后者在 assistedInstaller.nsh 的完成页之后声明，
;    表现为「点完成启动 Slime 后又弹自启询问」——用户反馈的糟糕体验）。
;    装到哪里（allowToChangeInstallationDirectory）与快捷方式（createDesktop/StartMenuShortcut）
;    由 electron-builder 原生向导提供，此处仅补充开机自启。
; 2) 卸载器：用「自定义卸载欢迎页（勾选框）」取代 electron-builder 默认卸载欢迎页，
;    让用户在同一页选择「是否删除用户数据」，替代原先卸载时弹 MessageBox 询问。
;    customUnWelcomePage 注册在 MUI_UNPAGE_WELCOME 处（卸载 INSTFILES=卸载段执行之前），
;    因此用户先勾选 → 点下一步 → 卸载段才按勾选结果删除/保留数据。

!include "nsDialogs.nsh"

Var slimeAutostartCheck
!ifdef BUILD_UNINSTALLER
Var slimeDeleteDataCheck
Var slimeDeleteData
!endif

!macro customPageAfterChangeDir
  Page custom nsslimeStartupPage nsslimeStartupLeave
!macroend

!macro customUnWelcomePage
  UninstPage custom un.slimeUninstallCheckPage un.slimeUninstallCheckLeave
!macroend

!macro customUnInstall
  ; 卸载时清理开机自启项
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Slime"
  ; 按用户在卸载勾选页的选择删除用户数据（仅勾选「删除」时执行，默认保留）
  ${if} $slimeDeleteData == "1"
    ; 删除用户数据目录
    RMDir /r "$APPDATA\slime-gui"
    ; 删除本地数据目录（Local\Programs\Slime 下的 slime-data）
    RMDir /r "$LOCALAPPDATA\slime-gui"
  ${endif}
!macroend

; NSIS 不把 Page custom 注册计为函数引用，会导致仅安装期使用的页面回调
; 报 warning 6010（install function not referenced），而 electron-builder 以 -WX 将警告视为错误。
; 用 pragma 对安装页函数区间抑制。卸载页函数用 !ifdef BUILD_UNINSTALLER 包裹——
; 只在卸载器构建中定义，避免在安装器构建里被当作「未用 WriteUninstaller 的卸载代码」报 6020。
!pragma warning disable 6010
Function nsslimeStartupPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 20u "让 Slime 随系统启动时自动运行？"
  ${NSD_CreateCheckbox} 0 30u 100% 30u "开机自动启动 Slime"
  Pop $slimeAutostartCheck
  ; 默认不勾选（保持克制）
  nsDialogs::Show
FunctionEnd

Function nsslimeStartupLeave
  ${NSD_GetState} $slimeAutostartCheck $0
  StrCmp $0 ${BST_CHECKED} 0 +3
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Slime" '"$INSTDIR\Slime.exe"'
  Goto +2
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Slime"
FunctionEnd
!pragma warning default 6010

!ifdef BUILD_UNINSTALLER
Function un.slimeUninstallCheckPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "卸载 Slime 前，请选择您希望如何处理用户数据："
  ${NSD_CreateCheckbox} 0 32u 100% 30u "删除用户数据（API 密钥、Agent、会话历史）"
  Pop $slimeDeleteDataCheck
  ${NSD_CreateLabel} 0 72u 100% 48u "取消勾选将保留数据，下次安装可恢复。$\n勾选将彻底清空，重装后为全新环境。"
  ; 默认不勾选（保留数据，更安全）
  nsDialogs::Show
FunctionEnd

Function un.slimeUninstallCheckLeave
  StrCpy $slimeDeleteData "0"
  ${NSD_GetState} $slimeDeleteDataCheck $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $slimeDeleteData "1"
  ${EndIf}
FunctionEnd
!endif