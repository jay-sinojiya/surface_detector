import type { Homography, ImageQuad, Vec2 } from "./types";
import { quadToArray } from "./fitPerspectiveQuad";

/**
 * Estimate a projective transform mapping unit-square surface coords
 * (0,0),(1,0),(1,1),(0,1) → image quad TL,TR,BR,BL.
 *
 * Uses Hartley-normalized DLT (stable when quad corners lie outside the frame).
 */
export function estimateHomographyFromQuad(quad: ImageQuad): Homography | null {
  const dst = quadToArray(quad);
  const src: Vec2[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return estimateHomography(src, dst);
}

export function estimateHomography(
  src: Vec2[],
  dst: Vec2[]
): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  if (!pointsIndependent(src) || !pointsIndependent(dst)) return null;

  const TnSrc = normalization(src);
  const TnDst = normalization(dst);
  if (!TnSrc || !TnDst) return null;

  const srcN = src.map((p) => apply3(TnSrc.T, p));
  const dstN = dst.map((p) => apply3(TnDst.T, p));
  if (srcN.some((p) => !p) || dstN.some((p) => !p)) return null;

  const Hn = dltHomography(
    srcN as Vec2[],
    dstN as Vec2[]
  );
  if (!Hn) return null;

  // H = Tdst^{-1} * Hn * Tsrc
  const Hmid = mul3(TnDst.Tinv, Hn);
  if (!Hmid) return null;
  const H = mul3(Hmid, TnSrc.T);
  if (!H) return null;

  if (Math.abs(H[8]) > 1e-12) {
    const s = 1 / H[8];
    for (let i = 0; i < 9; i++) H[i] *= s;
  }

  const det =
    H[0] * (H[4] * H[8] - H[5] * H[7]) -
    H[1] * (H[3] * H[8] - H[5] * H[6]) +
    H[2] * (H[3] * H[7] - H[4] * H[6]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;

  const Hinv = invert3x3(H);
  if (!Hinv) return null;

  let err = 0;
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(H, src[i]);
    if (!p) return null;
    err += Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
  }
  err /= 4;

  return { H, Hinv, reprojectionError: err };
}

export function applyHomography(H: Float64Array, p: Vec2): Vec2 | null {
  const x = H[0] * p.x + H[1] * p.y + H[2];
  const y = H[3] * p.x + H[4] * p.y + H[5];
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(w) < 1e-12) return null;
  return { x: x / w, y: y / w };
}

export function invertHomography(h: Homography): Homography | null {
  const H = h.Hinv;
  const Hinv = invert3x3(H);
  if (!Hinv) return null;
  return { H, Hinv, reprojectionError: h.reprojectionError };
}

function dltHomography(src: Vec2[], dst: Vec2[]): Float64Array | null {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([-x, -y, -1, 0, 0, 0, x * u, y * u, u]);
    A.push([0, 0, 0, -x, -y, -1, x * v, y * v, v]);
  }
  return solveHomogeneous9(A);
}

/** Similarity that maps points to centroid 0 and mean distance √2. */
function normalization(
  pts: Vec2[]
): { T: Float64Array; Tinv: Float64Array } | null {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let mean = 0;
  for (const p of pts) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= pts.length;
  if (mean < 1e-8) return null;
  const s = Math.SQRT2 / mean;
  const T = new Float64Array([s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]);
  const Tinv = new Float64Array([1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1]);
  return { T, Tinv };
}

function apply3(T: Float64Array, p: Vec2): Vec2 | null {
  const x = T[0] * p.x + T[1] * p.y + T[2];
  const y = T[3] * p.x + T[4] * p.y + T[5];
  const w = T[6] * p.x + T[7] * p.y + T[8];
  if (Math.abs(w) < 1e-12) return null;
  return { x: x / w, y: y / w };
}

function mul3(A: Float64Array, B: Float64Array): Float64Array | null {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return out;
}

function pointsIndependent(pts: Vec2[]): boolean {
  const unique = pts.filter(
    (p, i) =>
      !pts.slice(0, i).some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)
  );
  if (unique.length < 4) return false;
  const area =
    Math.abs(polygonArea([pts[0], pts[1], pts[2]])) +
    Math.abs(polygonArea([pts[0], pts[2], pts[3]]));
  return area > 1e-3;
}

function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a * 0.5;
}

function solveHomogeneous9(A: number[][]): Float64Array | null {
  const M: number[][] = Array.from({ length: 8 }, () => Array(8).fill(0));
  const b = new Float64Array(8);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) M[r][c] = A[r][c];
    b[r] = -A[r][8];
  }
  const x = solveLinear8(M, b);
  if (!x) return null;
  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = x[i];
  h[8] = 1;
  return h;
}

function solveLinear8(M: number[][], b: Float64Array): Float64Array | null {
  const n = 8;
  const a = M.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) return null;
    if (pivot !== col) {
      const tmp = a[col];
      a[col] = a[pivot];
      a[pivot] = tmp;
    }
    const div = a[col][col];
    for (let c = col; c <= n; c++) a[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (Math.abs(factor) < 1e-15) continue;
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }

  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = a[i][n];
  return x;
}

function invert3x3(m: Float64Array): Float64Array | null {
  const a = m[0],
    b = m[1],
    c = m[2],
    d = m[3],
    e = m[4],
    f = m[5],
    g = m[6],
    h = m[7],
    i = m[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  return new Float64Array([
    A * inv,
    D * inv,
    G * inv,
    B * inv,
    E * inv,
    H * inv,
    C * inv,
    F * inv,
    I * inv,
  ]);
}
