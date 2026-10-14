import { applyHomography, estimateHomographyFromQuad } from "../detection/homography";
import type { DetectedSurface, SegmentedMask } from "../detection/types";

export type CompositeOptions = {
  base: ImageData;
  surfaces: DetectedSurface[];
  /** Hole mask from segmentation (downsampled); used for clipping. */
  segmented: SegmentedMask;
  tileImage: CanvasImageSource;
  tileWidth: number;
  tileHeight: number;
  /** How many tile repeats across the unit-square surface U axis. */
  tileRepeatU: number;
  tileRepeatV: number;
  /** Which surface kinds to texture. */
  applyFloor: boolean;
  applyWall: boolean;
};

/**
 * Composite tile textures into alpha cutouts, then restore opaque foreground.
 *
 * Layer order:
 * 1. Fill hole pixels with perspective-mapped tile color
 * 2. Draw original opaque (and soft-edge) pixels on top
 */
export function compositePreview(options: CompositeOptions): ImageData {
  const {
    base,
    surfaces,
    segmented,
    tileImage,
    tileWidth,
    tileHeight,
    tileRepeatU,
    tileRepeatV,
    applyFloor,
    applyWall,
  } = options;

  const w = base.width;
  const h = base.height;
  const out = new ImageData(w, h);
  out.data.set(base.data);

  const tileData = sampleTilePixels(tileImage, tileWidth, tileHeight);
  const floor = surfaces.find((s) => s.kind === "Floor");
  const wall = surfaces.find((s) => s.kind === "Wall");
  const holeFull = upsampleHole(segmented, w, h);

  // Only walk hole pixels (much faster than scanning the full frame).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (!holeFull[idx]) continue;
      const i = idx * 4;
      const a = base.data[i + 3];
      if (a >= 128) continue;

      let color: [number, number, number] | null = null;
      if (applyFloor && floor?.homography) {
        color = sampleSurface(
          floor,
          x + 0.5,
          y + 0.5,
          tileData,
          tileWidth,
          tileHeight,
          tileRepeatU,
          tileRepeatV
        );
      }
      if (!color && applyWall && wall?.homography) {
        color = sampleSurface(
          wall,
          x + 0.5,
          y + 0.5,
          tileData,
          tileWidth,
          tileHeight,
          tileRepeatU,
          tileRepeatV
        );
      }
      if (!color) continue;

      const cover = 1 - a / 255;
      out.data[i] = Math.round(color[0] * cover + base.data[i] * (1 - cover));
      out.data[i + 1] = Math.round(
        color[1] * cover + base.data[i + 1] * (1 - cover)
      );
      out.data[i + 2] = Math.round(
        color[2] * cover + base.data[i + 2] * (1 - cover)
      );
      out.data[i + 3] = 255;
    }
  }

  for (let i = 0; i < base.data.length; i += 4) {
    if (base.data[i + 3] >= 250) {
      out.data[i] = base.data[i];
      out.data[i + 1] = base.data[i + 1];
      out.data[i + 2] = base.data[i + 2];
      out.data[i + 3] = base.data[i + 3];
    }
  }

  return out;
}

/**
 * Faster working-resolution composite for interactive preview.
 */
export function compositePreviewScaled(
  options: CompositeOptions,
  maxEdge = 1400
): HTMLCanvasElement {
  const { base } = options;
  const scale = Math.min(1, maxEdge / Math.max(base.width, base.height));
  const w = Math.max(2, Math.round(base.width * scale));
  const h = Math.max(2, Math.round(base.height * scale));

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = base.width;
  srcCanvas.height = base.height;
  const sctx = srcCanvas.getContext("2d");
  if (!sctx) throw new Error("Canvas unavailable");
  sctx.putImageData(base, 0, 0);

  const scaled = document.createElement("canvas");
  scaled.width = w;
  scaled.height = h;
  const ctx = scaled.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  const scaledBase = ctx.getImageData(0, 0, w, h);

  const scaledSurfaces: DetectedSurface[] = options.surfaces.map((s) => {
    const quad = {
      tl: { x: s.corners.quad.tl.x * scale, y: s.corners.quad.tl.y * scale },
      tr: { x: s.corners.quad.tr.x * scale, y: s.corners.quad.tr.y * scale },
      br: { x: s.corners.quad.br.x * scale, y: s.corners.quad.br.y * scale },
      bl: { x: s.corners.quad.bl.x * scale, y: s.corners.quad.bl.y * scale },
    };
    return {
      ...s,
      corners: { ...s.corners, quad },
      homography: estimateHomographyFromQuad(quad),
    };
  });

  const result = compositePreview({
    ...options,
    base: scaledBase,
    surfaces: scaledSurfaces,
  });

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("Canvas unavailable");
  octx.putImageData(result, 0, 0);
  return out;
}

function sampleSurface(
  surface: DetectedSurface,
  x: number,
  y: number,
  tile: Uint8ClampedArray,
  tw: number,
  th: number,
  repeatU: number,
  repeatV: number
): [number, number, number] | null {
  const Hinv = surface.homography?.Hinv;
  if (!Hinv) return null;
  const uv = applyHomography(Hinv, { x, y });
  if (!uv) return null;
  if (uv.x < -0.15 || uv.x > 1.15 || uv.y < -0.15 || uv.y > 1.15) {
    return null;
  }

  // Align tile axes with detected grout direction (yaw in UV space).
  const rotDeg = surface.groutRotationDeg ?? 0;
  let u = uv.x;
  let v = uv.y;
  if (Math.abs(rotDeg) > 0.05) {
    const rad = (rotDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const cx = u - 0.5;
    const cy = v - 0.5;
    u = cx * c - cy * s + 0.5;
    v = cx * s + cy * c + 0.5;
  }

  const uu = ((u * repeatU) % 1 + 1) % 1;
  const vv = ((v * repeatV) % 1 + 1) % 1;
  const tx = Math.min(tw - 1, Math.floor(uu * tw));
  const ty = Math.min(th - 1, Math.floor(vv * th));
  const ti = (ty * tw + tx) * 4;
  return [tile[ti], tile[ti + 1], tile[ti + 2]];
}

function sampleTilePixels(
  source: CanvasImageSource,
  width: number,
  height: number
): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable for tile sampling");
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

function upsampleHole(
  segmented: SegmentedMask,
  tw: number,
  th: number
): Uint8Array {
  const out = new Uint8Array(tw * th);
  const sw = segmented.width;
  const sh = segmented.height;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * (sh / th)));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * (sw / tw)));
      out[y * tw + x] = segmented.hole[sy * sw + sx];
    }
  }
  return out;
}
