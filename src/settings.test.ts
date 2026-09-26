import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings";

describe("mergeSettings", () => {
  it("returns a copy of defaults when parsed is missing/invalid", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, "not an object")).toEqual(DEFAULT_SETTINGS);
  });

  it("overrides top-level fields from a partial settings.json", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { format: "best", retries: 3 });
    expect(merged.format).toBe("best");
    expect(merged.retries).toBe(3);
    expect(merged.outputTemplate).toBe(DEFAULT_SETTINGS.outputTemplate);
  });

  it("shallow-merges nested subtitles/sponsorBlock objects instead of replacing them wholesale", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { subtitles: { write: true } });
    expect(merged.subtitles.write).toBe(true);
    expect(merged.subtitles.languages).toBe(DEFAULT_SETTINGS.subtitles.languages);

    const merged2 = mergeSettings(DEFAULT_SETTINGS, { sponsorBlock: { mode: "mark" } });
    expect(merged2.sponsorBlock.mode).toBe("mark");
    expect(merged2.sponsorBlock.categories).toEqual(DEFAULT_SETTINGS.sponsorBlock.categories);
  });

  it("ignores a malformed nested object rather than crashing", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { subtitles: "oops" });
    expect(merged.subtitles).toEqual(DEFAULT_SETTINGS.subtitles);
  });

  it("does not mutate the defaults object passed in", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    mergeSettings(DEFAULT_SETTINGS, { format: "best" });
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});
