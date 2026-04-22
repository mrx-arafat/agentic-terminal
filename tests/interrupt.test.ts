import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { isBareEscape, shouldInterrupt, wireEscInterrupt } from "../src/interrupt.js";

describe("shouldInterrupt", () => {
  it("fires on plain Escape when active", () => {
    expect(shouldInterrupt({ name: "escape" }, true)).toBe(true);
  });

  it("no-op when not active", () => {
    expect(shouldInterrupt({ name: "escape" }, false)).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldInterrupt({ name: "return" }, true)).toBe(false);
    expect(shouldInterrupt({ name: "a" }, true)).toBe(false);
  });

  it("ignores Escape combined with ctrl/meta", () => {
    expect(shouldInterrupt({ name: "escape", ctrl: true }, true)).toBe(false);
    expect(shouldInterrupt({ name: "escape", meta: true }, true)).toBe(false);
  });

  it("handles missing key payload", () => {
    expect(shouldInterrupt(undefined, true)).toBe(false);
  });
});

describe("isBareEscape", () => {
  it("matches a single 0x1b byte", () => {
    expect(isBareEscape(Buffer.from([0x1b]))).toBe(true);
  });

  it("matches double-ESC (terminals that meta-prefix bare Esc)", () => {
    expect(isBareEscape(Buffer.from([0x1b, 0x1b]))).toBe(true);
  });

  it("rejects CSI / arrow sequences", () => {
    expect(isBareEscape(Buffer.from([0x1b, 0x5b, 0x41]))).toBe(false); // Up arrow
    expect(isBareEscape(Buffer.from([0x1b, 0x4f, 0x50]))).toBe(false); // F1 (SS3)
  });

  it("rejects non-ESC bytes", () => {
    expect(isBareEscape(Buffer.from([0x61]))).toBe(false);
    expect(isBareEscape(Buffer.from([]))).toBe(false);
  });
});

describe("wireEscInterrupt", () => {
  function makeStdin(): NodeJS.ReadableStream & EventEmitter {
    const em = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    (em as { isTTY?: boolean }).isTTY = false;
    return em;
  }

  it("fires on keypress name=escape when active", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    wireEscInterrupt(stdin, { isActive: () => true, onInterrupt });

    stdin.emit("keypress", undefined, { name: "escape" });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("fires on bare ESC data byte when active", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    wireEscInterrupt(stdin, { isActive: () => true, onInterrupt });

    stdin.emit("data", Buffer.from([0x1b]));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("does not fire on arrow-key data sequences", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    wireEscInterrupt(stdin, { isActive: () => true, onInterrupt });

    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x41])); // Up
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("does not fire when inactive", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    wireEscInterrupt(stdin, { isActive: () => false, onInterrupt });

    stdin.emit("keypress", undefined, { name: "escape" });
    stdin.emit("data", Buffer.from([0x1b]));
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("detach removes listeners from both paths", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    const detach = wireEscInterrupt(stdin, { isActive: () => true, onInterrupt });

    detach();
    stdin.emit("keypress", undefined, { name: "escape" });
    stdin.emit("data", Buffer.from([0x1b]));
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("accepts string data chunks (paused-stream mode)", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    wireEscInterrupt(stdin, { isActive: () => true, onInterrupt });

    stdin.emit("data", "\x1b");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("fires on double-ESC (\\x1b\\x1b)", () => {
    const stdin = makeStdin();
    const onInterrupt = vi.fn();
    wireEscInterrupt(stdin, { isActive: () => true, onInterrupt });

    stdin.emit("data", Buffer.from([0x1b, 0x1b]));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
