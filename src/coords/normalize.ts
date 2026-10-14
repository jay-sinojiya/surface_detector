import type { ImageSize, Vec2 } from "../detection/types";

/** Clamp a value into [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Convert source pixel → normalized [0,1]×[0,1] (origin top-left). */
export function pixelToNormalized(p: Vec2, size: ImageSize): Vec2 {
  return {
    x: p.x / Math.max(1, size.width),
    y: p.y / Math.max(1, size.height),
  };
}

/** Convert normalized → source pixel. */
export function normalizedToPixel(p: Vec2, size: ImageSize): Vec2 {
  return {
    x: p.x * size.width,
    y: p.y * size.height,
  };
}

/** Convert source pixel → canvas display pixel given a display size. */
export function pixelToCanvas(
  p: Vec2,
  source: ImageSize,
  canvas: ImageSize
): Vec2 {
  return {
    x: (p.x / Math.max(1, source.width)) * canvas.width,
    y: (p.y / Math.max(1, source.height)) * canvas.height,
  };
}

/** Convert canvas display pixel → source pixel. */
export function canvasToPixel(
  p: Vec2,
  source: ImageSize,
  canvas: ImageSize
): Vec2 {
  return {
    x: (p.x / Math.max(1, canvas.width)) * source.width,
    y: (p.y / Math.max(1, canvas.height)) * source.height,
  };
}

/** Texture UV from unit-square surface coords (u,v in [0,1] before tiling). */
export function surfaceToUv(
  surface: Vec2,
  tileScaleU: number,
  tileScaleV: number
): Vec2 {
  return {
    x: surface.x * tileScaleU,
    y: surface.y * tileScaleV,
  };
}

export function scaleVec(p: Vec2, s: number): Vec2 {
  return { x: p.x * s, y: p.y * s };
}

export function addVec(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
