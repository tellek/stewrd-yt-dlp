import { describe, it, expect } from "vitest";
import { compareVersions, needsInstall, needsUpdate, resolveBinPaths } from "./ytdlp";

describe("resolveBinPaths", () => {
  it("builds bin/exe paths under the given root, trimming a trailing slash", () => {
    expect(resolveBinPaths("C:\\plugins\\stewrd-yt-dlp\\data")).toEqual({
      binDir: "C:\\plugins\\stewrd-yt-dlp\\data\\bin",
      ytDlpExe: "C:\\plugins\\stewrd-yt-dlp\\data\\bin\\yt-dlp.exe",
      ffmpegExe: "C:\\plugins\\stewrd-yt-dlp\\data\\bin\\ffmpeg.exe",
      ffprobeExe: "C:\\plugins\\stewrd-yt-dlp\\data\\bin\\ffprobe.exe",
    });
    expect(resolveBinPaths("C:\\data\\").binDir).toBe("C:\\data\\bin");
  });
});

describe("compareVersions", () => {
  it("compares date-based versions numerically, not lexically", () => {
    expect(compareVersions("2024.08.06", "2024.08.07")).toBe(-1);
    expect(compareVersions("2024.09.01", "2024.08.30")).toBe(1);
    expect(compareVersions("2024.08.06", "2024.08.06")).toBe(0);
  });

  it("treats a shorter version as having trailing zeros", () => {
    expect(compareVersions("2024.08.06", "2024.08.06.0")).toBe(0);
    expect(compareVersions("2024.08.06", "2024.08.06.1")).toBe(-1);
  });

  it("strips a leading v", () => {
    expect(compareVersions("v2024.08.06", "2024.08.06")).toBe(0);
  });
});

describe("needsInstall / needsUpdate", () => {
  it("needsInstall is true only when installed is null", () => {
    expect(needsInstall(null)).toBe(true);
    expect(needsInstall("2024.08.06")).toBe(false);
  });

  it("needsUpdate is false when not installed (that's a separate case)", () => {
    expect(needsUpdate(null, "2024.08.06")).toBe(false);
  });

  it("needsUpdate is true only when installed is strictly older", () => {
    expect(needsUpdate("2024.08.06", "2024.08.07")).toBe(true);
    expect(needsUpdate("2024.08.07", "2024.08.07")).toBe(false);
    expect(needsUpdate("2024.08.08", "2024.08.07")).toBe(false);
  });
});
