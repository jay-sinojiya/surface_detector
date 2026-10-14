import type { DetectedSurface, ImageSize, SegmentedMask } from "../detection/types";
import { pixelToCanvas } from "../coords/normalize";

type Props = {
  surfaces: DetectedSurface[];
  segmented: SegmentedMask | null;
  sourceSize: ImageSize;
  canvasSize: ImageSize;
  showMask: boolean;
  showCorners: boolean;
  showQuad: boolean;
  activeKind: "Floor" | "Wall" | null;
  onCornerDrag?: (
    kind: "Floor" | "Wall",
    corner: "tl" | "tr" | "br" | "bl",
    sourcePixel: { x: number; y: number }
  ) => void;
};

const COLORS: Record<string, string> = {
  Floor: "#2dd4bf",
  Wall: "#f59e0b",
};

export function DebugOverlay({
  surfaces,
  segmented,
  sourceSize,
  canvasSize,
  showMask,
  showCorners,
  showQuad,
  activeKind,
  onCornerDrag,
}: Props) {
  return (
    <svg
      className="debug-overlay"
      width={canvasSize.width}
      height={canvasSize.height}
      viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
    >
      {showMask && segmented && (
        <MaskOverlay
          segmented={segmented}
          canvasSize={canvasSize}
          surfaces={surfaces}
        />
      )}
      {surfaces.map((s) => {
        const color = COLORS[s.kind] ?? "#fff";
        const q = s.corners.quad;
        const tl = pixelToCanvas(q.tl, sourceSize, canvasSize);
        const tr = pixelToCanvas(q.tr, sourceSize, canvasSize);
        const br = pixelToCanvas(q.br, sourceSize, canvasSize);
        const bl = pixelToCanvas(q.bl, sourceSize, canvasSize);
        return (
          <g key={s.kind}>
            {showQuad && (
              <polygon
                points={`${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`}
                fill="none"
                stroke={color}
                strokeWidth={activeKind === s.kind ? 2.5 : 1.5}
                strokeDasharray={
                  Object.values(s.corners.sources).some((v) => v === "inferred")
                    ? "6 4"
                    : undefined
                }
              />
            )}
            {showCorners &&
              (
                [
                  ["tl", tl],
                  ["tr", tr],
                  ["br", br],
                  ["bl", bl],
                ] as const
              ).map(([name, p]) => (
                <circle
                  key={name}
                  cx={p.x}
                  cy={p.y}
                  r={7}
                  fill={color}
                  stroke="#0b1220"
                  strokeWidth={1.5}
                  style={{ cursor: onCornerDrag ? "grab" : "default" }}
                  onPointerDown={(e) => {
                    if (!onCornerDrag) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!onCornerDrag || e.buttons === 0) return;
                    const rect = (
                      e.currentTarget.ownerSVGElement as SVGSVGElement
                    ).getBoundingClientRect();
                    const cx = e.clientX - rect.left;
                    const cy = e.clientY - rect.top;
                    onCornerDrag(s.kind, name, {
                      x: (cx / canvasSize.width) * sourceSize.width,
                      y: (cy / canvasSize.height) * sourceSize.height,
                    });
                  }}
                />
              ))}
          </g>
        );
      })}
    </svg>
  );
}

function MaskOverlay({
  segmented,
  canvasSize,
  surfaces,
}: {
  segmented: SegmentedMask;
  canvasSize: ImageSize;
  surfaces: DetectedSurface[];
}) {
  // Lightweight tint: draw floor/wall region AABBs rather than every pixel.
  return (
    <g opacity={0.28}>
      {surfaces.map((s) => {
        const color = COLORS[s.kind] ?? "#fff";
        const scale = segmented.scale > 0 ? 1 / segmented.scale : 1;
        const x =
          (s.region.minX * scale * canvasSize.width) / segmented.sourceWidth;
        const y =
          (s.region.minY * scale * canvasSize.height) / segmented.sourceHeight;
        const w =
          ((s.region.maxX - s.region.minX + 1) * scale * canvasSize.width) /
          segmented.sourceWidth;
        const h =
          ((s.region.maxY - s.region.minY + 1) * scale * canvasSize.height) /
          segmented.sourceHeight;
        return (
          <rect
            key={s.kind}
            x={x}
            y={y}
            width={w}
            height={h}
            fill={color}
          />
        );
      })}
    </g>
  );
}
