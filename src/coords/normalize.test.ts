import { describe, expect, it } from "vitest";
import {
  canvasToPixel,
  normalizedToPixel,
  pixelToCanvas,
  pixelToNormalized,
} from "./normalize";

describe("coordinate helpers", () => {
  const size = { width: 400, height: 200 };

  it("round-trips pixel ↔ normalized", () => {
    const p = { x: 100, y: 50 };
    const n = pixelToNormalized(p, size);
    expect(n.x).toBeCloseTo(0.25);
    expect(n.y).toBeCloseTo(0.25);
    const back = normalizedToPixel(n, size);
    expect(back.x).toBeCloseTo(100);
    expect(back.y).toBeCloseTo(50);
  });

  it("round-trips pixel ↔ canvas", () => {
    const canvas = { width: 800, height: 400 };
    const p = { x: 100, y: 50 };
    const c = pixelToCanvas(p, size, canvas);
    expect(c.x).toBeCloseTo(200);
    expect(c.y).toBeCloseTo(100);
    const back = canvasToPixel(c, size, canvas);
    expect(back.x).toBeCloseTo(100);
    expect(back.y).toBeCloseTo(50);
  });
});
