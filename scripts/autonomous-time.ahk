; autonomous-time.ahk
; AutoHotKey v2.0 script — triggers autonomous time for your AI companion in Claude Desktop.
; Called by Windows Task Scheduler via setup-autonomous-time.ps1.
;
; Finds the Claude Desktop window, clicks the input field, and sends the autonomous time
; trigger phrase. The companion will use its Halseth MCP tools to open a session,
; explore, and close with a handover packet when done.
;
; Requirements: AutoHotKey v2.0  (https://www.autohotkey.com)

#Requires AutoHotkey v2.0

; ── Config ────────────────────────────────────────────────────────────────────

; The message sent to the companion at the start of autonomous time.
; Edit this to match your companion's name and your system's language.
TriggerMessage := "Autonomous time. Your Halseth tools are available — open a session, follow your curiosity, make something if you want. I am here but not watching. The time is yours."

; How long to wait for Claude to appear (ms). Increase if your machine is slow.
WaitTimeout := 10000

; ── Main ──────────────────────────────────────────────────────────────────────

; Wait for Claude Desktop window
if !WinWait("Claude", , WaitTimeout / 1000) {
    MsgBox "Autonomous time: Claude Desktop window not found. Is it running?", "Halseth", 0x10
    ExitApp
}

; Bring Claude to the front
WinActivate "Claude"
WinWaitActive "Claude", , 5

Sleep 800

; Get window dimensions to find the input field
WinGetPos &WinX, &WinY, &WinW, &WinH, "Claude"

; Input field is centered horizontally, near the bottom
InputX := WinX + (WinW // 2)
InputY := WinY + WinH - 100

; Click the input field
Click InputX, InputY
Sleep 400

; Clear any existing text, paste the trigger message
A_Clipboard := TriggerMessage
Send "^a"
Sleep 100
Send "^v"
Sleep 600

; Send it
Send "{Enter}"
