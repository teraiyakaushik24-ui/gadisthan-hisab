Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = currentDir

' Find node executable
nodeExe = "node"
If fso.FileExists(currentDir & "\node.exe") Then
    nodeExe = """" & currentDir & "\node.exe"""
ElseIf fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = """C:\Program Files\nodejs\node.exe"""
ElseIf fso.FileExists("C:\Program Files (x86)\nodejs\node.exe") Then
    nodeExe = """C:\Program Files (x86)\nodejs\node.exe"""
End If

' Check if port 3000 is already active
Set objExec = WshShell.Exec("netstat -ano")
strOut = objExec.StdOut.ReadAll()

If InStr(strOut, ":3000") = 0 Then
    ' Start node server hidden (0 = no console window)
    WshShell.Run nodeExe & " server.js", 0, False
    WScript.Sleep 3000
End If

' Find Google Chrome or fallback to default browser
chrome1 = "C:\Program Files\Google\Chrome\Application\chrome.exe"
chrome2 = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
chrome3 = WshShell.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe"

If fso.FileExists(chrome1) Then
    WshShell.Run """" & chrome1 & """ http://localhost:3000"
ElseIf fso.FileExists(chrome2) Then
    WshShell.Run """" & chrome2 & """ http://localhost:3000"
ElseIf fso.FileExists(chrome3) Then
    WshShell.Run """" & chrome3 & """ http://localhost:3000"
Else
    WshShell.Run "http://localhost:3000"
End If
