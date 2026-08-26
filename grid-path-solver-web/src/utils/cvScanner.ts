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
