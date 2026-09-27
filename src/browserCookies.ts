import type { PluginApi } from "stewrd-plugin-api";

// Maps a Windows "UserChoice" ProgId (from the registry) to the browser name
// yt-dlp's --cookies-from-browser flag expects. Pure/testable - matches by
// prefix since Chrome/Edge/etc. append a random suffix to their ProgId on
// recent Windows versions (e.g. "ChromeHTML.ABC123").
const PROGID_PREFIXES: Array<[string, string]> = [
  ["chromehtml", "chrome"],
  ["msedgehtm", "edge"],
  ["firefoxurl", "firefox"],
  ["bravehtml", "brave"],
  ["operastable", "opera"],
  ["operagxstable", "opera"],
  ["vivaldihtm", "vivaldi"],
];

export function progIdToYtDlpBrowser(progId: string): string | null {
  const normalized = progId.trim().toLowerCase();
  const match = PROGID_PREFIXES.find(([prefix]) => normalized.startsWith(prefix));
  return match ? match[1] : null; // e.g. Internet Explorer's ProgId has no yt-dlp cookie support
}

// Reads the user's default-browser choice from the registry (Windows only -
// this plugin targets Windows, matching the rest of its shell/PowerShell
// usage) and maps it to a yt-dlp-recognized browser name.
export async function detectDefaultBrowser(api: PluginApi): Promise<string | null> {
  try {
    const result = await api.shell.exec("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
      "/v",
      "ProgId",
    ]);
    if (result.code !== 0) return null;
    const match = /ProgId\s+REG_SZ\s+(\S+)/.exec(result.stdout);
    if (!match) return null;
    return progIdToYtDlpBrowser(match[1]);
  } catch {
    return null;
  }
}

// Opens the default browser directly to YouTube so the user can log in (or
// confirm they already are) before this session starts using its cookies.
// "" as the first `start` arg avoids a quoting bug where `start` treats a
// quoted first argument as a window title instead of the URL.
export async function openDefaultBrowserAtYouTube(api: PluginApi): Promise<void> {
  await api.shell.exec("cmd", ["/c", "start", "", "https://www.youtube.com"]).catch(() => {});
}
