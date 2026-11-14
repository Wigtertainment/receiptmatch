!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"

  Var desktopShortcutCheckbox
  Var desktopShortcutState

  # Extend electron-builder's desktop shortcut condition so it still owns creation and removal.
  !undef isNoDesktopShortcut
  !define isNoDesktopShortcut `"" SkipReceiptMatchDesktopShortcut ""`
  !macro _SkipReceiptMatchDesktopShortcut _a _b _t _f
    ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
    StrCmp "$R9" "true" `${_t}`
    StrCmp "$desktopShortcutState" "${BST_CHECKED}" `${_f}` `${_t}`
  !macroend

  !macro customPageAfterChangeDir
    Page custom ShowDesktopShortcutPage SaveDesktopShortcutChoice

    Function ShowDesktopShortcutPage
      ${if} ${isUpdated}
        Abort
      ${endif}
      nsDialogs::Create 1018
      Pop $0
      ${if} $0 == "error"
        Abort
      ${endif}
      ${if} $LANGUAGE == 1031
        !insertmacro MUI_HEADER_TEXT "Verknüpfungen" "Wählen Sie, ob ReceiptMatch auf dem Desktop erscheinen soll."
        StrCpy $0 "Desktop-Verknüpfung erstellen"
      ${else}
        !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose whether to add ReceiptMatch to your desktop."
        StrCpy $0 "Create a desktop shortcut"
      ${endif}
      ${NSD_CreateCheckbox} 0 0 100% 16u "$0"
      Pop $desktopShortcutCheckbox
      ${if} $desktopShortcutState == "${BST_CHECKED}"
        ${NSD_Check} $desktopShortcutCheckbox
      ${endif}
      nsDialogs::Show
    FunctionEnd

    Function SaveDesktopShortcutChoice
      ${NSD_GetState} $desktopShortcutCheckbox $desktopShortcutState
    FunctionEnd
  !macroend
!endif
