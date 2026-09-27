/** Grayscale image helpers shared by the neck tracker and hand detector. */

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major luminance, 0..255. */
  data: Float32Array;
}

export function grayFromRgba(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { width, height, data };
}

/** Bilinear sample; NaN outside the image. */
export function sample(img: GrayImage, x: number, y: number): number {
  if (!(x >= 0 && y >= 0 && x <= img.width - 1 && y <= img.height - 1)) return NaN;
  const x0 = Math.min(img.width - 2, Math.floor(x));
  const y0 = Math.min(img.height - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * img.width + x0;
  const d = img.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + img.width] * (1 - fx) + d[i + img.width + 1] * fx) * fy;
}

/** Half-resolution copy (2×2 box filter). */
export function downsample(img: GrayImage): GrayImage {
  const width = Math.max(1, img.width >> 1);
  const height = Math.max(1, img.height >> 1);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 2 * y * img.width + 2 * x;
      data[y * width + x] = 0.25 * (img.data[i] + img.data[i + 1] + img.data[i + img.width] + img.data[i + img.width + 1]);
    }
  }
  return { width, height, data };
}

/** Separable 3-tap blur ([1 2 1]/4), used before computing gradients. */
export function blur(img: GrayImage): GrayImage {
  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = img.data[x > 0 ? i - 1 : i];
      const r = img.data[x < w - 1 ? i + 1 : i];
      tmp[i] = 0.25 * l + 0.5 * img.data[i] + 0.25 * r;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = tmp[y > 0 ? i - w : i];
      const d = tmp[y < h - 1 ? i + w : i];
      out[i] = 0.25 * u + 0.5 * tmp[i] + 0.25 * d;
    }
  }
  return { width: w, height: h, data: out };
}

/** Image pyramid: level 0 is the (lightly blurred) input, each next level is half size. */
export function pyramid(img: GrayImage, levels: number): GrayImage[] {
  const out = [blur(img)];
  for (let l = 1; l < levels; l++) out.push(blur(downsample(out[l - 1])));
  return out;
}
