/**
 * Procedural tile textures for local demos (no backend tile catalog).
 */

export type TilePreset = "marble" | "slate" | "terracotta" | "checker";

export function createTileTexture(
  preset: TilePreset,
  size = 256
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable for tile texture");

  const grout = 6;
  const cell = size;

  switch (preset) {
    case "checker": {
      ctx.fillStyle = "#d9d2c5";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#8a8478";
      ctx.fillRect(0, 0, size / 2, size / 2);
      ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
      strokeGrout(ctx, size, grout, "#ebe6dc");
      break;
    }
    case "slate": {
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, "#4a5560");
      g.addColorStop(0.5, "#3a434c");
      g.addColorStop(1, "#2f363e");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cell, cell);
      noise(ctx, size, 0.08);
      strokeGrout(ctx, size, grout, "#1e242a");
      break;
    }
    case "terracotta": {
      ctx.fillStyle = "#c56a3c";
      ctx.fillRect(0, 0, cell, cell);
      const g = ctx.createRadialGradient(
        size * 0.35,
        size * 0.35,
        4,
        size * 0.5,
        size * 0.5,
        size * 0.7
      );
      g.addColorStop(0, "#d88252");
      g.addColorStop(1, "#b45a30");
      ctx.fillStyle = g;
      ctx.fillRect(grout, grout, size - grout * 2, size - grout * 2);
      noise(ctx, size, 0.05);
      strokeGrout(ctx, size, grout, "#e8d8c8");
      break;
    }
    case "marble":
    default: {
      ctx.fillStyle = "#f2efe8";
      ctx.fillRect(0, 0, cell, cell);
      // Soft veins
      ctx.strokeStyle = "rgba(160,150,140,0.45)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        const y0 = (size * (i + 1)) / 8;
        ctx.moveTo(0, y0 + Math.sin(i) * 10);
        ctx.bezierCurveTo(
          size * 0.3,
          y0 + 30 * Math.sin(i * 1.7),
          size * 0.7,
          y0 - 25 * Math.cos(i),
          size,
          y0 + 12 * Math.sin(i * 0.8)
        );
        ctx.stroke();
      }
      noise(ctx, size, 0.04);
      strokeGrout(ctx, size, grout, "#e6e0d6");
      break;
    }
  }

  return canvas;
}

function strokeGrout(
  ctx: CanvasRenderingContext2D,
  size: number,
  grout: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = grout;
  ctx.strokeRect(grout / 2, grout / 2, size - grout, size - grout);
}

function noise(
  ctx: CanvasRenderingContext2D,
  size: number,
  amount: number
): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 255 * amount;
    d[i] = clampByte(d[i] + n);
    d[i + 1] = clampByte(d[i + 1] + n);
    d[i + 2] = clampByte(d[i + 2] + n);
  }
  ctx.putImageData(img, 0, 0);
}

function clampByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}
