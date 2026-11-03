import { describe, expect, it } from "vitest";
import { iosOtherBrowser } from "./device.ts";

const ios = (tail: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`;

describe("iosOtherBrowser", () => {
  it("names iOS Chrome / Firefox / in-app browsers, not Safari or Android", () => {
    expect(iosOtherBrowser(ios("CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1"))).toBe("Chrome");
    expect(iosOtherBrowser(ios("FxiOS/133.0 Mobile/15E148 Safari/605.1.15"))).toBe("Firefox");
    expect(iosOtherBrowser(ios("Mobile/15E148 Safari/604.1 Line/14.19.0"))).toBe("LINE");
    expect(iosOtherBrowser(ios("Mobile/15E148"))).toBe("App");
    expect(iosOtherBrowser(ios("Version/18.1 Mobile/15E148 Safari/604.1"))).toBeNull();
    expect(iosOtherBrowser("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36")).toBeNull();
  });
});
