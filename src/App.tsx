import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyManualQuad,
  detectSurfacesFromUrl,
} from "./detection/detectSurfaces";
import { loadImageData } from "./detection/loadImage";
import type {
  DetectedSurface,
  DetectionResult,
  ImageQuad,
} from "./detection/types";
import { DebugOverlay } from "./components/DebugOverlay";
import {
  createTileTexture,
  type TilePreset,
} from "./rendering/createTileTexture";
import { compositePreviewScaled } from "./rendering/compositePreview";
import "./App.css";

/** Sample assets: Base = alpha cutout mask. Demo = grout reference (same size). */
const SAMPLE_BASE_URL = "/base.png";
const SAMPLE_DEMO_URL = "/demo.jpg";

type Mode = "original" | "composited" | "demo";

export default function App() {
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [surfaces, setSurfaces] = useState<DetectedSurface[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("composited");
  const [tilePreset, setTilePreset] = useState<TilePreset>("checker");
  const [repeat, setRepeat] = useState(8);
  const [showMask, setShowMask] = useState(false);
  const [showCorners, setShowCorners] = useState(true);
  const [showQuad, setShowQuad] = useState(true);
  const [showDebug, setShowDebug] = useState(true);
  const [manualBackup, setManualBackup] = useState<DetectedSurface[] | null>(
    null
  );
  /** Manual grout rotation offset (degrees) added on top of auto detection. */
  const [groutOffsetDeg, setGroutOffsetDeg] = useState(0);
  const [baseUrl, setBaseUrl] = useState(SAMPLE_BASE_URL);
  const [demoUrl, setDemoUrl] = useState<string | undefined>(SAMPLE_DEMO_URL);
  const [baseName, setBaseName] = useState("base.png (sample)");
  const [demoName, setDemoName] = useState("demo.jpg (sample)");

  const baseRef = useRef<ImageData | null>(null);
  const demoImgRef = useRef<HTMLImageElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const baseObjectUrl = useRef<string | null>(null);
  const demoObjectUrl = useRef<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 960, height: 720 });

  const tileCanvas = useMemo(
    () => createTileTexture(tilePreset, 256),
    [tilePreset]
  );

  const runDetection = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const loaded = await loadImageData(baseUrl);
      baseRef.current = loaded.data;
      const result = await detectSurfacesFromUrl({
        baseUrl,
        demoUrl,
      });
      setDetection(result);
      setSurfaces(result.surfaces);
      setManualBackup(null);
      setGroutOffsetDeg(0);
      (window as unknown as { __surfaceDetection?: unknown }).__surfaceDetection =
        result;
      if (!result.ok) setError(result.message);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Detection failed";
      setError(message);
      setDetection(null);
      setSurfaces([]);
    } finally {
      setBusy(false);
    }
  }, [baseUrl, demoUrl]);

  useEffect(() => {
    void runDetection();
  }, [runDetection]);

  useEffect(() => {
    if (!demoUrl) {
      demoImgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      demoImgRef.current = img;
    };
    img.onerror = () => {
      demoImgRef.current = null;
    };
    img.src = demoUrl;
  }, [demoUrl]);

  useEffect(() => {
    return () => {
      if (baseObjectUrl.current) URL.revokeObjectURL(baseObjectUrl.current);
      if (demoObjectUrl.current) URL.revokeObjectURL(demoObjectUrl.current);
    };
  }, []);

  const onBaseFile = (file: File) => {
    if (baseObjectUrl.current) URL.revokeObjectURL(baseObjectUrl.current);
    const url = URL.createObjectURL(file);
    baseObjectUrl.current = url;
    setBaseName(file.name);
    setBaseUrl(url);
  };

  const onDemoFile = (file: File) => {
    if (demoObjectUrl.current) URL.revokeObjectURL(demoObjectUrl.current);
    const url = URL.createObjectURL(file);
    demoObjectUrl.current = url;
    setDemoName(file.name);
    setDemoUrl(url);
  };

  const resetToSample = () => {
    if (baseObjectUrl.current) {
      URL.revokeObjectURL(baseObjectUrl.current);
      baseObjectUrl.current = null;
    }
    if (demoObjectUrl.current) {
      URL.revokeObjectURL(demoObjectUrl.current);
      demoObjectUrl.current = null;
    }
    setBaseName("base.png (sample)");
    setDemoName("demo.jpg (sample)");
    setBaseUrl(SAMPLE_BASE_URL);
    setDemoUrl(SAMPLE_DEMO_URL);
  };

  const surfacesForRender = useMemo(
    () =>
      surfaces.map((s) =>
        s.kind === "Floor"
          ? {
              ...s,
              groutRotationDeg: (s.groutRotationDeg ?? 0) + groutOffsetDeg,
            }
          : s
      ),
    [surfaces, groutOffsetDeg]
  );

  useEffect(() => {
    const base = baseRef.current;
    const canvas = previewRef.current;
    if (!base || !canvas || !detection?.segmented) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (mode === "demo" && demoImgRef.current) {
      const scale = Math.min(1, 1200 / Math.max(base.width, base.height));
      canvas.width = Math.round(base.width * scale);
      canvas.height = Math.round(base.height * scale);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(demoImgRef.current, 0, 0, canvas.width, canvas.height);
      setCanvasSize({ width: canvas.width, height: canvas.height });
      return;
    }

    if (mode === "original" || surfacesForRender.length === 0) {
      const src = document.createElement("canvas");
      src.width = base.width;
      src.height = base.height;
      src.getContext("2d")?.putImageData(base, 0, 0);
      const scale = Math.min(1, 1200 / Math.max(base.width, base.height));
      canvas.width = Math.round(base.width * scale);
      canvas.height = Math.round(base.height * scale);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawChecker(ctx, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      setCanvasSize({ width: canvas.width, height: canvas.height });
      return;
    }

    const t0 = performance.now();
    const composed = compositePreviewScaled(
      {
        base,
        surfaces: surfacesForRender,
        segmented: detection.segmented,
        tileImage: tileCanvas,
        tileWidth: tileCanvas.width,
        tileHeight: tileCanvas.height,
        tileRepeatU: repeat,
        tileRepeatV: repeat,
        applyFloor: true,
        applyWall: true,
      },
      1200
    );
    canvas.width = composed.width;
    canvas.height = composed.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(composed, 0, 0);
    setCanvasSize({ width: canvas.width, height: canvas.height });
    console.info(
      `[surfaceDetector] composite ${(performance.now() - t0).toFixed(0)}ms`
    );
  }, [detection, surfacesForRender, mode, tileCanvas, repeat]);

  const onCornerDrag = (
    kind: "Floor" | "Wall",
    corner: keyof ImageQuad,
    sourcePixel: { x: number; y: number }
  ) => {
    setSurfaces((prev) => {
      if (!manualBackup) setManualBackup(prev);
      return prev.map((s) => {
        if (s.kind !== kind) return s;
        const quad = { ...s.corners.quad, [corner]: sourcePixel };
        return applyManualQuad(s, quad);
      });
    });
    setMode("composited");
  };

  const revertManual = () => {
    if (manualBackup) {
      setSurfaces(manualBackup);
      setManualBackup(null);
    }
  };

  const floor = surfacesForRender.find((s) => s.kind === "Floor");
  const wall = surfacesForRender.find((s) => s.kind === "Wall");

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="eyebrow">Surface Detector</p>
          <h1>Floor mapping from grout direction</h1>
          <p className="sub">
            Base cutout + Demo grout lines → vanishing point → perspective
            quad → tile composite.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" disabled={busy} onClick={() => void runDetection()}>
            {busy ? "Detecting…" : "Run detection"}
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="panel">
          <section>
            <h2>Preview</h2>
            <div className="row">
              <button
                type="button"
                className={mode === "demo" ? "active" : ""}
                onClick={() => setMode("demo")}
              >
                Demo
              </button>
              <button
                type="button"
                className={mode === "original" ? "active" : ""}
                onClick={() => setMode("original")}
              >
                Base
              </button>
              <button
                type="button"
                className={mode === "composited" ? "active" : ""}
                onClick={() => setMode("composited")}
              >
                Tiled
              </button>
            </div>
          </section>

          <section>
            <h2>Tile</h2>
            <label>
              Preset
              <select
                value={tilePreset}
                onChange={(e) => setTilePreset(e.target.value as TilePreset)}
              >
                <option value="checker">Checker</option>
                <option value="marble">Marble</option>
                <option value="slate">Slate</option>
                <option value="terracotta">Terracotta</option>
              </select>
            </label>
            <label>
              Repeat ({repeat})
              <input
                type="range"
                min={2}
                max={20}
                value={repeat}
                onChange={(e) => setRepeat(Number(e.target.value))}
              />
            </label>
            <label>
              Grout rotation offset ({groutOffsetDeg.toFixed(0)}°)
              <input
                type="range"
                min={-45}
                max={45}
                step={1}
                value={groutOffsetDeg}
                onChange={(e) => setGroutOffsetDeg(Number(e.target.value))}
              />
            </label>
            <div className="tile-swatch">
              <img src={tileCanvas.toDataURL()} alt="Tile preview" />
            </div>
          </section>

          <section>
            <h2>Debug</h2>
            <label className="check">
              <input
                type="checkbox"
                checked={showDebug}
                onChange={(e) => setShowDebug(e.target.checked)}
              />
              Show diagnostics
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showMask}
                onChange={(e) => setShowMask(e.target.checked)}
                disabled={!showDebug}
              />
              Surface AABB
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showQuad}
                onChange={(e) => setShowQuad(e.target.checked)}
                disabled={!showDebug}
              />
              Perspective quad
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={showCorners}
                onChange={(e) => setShowCorners(e.target.checked)}
                disabled={!showDebug}
              />
              Corner handles
            </label>
          </section>

          <section>
            <h2>Images</h2>
            <p className="muted upload-hint">
              Upload a <strong>Base</strong> (PNG with transparent floor cutout)
              and a matching <strong>Demo</strong> (same size, visible grout).
            </p>
            <label className="file-btn">
              Upload Base
              <input
                type="file"
                accept="image/png,image/webp,.png,.webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onBaseFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="file-name">{baseName}</p>
            <label className="file-btn">
              Upload Demo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onDemoFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="file-name">{demoName}</p>
            <button type="button" onClick={resetToSample} disabled={busy}>
              Use sample images
            </button>
          </section>

          <section>
            <h2>Configuration</h2>
            <button type="button" onClick={() => void runDetection()} disabled={busy}>
              Reset to auto detection
            </button>
            <button
              type="button"
              onClick={revertManual}
              disabled={!manualBackup}
            >
              Revert manual edits
            </button>
          </section>

          <section className="stats">
            <h2>Detection</h2>
            {detection ? (
              <>
                <p>{detection.message}</p>
                <p>
                  Image {detection.imageSize.width}×{detection.imageSize.height}
                  {" · "}
                  {detection.durationMs.toFixed(0)} ms
                </p>
                {floor && (
                  <>
                    <p>
                      Floor confidence {(floor.confidence * 100).toFixed(0)}%
                      {floor.homography
                        ? ` · reproj ${floor.homography.reprojectionError.toFixed(2)}px`
                        : ""}
                    </p>
                    <p>
                      Grout depth{" "}
                      {floor.groutDepthAngleDeg?.toFixed(1) ?? "—"}° · rotation{" "}
                      {(floor.groutRotationDeg ?? 0).toFixed(1)}°
                    </p>
                    {floor.vanishingPoint && (
                      <p className="muted">
                        VP ({floor.vanishingPoint.x.toFixed(0)},{" "}
                        {floor.vanishingPoint.y.toFixed(0)})
                      </p>
                    )}
                  </>
                )}
                {wall ? (
                  <p>Wall confidence {(wall.confidence * 100).toFixed(0)}%</p>
                ) : (
                  <p className="muted">No wall cutout in Base (floor only).</p>
                )}
                {[...surfaces.flatMap((s) => s.warnings)].map((w) => (
                  <p key={w} className="warn">
                    {w}
                  </p>
                ))}
              </>
            ) : (
              <p className="muted">No detection yet.</p>
            )}
            {error && <p className="error">{error}</p>}
          </section>
        </aside>

        <main className="stage" ref={stageRef}>
          <div className="canvas-wrap">
            <canvas ref={previewRef} />
            {showDebug && detection && mode !== "demo" && (
              <DebugOverlay
                surfaces={surfacesForRender}
                segmented={detection.segmented}
                sourceSize={detection.imageSize}
                canvasSize={canvasSize}
                showMask={showMask}
                showCorners={showCorners}
                showQuad={showQuad}
                activeKind={floor ? "Floor" : wall ? "Wall" : null}
                onCornerDrag={onCornerDrag}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function drawChecker(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): void {
  const s = 16;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      const on = ((x / s) | 0) % 2 === ((y / s) | 0) % 2;
      ctx.fillStyle = on ? "#1a2230" : "#121821";
      ctx.fillRect(x, y, s, s);
    }
  }
}
