import type { PluginApi } from "stewrd-plugin-api";

// Maps a browser's process name (as seen in Get-Process) to the browser
// name yt-dlp's --cookies-from-browser flag expects. Pure/testable.
const PROCESS_NAME_TO_YTDLP: Record<string, string> = {
  chrome: "chrome",
  msedge: "edge",
  firefox: "firefox",
  brave: "brave",
  opera: "opera",
  vivaldi: "vivaldi",
};

export function processNameToYtDlpBrowser(processName: string): string | null {
  return PROCESS_NAME_TO_YTDLP[processName.trim().toLowerCase()] ?? null;
}

const BROWSER_PROCESS_NAMES = Object.keys(PROCESS_NAME_TO_YTDLP).join(",");

// Opens the user's default browser directly to YouTube (so they can confirm
// they're logged in), then detects which browser actually handled it by
// checking the real foreground window afterward - not the registry's
// "UserChoice" key, which can disagree with what Windows actually launches
// (observed: UserChoice reported Firefox while Chrome was the browser that
// visibly opened). Observing reality via GetForegroundWindow can't lie the
// way a stale/mismatched registry entry can.
export async function openDefaultBrowserAtYouTubeAndDetect(api: PluginApi): Promise<string | null> {
  await api.shell.exec("cmd", ["/c", "start", "", "https://www.youtube.com"]).catch(() => {});

  const script = [
    // Give the OS a moment to actually switch focus to the launched browser
    // before reading which window is in the foreground.
    "Start-Sleep -Milliseconds 900",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; " +
      "public class StewrdYtDlpWin32 { " +
      '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
      '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); }' +
      "'",
    "$hwnd = [StewrdYtDlpWin32]::GetForegroundWindow()",
    "$procId = 0",
    "[StewrdYtDlpWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null",
    "(Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName",
  ].join("; ");

  try {
    const result = await api.shell.exec("powershell", ["-NoProfile", "-Command", script]);
    if (result.code !== 0) return null;
    const name = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    return name ? processNameToYtDlpBrowser(name) : null;
  } catch {
    return null;
  }
}
