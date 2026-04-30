import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard, likelySupportsOsc52 } from "../src/clipboard.js";

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the OSC 52 escape sequence with base64-encoded ASCII text", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    copyToClipboard("hello");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[0]).toBe("\x1b]52;c;aGVsbG8=\x07");
  });

  it("encodes UTF-8 bytes for non-ASCII text", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    copyToClipboard("café");
    const expected = `\x1b]52;c;${Buffer.from("café", "utf8").toString("base64")}\x07`;
    expect(writeSpy.mock.calls[0]?.[0]).toBe(expected);
    // Sanity: non-ASCII char must produce more than 1 byte.
    expect(Buffer.from("café", "utf8").length).toBeGreaterThan(4);
  });

  it("emits an empty payload for the empty string", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    copyToClipboard("");
    expect(writeSpy.mock.calls[0]?.[0]).toBe("\x1b]52;c;\x07");
  });
});

describe("likelySupportsOsc52", () => {
  it("returns true for known terminal programs", () => {
    expect(likelySupportsOsc52({ TERM_PROGRAM: "WarpTerminal" })).toBe(true);
    expect(likelySupportsOsc52({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(likelySupportsOsc52({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(likelySupportsOsc52({ TERM_PROGRAM: "WezTerm" })).toBe(true);
    expect(likelySupportsOsc52({ TERM_PROGRAM: "kitty" })).toBe(true);
  });

  it("returns true for tmux variants", () => {
    expect(likelySupportsOsc52({ TERM_PROGRAM: "tmux" })).toBe(true);
    expect(likelySupportsOsc52({ TERM_PROGRAM: "tmux-256color" })).toBe(true);
  });

  it("returns false when TERM_PROGRAM is unset or unknown", () => {
    expect(likelySupportsOsc52({})).toBe(false);
    expect(likelySupportsOsc52({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
  });
});
