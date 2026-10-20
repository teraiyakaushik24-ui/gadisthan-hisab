Set WshShell = CreateObject("WScript.Shell")
strPath = WshShell.CurrentDirectory
WshShell.Run chr(34) & strPath & "\Launch_HISAB.bat" & Chr(34), 0
Set WshShell = Nothing
