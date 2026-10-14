import type { MaskRegion, Vec2 } from "./types";

export type GroutOrientation = {
  /** Dominant depth-grout angle in image degrees (0 = right, 90 = down). */
  depthAngleDeg: number;
  /** Dominant transverse (cross) grout angle in image degrees. */
  transverseAngleDeg: number;
  /**
   * Texture / plane yaw relative to image vertical.
   * 0° = depth grout runs straight up the image (toward the camera axis).
   */
  rotationDeg: number;
  vanishingPoint: Vec2 | null;
  confidence: number;
  supportLines: number;
};

type LineSeg = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  angleDeg: number;
  length: number;
};

/**
 * Estimate floor grout orientation from a reference photo (Demo) inside a
 * floor mask region. Depth grout lines are used for rotation + vanishing point.
 */
export function estimateGroutOrientation(options: {
  demo: ImageData;
  /** Optional hole mask in the same pixel space as demo (1 = floor). */
  holeFull?: Uint8Array | null;
  region?: MaskRegion | null;
  /** Region/mask are in downsampled space; scale maps them to demo pixels. */
  maskScale?: number;
}): GroutOrientation {
  const { demo, holeFull, region, maskScale = 1 } = options;
  const w = demo.width;
  const h = demo.height;
  let mask = buildAnalysisMask(w, h, holeFull, region, maskScale);
  // Drop left/right floor margins so receding parapet edges don't vote as depth.
  mask = shrinkMaskHorizontally(mask, w, h, 0.14);
  const lines = detectGroutLines(demo, mask);

  const floorCx = region
    ? ((region.minX + region.maxX) * 0.5 + 0.5) / (maskScale > 0 ? maskScale : 1)
    : w * 0.5;
  const floorHalfW = region
    ? ((region.maxX - region.minX + 1) * 0.5) / (maskScale > 0 ? maskScale : 1)
    : w * 0.35;

  // Primary depth cue: center-strip grout (the long line toward the VP).
  const centerDepth = estimateCenterDepthAngle(demo, mask, floorCx, floorHalfW);

  let depthAngleDeg = centerDepth?.angleDeg ?? 90;
  let transverseAngleDeg = 0;
  if (lines.length >= 3) {
    const classified = classifyGroutAngles(lines, floorCx, floorHalfW);
    transverseAngleDeg = classified.transverseAngleDeg;
    // Keep Hough depth only if center-strip failed.
    if (!centerDepth) depthAngleDeg = classified.depthAngleDeg;
  } else if (!centerDepth) {
    return {
      depthAngleDeg: 90,
      transverseAngleDeg: 0,
      rotationDeg: 0,
      vanishingPoint: null,
      confidence: 0,
      supportLines: 0,
    };
  }

  const vp = estimateVpFromDepthLines(lines, depthAngleDeg, w, h);

  // Rotation from depth-grout direction (center vertical ≈ 90° → 0° yaw).
  const rotationDeg = normalizeSigned180(depthAngleDeg - 90);

  const depthSupport = Math.max(
    centerDepth?.support ?? 0,
    lines.filter((l) => angleDiffDeg(l.angleDeg, depthAngleDeg) < 18).length
  );

  return {
    depthAngleDeg,
    transverseAngleDeg,
    rotationDeg,
    vanishingPoint: vp,
    confidence: Math.min(1, depthSupport / 12),
    supportLines: Math.max(lines.length, centerDepth?.support ?? 0),
  };
}

/**
 * Orient depth from dark-grout edges in a narrow vertical band around the
 * floor centerline — matches the Demo's one-point center grout.
 */
function estimateCenterDepthAngle(
  demo: ImageData,
  mask: Uint8Array,
  floorCx: number,
  floorHalfW: number
): { angleDeg: number; support: number } | null {
  const w = demo.width;
  const h = demo.height;
  const src = demo.data;
  const band = Math.max(10, floorHalfW * 0.16);
  const x0 = Math.max(0, Math.floor(floorCx - band));
  const x1 = Math.min(w - 1, Math.ceil(floorCx + band));

  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    gray[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }

  const rad = 4;
  const contrast = new Float32Array(w * h);
  let cSum = 0;
  let cCount = 0;
  for (let y = rad; y < h - rad; y++) {
    for (let x = Math.max(rad, x0); x <= Math.min(w - 1 - rad, x1); x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      let maxN = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const v = gray[(y + dy) * w + (x + dx)];
          if (v > maxN) maxN = v;
        }
      }
      const c = Math.max(0, maxN - gray[idx]);
      contrast[idx] = c;
      cSum += c;
      cCount++;
    }
  }
  if (cCount < 80) return null;
  const cThr = Math.max(6, (cSum / cCount) * 1.35);

  // Length-weighted orientation histogram on center-band contrast edges.
  const hist = new Float64Array(180);
  let support = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = Math.max(1, x0); x <= Math.min(w - 2, x1); x++) {
      const idx = y * w + x;
      if (!mask[idx] || contrast[idx] < cThr) continue;
      const gx =
        -gray[(y - 1) * w + (x - 1)] +
        gray[(y - 1) * w + (x + 1)] -
        2 * gray[y * w + (x - 1)] +
        2 * gray[y * w + (x + 1)] -
        gray[(y + 1) * w + (x - 1)] +
        gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] -
        2 * gray[(y - 1) * w + x] -
        gray[(y - 1) * w + (x + 1)] +
        gray[(y + 1) * w + (x - 1)] +
        2 * gray[(y + 1) * w + x] +
        gray[(y + 1) * w + (x + 1)];
      const mag = Math.hypot(gx, gy);
      if (mag < 8) continue;
      // Edge tangent is perpendicular to gradient → grout line angle.
      let ang = ((Math.atan2(gx, -gy) * 180) / Math.PI) % 180;
      if (ang < 0) ang += 180;
      const wgt = contrast[idx] * mag;
      hist[Math.floor(ang) % 180] += wgt;
      support++;
    }
  }
  if (support < 40) return null;

  const smooth = new Float64Array(180);
  for (let i = 0; i < 180; i++) {
    let s = 0;
    for (let d = -5; d <= 5; d++) s += hist[(i + d + 180) % 180];
    smooth[i] = s;
  }

  let best = 90;
  let bestW = -1;
  for (let a = 70; a <= 110; a++) {
    // Soft prior toward true vertical for one-point patio floors.
    const prior = Math.exp(-0.5 * Math.pow((a - 90) / 12, 2));
    const score = smooth[a] * (0.25 + 0.75 * prior);
    if (score > bestW) {
      bestW = score;
      best = a;
    }
  }
  if (bestW <= 0) return null;
  return { angleDeg: best, support };
}

function buildAnalysisMask(
  w: number,
  h: number,
  holeFull: Uint8Array | null | undefined,
  region: MaskRegion | null | undefined,
  maskScale: number
): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (holeFull && holeFull.length === w * h) {
    for (let i = 0; i < holeFull.length; i++) mask[i] = holeFull[i] ? 1 : 0;
    // Tiny dilate for partial grout on the mask boundary — keep small so
    // side parapet edges do not dominate depth-grout voting.
    return dilate(mask, w, h, 1);
  }

  // Fallback: lower band of the image (typical floor).
  const y0 = Math.floor(h * 0.45);
  for (let y = y0; y < h; y++) {
    for (let x = 0; x < w; x++) mask[y * w + x] = 1;
  }
  if (region) {
    const sx = maskScale > 0 ? 1 / maskScale : 1;
    const minX = Math.max(0, Math.floor(region.minX * sx) - 4);
    const maxX = Math.min(w - 1, Math.ceil(region.maxX * sx) + 4);
    const minY = Math.max(0, Math.floor(region.minY * sx) - 4);
    const maxY = Math.min(h - 1, Math.ceil(region.maxY * sx) + 4);
    const cropped = new Uint8Array(w * h);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = y * w + x;
        if (mask[i]) cropped[i] = 1;
      }
    }
    return cropped;
  }
  return mask;
}

function detectGroutLines(image: ImageData, mask: Uint8Array): LineSeg[] {
  const w = image.width;
  const h = image.height;
  const src = image.data;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    gray[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  }

  // Emphasize dark grout lines (black-hat style local contrast).
  const contrast = new Float32Array(w * h);
  const rad = 4;
  for (let y = rad; y < h - rad; y++) {
    for (let x = rad; x < w - rad; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      let maxN = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const v = gray[(y + dy) * w + (x + dx)];
          if (v > maxN) maxN = v;
        }
      }
      contrast[idx] = Math.max(0, maxN - gray[idx]);
    }
  }

  // Edge map from contrast + sobel on gray inside mask.
  const edge = new Uint8Array(w * h);
  let cSum = 0;
  let cCount = 0;
  for (let i = 0; i < contrast.length; i++) {
    if (!mask[i]) continue;
    cSum += contrast[i];
    cCount++;
  }
  const cThr = cCount ? Math.max(6, (cSum / cCount) * 1.4) : 10;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      const gx =
        -gray[(y - 1) * w + (x - 1)] +
        gray[(y - 1) * w + (x + 1)] -
        2 * gray[y * w + (x - 1)] +
        2 * gray[y * w + (x + 1)] -
        gray[(y + 1) * w + (x - 1)] +
        gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] -
        2 * gray[(y - 1) * w + x] -
        gray[(y - 1) * w + (x + 1)] +
        gray[(y + 1) * w + (x - 1)] +
        2 * gray[(y + 1) * w + x] +
        gray[(y + 1) * w + (x + 1)];
      const mag = Math.hypot(gx, gy);
      if (contrast[idx] >= cThr || mag > 40) edge[idx] = 1;
    }
  }

  return houghSegments(edge, w, h);
}

function houghSegments(edge: Uint8Array, w: number, h: number): LineSeg[] {
  const maxDist = Math.hypot(w, h);
  const numRho = Math.max(60, Math.round(maxDist / 3));
  const numTheta = 180;
  const acc = new Float32Array(numRho * numTheta);
  const rhoScale = (numRho - 1) / (2 * maxDist);
  const edgePts: Vec2[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      edgePts.push({ x, y });
      if (((x + y) & 1) === 1) continue;
      for (let ti = 0; ti < numTheta; ti++) {
        const theta = (ti * Math.PI) / numTheta;
        const rho = x * Math.cos(theta) + y * Math.sin(theta);
        const ri = Math.round((rho + maxDist) * rhoScale);
        if (ri < 0 || ri >= numRho) continue;
        acc[ri * numTheta + ti] += 1;
      }
    }
  }
  if (edgePts.length < 40) return [];

  const peaks: { rho: number; theta: number; score: number }[] = [];
  for (let ri = 1; ri < numRho - 1; ri++) {
    for (let ti = 0; ti < numTheta; ti++) {
      const v = acc[ri * numTheta + ti];
      if (v < 12) continue;
      const ti0 = (ti + numTheta - 1) % numTheta;
      const ti1 = (ti + 1) % numTheta;
      if (
        v >= acc[(ri - 1) * numTheta + ti] &&
        v >= acc[(ri + 1) * numTheta + ti] &&
        v >= acc[ri * numTheta + ti0] &&
        v >= acc[ri * numTheta + ti1]
      ) {
        peaks.push({
          rho: ri / rhoScale - maxDist,
          theta: (ti * Math.PI) / numTheta,
          score: v,
        });
      }
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const top = peaks.slice(0, 40);
  const lines: LineSeg[] = [];
  const used = new Uint8Array(edgePts.length);

  for (const peak of top) {
    const c = Math.cos(peak.theta);
    const s = Math.sin(peak.theta);
    const proj: { t: number; i: number }[] = [];
    for (let i = 0; i < edgePts.length; i++) {
      if (used[i]) continue;
      const p = edgePts[i];
      if (Math.abs(p.x * c + p.y * s - peak.rho) > 2.5) continue;
      proj.push({ t: -p.x * s + p.y * c, i });
    }
    if (proj.length < 10) continue;
    proj.sort((a, b) => a.t - b.t);
    let bestA = 0;
    let bestB = 0;
    let run = 0;
    for (let i = 1; i <= proj.length; i++) {
      const gap = i < proj.length ? proj[i].t - proj[i - 1].t : 1e9;
      if (gap > 8 || i === proj.length) {
        if (i - 1 - run > bestB - bestA) {
          bestA = run;
          bestB = i - 1;
        }
        run = i;
      }
    }
    const a = proj[bestA];
    const b = proj[bestB];
    if (b.t - a.t < 28) continue;
    const p1 = edgePts[a.i];
    const p2 = edgePts[b.i];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (length < 28) continue;
    const angleDeg =
      (((Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI) % 180 + 180) %
      180;
    lines.push({
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      angleDeg,
      length,
    });
    for (let i = bestA; i <= bestB; i++) used[proj[i].i] = 1;
  }
  return lines;
}

function classifyGroutAngles(
  lines: LineSeg[],
  floorCx: number,
  floorHalfW: number
): {
  depthAngleDeg: number;
  transverseAngleDeg: number;
} {
  // Length × center-bias histogram. Side parapet / planter edges (~70°/110°)
  // often outvote the true center depth grout (~90°) unless we prefer lines
  // near the floor's vertical midline.
  const hist = new Float64Array(180);
  const half = Math.max(24, floorHalfW);
  for (const l of lines) {
    const mx = (l.x1 + l.x2) * 0.5;
    const dist = Math.abs(mx - floorCx) / half;
    const centerBias = Math.max(0.08, 1 - dist * dist);
    const vertBias =
      0.35 + 0.65 * Math.exp(-0.5 * Math.pow((l.angleDeg - 90) / 18, 2));
    hist[Math.floor(l.angleDeg) % 180] += l.length * centerBias * vertBias;
  }
  // Smooth
  const smooth = new Float64Array(180);
  for (let i = 0; i < 180; i++) {
    let s = 0;
    for (let d = -4; d <= 4; d++) s += hist[(i + d + 180) % 180];
    smooth[i] = s;
  }

  // Depth = strongest weighted family near image-vertical.
  let depthAngleDeg = 90;
  let depthW = -1;
  for (let a = 75; a <= 105; a++) {
    if (smooth[a] > depthW) {
      depthW = smooth[a];
      depthAngleDeg = a;
    }
  }
  if (depthW <= 0) {
    for (let a = 60; a <= 120; a++) {
      if (smooth[a] > depthW) {
        depthW = smooth[a];
        depthAngleDeg = a;
      }
    }
  }

  // Transverse = strongest unweighted family away from depth (near-horizontal).
  const histRaw = new Float64Array(180);
  for (const l of lines) {
    histRaw[Math.floor(l.angleDeg) % 180] += l.length;
  }
  const smoothRaw = new Float64Array(180);
  for (let i = 0; i < 180; i++) {
    let s = 0;
    for (let d = -4; d <= 4; d++) s += histRaw[(i + d + 180) % 180];
    smoothRaw[i] = s;
  }
  for (let d = -22; d <= 22; d++) {
    smoothRaw[(depthAngleDeg + d + 180) % 180] = 0;
  }
  let transverseAngleDeg = 0;
  let transW = -1;
  for (let i = 0; i < 180; i++) {
    if (smoothRaw[i] > transW) {
      transW = smoothRaw[i];
      transverseAngleDeg = i;
    }
  }

  return { depthAngleDeg, transverseAngleDeg };
}

function estimateVpFromDepthLines(
  lines: LineSeg[],
  _depthAngleDeg: number,
  w: number,
  h: number
): Vec2 | null {
  // Depth grout fans toward the horizon VP (often inside the upper half of
  // the frame). Accept a wide angle band — not only lines near 90°.
  const depthish = lines.filter((l) => {
    const toHoriz = Math.min(l.angleDeg, 180 - l.angleDeg);
    return toHoriz > 18;
  });
  if (depthish.length < 2) return null;

  const votes: Vec2[] = [];
  for (let i = 0; i < depthish.length; i++) {
    for (let j = i + 1; j < depthish.length; j++) {
      if (angleDiffDeg(depthish[i].angleDeg, depthish[j].angleDeg) < 6) {
        continue;
      }
      const p = intersect(depthish[i], depthish[j]);
      if (!p) continue;
      // Horizon VP: horizontally centered, from slightly above the frame
      // down to mid-image (behind chairs / skyline on this patio).
      if (p.x < w * 0.2 || p.x > w * 0.8) continue;
      if (p.y < -h * 0.15 || p.y > h * 0.62) continue;
      votes.push(p);
    }
  }
  if (votes.length < 2) return null;

  // Density peak in the expected horizon band.
  const binsX = 24;
  const binsY = 20;
  const counts = new Float64Array(binsX * binsY);
  const x0 = w * 0.2;
  const x1 = w * 0.8;
  const y0 = -h * 0.15;
  const y1 = h * 0.62;
  for (const p of votes) {
    const xi = Math.min(
      binsX - 1,
      Math.max(0, Math.floor(((p.x - x0) / (x1 - x0)) * binsX))
    );
    const yi = Math.min(
      binsY - 1,
      Math.max(0, Math.floor(((p.y - y0) / (y1 - y0)) * binsY))
    );
    counts[yi * binsX + xi] += 1;
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  if (counts[best] < 2) {
    votes.sort((a, b) => a.x - b.x);
    const mx = votes[(votes.length / 2) | 0].x;
    votes.sort((a, b) => a.y - b.y);
    const my = votes[(votes.length / 2) | 0].y;
    return { x: mx, y: my };
  }
  const bx = best % binsX;
  const by = (best / binsX) | 0;
  return {
    x: x0 + ((bx + 0.5) / binsX) * (x1 - x0),
    y: y0 + ((by + 0.5) / binsY) * (y1 - y0),
  };
}

function intersect(a: LineSeg, b: LineSeg): Vec2 | null {
  const den =
    (a.x1 - a.x2) * (b.y1 - b.y2) - (a.y1 - a.y2) * (b.x1 - b.x2);
  if (Math.abs(den) < 1e-8) return null;
  const px =
    ((a.x1 * a.y2 - a.y1 * a.x2) * (b.x1 - b.x2) -
      (a.x1 - a.x2) * (b.x1 * b.y2 - b.y1 * b.x2)) /
    den;
  const py =
    ((a.x1 * a.y2 - a.y1 * a.x2) * (b.y1 - b.y2) -
      (a.y1 - a.y2) * (b.x1 * b.y2 - b.y1 * b.x2)) /
    den;
  return { x: px, y: py };
}

/** Zero out left/right fractions of each row that still has floor pixels. */
function shrinkMaskHorizontally(
  src: Uint8Array,
  w: number,
  h: number,
  frac: number
): Uint8Array {
  const out = src.slice();
  for (let y = 0; y < h; y++) {
    let minX = w;
    let maxX = -1;
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (maxX < minX) continue;
    const span = maxX - minX + 1;
    const cut = Math.max(2, Math.floor(span * frac));
    for (let x = minX; x < minX + cut; x++) out[y * w + x] = 0;
    for (let x = maxX - cut + 1; x <= maxX; x++) out[y * w + x] = 0;
  }
  return out;
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (src[ny * w + nx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

function normalizeSigned180(deg: number): number {
  let d = ((deg + 180) % 360) - 180;
  if (d <= -180) d += 360;
  return d;
}
