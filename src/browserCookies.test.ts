import { describe, it, expect } from "vitest";
import { progIdToYtDlpBrowser } from "./browserCookies";

describe("progIdToYtDlpBrowser", () => {
  it("maps common browser ProgIds to yt-dlp browser names", () => {
    expect(progIdToYtDlpBrowser("ChromeHTML")).toBe("chrome");
    expect(progIdToYtDlpBrowser("MSEdgeHTM")).toBe("edge");
    expect(progIdToYtDlpBrowser("FirefoxURL-308046B0AF4A39CB")).toBe("firefox");
    expect(progIdToYtDlpBrowser("BraveHTML")).toBe("brave");
  });

  it("matches a random per-install suffix Windows appends to some ProgIds", () => {
    expect(progIdToYtDlpBrowser("ChromeHTML.ABC123")).toBe("chrome");
    expect(progIdToYtDlpBrowser("MSEdgeHTM.XYZ789")).toBe("edge");
  });

  it("is case-insensitive", () => {
    expect(progIdToYtDlpBrowser("chromehtml")).toBe("chrome");
  });

  it("returns null for an unrecognized/unsupported ProgId (e.g. Internet Explorer)", () => {
    expect(progIdToYtDlpBrowser("IE.HTTP")).toBeNull();
    expect(progIdToYtDlpBrowser("")).toBeNull();
  });
});
