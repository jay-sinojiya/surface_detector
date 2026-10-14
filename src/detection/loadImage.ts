export type LoadedImage = {
  image: HTMLImageElement;
  width: number;
  height: number;
  data: ImageData;
};

/**
 * Load an image URL into HTMLImageElement + ImageData.
 * Preserves original pixel dimensions (no stretch).
 */
export async function loadImageData(url: string): Promise<LoadedImage> {
  const image = await loadHtmlImage(url);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width < 2 || height < 2) {
    throw new Error("Image is too small for surface detection");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  return { image, width, height, data };
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      image.crossOrigin = "anonymous";
    }
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
}

/** Analyze alpha / channel stats without assuming black = transparent. */
export function analyzeAlphaChannel(data: ImageData): {
  hasAlpha: boolean;
  fullyTransparent: number;
  fullyOpaque: number;
  partial: number;
  meanAlpha: number;
  nearBlackOpaque: number;
} {
  const src = data.data;
  let fullyTransparent = 0;
  let fullyOpaque = 0;
  let partial = 0;
  let alphaSum = 0;
  let nearBlackOpaque = 0;
  const n = data.width * data.height;

  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    alphaSum += a;
    if (a === 0) fullyTransparent++;
    else if (a === 255) {
      fullyOpaque++;
      const lum = (src[i] + src[i + 1] + src[i + 2]) / 3;
      if (lum < 18) nearBlackOpaque++;
    } else partial++;
  }

  return {
    hasAlpha: fullyTransparent + partial > 0,
    fullyTransparent,
    fullyOpaque,
    partial,
    meanAlpha: alphaSum / Math.max(1, n),
    nearBlackOpaque,
  };
}
