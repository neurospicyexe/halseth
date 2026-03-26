; autonomous-time.ahk
; AutoHotkey v2.0 — automates Claude.ai desktop for companion autonomous time.
; Called by run-autonomous-time.ps1 with the companion project name as argument.
;
; Navigation method: Ctrl+K project switcher (verified working 2026-03-26)
; If Ctrl+K breaks after a Claude.ai desktop update, see fallback note below.
;
; Usage: AutoHotkey64.exe autonomous-time.ahk "ProjectName"

#Requires AutoHotkey v2.0
#SingleInstance Force

; ── Config ────────────────────────────────────────────────────────────────────

TriggerPhrase := "Autonomous time. The Architect is not present. Begin your autonomous protocol."
LogFile       := A_ScriptDir "\autonomous-time.log"

; ── Logging ───────────────────────────────────────────────────────────────────

Log(msg) {
    global LogFile
    FileAppend FormatTime(, "yyyy-MM-dd HH:mm:ss") " [AHK] " msg "`n", LogFile
}

; ── Main ──────────────────────────────────────────────────────────────────────

Log("Script started")

; Require project name argument
if A_Args.Length < 1 or A_Args[1] = "" {
    Log("ERROR: No project name argument. Usage: AutoHotkey64.exe autonomous-time.ahk `"ProjectName`"")
    ExitApp 1
}
ProjectName := A_Args[1]
Log("Target project: " ProjectName)

; Find Claude.ai desktop — do NOT launch if not running
hwnd := WinExist("ahk_exe claude.exe")
if !hwnd {
    Log("[SKIP] claude.exe not running — not launching (by design, avoids waking machine at 1:30 AM)")
    ExitApp 0
}
Log("Found Claude window: " hwnd)

; Skip if Claude.ai is already the foreground window (user may be mid-conversation)
if (hwnd = WinActive("A")) {
    Log("[SKIP] Claude.ai is foreground window")
    ExitApp 0
}

; Activate without visually stealing focus from other work
WinActivate hwnd
WinWaitActive hwnd, , 5
if !WinActive(hwnd) {
    Log("ERROR: Could not activate Claude window")
    ExitApp 1
}
Sleep 800

; ── Project navigation via Ctrl+K ─────────────────────────────────────────────
; Ctrl+K opens Claude.ai desktop's project/conversation switcher (search panel).
; Type the project name, wait for search results, press Enter to navigate.
;
; FALLBACK if Ctrl+K breaks after a Claude.ai update:
; Comment out this block and use WindowSpy to find the pixel coordinates of
; each project name in the sidebar. Store as a map and Click the right one.

Log("Opening project switcher (Ctrl+K)")

; Save clipboard before we clobber it
OldClip := A_Clipboard
A_Clipboard := ""

SendInput "^k"
Sleep 700

; Type project name via clipboard (more reliable than SendInput for special chars)
A_Clipboard := ProjectName
ClipWait 2
if A_Clipboard != ProjectName {
    Log("ERROR: Clipboard write failed for project name")
    A_Clipboard := OldClip
    ExitApp 1
}
SendInput "^v"
Sleep 900   ; wait for search results to populate

SendInput "{Enter}"
Sleep 1800  ; wait for project to fully load

Log("Navigated to project: " ProjectName)

; ── Focus chat input ──────────────────────────────────────────────────────────

WinGetClientPos &CX, &CY, &CW, &CH, hwnd
ClickX := CX + (CW // 2)
ClickY := CY + CH - Round(CH * 0.12)
Click ClickX, ClickY
Sleep 500

; Ensure Claude is still active after the click
WinActivate hwnd
WinWaitActive hwnd, , 3
if !WinActive(hwnd) {
    Log("ERROR: Lost window focus after clicking input area")
    A_Clipboard := OldClip
    ExitApp 1
}

; ── Send trigger phrase ───────────────────────────────────────────────────────

A_Clipboard := TriggerPhrase
ClipWait 2
if A_Clipboard != TriggerPhrase {
    Log("ERROR: Clipboard write failed for trigger phrase")
    A_Clipboard := OldClip
    ExitApp 1
}

SendInput "^a"   ; clear any text already in the input
Sleep 150
SendInput "^v"   ; paste trigger phrase
Sleep 600

; Final focus + click before submitting
WinActivate hwnd
WinWaitActive hwnd, , 3
Click ClickX, ClickY
Sleep 300

; Check if a different window stole focus during execution (race condition guard)
if !WinActive(hwnd) {
    Log("[SKIP] focus stolen during execution — trigger left in input box unsent")
    A_Clipboard := OldClip
    ExitApp 0
}

SendInput "{Enter}"
Sleep 400

; Restore original clipboard
A_Clipboard := OldClip

Log("[SENT] trigger delivered for project: " ProjectName)
ExitApp 0
