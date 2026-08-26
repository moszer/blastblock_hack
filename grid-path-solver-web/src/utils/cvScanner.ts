export interface Point2D {
  x: number;
  y: number;
}

export interface QuadCorners {
  topLeft: Point2D;
  topRight: Point2D;
  bottomRight: Point2D;
  bottomLeft: Point2D;
}

// Global OpenCV status
let isOpenCvLoaded = false;
let isOpenCvLoading = false;

export const loadOpenCV = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(false);
      return;
    }

    if ((window as any).cv && (window as any).cv.Mat) {
      isOpenCvLoaded = true;
      resolve(true);
      return;
    }

    if (isOpenCvLoading) {
      const checkInterval = setInterval(() => {
        if ((window as any).cv && (window as any).cv.Mat) {
          clearInterval(checkInterval);
          isOpenCvLoaded = true;
          resolve(true);
        }
      }, 100);
      return;
    }

    isOpenCvLoading = true;
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
    script.async = true;
    script.onload = () => {
      // OpenCV.js takes a moment to initialize its WebAssembly runtime
      const checkRuntime = setInterval(() => {
        if ((window as any).cv && (window as any).cv.Mat) {
          clearInterval(checkRuntime);
          isOpenCvLoaded = true;
          isOpenCvLoading = false;
          resolve(true);
        }
      }, 50);
    };
    script.onerror = () => {
      isOpenCvLoading = false;
      resolve(false);
    };
    document.body.appendChild(script);
  });
};

/**
 * Order 4 points into Top-Left, Top-Right, Bottom-Right, Bottom-Left
 */
export const orderCorners = (pts: Point2D[]): QuadCorners => {
  if (pts.length !== 4) {
    throw new Error('orderCorners requires exactly 4 points');
  }

  // Sum (x + y): smallest is top-left, largest is bottom-right
  const sum = pts.map(p => ({ p, val: p.x + p.y }));
  sum.sort((a, b) => a.val - b.val);
  const topLeft = sum[0].p;
  const bottomRight = sum[3].p;

  // Diff (y - x): smallest is top-right, largest is bottom-left
  const diff = pts.map(p => ({ p, val: p.y - p.x }));
  diff.sort((a, b) => a.val - b.val);
  const topRight = diff[0].p;
  const bottomLeft = diff[3].p;

  return { topLeft, topRight, bottomRight, bottomLeft };
};

/**
 * Map normalized grid position (u, v in [0, 1]) to image coordinate (px, py)
 * using Bilinear Perspective Mapping
 */
export const mapGridToImage = (u: number, v: number, corners: QuadCorners): Point2D => {
  const { topLeft: TL, topRight: TR, bottomRight: BR, bottomLeft: BL } = corners;
  
  // Interpolate top and bottom edges
  const topX = TL.x * (1 - u) + TR.x * u;
  const topY = TL.y * (1 - u) + TR.y * u;

  const botX = BL.x * (1 - u) + BR.x * u;
  const botY = BL.y * (1 - u) + BR.y * u;

  // Interpolate between top and bottom
  const px = topX * (1 - v) + botX * v;
  const py = topY * (1 - v) + botY * v;

  return { x: px, y: py };
};

/**
 * Fast Built-in TypeScript Quad Detector (Runs 60fps with zero dependencies)
 */
export const detectQuadFast = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  expectedRatio: number
): QuadCorners | null => {
  try {
    const downW = 160;
    const downH = Math.floor((160 / width) * height);
    if (downW <= 0 || downH <= 0) return null;

    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    // Step 1: Luminance & horizontal/vertical gradient search
    // Find strongest rectangular bounding area
    const scaleX = width / downW;
    const scaleY = height / downH;

    let foundCount = 0;
    const rowHist = new Float32Array(downH);
    const colHist = new Float32Array(downW);

    for (let dy = 2; dy < downH - 2; dy++) {
      const sy = Math.floor(dy * scaleY);
      for (let dx = 2; dx < downW - 2; dx++) {
        const sx = Math.floor(dx * scaleX);
        const idx = (sy * width + sx) * 4;
        const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        
        // Edge gradient
        const idxR = (sy * width + Math.min(width - 1, sx + 2)) * 4;
        const idxB = (Math.min(height - 1, sy + 2) * width + sx) * 4;
        const bR = (data[idxR] + data[idxR + 1] + data[idxR + 2]) / 3;
        const bB = (data[idxB] + data[idxB + 1] + data[idxB + 2]) / 3;

        const grad = Math.abs(bR - b) + Math.abs(bB - b);
        if (grad > 35) {
          rowHist[dy] += grad;
          colHist[dx] += grad;
          foundCount++;
        }
      }
    }

    if (foundCount < 20) return null;

    // Find bounding box enclosing 85% of high gradient energy
    let top = 0, bottom = downH - 1, left = 0, right = downW - 1;
    let thY = 0, thX = 0;
    for (let i = 0; i < downH; i++) thY += rowHist[i];
    for (let i = 0; i < downW; i++) thX += colHist[i];

    thY = (thY / downH) * 0.7;
    thX = (thX / downW) * 0.7;

    while (top < downH && rowHist[top] < thY) top++;
    while (bottom > top && rowHist[bottom] < thY) bottom--;
    while (left < downW && colHist[left] < thX) left++;
    while (right > left && colHist[right] < thX) right--;

    const boxW = (right - left) * scaleX;
    const boxH = (bottom - top) * scaleY;
    const area = boxW * boxH;
    const totalArea = width * height;

    if (area < totalArea * 0.12 || area > totalArea * 0.95) {
      return null;
    }

    const currentRatio = boxW / boxH;
    if (Math.abs(currentRatio - expectedRatio) > 0.8) {
      // Ratio deviation too high
      return null;
    }

    return {
      topLeft: { x: left * scaleX, y: top * scaleY },
      topRight: { x: right * scaleX, y: top * scaleY },
      bottomRight: { x: right * scaleX, y: bottom * scaleY },
      bottomLeft: { x: left * scaleX, y: bottom * scaleY }
    };
  } catch (e) {
    return null;
  }
};

/**
 * OpenCV.js Quad Detector (Precise polygon contour detection & convex analysis)
 */
export const detectQuadOpenCV = (
  canvas: HTMLCanvasElement,
  expectedRatio: number
): QuadCorners | null => {
  const cv = (window as any).cv;
  if (!cv || !cv.Mat) return null;

  let src: any = null;
  let gray: any = null;
  let blur: any = null;
  let edges: any = null;
  let contours: any = null;
  let hierarchy: any = null;
  let poly: any = null;

  try {
    src = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    edges = new cv.Mat();
    cv.Canny(blur, edges, 50, 150);

    // Dilate edges slightly to close gaps
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = 0;
    let bestQuad: QuadCorners | null = null;
    const totalArea = canvas.width * canvas.height;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);

      if (area > totalArea * 0.12 && area < totalArea * 0.95 && area > maxArea) {
        const peri = cv.arcLength(cnt, true);
        poly = new cv.Mat();
        cv.approxPolyDP(cnt, poly, 0.035 * peri, true);

        if (poly.rows === 4 && cv.isContourConvex(poly)) {
          const pts: Point2D[] = [];
          for (let p = 0; p < 4; p++) {
            pts.push({
              x: poly.data32S[p * 2],
              y: poly.data32S[p * 2 + 1]
            });
          }
          const ordered = orderCorners(pts);
          const w = Math.hypot(ordered.topRight.x - ordered.topLeft.x, ordered.topRight.y - ordered.topLeft.y);
          const h = Math.hypot(ordered.bottomLeft.x - ordered.topLeft.x, ordered.bottomLeft.y - ordered.topLeft.y);
          const ratio = w / (h || 1);

          if (Math.abs(ratio - expectedRatio) < 0.9) {
            maxArea = area;
            bestQuad = ordered;
          }
        }
        poly.delete();
        poly = null;
      }
      cnt.delete();
    }

    return bestQuad;
  } catch (err) {
    console.error('OpenCV quad detection error:', err);
    return null;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blur) blur.delete();
    if (edges) edges.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
    if (poly) poly.delete();
  }
};

/**
 * Smooth detected quadrilateral across frames (Exponential Moving Average)
 */
export const smoothQuad = (
  prev: QuadCorners | null,
  curr: QuadCorners | null,
  alpha = 0.35
): QuadCorners | null => {
  if (!curr) return prev;
  if (!prev) return curr;

  const smoothPt = (p1: Point2D, p2: Point2D) => ({
    x: p1.x * (1 - alpha) + p2.x * alpha,
    y: p1.y * (1 - alpha) + p2.y * alpha
  });

  return {
    topLeft: smoothPt(prev.topLeft, curr.topLeft),
    topRight: smoothPt(prev.topRight, curr.topRight),
    bottomRight: smoothPt(prev.bottomRight, curr.bottomRight),
    bottomLeft: smoothPt(prev.bottomLeft, curr.bottomLeft)
  };
};

/**
 * Calculate jitter delta between two frames to detect stability
 */
export const getQuadMovement = (q1: QuadCorners, q2: QuadCorners): number => {
  const d1 = Math.hypot(q1.topLeft.x - q2.topLeft.x, q1.topLeft.y - q2.topLeft.y);
  const d2 = Math.hypot(q1.topRight.x - q2.topRight.x, q1.topRight.y - q2.topRight.y);
  const d3 = Math.hypot(q1.bottomRight.x - q2.bottomRight.x, q1.bottomRight.y - q2.bottomRight.y);
  const d4 = Math.hypot(q1.bottomLeft.x - q2.bottomLeft.x, q1.bottomLeft.y - q2.bottomLeft.y);
  return (d1 + d2 + d3 + d4) / 4;
};

// ---------------------------------------------------------------------------
// Block-lattice detection
//
// The board is not a solid rectangle: cells form an irregular staircase, so
// looking for one big quadrilateral fails. Instead we segment the individual
// blocks, infer the lattice (pitch + rotation) from their centers, then decide
// occupancy by sampling the mask at every lattice cell.
// ---------------------------------------------------------------------------

export interface DetectedBlock {
  r: number;
  c: number;
  cx: number;
  cy: number;
  size: number;
  color: { r: number; g: number; b: number };
  saturation: number;
  special: boolean;
}

export interface BlockGridDetection {
  rows: number;
  cols: number;
  cells: string[]; // "r,c"
  blocks: DetectedBlock[];
  origin: Point2D; // image coords of the center of cell (0, 0)
  ex: Point2D; // image vector for +1 column
  ey: Point2D; // image vector for +1 row
  startCell: { r: number; c: number } | null;
  quality: number; // 0..1, how well the blobs snap onto the lattice
}

interface Blob {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Image point of the center of lattice cell (r, c) */
export const cellCenterToImage = (det: BlockGridDetection, r: number, c: number): Point2D => ({
  x: det.origin.x + c * det.ex.x + r * det.ey.x,
  y: det.origin.y + c * det.ex.y + r * det.ey.y,
});

/** Image point of a lattice *corner*: (0,0) is the top-left of cell (0,0) */
export const cellCornerToImage = (det: BlockGridDetection, r: number, c: number): Point2D => {
  const cc = c - 0.5;
  const rr = r - 0.5;
  return {
    x: det.origin.x + cc * det.ex.x + rr * det.ey.x,
    y: det.origin.y + cc * det.ex.y + rr * det.ey.y,
  };
};

/** Collect square-ish blobs out of a binary mask */
const findBlockBlobs = (cv: any, bin: any, totalArea: number): Blob[] => {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const blobs: Blob[] = [];

  try {
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const minArea = totalArea * 0.0006;
    const maxArea = totalArea * 0.08;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minArea || area > maxArea) {
        cnt.delete();
        continue;
      }

      const rect = cv.boundingRect(cnt);
      const aspect = rect.width / (rect.height || 1);
      const fill = area / (rect.width * rect.height || 1);

      // Rounded squares: near 1:1 and they fill most of their bounding box
      if (aspect > 0.62 && aspect < 1.6 && fill > 0.65) {
        blobs.push({
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
          w: rect.width,
          h: rect.height,
        });
      }
      cnt.delete();
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }

  return blobs;
};

/** Median of a set of near-parallel vectors, with outlier rejection */
const medianVector = (vecs: Point2D[]): Point2D | null => {
  if (vecs.length < 2) return null;
  const lengths = vecs.map(v => Math.hypot(v.x, v.y));
  const typical = median(lengths);
  if (typical <= 0) return null;

  // Neighbours across a hole in the board sit 2+ cells away; drop them
  const kept = vecs.filter((_, i) => lengths[i] > typical * 0.7 && lengths[i] < typical * 1.4);
  if (kept.length < 2) return null;

  return { x: median(kept.map(v => v.x)), y: median(kept.map(v => v.y)) };
};

/**
 * Infer the lattice basis from blob centers. The two axes are estimated
 * independently so a tilted or off-axis camera (which shears the grid) still
 * fits, instead of assuming a pure rotation.
 */
const fitLattice = (blobs: Blob[]): { ex: Point2D; ey: Point2D } | null => {
  if (blobs.length < 4) return null;

  const blockSize = median(blobs.map(b => Math.max(b.w, b.h)));
  if (blockSize <= 2) return null;

  const maxNeighbor = blockSize * 2.4;
  const rightVecs: Point2D[] = [];
  const downVecs: Point2D[] = [];

  for (let i = 0; i < blobs.length; i++) {
    let bestRight: Point2D | null = null;
    let bestRightDist = Infinity;
    let bestDown: Point2D | null = null;
    let bestDownDist = Infinity;

    for (let j = 0; j < blobs.length; j++) {
      if (i === j) continue;
      const dx = blobs[j].cx - blobs[i].cx;
      const dy = blobs[j].cy - blobs[i].cy;
      const dist = Math.hypot(dx, dy);
      if (dist > maxNeighbor || dist < blockSize * 0.5) continue;

      if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.6 && dist < bestRightDist) {
        bestRightDist = dist;
        bestRight = { x: dx, y: dy };
      }
      if (dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.6 && dist < bestDownDist) {
        bestDownDist = dist;
        bestDown = { x: dx, y: dy };
      }
    }

    if (bestRight) rightVecs.push(bestRight);
    if (bestDown) downVecs.push(bestDown);
  }

  let ex = medianVector(rightVecs);
  let ey = medianVector(downVecs);

  // A single row or single column still has one usable axis
  if (!ex && ey) ex = { x: ey.y, y: -ey.x };
  if (!ey && ex) ey = { x: -ex.y, y: ex.x };
  if (!ex || !ey) return null;

  const lenX = Math.hypot(ex.x, ex.y);
  const lenY = Math.hypot(ey.x, ey.y);
  if (lenX < blockSize * 0.6 || lenY < blockSize * 0.6) return null;
  if (lenX > blockSize * 2.2 || lenY > blockSize * 2.2) return null;

  // Axes must stay roughly perpendicular and roughly horizontal / vertical,
  // otherwise we are looking at something that is not a game board.
  const cosine = (ex.x * ey.x + ex.y * ey.y) / (lenX * lenY);
  if (Math.abs(cosine) > 0.45) return null;
  if (Math.abs(ex.x) < Math.abs(ex.y)) return null;
  if (Math.abs(ey.y) < Math.abs(ey.x)) return null;

  return { ex, ey };
};

/** Convert an image point to fractional lattice coordinates */
const imageToLattice = (
  p: Point2D,
  origin: Point2D,
  ex: Point2D,
  ey: Point2D
): { r: number; c: number } | null => {
  const det = ex.x * ey.y - ey.x * ex.y;
  if (Math.abs(det) < 1e-6) return null;
  const px = p.x - origin.x;
  const py = p.y - origin.y;
  return {
    c: (px * ey.y - ey.x * py) / det,
    r: (ex.x * py - px * ex.y) / det,
  };
};

/**
 * Full auto grid detection: finds the blocks, infers the lattice, and reports
 * which lattice cells are occupied. Works on irregular / staircase boards.
 */
export const detectBlockGrid = (
  canvas: HTMLCanvasElement,
  options: { sensitivity?: number; maxDim?: number; outputScale?: number } = {}
): BlockGridDetection | null => {
  const cv = (window as any).cv;
  if (!cv || !cv.Mat) return null;
  if (!canvas.width || !canvas.height) return null;

  const sensitivity = options.sensitivity ?? 0;
  const maxDim = options.maxDim ?? 640;
  // Callers that hand us an already-shrunk frame use this to map the result
  // back onto the full-size canvas.
  const outputScale = options.outputScale ?? 1;

  let src: any = null;
  let small: any = null;
  let gray: any = null;
  let blurred: any = null;
  let bin: any = null;
  let kernel: any = null;

  try {
    src = cv.imread(canvas);

    const longest = Math.max(canvas.width, canvas.height);
    const scale = longest > maxDim ? maxDim / longest : 1;
    const sw = Math.max(1, Math.round(canvas.width * scale));
    const sh = Math.max(1, Math.round(canvas.height * scale));

    small = new cv.Mat();
    if (scale < 1) {
      cv.resize(src, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    } else {
      src.copyTo(small);
    }

    gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    bin = new cv.Mat();
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);

    const totalArea = sw * sh;
    const upscale = outputScale / scale;

    // The blocks may be lighter than the background (dark theme) or darker
    // (light theme), and glare can defeat a global threshold entirely — so try
    // each strategy until the lattice fit succeeds.
    const otsu = cv.threshold(blurred, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const passes: Array<() => void> = [
      () => cv.threshold(blurred, bin, Math.max(1, Math.min(254, otsu + sensitivity)), 255, cv.THRESH_BINARY),
      () => cv.threshold(blurred, bin, Math.max(1, Math.min(254, otsu - sensitivity)), 255, cv.THRESH_BINARY_INV),
      () =>
        cv.adaptiveThreshold(
          blurred,
          bin,
          255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY,
          Math.max(11, (Math.round(Math.min(sw, sh) / 12) | 1)),
          -6 - sensitivity / 10
        ),
    ];

    for (const applyThreshold of passes) {
      applyThreshold();
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel);

      let blobs = findBlockBlobs(cv, bin, totalArea);
      if (blobs.length < 4) {
        // Blocks that touch each other merge into one contour; erode to split
        // them apart before giving up on this threshold.
        cv.erode(bin, bin, kernel, new cv.Point(-1, -1), 2);
        blobs = findBlockBlobs(cv, bin, totalArea);
      }
      if (blobs.length < 4) continue;

      const basis = fitLattice(blobs);
      if (!basis) continue;

      const { ex, ey } = basis;

      // Snap every blob onto the lattice using the first blob as a provisional
      // origin, then re-base so the smallest index becomes 0.
      const anchor = { x: blobs[0].cx, y: blobs[0].cy };
      const indexed: Array<{ blob: Blob; r: number; c: number; err: number }> = [];
      let ok = true;

      for (const blob of blobs) {
        const lat = imageToLattice({ x: blob.cx, y: blob.cy }, anchor, ex, ey);
        if (!lat) {
          ok = false;
          break;
        }
        const r = Math.round(lat.r);
        const c = Math.round(lat.c);
        indexed.push({ blob, r, c, err: Math.max(Math.abs(lat.r - r), Math.abs(lat.c - c)) });
      }
      if (!ok) continue;

      // Blobs must actually sit on lattice nodes, otherwise this is not a grid
      if (median(indexed.map(i => i.err)) > 0.18) continue;

      let minR = Infinity;
      let minC = Infinity;
      let maxR = -Infinity;
      let maxC = -Infinity;
      for (const it of indexed) {
        if (it.r < minR) minR = it.r;
        if (it.c < minC) minC = it.c;
        if (it.r > maxR) maxR = it.r;
        if (it.c > maxC) maxC = it.c;
      }

      const rows = maxR - minR + 1;
      const cols = maxC - minC + 1;
      if (rows < 2 || cols < 2 || rows > 24 || cols > 24) continue;
      if (blobs.length > rows * cols * 1.1) continue;

      // Origin = image position of cell (0, 0) in the re-based lattice
      const origin: Point2D = {
        x: anchor.x + minC * ex.x + minR * ey.x,
        y: anchor.y + minC * ex.y + minR * ey.y,
      };

      // Occupancy pass: sample the mask at every lattice cell. This recovers
      // cells whose blobs merged together or were rejected as non-square.
      const sampleRadius = Math.max(1, Math.round(Math.min(Math.hypot(ex.x, ex.y), Math.hypot(ey.x, ey.y)) * 0.28));
      // Reading through Mat.ucharPtr costs a call per pixel and dominates the
      // whole detection; the backing buffers are plain typed arrays.
      const binData: Uint8Array = bin.data;
      const rgbaData: Uint8Array = small.data;
      const sampleStep = Math.max(1, Math.round(sampleRadius / 6));
      const cells: string[] = [];
      const blocks: DetectedBlock[] = [];
      let bestSpecial: DetectedBlock | null = null;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const px = Math.round(origin.x + c * ex.x + r * ey.x);
          const py = Math.round(origin.y + c * ex.y + r * ey.y);
          if (px < 0 || py < 0 || px >= sw || py >= sh) continue;

          let on = 0;
          let total = 0;
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;

          for (let dy = -sampleRadius; dy <= sampleRadius; dy += sampleStep) {
            const y = py + dy;
            if (y < 0 || y >= sh) continue;
            const rowStart = y * sw;
            for (let dx = -sampleRadius; dx <= sampleRadius; dx += sampleStep) {
              const x = px + dx;
              if (x < 0 || x >= sw) continue;
              total++;
              const idx = rowStart + x;
              if (binData[idx] > 127) on++;
              const rgba = idx * 4;
              sumR += rgbaData[rgba];
              sumG += rgbaData[rgba + 1];
              sumB += rgbaData[rgba + 2];
            }
          }

          if (total === 0 || on / total < 0.55) continue;

          const cr = sumR / total;
          const cg = sumG / total;
          const cb = sumB / total;
          const maxCh = Math.max(cr, cg, cb);
          const minCh = Math.min(cr, cg, cb);
          const saturation = maxCh > 0 ? (maxCh - minCh) / maxCh : 0;

          const block: DetectedBlock = {
            r,
            c,
            cx: px * upscale,
            cy: py * upscale,
            size: Math.hypot(ex.x, ex.y) * upscale,
            color: { r: cr, g: cg, b: cb },
            saturation,
            special: false,
          };

          cells.push(`${r},${c}`);
          blocks.push(block);
        }
      }

      if (cells.length < 4) continue;

      // The start cell is the vividly coloured (usually green) block; ordinary
      // blocks are near-grey, so a high-saturation outlier stands out.
      const baseSaturation = median(blocks.map(b => b.saturation));
      for (const block of blocks) {
        if (block.saturation > Math.max(0.22, baseSaturation + 0.15)) {
          if (!bestSpecial || block.saturation > bestSpecial.saturation) bestSpecial = block;
        }
      }
      if (bestSpecial) bestSpecial.special = true;

      const quality = Math.max(0, 1 - median(indexed.map(i => i.err)) / 0.18);

      return {
        rows,
        cols,
        cells,
        blocks,
        origin: { x: origin.x * upscale, y: origin.y * upscale },
        ex: { x: ex.x * upscale, y: ex.y * upscale },
        ey: { x: ey.x * upscale, y: ey.y * upscale },
        startCell: bestSpecial ? { r: bestSpecial.r, c: bestSpecial.c } : null,
        quality,
      };
    }

    return null;
  } catch (err) {
    console.error('detectBlockGrid error:', err);
    return null;
  } finally {
    if (src) src.delete();
    if (small) small.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (bin) bin.delete();
    if (kernel) kernel.delete();
  }
};

/** Stable signature of a detection, used to decide when the scan has settled */
export const detectionSignature = (det: BlockGridDetection): string =>
  `${det.rows}x${det.cols}|${[...det.cells].sort().join(';')}`;
