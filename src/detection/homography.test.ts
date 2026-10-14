import { describe, expect, it } from "vitest";
import {
  applyHomography,
  estimateHomography,
  estimateHomographyFromQuad,
} from "./homography";
import type { ImageQuad } from "./types";

describe("estimateHomographyFromQuad", () => {
  it("maps unit square corners to the image quad", () => {
    const quad: ImageQuad = {
      tl: { x: 100, y: 50 },
      tr: { x: 300, y: 40 },
      br: { x: 320, y: 220 },
      bl: { x: 80, y: 200 },
    };
    const h = estimateHomographyFromQuad(quad);
    expect(h).not.toBeNull();
    expect(h!.reprojectionError).toBeLessThan(1e-6);

    const src = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const dst = [quad.tl, quad.tr, quad.br, quad.bl];
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h!.H, src[i]);
      expect(p).not.toBeNull();
      expect(p!.x).toBeCloseTo(dst[i].x, 5);
      expect(p!.y).toBeCloseTo(dst[i].y, 5);
    }
  });

  it("rejects degenerate / collinear points", () => {
    const h = estimateHomography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ]
    );
    expect(h).toBeNull();
  });

  it("inverts consistently for a mid-point sample", () => {
    const quad: ImageQuad = {
      tl: { x: 0, y: 0 },
      tr: { x: 200, y: 0 },
      br: { x: 200, y: 100 },
      bl: { x: 0, y: 100 },
    };
    const h = estimateHomographyFromQuad(quad)!;
    const img = applyHomography(h.H, { x: 0.5, y: 0.5 })!;
    const back = applyHomography(h.Hinv, img)!;
    expect(back.x).toBeCloseTo(0.5, 5);
    expect(back.y).toBeCloseTo(0.5, 5);
  });
});

describe("exterior perspective quad", () => {
  it("maps floor pixels into unit UV with foreshortening", () => {
    const vp = { x: 513, y: 251 };
    const farY = 404;
    const botY = 763;
    const tl = { x: 177, y: farY };
    const tr = { x: 844, y: farY };
    const t = (botY - vp.y) / (farY - vp.y);
    const bl = { x: vp.x + t * (tl.x - vp.x), y: botY };
    const br = { x: vp.x + t * (tr.x - vp.x), y: botY };
    const h = estimateHomographyFromQuad({ tl, tr, br, bl });
    expect(h).not.toBeNull();
    expect(h!.reprojectionError).toBeLessThan(1);

    const near = applyHomography(h!.Hinv, { x: 512, y: 740 })!;
    const far = applyHomography(h!.Hinv, { x: 512, y: 430 })!;
    expect(near.x).toBeGreaterThan(0.2);
    expect(near.x).toBeLessThan(0.8);
    expect(near.y).toBeGreaterThan(0.5);
    expect(far.y).toBeLessThan(near.y);
    expect(far.y).toBeGreaterThan(-0.05);
    expect(far.y).toBeLessThan(0.45);
  });
});
