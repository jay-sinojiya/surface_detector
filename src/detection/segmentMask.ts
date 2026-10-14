import type { MaskRegion, SegmentedMask, Vec2 } from "./types";

const MAX_MASK_EDGE = 512;
const MIN_REGION_AREA_FRAC = 0.004;

/**
 * Segment transparent (preferred) or near-black hole regions from a base photo.
 * Does not treat black as transparent when a real alpha channel is present.
 */
export function segmentMaskRegions(image: ImageData): SegmentedMask {
  const sw = image.width;
  const sh = image.height;
  const scale = Math.min(1, MAX_MASK_EDGE / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));

  const { hole, usedBlackFallback } = buildHoleMask(image, w, h);
  let holePx = 0;
  for (let i = 0; i < hole.length; i++) if (hole[i]) holePx++;

  const regions = labelConnectedComponents(hole, w, h).filter(
    (r) => r.area >= Math.max(24, w * h * MIN_REGION_AREA_FRAC)
  );
  regions.sort((a, b) => b.area - a.area);

  return {
    width: w,
    height: h,
    scale,
    sourceWidth: sw,
    sourceHeight: sh,
    regions,
    holePx,
    usedBlackFallback,
    hole,
  };
}

export function classifyFloorAndWall(
  regions: MaskRegion[],
  maskH: number
): { floor: MaskRegion | null; wall: MaskRegion | null } {
  if (regions.length === 0) return { floor: null, wall: null };
  if (regions.length === 1) {
    const only = regions[0];
    const cyNorm = only.cy / Math.max(1, maskH - 1);
    if (cyNorm < 0.35 && aspectOf(only) < 0.85) {
      return { floor: null, wall: only };
    }
    return { floor: only, wall: null };
  }

  const scored = regions.map((r) => {
    const cyNorm = r.cy / Math.max(1, maskH - 1);
    const aspect = aspectOf(r);
    const floorScore =
      r.area * (0.55 + 0.45 * cyNorm) * (aspect >= 0.7 ? 1.15 : 0.9);
    const wallScore =
      r.area *
      (0.4 + 0.6 * (1 - cyNorm)) *
      (aspect < 0.95 ? 1.25 : 0.85);
    return { r, floorScore, wallScore };
  });

  let floor = scored[0].r;
  let bestFloor = -1;
  for (const s of scored) {
    if (s.floorScore > bestFloor) {
      bestFloor = s.floorScore;
      floor = s.r;
    }
  }

  let wall: MaskRegion | null = null;
  let bestWall = -1;
  for (const s of scored) {
    if (s.r.id === floor.id) continue;
    if (s.wallScore > bestWall) {
      bestWall = s.wallScore;
      wall = s.r;
    }
  }

  // Reject weak wall candidates (tiny side blobs from furniture gaps).
  if (wall && wall.area < floor.area * 0.12) {
    wall = null;
  }

  return { floor, wall };
}

function aspectOf(r: MaskRegion): number {
  const bw = Math.max(1, r.maxX - r.minX + 1);
  const bh = Math.max(1, r.maxY - r.minY + 1);
  return bw / bh;
}

function buildHoleMask(
  image: ImageData,
  tw: number,
  th: number
): { hole: Uint8Array; usedBlackFallback: boolean } {
  const sw = image.width;
  const sh = image.height;
  const src = image.data;
  const out = new Uint8Array(tw * th);

  let alphaHole = 0;
  let darkHole = 0;

  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * (sh / th)));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * (sw / tw)));
      const i = (sy * sw + sx) * 4;
      const a = src[i + 3];
      const lum = (src[i] + src[i + 1] + src[i + 2]) / 3;
      if (a < 128) {
        out[y * tw + x] = 1;
        alphaHole++;
      } else if (lum < 18) {
        out[y * tw + x] = 2;
        darkHole++;
      }
    }
  }

  const usedBlackFallback =
    alphaHole < tw * th * 0.002 && darkHole > tw * th * 0.01;

  if (usedBlackFallback) {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i] === 2 || out[i] === 1 ? 1 : 0;
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i] === 1 ? 1 : 0;
    }
  }

  return { hole: out, usedBlackFallback };
}

function labelConnectedComponents(
  hole: Uint8Array,
  w: number,
  h: number
): MaskRegion[] {
  const labels = new Int32Array(w * h);
  const regions: MaskRegion[] = [];
  let nextId = 1;
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!hole[idx] || labels[idx]) continue;

      let qh = 0;
      let qt = 0;
      qx[qt] = x;
      qy[qt] = y;
      qt++;
      labels[idx] = nextId;

      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let sumX = 0;
      let sumY = 0;
      const boundary: Vec2[] = [];

      while (qh < qt) {
        const cx = qx[qh];
        const cy = qy[qh];
        qh++;
        area++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        let isBoundary = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
              isBoundary = true;
              continue;
            }
            const nidx = ny * w + nx;
            if (!hole[nidx]) {
              isBoundary = true;
              continue;
            }
            if (labels[nidx]) continue;
            labels[nidx] = nextId;
            qx[qt] = nx;
            qy[qt] = ny;
            qt++;
          }
        }
        if (isBoundary && boundary.length < 6000) {
          boundary.push({ x: cx, y: cy });
        }
      }

      regions.push({
        id: nextId,
        area,
        minX,
        minY,
        maxX,
        maxY,
        cx: sumX / area,
        cy: sumY / area,
        boundary,
      });
      nextId++;
    }
  }
  return regions;
}

/** Upscale a downsampled region point into source pixel coordinates. */
export function regionPointToSource(
  p: Vec2,
  scale: number
): Vec2 {
  const sx = scale > 0 ? 1 / scale : 1;
  return { x: (p.x + 0.5) * sx, y: (p.y + 0.5) * sx };
}
