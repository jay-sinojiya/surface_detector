export type Vec2 = { x: number; y: number };

export type ImageSize = { width: number; height: number };

export type SurfaceKind = "Floor" | "Wall";

/** Image-space quad corners in TL, TR, BR, BL order (source pixel coords). */
export type ImageQuad = {
  tl: Vec2;
  tr: Vec2;
  br: Vec2;
  bl: Vec2;
};

export type CornerSource = "detected" | "inferred" | "manual";

export type SurfaceCorners = {
  quad: ImageQuad;
  sources: Record<keyof ImageQuad, CornerSource>;
};

export type MaskRegion = {
  id: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  boundary: Vec2[];
};

export type SegmentedMask = {
  /** Downsampled mask width/height. */
  width: number;
  height: number;
  scale: number;
  sourceWidth: number;
  sourceHeight: number;
  regions: MaskRegion[];
  holePx: number;
  usedBlackFallback: boolean;
  /** Packed hole mask (1 = hole) at downsample resolution. */
  hole: Uint8Array;
};

export type Homography = {
  /** Row-major 3×3 matrix. */
  H: Float64Array;
  /** Inverse row-major 3×3 matrix. */
  Hinv: Float64Array;
  reprojectionError: number;
};

export type DetectedSurface = {
  kind: SurfaceKind;
  region: MaskRegion;
  corners: SurfaceCorners;
  homography: Homography | null;
  confidence: number;
  warnings: string[];
  /** Grout-derived texture yaw in degrees (0 = depth aligns with image vertical). */
  groutRotationDeg?: number;
  groutDepthAngleDeg?: number;
  groutTransverseAngleDeg?: number;
  vanishingPoint?: Vec2 | null;
};

export type DetectionResult = {
  ok: boolean;
  message: string;
  imageSize: ImageSize;
  segmented: SegmentedMask | null;
  surfaces: DetectedSurface[];
  durationMs: number;
  /** Paired Demo image used for grout orientation, if any. */
  demoUrl?: string;
};

export type ManualOverrides = {
  floorQuad?: ImageQuad;
  wallQuad?: ImageQuad;
};
