import { isQuadValid } from "./fitPerspectiveQuad";
import type { ImageQuad, MaskRegion, Vec2 } from "./types";

/**
 * Build a floor perspective quad from the Base cutout + vanishing point.
 *
 * Important: many patio Base masks are full-bleed at the bottom (x=0…W), so
 * left/right hole borders are vertical image edges — NOT floor depth lines.
 * Fitting those flattens the floor (VP → ∞). Instead:
 *   1. Take the real far curb corners from the tapered top of the mask
 *   2. Shoot rays through the horizon VP (from Demo grout) down to the
 *      bottom of the floor — corners may lie outside the image, which is
 *      correct for a cropped one-point floor.
 */
export function fitFloorQuadFromMaskSides(options: {
  region: MaskRegion;
  hole: Uint8Array;
  maskW: number;
  maskH: number;
  /** Demo depth-grout VP in mask space (preferred). */
  preferredVp?: Vec2 | null;
}): { quad: ImageQuad; vanishingPoint: Vec2 } | null {
  const { region, hole, maskW, maskH, preferredVp } = options;

  const far = buildFarBoundary(region, hole, maskW);
  if (far.length < 4) return null;

  const farY = farYPercentile(far, 0.2);
  const tlFar = edgeAtY(region, hole, maskW, farY, "left");
  const trFar = edgeAtY(region, hole, maskW, farY, "right");
  if (!tlFar || !trFar) return null;

  const bottomY = bottomFloorY(region, hole, maskW);

  let vp =
    preferredVp && isPlausibleFloorVp(preferredVp, region, maskW, maskH)
      ? preferredVp
      : null;

  // Weak fallback: intersect inset side points (ignore image-border clips).
  if (!vp) {
    const leftPts = insetSidePoints(region, hole, maskW, maskH, "left");
    const rightPts = insetSidePoints(region, hole, maskW, maskH, "right");
    if (leftPts.length >= 4 && rightPts.length >= 4) {
      const sideVp = intersectLines(fitLine(leftPts), fitLine(rightPts));
      if (sideVp && isPlausibleFloorVp(sideVp, region, maskW, maskH)) {
        vp = sideVp;
      }
    }
  }
  if (!vp) vp = syntheticHorizonVp(region, maskH);

  // Rays: far curb corners → through VP → bottom of floor (may exit frame).
  // Do NOT run orderQuadCorners — exterior bottoms break min(x+y) TL scoring.
  let bl = extendThroughVp(tlFar, vp, bottomY);
  let br = extendThroughVp(trFar, vp, bottomY);
  if (!bl || !br) return null;

  let quad: ImageQuad = { tl: tlFar, tr: trFar, br, bl };
  if (!isQuadValid(quad, 12)) return null;

  // Sanity: top must be meaningfully narrower than bottom (pitch cue).
  const topW = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const botW = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
  if (!(botW > topW * 1.05)) {
    vp = syntheticHorizonVp(region, maskH);
    bl = extendThroughVp(tlFar, vp, bottomY);
    br = extendThroughVp(trFar, vp, bottomY);
    if (!bl || !br) return null;
    quad = { tl: tlFar, tr: trFar, br, bl };
    if (!isQuadValid(quad, 12)) return null;
  }

  return { quad, vanishingPoint: vp };
}

/** @deprecated alias kept for callers */
export function fitFloorQuadFromGrout(options: {
  region: MaskRegion;
  hole: Uint8Array;
  maskW: number;
  maskH: number;
  vanishingPoint: Vec2;
}): ImageQuad | null {
  const result = fitFloorQuadFromMaskSides({
    ...options,
    preferredVp: options.vanishingPoint,
  });
  return result?.quad ?? null;
}

function edgeAtY(
  region: MaskRegion,
  hole: Uint8Array,
  maskW: number,
  y: number,
  side: "left" | "right"
): Vec2 | null {
  const yi = Math.max(
    region.minY,
    Math.min(region.maxY, Math.round(y))
  );
  let xmin = maskW;
  let xmax = -1;
  for (let x = region.minX; x <= region.maxX; x++) {
    if (!hole[yi * maskW + x]) continue;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
  }
  if (xmax < xmin) return null;
  return side === "left" ? { x: xmin, y: yi } : { x: xmax, y: yi };
}

function bottomFloorY(
  region: MaskRegion,
  hole: Uint8Array,
  maskW: number
): number {
  for (let y = region.maxY; y >= region.minY; y--) {
    for (let x = region.minX; x <= region.maxX; x++) {
      if (hole[y * maskW + x]) return y;
    }
  }
  return region.maxY;
}

/**
 * Side samples that are inset from the image border so full-bleed vertical
 * crop edges do not dominate the VP fit.
 */
function insetSidePoints(
  region: MaskRegion,
  hole: Uint8Array,
  maskW: number,
  _maskH: number,
  side: "left" | "right"
): Vec2[] {
  const pts: Vec2[] = [];
  const margin = Math.max(2, Math.round(maskW * 0.02));
  for (let y = region.minY; y <= region.maxY; y++) {
    if (side === "left") {
      for (let x = region.minX; x <= region.maxX; x++) {
        if (!hole[y * maskW + x]) continue;
        if (x <= margin) break; // clipped to border — skip this row
        pts.push({ x, y });
        break;
      }
    } else {
      for (let x = region.maxX; x >= region.minX; x--) {
        if (!hole[y * maskW + x]) continue;
        if (x >= maskW - 1 - margin) break;
        pts.push({ x, y });
        break;
      }
    }
  }
  if (pts.length < 8) return pts;
  // Prefer the upper (tapering) half of the floor.
  const midY = (region.minY + region.maxY) * 0.55;
  const upper = pts.filter((p) => p.y <= midY);
  return upper.length >= 4 ? upper : pts;
}

function fitLine(pts: Vec2[]): { vx: number; vy: number; x0: number; y0: number } {
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const x0 = sx / n;
  const y0 = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - x0;
    const dy = p.y - y0;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { vx: Math.cos(ang), vy: Math.sin(ang), x0, y0 };
}

function intersectLines(
  a: { vx: number; vy: number; x0: number; y0: number },
  b: { vx: number; vy: number; x0: number; y0: number }
): Vec2 | null {
  const det = a.vx * -b.vy - a.vy * -b.vx;
  if (Math.abs(det) < 1e-8) return null;
  const dx = b.x0 - a.x0;
  const dy = b.y0 - a.y0;
  const t = (dx * -b.vy - -b.vx * dy) / det;
  return { x: a.x0 + t * a.vx, y: a.y0 + t * a.vy };
}

function isPlausibleFloorVp(
  vp: Vec2,
  region: MaskRegion,
  maskW: number,
  maskH: number
): boolean {
  if (!Number.isFinite(vp.x) || !Number.isFinite(vp.y)) return false;
  if (vp.x < maskW * 0.15 || vp.x > maskW * 0.85) return false;
  // Above far curb, not inside the floor slab.
  if (vp.y > region.minY - 2) return false;
  // Reject absurdly distant VPs (flat / fronto-parallel look).
  if (region.minY - vp.y > maskH * 2.5) return false;
  return true;
}

/** Horizon-like VP for one-point patio previews. */
function syntheticHorizonVp(region: MaskRegion, maskH: number): Vec2 {
  return {
    x: region.cx,
    y: Math.min(region.minY - 12, maskH * 0.36),
  };
}

/** Extend the line vp→far until it reaches targetY (past far, toward camera). */
function extendThroughVp(far: Vec2, vp: Vec2, targetY: number): Vec2 | null {
  const dy = far.y - vp.y;
  if (Math.abs(dy) < 1e-8) return null;
  // p = vp + t (far - vp); t=1 at far, t>1 toward the camera / bottom.
  const t = (targetY - vp.y) / dy;
  if (t <= 0) return null;
  return {
    x: vp.x + t * (far.x - vp.x),
    y: targetY,
  };
}

function buildFarBoundary(
  region: MaskRegion,
  hole: Uint8Array,
  maskW: number
): Vec2[] {
  const poly: Vec2[] = [];
  for (let x = region.minX; x <= region.maxX; x++) {
    for (let y = region.minY; y <= region.maxY; y++) {
      if (hole[y * maskW + x]) {
        poly.push({ x, y });
        break;
      }
    }
  }
  return poly;
}

function farYPercentile(far: Vec2[], pct: number): number {
  if (far.length === 0) return 0;
  const ys = far.map((p) => p.y).sort((a, b) => a - b);
  const i = Math.min(ys.length - 1, Math.max(0, Math.floor(ys.length * pct)));
  return ys[i];
}
