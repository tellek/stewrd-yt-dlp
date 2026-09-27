import type { YtDlpSettings } from "./settings";

export type QueueItemStatus = "queued" | "downloading" | "done" | "error";

export interface QueueItem {
  id: string;
  url: string;
  status: QueueItemStatus;
  progress: number;
  etaSeconds: number | null;
  error: string | null;
}

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createQueueItem(url: string): QueueItem {
  return { id: makeId(), url: url.trim(), status: "queued", progress: 0, etaSeconds: null, error: null };
}

export function addToQueue(queue: QueueItem[], url: string): QueueItem[] {
  const trimmed = url.trim();
  if (!trimmed) return queue;
  return [...queue, createQueueItem(trimmed)];
}

export function removeFromQueue(queue: QueueItem[], id: string): QueueItem[] {
  return queue.filter((item) => item.id !== id);
}

// Any item still "downloading" at activate() time is from a hot-reload
// takeover where the prior instance's process may or may not have actually
// finished - resetting to "queued" retries it, at worst producing one
// harmless duplicate download (see plan's "Interrupted item on takeover").
export function resetInterruptedItems(queue: QueueItem[]): QueueItem[] {
  return queue.map((item) =>
    item.status === "downloading" ? { ...item, status: "queued", progress: 0, etaSeconds: null } : item,
  );
}

// Moves the item with `sourceId` to just before the item with `targetId`
// (drag-and-drop reorder). No-op if either id is missing or they're the
// same item.
export function reorderQueue(queue: QueueItem[], sourceId: string, targetId: string): QueueItem[] {
  if (sourceId === targetId) return queue;
  const source = queue.find((item) => item.id === sourceId);
  if (!source) return queue;
  const withoutSource = queue.filter((item) => item.id !== sourceId);
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return queue;
  const result = [...withoutSource];
  result.splice(targetIndex, 0, source);
  return result;
}

export function nextQueuedItem(queue: QueueItem[]): QueueItem | undefined {
  return queue.find((item) => item.status === "queued");
}

export function updateItem(queue: QueueItem[], id: string, patch: Partial<QueueItem>): QueueItem[] {
  return queue.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

// --- stdout/stderr chunk buffering ---
// api.shell.spawn's onStdout/onStderr deliver arbitrary chunks, not whole
// lines, so a progress line can be split across two calls. splitLines keeps
// any trailing partial line as `carry` for the next call.
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split(/\r?\n/);
  const carryOut = parts.pop() ?? "";
  return { lines: parts, carry: carryOut };
}

export interface ParsedProgress {
  percent: number;
  etaSeconds: number | null;
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%.*?ETA\s+(\S+)/;

export function parseDownloadProgressLine(line: string): ParsedProgress | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const percent = parseFloat(m[1]);
  if (Number.isNaN(percent)) return null;
  return { percent, etaSeconds: parseEta(m[2]) };
}

function parseEta(raw: string): number | null {
  if (raw === "Unknown" || raw === "--:--") return null;
  const parts = raw.split(":").map(Number);
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// bestvideo+bestaudio (and similar multi-format selectors) download two
// streams sequentially, so raw percent resets 0->100 twice. This tracker
// detects a backward jump and folds it into a monotonically non-decreasing
// overall percent instead of letting the UI's progress bar jump backwards.
export class ProgressTracker {
  private stagesCompleted = 0;
  private stageCount = 1;
  private lastRaw = 0;

  update(rawPercent: number): number {
    if (rawPercent < this.lastRaw - 5) {
      this.stagesCompleted += 1;
      this.stageCount = Math.max(this.stageCount, this.stagesCompleted + 1);
    }
    this.lastRaw = rawPercent;
    const overall = (this.stagesCompleted * 100 + rawPercent) / this.stageCount;
    return Math.min(100, Math.max(0, overall));
  }
}

export interface BuildArgsOptions {
  binDir: string;
  outputDirectory: string;
  archivePath: string;
  url: string;
}

// Assembles the full yt-dlp argument list for one queue item from settings.
// Always-on flags (never user-configurable) come first, then the
// settings-mapped flags, then extraArgs, then the url last.
export function buildArgs(settings: YtDlpSettings, opts: BuildArgsOptions): string[] {
  const args: string[] = ["--newline", "--ignore-errors", "-i", "--no-color", "--ffmpeg-location", opts.binDir];

  args.push("-f", settings.format);
  args.push("-o", joinPath(opts.outputDirectory, settings.outputTemplate));

  if (settings.audioOnly) {
    args.push("-x", "--audio-format", settings.audioFormat);
  }

  if (!settings.downloadPlaylists) {
    args.push("--no-playlist");
  }
  if (settings.playlistItems.trim()) {
    args.push("--playlist-items", settings.playlistItems.trim());
  }

  if (settings.embedThumbnail) args.push("--embed-thumbnail");
  if (settings.embedMetadata) args.push("--embed-metadata");
  if (settings.embedChapters) args.push("--embed-chapters");

  if (settings.subtitles.write || settings.subtitles.writeAutoGenerated) {
    if (settings.subtitles.write) args.push("--write-subs");
    if (settings.subtitles.writeAutoGenerated) args.push("--write-auto-subs");
    args.push("--sub-langs", settings.subtitles.languages);
    if (settings.subtitles.embed) args.push("--embed-subs");
  }

  if (settings.sponsorBlock.mode === "mark") {
    args.push("--sponsorblock-mark", settings.sponsorBlock.categories.join(","));
  } else if (settings.sponsorBlock.mode === "remove") {
    args.push("--sponsorblock-remove", settings.sponsorBlock.categories.join(","));
  }

  if (settings.downloadArchiveEnabled) {
    args.push("--download-archive", opts.archivePath);
  }

  if (settings.rateLimit.trim()) args.push("--limit-rate", settings.rateLimit.trim());
  args.push("-N", String(settings.concurrentFragments));
  args.push("--retries", String(settings.retries));
  if (settings.sleepBetweenDownloadsSeconds > 0) {
    args.push("--sleep-requests", String(settings.sleepBetweenDownloadsSeconds));
  }
  if (settings.cookiesFromBrowser.trim()) {
    args.push("--cookies-from-browser", settings.cookiesFromBrowser.trim());
  }
  if (settings.proxy.trim()) args.push("--proxy", settings.proxy.trim());

  args.push(...settings.extraArgs);
  args.push(opts.url);
  return args;
}

function joinPath(dir: string, file: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}\\${file}`;
}
