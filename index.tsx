/// <reference path="../.stewrd/plugin-api.d.ts" />
import { useEffect, useState } from "react";
import type { PluginContext, PluginApi } from "stewrd-plugin-api";
import { loadSettings, type YtDlpSettings } from "./src/settings";
import {
  addToQueue,
  removeFromQueue,
  resetInterruptedItems,
  nextQueuedItem,
  reorderQueue,
  updateItem,
  splitLines,
  parseDownloadProgressLine,
  isPostProcessingLine,
  ProgressTracker,
  estimateStreamCount,
  buildArgs,
  type QueueItem,
} from "./src/queue";
import {
  resolveBinPaths,
  isYtDlpInstalled,
  isFfmpegInstalled,
  getInstalledYtDlpVersion,
  fetchLatestYtDlp,
  fetchLatestFfmpeg,
  needsInstall,
  needsUpdate,
  installYtDlp,
  installFfmpeg,
  killProcessTree,
  type BinPaths,
} from "./src/ytdlp";
import { openDefaultBrowserAtYouTubeAndDetect } from "./src/browserCookies";
import anonymousIcon from "./icons/anonymous.png";
import mp3Icon from "./icons/mp3.png";
import mp4Icon from "./icons/mp4.png";
import mkvIcon from "./icons/mkv.png";

// api.ui.TextBox is a <textarea> with a hardcoded `resize: vertical` inline
// style and no prop to override it - a scoped CSS override (same
// inject-once pattern stewrd-terminal uses for its xterm CSS) is the only
// way to make the single-line Output Folder / Paste A Video URL boxes
// non-resizable, since inline styles can only be beaten by an !important
// rule, not another inline style from the plugin side.
const NO_RESIZE_CLASS = "stewrd-yt-dlp-no-resize";
function injectNoResizeCssOnce() {
  if (document.getElementById("stewrd-yt-dlp-no-resize-css")) return;
  const style = document.createElement("style");
  style.id = "stewrd-yt-dlp-no-resize-css";
  style.textContent = `.${NO_RESIZE_CLASS} textarea { resize: none !important; }`;
  document.head.appendChild(style);
}

// --- module-scope runtime state ---------------------------------------
// Lives here (not inside Component) so processing keeps running whether or
// not the plugin's pane is mounted - this is why plugin.json sets
// background: true. Component only subscribes for rendering.

interface PersistedState {
  queue: QueueItem[];
  outputDirectory: string;
}

const STATE_FILE = "queue-state.json";

let queue: QueueItem[] = [];
let outputDirectory = "";
let archivePath = "download-archive.txt";
let currentSettings: YtDlpSettings | null = null;
let banner: { tone: "warning" | "error" | "success"; message: string } | null = null;
let ytdlpAvailable = false;
let ffmpegAvailable = false;
let processing = false;
let installing = false;
let activeChild: { pid: number } | null = null;

// Set only via the "Use Browser Cookies" button, never persisted to disk -
// resets to null on every app restart, matching "for the rest of this
// session" rather than a settings.json preference.
let sessionCookiesBrowser: string | null = null;
let selectedMergeFormat: string | null = null;
let detectingBrowser = false;

// Captured once in activate() so UI-driven actions (add/remove/reorder from
// Component) can persist state and (re)kick the processing loop themselves,
// not just the code paths that already had a ctx/api in scope.
let hostApi: PluginApi | null = null;
let hostCtx: PluginContext | null = null;
let hostPaths: BinPaths | null = null;
let hostOwnerId = "";

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((fn) => fn());
}

// Synchronous in-memory owner token shared across a hot-reload (the old and
// new plugin module instances share the same webview window/globalThis).
// Only the instance whose id matches this token is allowed to touch queue
// state or talk to the host apis - this covers the gap where the host
// awaits the new activate() to completion before tearing the old one down.
declare global {
  // eslint-disable-next-line no-var
  var __stewrdYtDlpOwner: string | undefined;
}

function isOwner(myId: string): boolean {
  return globalThis.__stewrdYtDlpOwner === myId;
}

async function loadState(api: PluginApi): Promise<PersistedState> {
  // Checked via listDir first (not just try/catch around readTextFile) so a
  // brand-new install's expected "file doesn't exist yet" case doesn't log
  // a host-side file-read error on every first run.
  try {
    const entries = await api.fs.listDir();
    if (!entries.some((e) => !e.isDir && e.name === STATE_FILE)) return { queue: [], outputDirectory: "" };
    const raw = await api.fs.readTextFile(STATE_FILE);
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return { queue: Array.isArray(parsed.queue) ? parsed.queue : [], outputDirectory: parsed.outputDirectory ?? "" };
  } catch {
    return { queue: [], outputDirectory: "" };
  }
}

async function saveState(api: PluginApi, myId: string): Promise<void> {
  if (!isOwner(myId)) return;
  const state: PersistedState = { queue, outputDirectory };
  await api.fs.writeTextFile(STATE_FILE, JSON.stringify(state)).catch(() => {});
}

async function defaultDownloadsDir(api: PluginApi): Promise<string> {
  try {
    const result = await api.shell.exec("cmd", ["/c", "echo %USERPROFILE%\\Downloads"]);
    const dir = result.stdout.trim();
    if (dir && !dir.includes("%")) return dir;
  } catch {
    // fall through to a relative fallback below
  }
  return "Downloads";
}

function setQueue(next: QueueItem[]) {
  queue = next;
  notify();
}

// Fire-and-forget persistence + processing-loop kick for any UI-driven queue
// mutation (add/remove/reorder) - the loop only drives itself forward while
// it's already running, so adding to an empty/exhausted queue needs an
// explicit restart, and every mutation needs to reach queue-state.json or
// it's lost the next time the app restarts.
function persistAndKick() {
  if (!hostApi || !hostCtx || !hostPaths || !hostOwnerId) return;
  saveState(hostApi, hostOwnerId);
  if (!processing) runProcessingLoop(hostApi, hostCtx, hostOwnerId, hostPaths);
}

function setBanner(next: typeof banner) {
  banner = next;
  notify();
}

function safeLog(api: PluginApi, ctx: PluginContext, level: "info" | "warn" | "error", msg: string) {
  if (ctx.signal.aborted) return;
  try {
    api.log[level](msg);
  } catch {
    // thrown after hot-reload/deactivation - safe to ignore
  }
}

function safeStatus(api: PluginApi, ctx: PluginContext, color: "idle" | "in-progress" | "success" | "warning" | "error") {
  if (ctx.signal.aborted) return;
  try {
    api.statusIcon.set(color);
  } catch {
    // silent no-op before the sidebar entry exists, or thrown post-deactivation
  }
}

// --- binary install/update -------------------------------------------

async function ensureBinariesInstalled(api: PluginApi, ctx: PluginContext, myId: string, paths: BinPaths): Promise<boolean> {
  const ytInstalled = await isYtDlpInstalled(api);
  const ffInstalled = await isFfmpegInstalled(api);
  if (ytInstalled && ffInstalled) return true;
  if (!isOwner(myId)) return false;

  const confirmed = await api.modal.confirm({
    title: "Install YT-DLP",
    message: "YT-DLP (and its FFmpeg dependency) is not installed yet. Download and install it now?",
    confirmLabel: "Install",
    cancelLabel: "Not Now",
  });
  if (!confirmed || !isOwner(myId)) return false;

  installing = true;
  notify();
  try {
    safeStatus(api, ctx, "in-progress");
    if (!ytInstalled) {
      safeLog(api, ctx, "info", "Downloading yt-dlp...");
      const release = await fetchLatestYtDlp(ctx.signal);
      await installYtDlp(api, paths, release);
    }
    if (!isOwner(myId)) return false;
    if (!ffInstalled) {
      safeLog(api, ctx, "info", "Downloading FFmpeg (this may take a minute)...");
      const release = await fetchLatestFfmpeg(ctx.signal);
      await installFfmpeg(api, paths, release);
    }
    if (!isOwner(myId)) return false;
    api.toast.show({ message: "YT-DLP Installed", kind: "success" });
    safeStatus(api, ctx, "idle");
    return true;
  } catch (err) {
    safeLog(api, ctx, "error", `Install failed: ${err}`);
    safeStatus(api, ctx, "error");
    setBanner({
      tone: "warning",
      message: "FFmpeg install failed - downloads will use single-file formats without thumbnail/metadata embedding.",
    });
    return await isYtDlpInstalled(api); // yt-dlp alone can still work without ffmpeg for some formats
  } finally {
    installing = false;
    notify();
  }
}

async function checkForUpdates(api: PluginApi, ctx: PluginContext, myId: string, paths: BinPaths): Promise<void> {
  try {
    const installed = await getInstalledYtDlpVersion(api, paths.ytDlpExe);
    if (needsInstall(installed)) return; // handled by ensureBinariesInstalled
    const latest = await fetchLatestYtDlp(ctx.signal);
    if (!isOwner(myId)) return;
    if (needsUpdate(installed, latest.version)) {
      setBanner({ tone: "success", message: `YT-DLP Update Available (${latest.version})` });
    }
  } catch (err) {
    safeLog(api, ctx, "warn", `Update check failed: ${err}`);
  }
}

// --- queue processing loop -------------------------------------------

async function runProcessingLoop(api: PluginApi, ctx: PluginContext, myId: string, paths: BinPaths) {
  if (processing || !isOwner(myId)) return;
  processing = true;
  try {
    while (isOwner(myId)) {
      const item = nextQueuedItem(queue);
      if (!item || !currentSettings) break;

      setQueue(updateItem(queue, item.id, { status: "downloading", finalizing: false }));
      await saveState(api, myId);
      safeStatus(api, ctx, "in-progress");

      const args = buildArgs(currentSettings, {
        binDir: paths.binDir,
        outputDirectory,
        archivePath,
        url: item.url,
        cookiesFromBrowser: sessionCookiesBrowser,
        mergeOutputFormat: selectedMergeFormat,
      });

      let stdoutCarry = "";
      let stderrCarry = "";
      let lastError = "";
      const tracker = new ProgressTracker(estimateStreamCount(currentSettings));

      const child = api.shell.spawn(paths.ytDlpExe, args, {
        onStdout: (chunk) => {
          if (!isOwner(myId)) return;
          const { lines, carry } = splitLines(stdoutCarry, chunk);
          stdoutCarry = carry;
          for (const line of lines) {
            const parsed = parseDownloadProgressLine(line);
            if (parsed) {
              const overall = tracker.update(parsed.percent);
              setQueue(updateItem(queue, item.id, { progress: overall, etaSeconds: parsed.etaSeconds }));
            } else if (isPostProcessingLine(line)) {
              setQueue(updateItem(queue, item.id, { finalizing: true, etaSeconds: null }));
            }
          }
        },
        onStderr: (chunk) => {
          if (!isOwner(myId)) return;
          const { lines, carry } = splitLines(stderrCarry, chunk);
          stderrCarry = carry;
          for (const line of lines) {
            if (line.includes("ERROR:")) lastError = line;
          }
        },
      });
      activeChild = { pid: child.pid };

      const result = await child.done;
      activeChild = null;
      if (!isOwner(myId)) break;

      if (result.code === 0) {
        setQueue(removeFromQueue(queue, item.id));
        safeLog(api, ctx, "info", `Downloaded: ${item.url}`);
        if (!ctx.signal.aborted) {
          try {
            api.toast.show({ title: "Download Complete", message: item.url, kind: "success" });
          } catch {
            // thrown after hot-reload/deactivation - safe to ignore
          }
        }
      } else {
        setQueue(updateItem(queue, item.id, { status: "error", error: lastError || `yt-dlp exited with code ${result.code}` }));
      }
      await saveState(api, myId);
    }
  } finally {
    processing = false;
    if (isOwner(myId)) safeStatus(api, ctx, queue.some((i) => i.status === "error") ? "error" : "idle");
  }
}

// --- activate/deactivate -----------------------------------------------

export async function activate(ctx: PluginContext) {
  const myId = crypto.randomUUID();
  globalThis.__stewrdYtDlpOwner = myId;
  ctx.api.statusIcon.set("idle");

  currentSettings = await loadSettings(ctx.pluginId);
  const rootPath = await ctx.api.fs.getRootPath();
  const paths = resolveBinPaths(rootPath);
  archivePath = `${rootPath.replace(/[\\/]+$/, "")}\\download-archive.txt`;

  hostApi = ctx.api;
  hostCtx = ctx;
  hostPaths = paths;
  hostOwnerId = myId;

  const persisted = await loadState(ctx.api);
  queue = resetInterruptedItems(persisted.queue);
  outputDirectory = persisted.outputDirectory || (await defaultDownloadsDir(ctx.api));
  notify();

  ctx.onDispose(() => {
    if (activeChild) killProcessTree(ctx.api, activeChild.pid);
  });

  ensureBinariesInstalled(ctx.api, ctx, myId, paths).then((ready) => {
    ytdlpAvailable = ready;
    ffmpegAvailable = ready;
    notify();
    if (ready && isOwner(myId)) {
      runProcessingLoop(ctx.api, ctx, myId, paths);
    }
  });

  if (currentSettings.autoUpdateCheckOnStartup) {
    checkForUpdates(ctx.api, ctx, myId, paths).catch(() => {});
  }
}

export function deactivate() {}

// --- UI -----------------------------------------------------------------

type FormatKey = "mp3" | "mp4" | "mkv";

const FORMAT_OPTIONS: { key: FormatKey; icon: string; label: string }[] = [
  { key: "mp3", icon: mp3Icon, label: "Audio" },
  { key: "mp4", icon: mp4Icon, label: "1080" },
  { key: "mkv", icon: mkvIcon, label: "Best" },
];

// Patches currentSettings + the merge container for a given format icon.
// mp4/mkv also force --merge-output-format so the container matches the
// icon the user actually clicked, instead of leaving it to yt-dlp's own
// (less predictable) default merge-container choice.
function applyFormatKey(settings: YtDlpSettings, key: FormatKey): { settings: YtDlpSettings; mergeOutputFormat: string | null } {
  if (key === "mp3") {
    return { settings: { ...settings, audioOnly: true, audioFormat: "mp3" }, mergeOutputFormat: null };
  }
  if (key === "mp4") {
    return {
      settings: { ...settings, audioOnly: false, format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]" },
      mergeOutputFormat: "mp4",
    };
  }
  return { settings: { ...settings, audioOnly: false, format: "bestvideo+bestaudio/best" }, mergeOutputFormat: "mkv" };
}

export function Component({ api }: { api: PluginApi }) {
  const [, setTick] = useState(0);
  const [palette, setPalette] = useState(api.theme.palette);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState(outputDirectory);
  const [formatKey, setFormatKey] = useState<FormatKey>("mp3"); // mp3/Audio is the default

  useEffect(() => {
    const rerender = () => {
      setTick((n) => n + 1);
      setFolder(outputDirectory);
    };
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  useEffect(() => api.theme.subscribe(setPalette), [api]);
  useEffect(() => injectNoResizeCssOnce(), []);

  const submitUrl = () => {
    if (!url.trim()) return;
    setQueue(addToQueue(queue, url.trim()));
    persistAndKick();
    setUrl("");
  };

  const changeFolder = (value: string) => {
    setFolder(value);
    outputDirectory = value;
  };

  const changeFormat = (key: FormatKey) => {
    setFormatKey(key);
    if (!currentSettings) return;
    const { settings, mergeOutputFormat } = applyFormatKey(currentSettings, key);
    currentSettings = settings;
    selectedMergeFormat = mergeOutputFormat;
  };

  const useBrowserCookies = async () => {
    if (sessionCookiesBrowser) {
      sessionCookiesBrowser = null;
      notify();
      api.toast.show({ message: "Downloading anonymously again", kind: "idle" });
      return;
    }

    detectingBrowser = true;
    notify();
    const browser = await openDefaultBrowserAtYouTubeAndDetect(api);
    sessionCookiesBrowser = browser;
    detectingBrowser = false;
    notify();
    if (browser) {
      api.toast.show({ message: `Using ${browser} cookies for this session`, kind: "success" });
    } else {
      api.toast.show({ message: "Could not detect your default browser", kind: "warning" });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
      {installing && (
        <>
          <api.ui.Blanket />
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 11,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <api.ui.Spinner size={32} />
            <span style={{ color: palette.text }}>Installing YT-DLP...</span>
          </div>
        </>
      )}
      <h2 style={{ margin: 0 }}>YT-DLP</h2>

      {banner && (
        <api.ui.Banner message={banner.message} tone={banner.tone} onDismiss={() => setBanner(null)} />
      )}

      <div className={NO_RESIZE_CLASS}>
        <div style={{ marginBottom: 4, color: palette.textMuted }}>Output Folder</div>
        <api.ui.TextBox value={folder} onChange={changeFolder} rows={1} placeholder="C:\Users\you\Downloads" />
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <div style={{ flex: 1, display: "flex", gap: 16 }}>
          {FORMAT_OPTIONS.map((opt) => {
            const selected = formatKey === opt.key;
            return (
              <div
                key={opt.key}
                onClick={() => changeFormat(opt.key)}
                title={opt.label}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, cursor: "pointer" }}
              >
                <api.ui.MaskIcon
                  png={opt.icon}
                  alt={opt.label}
                  size={40}
                  color={selected ? palette.accent : palette.status.idle}
                />
                <span style={{ fontSize: 11, color: palette.textMuted, visibility: selected ? "visible" : "hidden" }}>
                  {opt.label}
                </span>
              </div>
            );
          })}
        </div>

        <div
          onClick={detectingBrowser ? undefined : useBrowserCookies}
          title="Click To Stop Downloading Anonymously And Use Your Browser Cookies"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            cursor: detectingBrowser ? "default" : "pointer",
            paddingBottom: 4,
          }}
        >
          {detectingBrowser ? (
            <api.ui.Spinner size={40} />
          ) : (
            <api.ui.MaskIcon
              png={anonymousIcon}
              alt="Anonymous"
              size={40}
              color={sessionCookiesBrowser ? palette.status.idle : palette.accent}
            />
          )}
          <span style={{ fontSize: 11, color: palette.textMuted }}>
            {sessionCookiesBrowser ?? "Anon"}
          </span>
        </div>
      </div>

      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submitUrl();
          }
        }}
        style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
      >
        <div className={NO_RESIZE_CLASS} style={{ flex: 1 }}>
          <api.ui.TextBox value={url} onChange={setUrl} rows={1} placeholder="Paste A Video URL" />
        </div>
        <api.ui.TextButton label="Add To Queue" variant="primary" onClick={submitUrl} />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          border: `1px solid ${palette.border}`,
          borderRadius: 4,
          padding: 8,
        }}
      >
        {queue.length === 0 && (
          <div style={{ color: palette.textMuted }}>{ytdlpAvailable ? "Queue Is Empty" : "Preparing YT-DLP..."}</div>
        )}
        {queue.map((item) => (
          <div
            key={item.id}
            draggable={item.status === "queued"}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", item.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (item.status !== "queued") return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const sourceId = e.dataTransfer.getData("text/plain");
              if (!sourceId || sourceId === item.id) return;
              setQueue(reorderQueue(queue, sourceId, item.id));
              persistAndKick();
            }}
            style={{
              padding: "8px 0",
              borderBottom: `1px solid ${palette.border}`,
              cursor: item.status === "queued" ? "grab" : "default",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.url}</span>
              <api.ui.IconButton
                label="Remove"
                onClick={() => {
                  setQueue(removeFromQueue(queue, item.id));
                  persistAndKick();
                }}
              />
            </div>
            {item.status === "downloading" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <api.ui.Spinner size={14} />
                <div style={{ flex: 1 }}>
                  <api.ui.ProgressBar value={item.finalizing ? 100 : item.progress} />
                </div>
                <span style={{ color: palette.textMuted, fontSize: 12 }}>
                  {item.finalizing
                    ? "Finalizing..."
                    : item.etaSeconds != null
                      ? `ETA ${formatEta(item.etaSeconds)}`
                      : ""}
                </span>
              </div>
            )}
            {item.status === "error" && (
              <api.ui.Banner message={item.error ?? "Download Failed"} tone="error" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatEta(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
