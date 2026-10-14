import { fitFloorQuadFromMaskSides } from "./fitFloorFromGrout";
import {
  fitFloorPerspectiveQuad,
  fitPerspectiveQuad,
  isQuadValid,
} from "./fitPerspectiveQuad";
import { estimateGroutOrientation } from "./groutOrientation";
import { estimateHomographyFromQuad } from "./homography";
import { analyzeAlphaChannel, loadImageData } from "./loadImage";
import {
  classifyFloorAndWall,
  regionPointToSource,
  segmentMaskRegions,
} from "./segmentMask";
import type {
  DetectedSurface,
  DetectionResult,
  ImageQuad,
  ManualOverrides,
  MaskRegion,
  SegmentedMask,
  SurfaceCorners,
  SurfaceKind,
} from "./types";

const MAX_REPROJECTION_PX = 12;

export type DetectOptions = {
  /** Base / mask image (alpha cutouts). */
  baseUrl: string;
  /**
   * Optional Demo / reference photo with visible grout.
   * Used only for grout direction + vanishing point (must match base size).
   */
  demoUrl?: string;
  overrides?: ManualOverrides;
};

/**
 * Detect floor/wall from Base alpha cutouts and orient the floor mapping
 * using Demo grout direction when provided.
 */
export async function detectSurfacesFromUrl(
  baseUrlOrOptions: string | DetectOptions,
  maybeOverrides?: ManualOverrides
): Promise<DetectionResult> {
  const options: DetectOptions =
    typeof baseUrlOrOptions === "string"
      ? { baseUrl: baseUrlOrOptions, overrides: maybeOverrides }
      : baseUrlOrOptions;

  const { baseUrl, demoUrl, overrides } = options;
  const t0 = performance.now();
  const loaded = await loadImageData(baseUrl);
  const alpha = analyzeAlphaChannel(loaded.data);

  if (
    !alpha.hasAlpha &&
    alpha.nearBlackOpaque < loaded.width * loaded.height * 0.01
  ) {
    return {
      ok: false,
      message:
        "No usable alpha cutouts or near-black holes found in the base image",
      imageSize: { width: loaded.width, height: loaded.height },
      segmented: null,
      surfaces: [],
      durationMs: performance.now() - t0,
      demoUrl,
    };
  }

  const segmented = segmentMaskRegions(loaded.data);
  if (segmented.holePx < 8 || segmented.regions.length === 0) {
    return {
      ok: false,
      message: "No transparent Floor/Wall cutouts found on the base photo",
      imageSize: { width: loaded.width, height: loaded.height },
      segmented,
      surfaces: [],
      durationMs: performance.now() - t0,
      demoUrl,
    };
  }

  const { floor, wall } = classifyFloorAndWall(
    segmented.regions,
    segmented.height
  );

  let demoData: ImageData | null = null;
  if (demoUrl) {
    const demo = await loadImageData(demoUrl);
    if (demo.width !== loaded.width || demo.height !== loaded.height) {
      return {
        ok: false,
        message: `Demo/Base size mismatch: demo ${demo.width}×${demo.height} vs base ${loaded.width}×${loaded.height}`,
        imageSize: { width: loaded.width, height: loaded.height },
        segmented,
        surfaces: [],
        durationMs: performance.now() - t0,
        demoUrl,
      };
    }
    demoData = demo.data;
  }

  const surfaces: DetectedSurface[] = [];
  if (floor) {
    surfaces.push(
      buildFloorSurface({
        region: floor,
        segmented,
        baseImage: loaded.data,
        demoImage: demoData,
        manualQuad: overrides?.floorQuad,
      })
    );
  }
  if (wall) {
    surfaces.push(
      buildSurface("Wall", wall, segmented.scale, overrides?.wallQuad)
    );
  }

  const ok = surfaces.some((s) => s.homography != null);
  const floorSurf = surfaces.find((s) => s.kind === "Floor");
  const labels = surfaces.map((s) => s.kind).join(" + ") || "none";
  let message = ok
    ? `Detected ${labels}`
    : "Could not estimate a valid projective mapping";
  if (floorSurf?.groutRotationDeg != null && demoUrl) {
    message += ` · grout rotation ${floorSurf.groutRotationDeg.toFixed(1)}°`;
  }
  if (!wall && floor) {
    message += " (floor cutout only)";
  }

  return {
    ok,
    message,
    imageSize: { width: loaded.width, height: loaded.height },
    segmented,
    surfaces,
    durationMs: performance.now() - t0,
    demoUrl,
  };
}

function buildFloorSurface(options: {
  region: MaskRegion;
  segmented: SegmentedMask;
  baseImage: ImageData;
  demoImage: ImageData | null;
  manualQuad?: ImageQuad;
}): DetectedSurface {
  const { region, segmented, baseImage, demoImage, manualQuad } = options;
  const warnings: string[] = [];
  const scale = segmented.scale;

  const holeFull = upsampleHole(
    segmented,
    baseImage.width,
    baseImage.height
  );

  let grout = demoImage
    ? estimateGroutOrientation({
        demo: demoImage,
        holeFull,
        region,
        maskScale: scale,
      })
    : null;

  if (demoImage && grout && grout.supportLines < 3) {
    warnings.push("Grout lines were weak — falling back to mask geometry");
    grout = null;
  }

  const preferredVpMask = grout?.vanishingPoint
    ? {
        x: grout.vanishingPoint.x * scale - 0.5,
        y: grout.vanishingPoint.y * scale - 0.5,
      }
    : null;

  const sideFit = fitFloorQuadFromMaskSides({
    region,
    hole: segmented.hole,
    maskW: segmented.width,
    maskH: segmented.height,
    preferredVp: preferredVpMask,
  });

  let autoQuadMask = sideFit?.quad ?? fitFloorPerspectiveQuad(region);
  let method = sideFit ? "mask-sides+grout" : "mask";
  if (!sideFit) {
    warnings.push("Side-edge floor quad failed — using hull/band fit");
  }

  const autoQuad = scaleQuad(autoQuadMask, scale);
  const vpSource = sideFit
    ? regionPointToSource(sideFit.vanishingPoint, scale)
    : grout?.vanishingPoint ?? null;

  // UV yaw: Demo center depth-grout when reliable; else 0 for one-point
  // patio (quad already encodes pitch via VP).
  let groutRotationDeg = 0;
  let depthAngle = 90;
  let transAngle = grout?.transverseAngleDeg ?? 0;
  if (
    grout &&
    grout.supportLines >= 3 &&
    Math.abs(grout.rotationDeg) < 25
  ) {
    groutRotationDeg = grout.rotationDeg;
    depthAngle = grout.depthAngleDeg;
    transAngle = grout.transverseAngleDeg;
  }

  let corners: SurfaceCorners;
  if (manualQuad && isQuadValid(manualQuad)) {
    corners = {
      quad: manualQuad,
      sources: { tl: "manual", tr: "manual", br: "manual", bl: "manual" },
    };
  } else {
    corners = {
      quad: autoQuad,
      sources: {
        tl: method === "grout-vp" ? "inferred" : "detected",
        tr: method === "grout-vp" ? "inferred" : "detected",
        br: method === "grout-vp" ? "inferred" : "detected",
        bl: method === "grout-vp" ? "inferred" : "detected",
      },
    };
  }

  const homography = isQuadValid(corners.quad)
    ? estimateHomographyFromQuad(corners.quad)
    : null;

  if (!homography) warnings.push("Floor: degenerate or invalid homography");
  else if (homography.reprojectionError > MAX_REPROJECTION_PX) {
    warnings.push(
      `Floor: high reprojection error (${homography.reprojectionError.toFixed(1)} px)`
    );
  }

  const confidence = computeConfidence(
    region,
    homography?.reprojectionError,
    grout?.confidence ?? 0
  );

  return {
    kind: "Floor",
    region,
    corners,
    homography,
    confidence,
    warnings,
    groutRotationDeg,
    groutDepthAngleDeg: depthAngle,
    groutTransverseAngleDeg: transAngle,
    vanishingPoint: vpSource,
  };
}

function buildSurface(
  kind: SurfaceKind,
  region: MaskRegion,
  scale: number,
  manualQuad?: ImageQuad
): DetectedSurface {
  const warnings: string[] = [];
  const autoQuadMask =
    kind === "Floor"
      ? fitFloorPerspectiveQuad(region)
      : fitPerspectiveQuad(region);
  const autoQuad = scaleQuad(autoQuadMask, scale);

  let corners: SurfaceCorners;
  if (manualQuad && isQuadValid(manualQuad)) {
    corners = {
      quad: manualQuad,
      sources: { tl: "manual", tr: "manual", br: "manual", bl: "manual" },
    };
  } else {
    corners = {
      quad: autoQuad,
      sources: {
        tl: "detected",
        tr: "detected",
        br: "detected",
        bl: "detected",
      },
    };
  }

  const homography = isQuadValid(corners.quad)
    ? estimateHomographyFromQuad(corners.quad)
    : null;
  if (!homography) warnings.push(`${kind}: degenerate or invalid homography`);

  return {
    kind,
    region,
    corners,
    homography,
    confidence: computeConfidence(region, homography?.reprojectionError, 0),
    warnings,
  };
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

function scaleQuad(q: ImageQuad, scale: number): ImageQuad {
  return {
    tl: regionPointToSource(q.tl, scale),
    tr: regionPointToSource(q.tr, scale),
    br: regionPointToSource(q.br, scale),
    bl: regionPointToSource(q.bl, scale),
  };
}

function computeConfidence(
  region: MaskRegion,
  reprojectionError: number | undefined,
  groutConfidence: number
): number {
  const bw = region.maxX - region.minX + 1;
  const bh = region.maxY - region.minY + 1;
  const fill = region.area / Math.max(1, bw * bh);
  const fillScore = clamp01(0.25 + fill * 0.75);
  const errScore =
    reprojectionError == null
      ? 0.4
      : clamp01(1 - reprojectionError / MAX_REPROJECTION_PX);
  return clamp01(fillScore * 0.45 + errScore * 0.35 + groutConfidence * 0.2);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Rebuild a surface after the user edits its quad (source-pixel coords). */
export function applyManualQuad(
  surface: DetectedSurface,
  quad: ImageQuad
): DetectedSurface {
  const warnings: string[] = [];
  if (!isQuadValid(quad)) {
    return {
      ...surface,
      corners: {
        quad,
        sources: { tl: "manual", tr: "manual", br: "manual", bl: "manual" },
      },
      homography: null,
      confidence: 0,
      warnings: [`${surface.kind}: invalid manual quad`],
    };
  }

  const homography = estimateHomographyFromQuad(quad);
  if (!homography) {
    warnings.push(`${surface.kind}: degenerate or invalid homography`);
  } else if (homography.reprojectionError > MAX_REPROJECTION_PX) {
    warnings.push(
      `${surface.kind}: high reprojection error (${homography.reprojectionError.toFixed(1)} px)`
    );
  }

  return {
    ...surface,
    corners: {
      quad,
      sources: { tl: "manual", tr: "manual", br: "manual", bl: "manual" },
    },
    homography,
    confidence: computeConfidence(
      surface.region,
      homography?.reprojectionError,
      0
    ),
    warnings,
  };
}
