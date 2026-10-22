/**
 * Windows 顶层窗口枚举（零依赖，走 PowerShell + user32）。
 *
 * 目的：让「选择浏览器」能看见用户**实际打开的所有浏览器窗口**，
 * 而不只是那些碰巧开了调试端口的。用户看到的是「我开着的窗口」，这才符合直觉。
 */
const { execFile } = require('node:child_process')
const path = require('node:path')

function psPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

const SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public static List<string> Dump() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      int len = GetWindowTextW(h, sb, 512);
      if (len <= 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string title = sb.ToString().Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\'");
      list.Add(pid.ToString() + "|" + title);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
if (-not ("WinEnum" -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
$pidToName = @{}
Get-Process | ForEach-Object { $pidToName[$_.Id] = $_.ProcessName }
$out = @()
foreach ($row in [WinEnum]::Dump()) {
  $parts = $row.Split('|', 2)
  $procId = [int]$parts[0]
  $title = $parts[1]
  $name = $pidToName[$procId]
  if ($name -in @('msedge','chrome','brave','chromium')) {
    $out += [pscustomobject]@{ pid = $procId; process = $name; title = $title }
  }
}
$out | ConvertTo-Json -Compress
`

/** 列出所有浏览器顶层窗口 */
function listBrowserWindows(timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile(psPath(), ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        const s = String(stdout || '').trim()
        if (!s) return resolve([])
        try {
          const j = JSON.parse(s)
          return resolve(Array.isArray(j) ? j : [j])
        } catch { return resolve([]) }
      })
  })
}

module.exports = { listBrowserWindows }
