import { describe, it, expect } from "vitest";
import { processNameToYtDlpBrowser } from "./browserCookies";

describe("processNameToYtDlpBrowser", () => {
  it("maps common browser process names to yt-dlp browser names", () => {
    expect(processNameToYtDlpBrowser("chrome")).toBe("chrome");
    expect(processNameToYtDlpBrowser("msedge")).toBe("edge");
    expect(processNameToYtDlpBrowser("firefox")).toBe("firefox");
    expect(processNameToYtDlpBrowser("brave")).toBe("brave");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(processNameToYtDlpBrowser("  Chrome  ")).toBe("chrome");
    expect(processNameToYtDlpBrowser("MSEDGE")).toBe("edge");
  });

  it("returns null for an unrecognized process name", () => {
    expect(processNameToYtDlpBrowser("explorer")).toBeNull();
    expect(processNameToYtDlpBrowser("")).toBeNull();
  });
});
