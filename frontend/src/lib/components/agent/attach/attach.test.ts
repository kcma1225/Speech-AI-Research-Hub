import { describe, expect, it } from "vitest";
import { checkFile, namePasted } from "./api.ts";

const formats = { accept: ".pdf,.docx,.md,.png,.jpg,.jpeg,.webp", maxBytes: 30 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024, maxPerMessage: 10 };
const file = (name: string, size: number, type = "") => new File([new Uint8Array(size)], name, { type });

describe("composer attachments", () => {
  it("names pasted clipboard images by time and keeps real file names", () => {
    const at = new Date(2026, 9, 21, 9, 5, 7);
    expect(namePasted(file("image.png", 4, "image/png"), at).name).toBe("pasted-20261021-090507.png");
    expect(namePasted(file("", 4, "image/jpeg"), at).name).toBe("pasted-20261021-090507.jpg");
    expect(namePasted(file("figure-3.png", 4, "image/png"), at).name).toBe("figure-3.png");
  });

  it("checks type and size like the server (images 10 MB, documents 30 MB)", () => {
    expect(checkFile(file("a.png", 10), formats)).toBeNull();
    expect(checkFile(file("a.gif", 10), formats)).toEqual({ key: "attach.badType" });
    expect(checkFile(file("noext", 10), formats)).toEqual({ key: "attach.badType" });
    expect(checkFile(file("big.webp", 10 * 1024 * 1024 + 1), formats)).toEqual({ key: "attach.tooLarge", size: "10 MB" });
    expect(checkFile(file("big.pdf", 20 * 1024 * 1024), formats)).toBeNull();
    expect(checkFile(file("huge.PDF", 30 * 1024 * 1024 + 1), formats)).toEqual({ key: "attach.tooLarge", size: "30 MB" });
  });
});
