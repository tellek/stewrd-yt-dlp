import type { PluginApi } from "stewrd-plugin-api";

export interface BinPaths {
  binDir: string;
  ytDlpExe: string;
  ffmpegExe: string;
  ffprobeExe: string;
}

export function resolveBinPaths(rootPath: string): BinPaths {
  const root = rootPath.replace(/[\\/]+$/, "");
  const binDir = `${root}\\bin`;
  return {
    binDir,
    ytDlpExe: `${binDir}\\yt-dlp.exe`,
    ffmpegExe: `${binDir}\\ffmpeg.exe`,
    ffprobeExe: `${binDir}\\ffprobe.exe`,
  };
}

// yt-dlp releases are date-based, e.g. "2024.08.06" or "2024.08.06.232710".
// Compares numeric dot-separated segments; a version with fewer segments is
// treated as having trailing zeros so "2024.08.06" == "2024.08.06.0".
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export function needsInstall(installed: string | null): boolean {
  return installed === null;
}

export function needsUpdate(installed: string | null, latest: string): boolean {
  if (installed === null) return false; // not-installed is a separate case, not an "update"
  return compareVersions(installed, latest) < 0;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}
interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

export interface ReleaseInfo {
  version: string;
  downloadUrl: string;
}

async function fetchLatestRelease(repo: string, assetPredicate: (name: string) => boolean, signal?: AbortSignal): Promise<ReleaseInfo> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { signal });
  if (!res.ok) throw new Error(`GitHub release lookup failed for ${repo}: ${res.status}`);
  const data = (await res.json()) as GitHubRelease;
  const asset = data.assets.find((a) => assetPredicate(a.name));
  if (!asset) throw new Error(`No matching release asset found for ${repo}`);
  return { version: data.tag_name, downloadUrl: asset.browser_download_url };
}

export function fetchLatestYtDlp(signal?: AbortSignal): Promise<ReleaseInfo> {
  return fetchLatestRelease("yt-dlp/yt-dlp", (name) => name === "yt-dlp.exe", signal);
}

export function fetchLatestFfmpeg(signal?: AbortSignal): Promise<ReleaseInfo> {
  return fetchLatestRelease("BtbN/FFmpeg-Builds", (name) => name === "ffmpeg-master-latest-win64-gpl.zip", signal);
}

// listDir on a not-yet-existing "bin\" folder may reject rather than return
// [] - either case means "not installed", never an unhandled rejection that
// would silently abort the startup check.
async function binDirEntries(api: PluginApi): Promise<{ name: string; isDir: boolean }[]> {
  try {
    return await api.fs.listDir("bin");
  } catch {
    return [];
  }
}

export async function isYtDlpInstalled(api: PluginApi): Promise<boolean> {
  const entries = await binDirEntries(api);
  return entries.some((e) => !e.isDir && e.name.toLowerCase() === "yt-dlp.exe");
}

export async function isFfmpegInstalled(api: PluginApi): Promise<boolean> {
  const entries = await binDirEntries(api);
  return entries.some((e) => !e.isDir && e.name.toLowerCase() === "ffmpeg.exe");
}

export async function getInstalledYtDlpVersion(api: PluginApi, ytDlpExe: string): Promise<string | null> {
  if (!(await isYtDlpInstalled(api))) return null;
  try {
    const result = await api.shell.exec(ytDlpExe, ["--version"]);
    if (result.code !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function ensureBinDir(api: PluginApi): Promise<void> {
  await api.fs.writeTextFile("bin/.keep", "");
  await api.fs.deleteFile("bin/.keep").catch(() => {});
}

// Downloads yt-dlp.exe (a bare exe - no archive) via PowerShell, with the
// url/paths passed through the env option (never string-interpolated into
// -Command) so an apostrophe anywhere in the install path can't break
// PowerShell's quoting.
export async function installYtDlp(api: PluginApi, paths: BinPaths, release: ReleaseInfo): Promise<void> {
  await ensureBinDir(api);
  const tempPath = `${paths.binDir}\\yt-dlp.download.tmp`;
  const result = await api.shell.exec(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:DL_URL -OutFile $env:DL_OUT",
    ],
    { env: { DL_URL: release.downloadUrl, DL_OUT: tempPath } },
  );
  if (result.code !== 0) throw new Error(`yt-dlp download failed: ${result.stderr}`);
  // api.fs paths are relative to the plugin's sandboxed data\ root, unlike
  // the absolute paths shell.exec needs - hence the literal "bin/..." here
  // rather than deriving one from `paths` (which holds absolute paths).
  await api.fs.renameFile("bin/yt-dlp.download.tmp", "bin/yt-dlp.exe");
}

// Ffmpeg ships only as a zip (BtbN/FFmpeg-Builds), never a bare exe - the
// single PowerShell command downloads it, extracts it, moves the two nested
// exes into bin\, then deletes the temp zip/extracted folder. Every path is
// passed through env for the same quoting-safety reason as installYtDlp.
export async function installFfmpeg(api: PluginApi, paths: BinPaths, release: ReleaseInfo): Promise<void> {
  await ensureBinDir(api);
  const tempZip = `${paths.binDir}\\ffmpeg.download.tmp.zip`;
  const extractDir = `${paths.binDir}\\ffmpeg-extract-tmp`;
  const command = [
    "$ProgressPreference='SilentlyContinue'",
    "Invoke-WebRequest -Uri $env:ZIP_URL -OutFile $env:ZIP_PATH",
    "Expand-Archive -LiteralPath $env:ZIP_PATH -DestinationPath $env:EXTRACT_DIR -Force",
    "Move-Item (Join-Path $env:EXTRACT_DIR '*\\bin\\ffmpeg.exe') $env:BIN_DIR -Force",
    "Move-Item (Join-Path $env:EXTRACT_DIR '*\\bin\\ffprobe.exe') $env:BIN_DIR -Force",
    "Remove-Item -LiteralPath $env:ZIP_PATH -Force",
    "Remove-Item -LiteralPath $env:EXTRACT_DIR -Recurse -Force",
  ].join("; ");
  const result = await api.shell.exec("powershell", ["-NoProfile", "-Command", command], {
    env: {
      ZIP_URL: release.downloadUrl,
      ZIP_PATH: tempZip,
      EXTRACT_DIR: extractDir,
      BIN_DIR: paths.binDir,
    },
  });
  if (result.code !== 0) throw new Error(`ffmpeg install failed: ${result.stderr}`);
}

// Kills the whole process tree, not just the direct pid - the host's
// kill_command only calls start_kill(), which on Windows doesn't reach
// child processes, and yt-dlp spawns ffmpeg as a subprocess for merges/HLS.
export async function killProcessTree(api: PluginApi, pid: number): Promise<void> {
  await api.shell.exec("taskkill", ["/F", "/T", "/PID", String(pid)]).catch(() => {});
}
