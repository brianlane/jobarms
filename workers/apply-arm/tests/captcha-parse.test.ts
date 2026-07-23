import { describe, expect, it } from "vitest";
import { parseTileResponse } from "../src/gemini";

describe("parseTileResponse", () => {
  it("accepts the documented {tiles:[...]} shape", () => {
    expect(parseTileResponse({ tiles: [0, 3, 5] }, 9)).toEqual([0, 3, 5]);
  });

  it("accepts a bare array", () => {
    expect(parseTileResponse([1, 2], 9)).toEqual([1, 2]);
  });

  it("coerces numeric strings", () => {
    expect(parseTileResponse({ tiles: ["0", "8"] }, 9)).toEqual([0, 8]);
  });

  it("drops out-of-range, duplicate, and junk values", () => {
    expect(parseTileResponse({ tiles: [0, 0, 9, -1, "x", 3] }, 9)).toEqual([0, 3]);
  });

  it("handles 4x4 grids", () => {
    expect(parseTileResponse({ tiles: [15] }, 16)).toEqual([15]);
    expect(parseTileResponse({ tiles: [16] }, 16)).toEqual([]);
  });

  it("returns empty for malformed input", () => {
    expect(parseTileResponse(null, 9)).toEqual([]);
    expect(parseTileResponse({ nope: true }, 9)).toEqual([]);
  });
});
