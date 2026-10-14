import type { ImageQuad, MaskRegion, Vec2 } from "./types";

/**
 * Approximate a mask region as a perspective quad (convex hull → 4 corners).
 */
export function fitPerspectiveQuad(region: MaskRegion): ImageQuad {
  const pts =
    region.boundary.length >= 4 ? region.boundary : cornersFromAabb(region);

  const hull = convexHull(pts);
  const quadPts =
    hull.length <= 4 ? padToQuad(hull, region) : simplifyToQuad(hull);

  return orderQuadCorners(quadPts);
}

/**
 * Floor-oriented quad: prefer top-edge extremes + bottom image corners.
 * Works better when furniture occludes true room corners.
 */
export function fitFloorPerspectiveQuad(region: MaskRegion): ImageQuad {
  const pts =
    region.boundary.length >= 4 ? region.boundary : cornersFromAabb(region);
  if (pts.length < 4) return fitPerspectiveQuad(region);

  const minY = region.minY;
  const maxY = region.maxY;
  const band = Math.max(2, Math.round((maxY - minY + 1) * 0.12));

  const top = pts.filter((p) => p.y <= minY + band);
  const bot = pts.filter((p) => p.y >= maxY - band);
  const left = pts.filter((p) => p.x <= region.minX + band);
  const right = pts.filter((p) => p.x >= region.maxX - band);

  const tl =
    top.length > 0
      ? top.reduce((a, b) => (a.x < b.x ? a : b))
      : { x: region.minX, y: region.minY };
  const tr =
    top.length > 0
      ? top.reduce((a, b) => (a.x > b.x ? a : b))
      : { x: region.maxX, y: region.minY };

  // Bottom corners: prefer extreme X on the bottom band; fall back to side bands.
  let bl =
    bot.length > 0
      ? bot.reduce((a, b) => (a.x < b.x ? a : b))
      : left.length > 0
        ? left.reduce((a, b) => (a.y > b.y ? a : b))
        : { x: region.minX, y: region.maxY };
  let br =
    bot.length > 0
      ? bot.reduce((a, b) => (a.x > b.x ? a : b))
      : right.length > 0
        ? right.reduce((a, b) => (a.y > b.y ? a : b))
        : { x: region.maxX, y: region.maxY };

  // If top span is tiny (occluded), widen using hull extremes.
  if (Math.abs(tr.x - tl.x) < (region.maxX - region.minX) * 0.25) {
    return fitPerspectiveQuad(region);
  }

  const ordered = orderQuadCorners([tl, tr, br, bl]);
  if (!isQuadValid(ordered, 8)) return fitPerspectiveQuad(region);
  return ordered;
}

function cornersFromAabb(region: MaskRegion): Vec2[] {
  return [
    { x: region.minX, y: region.minY },
    { x: region.maxX, y: region.minY },
    { x: region.maxX, y: region.maxY },
    { x: region.minX, y: region.maxY },
  ];
}

function padToQuad(hull: Vec2[], region: MaskRegion): Vec2[] {
  if (hull.length >= 4) return hull.slice(0, 4);
  const aabb = cornersFromAabb(region);
  const out = hull.slice();
  for (const p of aabb) {
    if (out.length >= 4) break;
    if (!out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1)) out.push(p);
  }
  while (out.length < 4) out.push({ ...out[out.length - 1] });
  return out.slice(0, 4);
}

function simplifyToQuad(hull: Vec2[]): Vec2[] {
  const n = hull.length;
  let bestArea = -1;
  let best: Vec2[] = hull.slice(0, 4);
  const limit = Math.min(n, 48);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      for (let k = j + 1; k < limit; k++) {
        for (let l = k + 1; l < limit; l++) {
          const q = [hull[i], hull[j], hull[k], hull[l]];
          const area = Math.abs(polygonArea(q));
          if (area > bestArea) {
            bestArea = area;
            best = q;
          }
        }
      }
    }
  }
  return best;
}

export function orderQuadCorners(pts: Vec2[]): ImageQuad {
  let tl = pts[0];
  let tr = pts[0];
  let br = pts[0];
  let bl = pts[0];
  let tlScore = Infinity;
  let trScore = Infinity;
  let brScore = -Infinity;
  let blScore = Infinity;

  for (const p of pts) {
    const tlS = p.x + p.y;
    const trS = -p.x + p.y;
    const brS = p.x + p.y;
    const blS = p.x - p.y;
    if (tlS < tlScore) {
      tlScore = tlS;
      tl = p;
    }
    if (trS < trScore) {
      trScore = trS;
      tr = p;
    }
    if (brS > brScore) {
      brScore = brS;
      br = p;
    }
    if (blS < blScore) {
      blScore = blS;
      bl = p;
    }
  }

  const unique = uniquePoints([tl, tr, br, bl]);
  if (unique.length < 4) {
    const byY = [...pts].sort((a, b) => a.y - b.y || a.x - b.x);
    const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
    const bot = byY.slice(-2).sort((a, b) => a.x - b.x);
    return { tl: top[0], tr: top[1], br: bot[1], bl: bot[0] };
  }

  return { tl, tr, br, bl };
}

function uniquePoints(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (!out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.5)) out.push(p);
  }
  return out;
}

function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;

  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a * 0.5;
}

export function quadToArray(q: ImageQuad): Vec2[] {
  return [q.tl, q.tr, q.br, q.bl];
}

export function isQuadValid(q: ImageQuad, minArea = 16): boolean {
  const pts = quadToArray(q);
  if (uniquePoints(pts).length < 4) return false;
  return Math.abs(polygonArea(pts)) >= minArea;
}
