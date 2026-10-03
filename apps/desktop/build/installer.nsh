; Generated resource path budget is checked before extraction. NSIS extraction
; cannot safely materialize this application's resources beyond MAX_PATH.
!include "${__FILEDIR__}\service-path-limits.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  !define MUI_DIRECTORYPAGE_TEXT_TOP "请选择较短的安装目录，以确保课堂资源能够完整解压。过长的路径无法继续安装。"

  Function .onVerifyInstDir
    ; electron-builder may append APP_FILENAME after the directory page.
    ; Reserve that suffix so its sanitization cannot invalidate the budget.
    StrLen $R0 $INSTDIR
    StrLen $R1 "${APP_FILENAME}"
    IntOp $R0 $R0 + $R1
    IntOp $R0 $R0 + 1
    ${If} $R0 > ${SEW_MAX_INSTALL_DIR_LENGTH}
      SetErrors
    ${EndIf}
  FunctionEnd

  !macro customInit
    ; /D sets the complete path for silent installation and has no page.
    ${If} ${Silent}
      StrLen $R0 $INSTDIR
      ${If} $R0 > ${SEW_MAX_INSTALL_DIR_LENGTH}
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !macroend
!endif
