import { describe, it, expect } from "vitest";
import {
  addToQueue,
  removeFromQueue,
  resetInterruptedItems,
  nextQueuedItem,
  reorderQueue,
  splitLines,
  parseDownloadProgressLine,
  ProgressTracker,
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
  it("passes through a single-stream 0->100 sequence unchanged", () => {
    const t = new ProgressTracker();
    expect(t.update(0)).toBe(0);
    expect(t.update(50)).toBe(50);
    expect(t.update(100)).toBe(100);
  });

  it("folds a two-stream reset (video then audio) into a monotonic 0->100", () => {
    const t = new ProgressTracker();
    expect(t.update(0)).toBe(0);
    expect(t.update(50)).toBe(50);
    expect(t.update(100)).toBe(100);
    // second stream restarts at 0 - must not report a drop back to 0/25
    expect(t.update(0)).toBe(50);
    expect(t.update(50)).toBe(75);
    expect(t.update(100)).toBe(100);
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

  it("adds --sleep-requests only when > 0", () => {
    const withSleep = buildArgs(DEFAULT_SETTINGS, opts);
    expect(withSleep).toEqual(expect.arrayContaining(["--sleep-requests", "3"]));

    const noSleep = buildArgs({ ...DEFAULT_SETTINGS, sleepBetweenDownloadsSeconds: 0 }, opts);
    expect(noSleep).not.toContain("--sleep-requests");
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
