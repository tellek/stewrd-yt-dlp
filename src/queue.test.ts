import { describe, it, expect } from "vitest";
import {
  addToQueue,
  removeFromQueue,
  resetInterruptedItems,
  nextQueuedItem,
  reorderQueue,
  splitLines,
  parseDownloadProgressLine,
  isPostProcessingLine,
  ProgressTracker,
  estimateStreamCount,
  buildArgs,
} from "./queue";
import { DEFAULT_SETTINGS } from "./settings";

describe("addToQueue / removeFromQueue", () => {
  it("adds a trimmed url as a queued item", () => {
    const queue = addToQueue([], "  https://example.com/watch?v=abc  ");
    expect(queue).toHaveLength(1);
    expect(queue[0].url).toBe("https://example.com/watch?v=abc");
    expect(queue[0].status).toBe("queued");
  });

  it("ignores a blank url", () => {
    expect(addToQueue([], "   ")).toEqual([]);
  });

  it("removes an item by id without touching others", () => {
    let queue = addToQueue([], "a");
    queue = addToQueue(queue, "b");
    const removed = removeFromQueue(queue, queue[0].id);
    expect(removed).toHaveLength(1);
    expect(removed[0].url).toBe("b");
  });
});

describe("resetInterruptedItems / nextQueuedItem", () => {
  it("resets a downloading item to queued and clears its progress", () => {
    const queue = addToQueue([], "a").map((i) => ({ ...i, status: "downloading" as const, progress: 42 }));
    const reset = resetInterruptedItems(queue);
    expect(reset[0].status).toBe("queued");
    expect(reset[0].progress).toBe(0);
  });

  it("leaves queued/done/error items alone", () => {
    const queue = addToQueue([], "a").map((i) => ({ ...i, status: "done" as const }));
    expect(resetInterruptedItems(queue)[0].status).toBe("done");
  });

  it("finds the first queued item", () => {
    let queue = addToQueue([], "a");
    queue = addToQueue(queue, "b");
    queue = queue.map((i, idx) => (idx === 0 ? { ...i, status: "done" as const } : i));
    expect(nextQueuedItem(queue)?.url).toBe("b");
  });
});

describe("reorderQueue", () => {
  it("moves the source item to just before the target item", () => {
    let queue = addToQueue([], "a");
    queue = addToQueue(queue, "b");
    queue = addToQueue(queue, "c");
    const reordered = reorderQueue(queue, queue[2].id, queue[0].id);
    expect(reordered.map((i) => i.url)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when source and target are the same item", () => {
    let queue = addToQueue([], "a");
    queue = addToQueue(queue, "b");
    expect(reorderQueue(queue, queue[0].id, queue[0].id)).toEqual(queue);
  });

  it("is a no-op when either id is unknown", () => {
    const queue = addToQueue([], "a");
    expect(reorderQueue(queue, "missing", queue[0].id)).toEqual(queue);
    expect(reorderQueue(queue, queue[0].id, "missing")).toEqual(queue);
  });
});

describe("splitLines", () => {
  it("splits a chunk with no partial trailing line", () => {
    const { lines, carry } = splitLines("", "line1\nline2\n");
    expect(lines).toEqual(["line1", "line2"]);
    expect(carry).toBe("");
  });

  it("carries a partial trailing line into the next call", () => {
    const first = splitLines("", "[download]  4");
    expect(first.lines).toEqual([]);
    expect(first.carry).toBe("[download]  4");

    const second = splitLines(first.carry, "5.2% ETA 00:05\n");
    expect(second.lines).toEqual(["[download]  45.2% ETA 00:05"]);
    expect(second.carry).toBe("");
  });
});

describe("parseDownloadProgressLine", () => {
  it("parses percent and mm:ss ETA", () => {
    const parsed = parseDownloadProgressLine("[download]  45.2% of 10.00MiB at 1.20MiB/s ETA 00:05");
    expect(parsed).toEqual({ percent: 45.2, etaSeconds: 5 });
  });

  it("parses an h:mm:ss ETA", () => {
    const parsed = parseDownloadProgressLine("[download]  10.0% of 1.00GiB at 500KiB/s ETA 01:02:03");
    expect(parsed?.etaSeconds).toBe(3723);
  });

  it("returns null ETA for Unknown", () => {
    const parsed = parseDownloadProgressLine("[download]  0.0% of ~10.00MiB at Unknown speed ETA Unknown");
    expect(parsed?.etaSeconds).toBeNull();
  });

  it("returns null for a non-progress line", () => {
    expect(parseDownloadProgressLine("[youtube] abc: Downloading webpage")).toBeNull();
  });
});

describe("ProgressTracker", () => {
  it("passes through a single-stream 0->100 sequence unchanged (default/1 expected stream)", () => {
    const t = new ProgressTracker();
    expect(t.update(0)).toBe(0);
    expect(t.update(50)).toBe(50);
    expect(t.update(100)).toBe(100);
  });

  it("when told upfront to expect 2 streams, stage 1 correctly reports only up to 50% (not a misleading 100%)", () => {
    const t = new ProgressTracker(2);
    expect(t.update(0)).toBe(0);
    expect(t.update(50)).toBe(25);
    expect(t.update(100)).toBe(50); // end of stream 1 - correctly halfway, not 100
    // stream 2 restarts at 0 - continues smoothly from 50, never backwards
    expect(t.update(0)).toBe(50);
    expect(t.update(50)).toBe(75);
    expect(t.update(100)).toBe(100);
  });

  it("never regresses below its own historical max even if the stream-count guess turns out wrong", () => {
    const t = new ProgressTracker(1); // wrong guess: caller expected only 1 stream
    expect(t.update(100)).toBe(100);
    // an unexpected second stream resets to 0 - reactive detection kicks in,
    // but the clamp guarantees the displayed value never drops below 100
    expect(t.update(0)).toBe(100);
    expect(t.update(50)).toBe(100);
  });
});

describe("estimateStreamCount", () => {
  it("is 1 for audioOnly regardless of format", () => {
    expect(estimateStreamCount({ audioOnly: true, format: "bestvideo+bestaudio/best" })).toBe(1);
  });

  it("is 2 for a '+'-combined video+audio format selector", () => {
    expect(estimateStreamCount({ audioOnly: false, format: "bestvideo+bestaudio/best" })).toBe(2);
  });

  it("is 1 for a single-format selector", () => {
    expect(estimateStreamCount({ audioOnly: false, format: "best" })).toBe(1);
  });
});

describe("isPostProcessingLine", () => {
  it("recognizes common ffmpeg post-processing markers", () => {
    expect(isPostProcessingLine("[Merger] Merging formats into \"video.mp4\"")).toBe(true);
    expect(isPostProcessingLine("[Metadata] Adding metadata to \"video.mp4\"")).toBe(true);
    expect(isPostProcessingLine("[EmbedThumbnail] Adding thumbnail to \"video.mp4\"")).toBe(true);
    expect(isPostProcessingLine("[ffmpeg] Merging formats")).toBe(true);
  });

  it("does not match a normal download progress line", () => {
    expect(isPostProcessingLine("[download]  45.2% of 10.00MiB at 1.20MiB/s ETA 00:05")).toBe(false);
  });
});

describe("buildArgs", () => {
  const opts = { binDir: "C:\\bin", outputDirectory: "C:\\Downloads", archivePath: "C:\\data\\archive.txt", url: "https://x/y" };

  it("includes always-on flags and settings-mapped flags", () => {
    const args = buildArgs(DEFAULT_SETTINGS, opts);
    expect(args).toContain("--newline");
    expect(args).toContain("--ignore-errors");
    expect(args).toEqual(expect.arrayContaining(["--ffmpeg-location", "C:\\bin"]));
    expect(args).toEqual(expect.arrayContaining(["-f", DEFAULT_SETTINGS.format]));
    expect(args).toEqual(expect.arrayContaining(["-o", "C:\\Downloads\\%(title)s [%(id)s].%(ext)s"]));
    expect(args).toContain("--no-playlist");
    expect(args[args.length - 1]).toBe("https://x/y");
  });

  it("omits empty/zero optional flags", () => {
    const args = buildArgs(DEFAULT_SETTINGS, opts);
    expect(args).not.toContain("--limit-rate");
    expect(args).not.toContain("--cookies-from-browser");
    expect(args).not.toContain("--proxy");
    expect(args).not.toContain("--download-archive");
  });

  it("adds --sleep-interval/--max-sleep-interval as a randomized range by default", () => {
    const args = buildArgs(DEFAULT_SETTINGS, opts);
    expect(args).toEqual(expect.arrayContaining(["--sleep-interval", "5"]));
    expect(args).toEqual(expect.arrayContaining(["--max-sleep-interval", "25"]));
  });

  it("omits --max-sleep-interval when max <= min, and both flags when min is 0", () => {
    const fixedOnly = buildArgs({ ...DEFAULT_SETTINGS, sleepIntervalMinSeconds: 5, sleepIntervalMaxSeconds: 5 }, opts);
    expect(fixedOnly).toEqual(expect.arrayContaining(["--sleep-interval", "5"]));
    expect(fixedOnly).not.toContain("--max-sleep-interval");

    const noSleep = buildArgs({ ...DEFAULT_SETTINGS, sleepIntervalMinSeconds: 0, sleepIntervalMaxSeconds: 25 }, opts);
    expect(noSleep).not.toContain("--sleep-interval");
    expect(noSleep).not.toContain("--max-sleep-interval");
  });

  it("adds -x/--audio-format when audioOnly is set", () => {
    const args = buildArgs({ ...DEFAULT_SETTINGS, audioOnly: true, audioFormat: "mp3" }, opts);
    expect(args).toContain("-x");
    expect(args).toEqual(expect.arrayContaining(["--audio-format", "mp3"]));
  });

  it("adds sponsorblock flags based on mode", () => {
    const mark = buildArgs({ ...DEFAULT_SETTINGS, sponsorBlock: { mode: "mark", categories: ["sponsor", "intro"] } }, opts);
    expect(mark).toEqual(expect.arrayContaining(["--sponsorblock-mark", "sponsor,intro"]));

    const off = buildArgs(DEFAULT_SETTINGS, opts);
    expect(off).not.toContain("--sponsorblock-mark");
    expect(off).not.toContain("--sponsorblock-remove");
  });

  it("appends extraArgs before the url", () => {
    const args = buildArgs({ ...DEFAULT_SETTINGS, extraArgs: ["--verbose"] }, opts);
    expect(args[args.length - 2]).toBe("--verbose");
    expect(args[args.length - 1]).toBe("https://x/y");
  });
});
