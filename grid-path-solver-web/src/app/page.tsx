"use client";

import { useState, useCallback, useEffect, useRef } from 'react';
import { Point, PointStr, toStr, fromStr, solveHamiltonianPath } from '@/utils/solver';
import { 
  loadOpenCV, 
  detectQuadOpenCV, 
  detectQuadFast, 
  smoothQuad, 
  getQuadMovement, 
  mapGridToImage, 
  detectBlockGrid,
  detectionSignature,
  cellCornerToImage,
  QuadCorners,
  BlockGridDetection
} from '@/utils/cvScanner';

// Default layout from original Python code
const defaultLayout: Record<number, number[]> = {
  0: [1, 2, 3, 4, 5, 6],
  1: [1, 2, 3, 4, 5, 6, 7],
  2: [1, 2, 3, 4, 6, 7],
  3: [2, 4, 5, 6, 7],
  4: [2, 3, 4, 5, 6, 7],
  5: [2, 3, 4, 5, 6, 7],
  6: [1, 2, 3, 4, 5, 6],
  7: [1, 2, 3, 4, 5, 6],
  8: [0, 1],
};

const initialActive = new Set<PointStr>();
for (const [rStr, cols] of Object.entries(defaultLayout)) {
  const r = parseInt(rStr, 10);
  for (const c of cols) {
    initialActive.add(toStr({ r, c }));
  }
}

// Fixed dimensions for SVG line calculations
const CELL_SIZE = 48; // w-12 = 3rem = 48px
const GAP = 6;
const PAD = 32; // p-8 = 2rem = 32px

// Global AudioContext for sound effects
let audioCtx: AudioContext | null = null;
const playSound = (type: 'add' | 'remove' | 'start' | 'end' | 'solve' | 'error') => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    const t = audioCtx.currentTime;
    if (type === 'add') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(400, t);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.05);
      gainNode.gain.setValueAtTime(0.1, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.start();
      osc.stop(t + 0.05);
    } else if (type === 'remove') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.exponentialRampToValueAtTime(150, t + 0.05);
      gainNode.gain.setValueAtTime(0.1, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.start();
      osc.stop(t + 0.05);
    } else if (type === 'start' || type === 'end') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(type === 'start' ? 880 : 660, t);
      gainNode.gain.setValueAtTime(0.1, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.start();
      osc.stop(t + 0.1);
    } else if (type === 'solve') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.setValueAtTime(554, t + 0.1);
      osc.frequency.setValueAtTime(659, t + 0.2);
      gainNode.gain.setValueAtTime(0.05, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.start();
      osc.stop(t + 0.4);
    } else if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, t);
      osc.frequency.exponentialRampToValueAtTime(100, t + 0.3);
      gainNode.gain.setValueAtTime(0.1, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start();
      osc.stop(t + 0.3);
    }
  } catch (e) {
    console.error("Audio playback failed", e);
  }
};

export default function GridPathSolver() {
  const [rows, setRows] = useState(9);
  const [cols, setCols] = useState(8);
  const [activeCells, setActiveCells] = useState<Set<PointStr>>(initialActive);
  const [start, setStart] = useState<PointStr | null>(toStr({ r: 1, c: 2 }));
  const [end, setEnd] = useState<PointStr | null>(null);
  const [solution, setSolution] = useState<PointStr[] | null>(null);
  const [status, setStatus] = useState("Ready");
  const [toolMode, setToolMode] = useState<'paint' | 'start' | 'end'>('paint');
  const [scale, setScale] = useState(1);
  
  // Drag state
  const dragMode = useRef<'add' | 'remove' | null>(null);
  const dragSeen = useRef<Set<PointStr>>(new Set());
  const lastTouchTime = useRef<number>(0);
  
  // Camera state & real-time grid adjustments
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [scanMode, setScanMode] = useState<'auto' | 'manual'>('auto');
  const [autoSnap, setAutoSnap] = useState(true);
  const [cvReady, setCvReady] = useState(false);
  const [detectionStatus, setDetectionStatus] = useState<'searching' | 'tracking' | 'locked'>('searching');
  const [lockProgress, setLockProgress] = useState(0);

  const [scanScale, setScanScale] = useState(1.0);
  const [scanWidthScale, setScanWidthScale] = useState(1.0);
  const [scanHeightScale, setScanHeightScale] = useState(1.0);
  const [scanOffsetX, setScanOffsetX] = useState(0);
  const [scanOffsetY, setScanOffsetY] = useState(0);
  const [scanSensitivity, setScanSensitivity] = useState(0);
  const [liveDetectedCount, setLiveDetectedCount] = useState(0);
  const [showAdvancedScan, setShowAdvancedScan] = useState(false);

  const scanModeRef = useRef<'auto' | 'manual'>('auto');
  scanModeRef.current = scanMode;
  const autoSnapRef = useRef(true);
  autoSnapRef.current = autoSnap;

  const lastDetectedQuadRef = useRef<QuadCorners | null>(null);
  const stabilityFramesRef = useRef<number>(0);

  // Block-lattice detection (primary auto mode)
  const [detectedGrid, setDetectedGrid] = useState<{ rows: number; cols: number } | null>(null);
  const blockDetRef = useRef<BlockGridDetection | null>(null);
  const lastBlockScanRef = useRef<number>(0);
  const blockSigRef = useRef<string>('');
  const blockStableRef = useRef<number>(0);
  const blockMissRef = useRef<number>(0);
  const pendingGridRef = useRef<{ rows: number; cols: number; start: PointStr | null } | null>(null);

  const BLOCK_LOCK_FRAMES = 6;

  // Frame rotation: some browsers hand back a landscape track even when the
  // device is upright, so the frame is rotated on the way into the canvas.
  const [frameRotation, setFrameRotation] = useState(0);
  const frameRotationRef = useRef(0);
  frameRotationRef.current = frameRotation;
  const uiPortraitRef = useRef(true);
  const autoRotationDoneRef = useRef(false);
  const autoCapturedRef = useRef<boolean>(false);
  const searchRadarAngleRef = useRef<number>(0);

  const scanParamsRef = useRef({
    scale: 1.0,
    widthScale: 1.0,
    heightScale: 1.0,
    offsetX: 0,
    offsetY: 0,
    sensitivity: 0,
  });

  const lastCountUpdateRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const liveCellsRef = useRef<Set<PointStr>>(new Set());

  // Load OpenCV.js asynchronously on mount
  useEffect(() => {
    loadOpenCV().then(ready => {
      if (ready) setCvReady(true);
    });
  }, []);

  // Gestures ref
  const touchStateRef = useRef<{
    startX: number;
    startY: number;
    initialOffsetX: number;
    initialOffsetY: number;
    initialDistance: number;
    initialScale: number;
    isDragging: boolean;
    isPinching: boolean;
    lastTapTime: number;
  }>({
    startX: 0,
    startY: 0,
    initialOffsetX: 0,
    initialOffsetY: 0,
    initialDistance: 0,
    initialScale: 1.0,
    isDragging: false,
    isPinching: false,
    lastTapTime: 0,
  });

  // Helper to sync scan params real-time
  const setScanParam = (key: keyof typeof scanParamsRef.current, value: number) => {
    scanParamsRef.current[key] = value;
    if (key === 'scale') setScanScale(value);
    else if (key === 'widthScale') setScanWidthScale(value);
    else if (key === 'heightScale') setScanHeightScale(value);
    else if (key === 'offsetX') setScanOffsetX(value);
    else if (key === 'offsetY') setScanOffsetY(value);
    else if (key === 'sensitivity') setScanSensitivity(value);
  };

  const resetScanParams = () => {
    scanParamsRef.current = {
      scale: 1.0,
      widthScale: 1.0,
      heightScale: 1.0,
      offsetX: 0,
      offsetY: 0,
      sensitivity: 0,
    };
    setScanScale(1.0);
    setScanWidthScale(1.0);
    setScanHeightScale(1.0);
    setScanOffsetX(0);
    setScanOffsetY(0);
    setScanSensitivity(0);
  };

  // Particles state
  const particleCanvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<any[]>([]);

  // Particle Loop
  useEffect(() => {
    let animId: number;
    const canvas = particleCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    
    const loop = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life--;
        
        if (p.life <= 0) {
          particlesRef.current.splice(i, 1);
          continue;
        }
        
        const alpha = p.life / p.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        ctx.fill();
      }
      
      animId = requestAnimationFrame(loop);
    };
    loop();
    
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const spawnParticles = (x: number, y: number, color: string) => {
    for (let i = 0; i < 4; i++) {
      particlesRef.current.push({
        x: x + (Math.random() - 0.5) * 15,
        y: y + (Math.random() - 0.5) * 15,
        vx: (Math.random() - 0.5) * 5,
        vy: (Math.random() - 0.5) * 5,
        life: 20 + Math.random() * 20,
        maxLife: 40,
        color: color,
        size: 3 + Math.random() * 5
      });
    }
  };

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!dragMode.current) return;
      let x = 0, y = 0;
      if ('touches' in e) {
        x = e.touches[0].clientX;
        y = e.touches[0].clientY;
      } else {
        x = e.clientX;
        y = e.clientY;
      }
      const color = dragMode.current === 'add' ? '#7db8f5' : '#ff4d4f';
      spawnParticles(x, y, color);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('touchmove', handleMove);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('touchmove', handleMove);
    };
  }, []);

  // Resize effect for responsiveness
  useEffect(() => {
    const updateScale = () => {
      const maxWidth = window.innerWidth - 32; // 16px padding on sides
      const gridTotalWidth = PAD * 2 + cols * CELL_SIZE + (cols - 1) * GAP;
      if (gridTotalWidth > maxWidth) {
        setScale(maxWidth / gridTotalWidth);
      } else {
        setScale(1);
      }
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [cols, rows]);

  // Handlers
  const handleCellDown = (r: number, c: number, e?: React.MouseEvent | React.TouchEvent) => {
    if (e && e.type === 'touchstart') {
      lastTouchTime.current = Date.now();
    } else if (e && e.type === 'mousedown') {
      if (Date.now() - lastTouchTime.current < 500) {
        return; // Ignore synthetic mousedown
      }
    }

    if (e && e.cancelable) e.preventDefault(); 
    const pStr = toStr({ r, c });
    
    if (toolMode === 'start' || (e && 'button' in e && e.button === 2)) {
      if (activeCells.has(pStr)) {
        setStart(pStr);
        setSolution(null);
        playSound('start');
      }
      if (toolMode === 'start') setToolMode('paint');
      return;
    }
    
    if (toolMode === 'end' || (e && 'shiftKey' in e && e.shiftKey) || (e && 'button' in e && e.button === 1)) {
      if (activeCells.has(pStr)) {
        setEnd(prev => prev === pStr ? null : pStr);
        setSolution(null);
        playSound('end');
      }
      if (toolMode === 'end') setToolMode('paint');
      return;
    }

    if (!e || ('button' in e && e.button === 0) || ('touches' in e)) {
      const mode = activeCells.has(pStr) ? 'remove' : 'add';
      dragMode.current = mode;
      dragSeen.current = new Set([pStr]);
      paintCell(pStr, mode);
    }
  };

  const handleCellEnter = (r: number, c: number) => {
    if (!dragMode.current) return;
    const pStr = toStr({ r, c });
    if (dragSeen.current.has(pStr)) return;
    dragSeen.current.add(pStr);
    paintCell(pStr, dragMode.current);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!dragMode.current) return;
    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const rAttr = el?.getAttribute('data-r');
    const cAttr = el?.getAttribute('data-c');
    if (rAttr != null && cAttr != null) {
      const r = parseInt(rAttr, 10);
      const c = parseInt(cAttr, 10);
      const pStr = toStr({ r, c });
      if (!dragSeen.current.has(pStr)) {
        dragSeen.current.add(pStr);
        paintCell(pStr, dragMode.current);
      }
    }
  };

  const handleGlobalUp = useCallback(() => {
    dragMode.current = null;
    dragSeen.current.clear();
  }, []);

  useEffect(() => {
    window.addEventListener('mouseup', handleGlobalUp);
    window.addEventListener('touchend', handleGlobalUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalUp);
      window.removeEventListener('touchend', handleGlobalUp);
    };
  }, [handleGlobalUp]);

  const paintCell = (pStr: PointStr, mode: 'add' | 'remove') => {
    setActiveCells(prev => {
      const isChanging = mode === 'add' ? !prev.has(pStr) : prev.has(pStr);
      if (isChanging) {
        playSound(mode);
      }

      const next = new Set(prev);
      if (mode === 'add') {
        next.add(pStr);
      } else {
        next.delete(pStr);
        if (start === pStr) setStart(null);
        if (end === pStr) setEnd(null);
      }
      return next;
    });
    setSolution(null);
  };

  // Actions
  const handleResize = (newRows: number, newCols: number) => {
    setRows(newRows);
    setCols(newCols);
    setActiveCells(prev => {
      const next = new Set<PointStr>();
      for (const pStr of prev) {
        const p = fromStr(pStr);
        if (p.r < newRows && p.c < newCols) {
          next.add(pStr);
        }
      }
      return next;
    });
    if (start) {
      const p = fromStr(start);
      if (p.r >= newRows || p.c >= newCols) setStart(null);
    }
    if (end) {
      const p = fromStr(end);
      if (p.r >= newRows || p.c >= newCols) setEnd(null);
    }
    setSolution(null);
  };

  const fillAll = () => {
    const next = new Set<PointStr>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        next.add(toStr({ r, c }));
      }
    }
    setActiveCells(next);
    setSolution(null);
  };

  const clearAll = () => {
    setActiveCells(new Set());
    setStart(null);
    setEnd(null);
    setSolution(null);
  };

  const clearEndpoints = () => {
    setStart(null);
    setEnd(null);
    setSolution(null);
  };

  const resetDetectorState = () => {
    blockDetRef.current = null;
    blockSigRef.current = '';
    blockStableRef.current = 0;
    blockMissRef.current = 0;
    lastBlockScanRef.current = 0;
    pendingGridRef.current = null;
    lastDetectedQuadRef.current = null;
    stabilityFramesRef.current = 0;
    liveCellsRef.current = new Set();
    autoRotationDoneRef.current = false;
    setDetectedGrid(null);
    setLiveDetectedCount(0);
    setLockProgress(0);
    setDetectionStatus('searching');
  };

  const startCamera = async (overrideFacing?: 'environment' | 'user') => {
    resetDetectorState();
    setIsCameraActive(true);
    const targetFacing = (overrideFacing === 'environment' || overrideFacing === 'user') ? overrideFacing : facingMode;
    try {
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
      }

      // Match the stream to how the device is being held: asking for a
      // landscape frame on a phone held upright letterboxes the preview into a
      // thin strip and wastes most of the screen.
      const portrait = window.innerHeight >= window.innerWidth;
      uiPortraitRef.current = portrait;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: targetFacing,
          width: { ideal: portrait ? 1080 : 1920 },
          height: { ideal: portrait ? 1920 : 1080 },
          aspectRatio: { ideal: portrait ? 9 / 16 : 16 / 9 },
        }
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      // Some browsers ignore the ideal size and hand back a landscape track
      // anyway; ask the track itself to switch once it is running.
      if (portrait) {
        const [track] = stream.getVideoTracks();
        const settings = track?.getSettings?.();
        if (track && settings && (settings.width ?? 0) > (settings.height ?? 0)) {
          try {
            await track.applyConstraints({ aspectRatio: { ideal: 9 / 16 } });
          } catch {
            // Camera cannot deliver a portrait frame; the preview still works
          }
        }
      }

      processVideo();
    } catch (err) {
      alert("Could not access camera: " + err);
      setIsCameraActive(false);
    }
  };

  const toggleCamera = () => {
    const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextFacing);
    startCamera(nextFacing);
  };

  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    setIsCameraActive(false);
  };

  // Viewport Touch Gestures
  const handleCamTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - touchStateRef.current.lastTapTime < 350) {
        // Double tap -> reset position & scale
        resetScanParams();
        touchStateRef.current.lastTapTime = 0;
        return;
      }
      touchStateRef.current.lastTapTime = now;
      touchStateRef.current.startX = e.touches[0].clientX;
      touchStateRef.current.startY = e.touches[0].clientY;
      touchStateRef.current.initialOffsetX = scanParamsRef.current.offsetX;
      touchStateRef.current.initialOffsetY = scanParamsRef.current.offsetY;
      touchStateRef.current.isDragging = true;
      touchStateRef.current.isPinching = false;
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchStateRef.current.initialDistance = dist;
      touchStateRef.current.initialScale = scanParamsRef.current.scale;
      touchStateRef.current.isPinching = true;
      touchStateRef.current.isDragging = false;
    }
  };

  const handleCamTouchMove = (e: React.TouchEvent) => {
    if (touchStateRef.current.isPinching && e.touches.length >= 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (touchStateRef.current.initialDistance > 0) {
        const factor = dist / touchStateRef.current.initialDistance;
        const newScale = Math.min(Math.max(touchStateRef.current.initialScale * factor, 0.25), 2.5);
        setScanParam('scale', parseFloat(newScale.toFixed(2)));
      }
    } else if (touchStateRef.current.isDragging && e.touches.length === 1) {
      const dx = e.touches[0].clientX - touchStateRef.current.startX;
      const dy = e.touches[0].clientY - touchStateRef.current.startY;
      const newOffX = Math.min(Math.max(touchStateRef.current.initialOffsetX + (dx / (window.innerWidth || 400)), -0.6), 0.6);
      const newOffY = Math.min(Math.max(touchStateRef.current.initialOffsetY + (dy / (window.innerHeight || 600)), -0.6), 0.6);
      setScanParam('offsetX', parseFloat(newOffX.toFixed(3)));
      setScanParam('offsetY', parseFloat(newOffY.toFixed(3)));
    }
  };

  const handleCamTouchEnd = () => {
    touchStateRef.current.isDragging = false;
    touchStateRef.current.isPinching = false;
  };

  // Mouse drag & scroll zoom support for desktop
  const isMouseDownRef = useRef(false);
  const mouseStartRef = useRef({ x: 0, y: 0, offX: 0, offY: 0 });

  const handleCamMouseDown = (e: React.MouseEvent) => {
    isMouseDownRef.current = true;
    mouseStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offX: scanParamsRef.current.offsetX,
      offY: scanParamsRef.current.offsetY,
    };
  };

  const handleCamMouseMove = (e: React.MouseEvent) => {
    if (!isMouseDownRef.current) return;
    const dx = e.clientX - mouseStartRef.current.x;
    const dy = e.clientY - mouseStartRef.current.y;
    const newOffX = Math.min(Math.max(mouseStartRef.current.offX + (dx / (window.innerWidth || 800)), -0.6), 0.6);
    const newOffY = Math.min(Math.max(mouseStartRef.current.offY + (dy / (window.innerHeight || 800)), -0.6), 0.6);
    setScanParam('offsetX', parseFloat(newOffX.toFixed(3)));
    setScanParam('offsetY', parseFloat(newOffY.toFixed(3)));
  };

  const handleCamMouseUp = () => {
    isMouseDownRef.current = false;
  };

  const handleCamWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    const newScale = Math.min(Math.max(scanParamsRef.current.scale + delta, 0.25), 2.5);
    setScanParam('scale', parseFloat(newScale.toFixed(2)));
  };

  /**
   * Draw the live OpenCV preview: detected blocks, the inferred lattice and
   * the auto-detected start cell.
   */
  const drawBlockOverlay = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    det: BlockGridDetection,
    stable: number
  ) => {
    const locked = stable >= BLOCK_LOCK_FRAMES;
    const accent = locked ? '#22c55e' : '#38bdf8';
    const unit = Math.hypot(det.ex.x, det.ex.y);
    const lineW = Math.max(1.5, canvas.width / 900);

    ctx.save();

    // Lattice
    ctx.strokeStyle = locked ? 'rgba(34, 197, 94, 0.45)' : 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = lineW;
    for (let r = 0; r <= det.rows; r++) {
      const a = cellCornerToImage(det, r, 0);
      const b = cellCornerToImage(det, r, det.cols);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let c = 0; c <= det.cols; c++) {
      const a = cellCornerToImage(det, 0, c);
      const b = cellCornerToImage(det, det.rows, c);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Detected blocks
    const half = unit * 0.38;
    for (const block of det.blocks) {
      ctx.fillStyle = locked ? 'rgba(34, 197, 94, 0.28)' : 'rgba(56, 189, 248, 0.26)';
      ctx.strokeStyle = accent;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      const radius = Math.max(2, half * 0.35);
      const x = block.cx - half;
      const y = block.cy - half;
      const size = half * 2;
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, size, size, radius);
      } else {
        ctx.rect(x, y, size, size);
      }
      ctx.fill();
      ctx.stroke();
    }

    // Auto-detected start cell
    if (det.startCell) {
      const startBlock = det.blocks.find(b => b.r === det.startCell!.r && b.c === det.startCell!.c);
      if (startBlock) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = lineW * 2.2;
        ctx.shadowColor = '#facc15';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(startBlock.cx, startBlock.cy, half * 1.05, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#facc15';
        ctx.font = `bold ${Math.max(12, Math.round(unit * 0.34))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('START', startBlock.cx, startBlock.cy - half * 1.4);
      }
    }

    // Outer bracket + readout
    const tl = cellCornerToImage(det, 0, 0);
    const tr = cellCornerToImage(det, 0, det.cols);
    const br = cellCornerToImage(det, det.rows, det.cols);
    const bl = cellCornerToImage(det, det.rows, 0);
    ctx.strokeStyle = accent;
    ctx.lineWidth = lineW * 2.4;
    ctx.shadowColor = accent;
    ctx.shadowBlur = locked ? 16 : 6;
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;

    const label = `${det.rows} x ${det.cols}  -  ${det.cells.length} blocks`;
    const fontSize = Math.max(14, Math.round(canvas.width / 42));
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    const textW = ctx.measureText(label).width;
    const boxX = Math.max(8, Math.min(tl.x, bl.x));
    const boxY = Math.max(fontSize * 1.8, Math.min(tl.y, tr.y) - fontSize * 1.6);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(boxX - 8, boxY - fontSize, textW + 16, fontSize * 1.5);
    ctx.fillStyle = accent;
    ctx.fillText(label, boxX, boxY + fontSize * 0.2);

    ctx.restore();
  };

  /**
   * Primary auto mode: segment the individual blocks with OpenCV and infer the
   * grid from them, so boards that are not a solid rectangle still work.
   * Returns whether the frame was handled (and whether it triggered a capture).
   */
  const runBlockDetection = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    now: number
  ): 'captured' | 'handled' | 'none' => {
    const cv = (window as any).cv;
    if (!cv || !cv.Mat) return 'none';

    // Detection is the expensive part; the overlay is redrawn every frame from
    // the latest result so the preview stays smooth.
    if (now - lastBlockScanRef.current > 90) {
      lastBlockScanRef.current = now;
      const det = detectBlockGrid(canvas, { sensitivity: scanParamsRef.current.sensitivity });

      if (det) {
        const sig = detectionSignature(det);
        if (sig === blockSigRef.current) {
          blockStableRef.current = Math.min(20, blockStableRef.current + 1);
        } else {
          blockSigRef.current = sig;
          blockStableRef.current = 1;
        }
        blockDetRef.current = det;
        blockMissRef.current = 0;
      } else {
        blockMissRef.current += 1;
        blockStableRef.current = Math.max(0, blockStableRef.current - 1);
        if (blockMissRef.current > 5) {
          blockDetRef.current = null;
          blockSigRef.current = '';
          blockStableRef.current = 0;
        }
      }
    }

    const det = blockDetRef.current;
    if (!det) return 'none';

    const stable = blockStableRef.current;
    const locked = stable >= BLOCK_LOCK_FRAMES;
    drawBlockOverlay(ctx, canvas, det, stable);

    liveCellsRef.current = new Set(det.cells as PointStr[]);
    pendingGridRef.current = {
      rows: det.rows,
      cols: det.cols,
      start: det.startCell ? toStr(det.startCell) : null,
    };

    if (now - lastCountUpdateRef.current > 120) {
      lastCountUpdateRef.current = now;
      setLiveDetectedCount(det.cells.length);
      setLockProgress(Math.min(100, Math.round((stable / BLOCK_LOCK_FRAMES) * 100)));
      setDetectionStatus(locked ? 'locked' : 'tracking');
      setDetectedGrid({ rows: det.rows, cols: det.cols });
    }

    if (locked && autoSnapRef.current && !autoCapturedRef.current) {
      autoCapturedRef.current = true;
      confirmScan();
      return 'captured';
    }

    return 'handled';
  };

  const processVideo = () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;

      // A landscape track on an upright device gets turned a quarter turn so
      // the preview fills the screen the way the user is holding it.
      if (!autoRotationDoneRef.current && vw > 0 && vh > 0) {
        autoRotationDoneRef.current = true;
        if (uiPortraitRef.current && vw > vh) {
          setFrameRotation(90);
          frameRotationRef.current = 90;
        }
      }

      const rotation = frameRotationRef.current;
      const quarterTurn = rotation === 90 || rotation === 270;
      canvas.width = quarterTurn ? vh : vw;
      canvas.height = quarterTurn ? vw : vh;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.save();
        if (rotation === 90) {
          ctx.translate(canvas.width, 0);
          ctx.rotate(Math.PI / 2);
        } else if (rotation === 180) {
          ctx.translate(canvas.width, canvas.height);
          ctx.rotate(Math.PI);
        } else if (rotation === 270) {
          ctx.translate(0, canvas.height);
          ctx.rotate(-Math.PI / 2);
        }
        ctx.drawImage(video, 0, 0, vw, vh);
        ctx.restore();

        const now = Date.now();

        if (scanModeRef.current === 'auto') {
          // --- BLOCK-LATTICE DETECTION (preferred) ---
          const blockResult = runBlockDetection(ctx, canvas, now);
          if (blockResult === 'captured') return;
          if (blockResult === 'handled') {
            animationRef.current = requestAnimationFrame(processVideo);
            return;
          }

          // --- FALLBACK: whole-board quad detection ---
          const expectedRatio = cols / rows;
          let detected: QuadCorners | null = null;

          if ((window as any).cv && (window as any).cv.Mat) {
            detected = detectQuadOpenCV(canvas, expectedRatio);
          }
          if (!detected) {
            detected = detectQuadFast(ctx, canvas.width, canvas.height, expectedRatio);
          }

          if (detected) {
            const smoothed = smoothQuad(lastDetectedQuadRef.current, detected, 0.35);
            if (lastDetectedQuadRef.current && smoothed) {
              const movement = getQuadMovement(lastDetectedQuadRef.current, smoothed);
              if (movement < 8) {
                stabilityFramesRef.current = Math.min(25, stabilityFramesRef.current + 1);
              } else {
                stabilityFramesRef.current = Math.max(0, stabilityFramesRef.current - 2);
              }
            } else {
              stabilityFramesRef.current = 1;
            }
            lastDetectedQuadRef.current = smoothed;
          } else {
            stabilityFramesRef.current = Math.max(0, stabilityFramesRef.current - 1);
          }

          const quad = lastDetectedQuadRef.current;
          const stability = stabilityFramesRef.current;
          const isLocked = stability >= 16;
          const isTracking = !!quad && stability > 0;
          const progress = Math.min(100, Math.round((stability / 16) * 100));

          if (now - lastCountUpdateRef.current > 120) {
            lastCountUpdateRef.current = now;
            setLockProgress(progress);
            setDetectionStatus(isLocked ? 'locked' : isTracking ? 'tracking' : 'searching');
          }

          if (quad && isTracking) {
            // Draw Tracking Bounding Quadrilateral
            const strokeColor = isLocked ? '#22c55e' : '#38bdf8';
            ctx.save();
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isLocked ? 4 : 2.5;
            ctx.shadowColor = strokeColor;
            ctx.shadowBlur = isLocked ? 16 : 8;

            ctx.beginPath();
            ctx.moveTo(quad.topLeft.x, quad.topLeft.y);
            ctx.lineTo(quad.topRight.x, quad.topRight.y);
            ctx.lineTo(quad.bottomRight.x, quad.bottomRight.y);
            ctx.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
            ctx.closePath();
            ctx.stroke();

            // Draw Corner Reticles
            const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
            ctx.fillStyle = strokeColor;
            for (const pt of corners) {
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, isLocked ? 7 : 5, 0, Math.PI * 2);
              ctx.fill();
            }

            // Draw Perspective Grid Lines
            ctx.strokeStyle = isLocked ? 'rgba(34, 197, 94, 0.4)' : 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 1;
            ctx.shadowBlur = 0;

            for (let r = 1; r < rows; r++) {
              const pL = mapGridToImage(0, r / rows, quad);
              const pR = mapGridToImage(1, r / rows, quad);
              ctx.beginPath();
              ctx.moveTo(pL.x, pL.y);
              ctx.lineTo(pR.x, pR.y);
              ctx.stroke();
            }
            for (let c = 1; c < cols; c++) {
              const pT = mapGridToImage(c / cols, 0, quad);
              const pB = mapGridToImage(c / cols, 1, quad);
              ctx.beginPath();
              ctx.moveTo(pT.x, pT.y);
              ctx.lineTo(pB.x, pB.y);
              ctx.stroke();
            }
            ctx.restore();

            // Sample Grid Cells via Bilinear Perspective Mapping
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const samples: {r: number, c: number, b: number, px: number, py: number}[] = [];

            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const centerPt = mapGridToImage((c + 0.5) / cols, (r + 0.5) / rows, quad);
                const px = Math.floor(centerPt.x);
                const py = Math.floor(centerPt.y);

                if (px >= 0 && px < canvas.width && py >= 0 && py < canvas.height) {
                  const idx = (py * canvas.width + px) * 4;
                  const brightness = (data[idx] + data[idx+1] + data[idx+2]) / 3;
                  samples.push({ r, c, b: brightness, px, py });
                }
              }
            }

            const sorted = [...samples].sort((a, b) => a.b - b.b);
            let maxGap = 0;
            let baseThreshold = 60;
            if (sorted.length > 0) {
              for (let i = 0; i < sorted.length - 1; i++) {
                const gap = sorted[i+1].b - sorted[i].b;
                if (gap > maxGap && i > sorted.length * 0.1 && i < sorted.length * 0.9) {
                  maxGap = gap;
                  baseThreshold = sorted[i].b + gap / 2;
                }
              }
            }

            const threshold = Math.max(10, Math.min(245, baseThreshold + scanParamsRef.current.sensitivity));
            const newCells = new Set<PointStr>();

            for (const s of samples) {
              const isBlock = s.b > threshold;
              if (isBlock) {
                newCells.add(toStr({ r: s.r, c: s.c }));
                ctx.fillStyle = isLocked ? 'rgba(34, 197, 94, 0.45)' : 'rgba(56, 189, 248, 0.45)';
                ctx.beginPath();
                ctx.arc(s.px, s.py, 8, 0, Math.PI * 2);
                ctx.fill();
              }

              ctx.fillStyle = isBlock ? '#22c55e' : '#f43f5e';
              ctx.beginPath();
              ctx.arc(s.px, s.py, 3, 0, Math.PI * 2);
              ctx.fill();
            }

            liveCellsRef.current = newCells;
            pendingGridRef.current = null;
            setLiveDetectedCount(newCells.size);

            // Auto-Snap Trigger!
            if (isLocked && autoSnapRef.current && !autoCapturedRef.current && newCells.size > 0) {
              autoCapturedRef.current = true;
              confirmScan();
              return;
            }
          } else {
            // Searching Animation Guide Radar
            searchRadarAngleRef.current = (searchRadarAngleRef.current + 0.05) % (Math.PI * 2);
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const radius = Math.min(canvas.width, canvas.height) * 0.28;

            ctx.save();
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 8]);
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(
              cx + Math.cos(searchRadarAngleRef.current) * radius,
              cy + Math.sin(searchRadarAngleRef.current) * radius
            );
            ctx.stroke();
            ctx.restore();
          }
        } else {
          // --- MANUAL CALIBRATION MODE ---
          const padding = 24;
          const availableW = canvas.width - padding * 2;
          const availableH = canvas.height - padding * 2;
          const gridRatio = cols / rows;
          
          let baseBoxW = availableW;
          let baseBoxH = baseBoxW / gridRatio;
          
          if (baseBoxH > availableH) {
            baseBoxH = availableH;
            baseBoxW = baseBoxH * gridRatio;
          }

          const { scale: sScale, widthScale: wScale, heightScale: hScale, offsetX: offX, offsetY: offY, sensitivity } = scanParamsRef.current;
          
          const boxW = baseBoxW * sScale * wScale;
          const boxH = baseBoxH * sScale * hScale;
          
          const startX = (canvas.width - boxW) / 2 + (offX * canvas.width);
          const startY = (canvas.height - boxH) / 2 + (offY * canvas.height);
          const cellW = boxW / cols;
          const cellH = boxH / rows;

          // Draw modern outer grid frame with corner brackets
          ctx.save();
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = Math.max(3, Math.min(6, Math.floor(canvas.width / 250)));
          ctx.lineCap = 'round';
          const bracketLen = Math.min(cellW, cellH, 30);

          // Top-Left
          ctx.beginPath();
          ctx.moveTo(startX, startY + bracketLen);
          ctx.lineTo(startX, startY);
          ctx.lineTo(startX + bracketLen, startY);
          ctx.stroke();

          // Top-Right
          ctx.beginPath();
          ctx.moveTo(startX + boxW - bracketLen, startY);
          ctx.lineTo(startX + boxW, startY);
          ctx.lineTo(startX + boxW, startY + bracketLen);
          ctx.stroke();

          // Bottom-Left
          ctx.beginPath();
          ctx.moveTo(startX, startY + boxH - bracketLen);
          ctx.lineTo(startX, startY + boxH);
          ctx.lineTo(startX + bracketLen, startY + boxH);
          ctx.stroke();

          // Bottom-Right
          ctx.beginPath();
          ctx.moveTo(startX + boxW - bracketLen, startY + boxH);
          ctx.lineTo(startX + boxW, startY + boxH);
          ctx.lineTo(startX + boxW, startY + boxH - bracketLen);
          ctx.stroke();
          ctx.restore();

          // Center Reticle
          const cx = startX + boxW / 2;
          const cy = startY + boxH / 2;
          ctx.save();
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx - 10, cy);
          ctx.lineTo(cx + 10, cy);
          ctx.moveTo(cx, cy - 10);
          ctx.lineTo(cx + 10, cy);
          ctx.stroke();
          ctx.restore();

          // Grid lines
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.lineWidth = Math.max(1, Math.min(2, Math.floor(canvas.width / 500)));
          
          for (let r = 0; r <= rows; r++) {
            ctx.beginPath();
            ctx.moveTo(startX, startY + r * cellH);
            ctx.lineTo(startX + boxW, startY + r * cellH);
            ctx.stroke();
          }
          for (let c = 0; c <= cols; c++) {
            ctx.beginPath();
            ctx.moveTo(startX + c * cellW, startY);
            ctx.lineTo(startX + c * cellW, startY + boxH);
            ctx.stroke();
          }
          ctx.restore();

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          const samples: {r: number, c: number, b: number, px: number, py: number}[] = [];
          
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const px = Math.floor(startX + c * cellW + cellW / 2);
              const py = Math.floor(startY + r * cellH + cellH / 2);
              
              if (px >= 0 && px < canvas.width && py >= 0 && py < canvas.height) {
                const idx = (py * canvas.width + px) * 4;
                const brightness = (data[idx] + data[idx+1] + data[idx+2]) / 3;
                samples.push({ r, c, b: brightness, px, py });
              }
            }
          }
          
          const sorted = [...samples].sort((a, b) => a.b - b.b);
          let maxGap = 0;
          let baseThreshold = 60;
          
          if (sorted.length > 0) {
            for (let i = 0; i < sorted.length - 1; i++) {
              const gap = sorted[i+1].b - sorted[i].b;
              if (gap > maxGap && i > sorted.length * 0.1 && i < sorted.length * 0.9) {
                maxGap = gap;
                baseThreshold = sorted[i].b + gap / 2;
              }
            }
          }

          const threshold = Math.max(10, Math.min(245, baseThreshold + sensitivity));
          const newCells = new Set<PointStr>();
          
          for (const s of samples) {
            const isBlock = s.b > threshold;
            if (isBlock) {
              newCells.add(toStr({ r: s.r, c: s.c }));
              ctx.fillStyle = 'rgba(56, 189, 248, 0.45)';
              ctx.fillRect(startX + s.c * cellW + 2, startY + s.r * cellH + 2, cellW - 4, cellH - 4);
            }
            
            ctx.fillStyle = isBlock ? '#22c55e' : '#f43f5e';
            ctx.beginPath();
            ctx.arc(s.px, s.py, Math.max(2, Math.min(5, Math.floor(cellW / 10))), 0, Math.PI * 2);
            ctx.fill();
          }
          
          liveCellsRef.current = newCells;
          pendingGridRef.current = null;
          if (now - lastCountUpdateRef.current > 150) {
            lastCountUpdateRef.current = now;
            setLiveDetectedCount(newCells.size);
          }
        }
      }
    }
    animationRef.current = requestAnimationFrame(processVideo);
  };

  const confirmScan = () => {
    const cells = new Set(liveCellsRef.current);
    const pending = pendingGridRef.current;

    if (pending) {
      setRows(pending.rows);
      setCols(pending.cols);
    }
    setActiveCells(cells);
    setStart(pending?.start && cells.has(pending.start) ? pending.start : null);
    setEnd(null);
    setSolution(null);
    setStatus(
      pending
        ? `Scanned! ${pending.rows}x${pending.cols}, ${cells.size} blocks${pending.start ? ' (start detected)' : ''}.`
        : `Scanned! Found ${cells.size} blocks.`
    );
    playSound('solve');
    stopCamera();
  };

  const solve = () => {
    if (activeCells.size === 0) {
      alert("No active cells.");
      return;
    }
    if (!start) {
      alert("Please set a start point (right click on a cell).");
      return;
    }
    
    setStatus("Solving...");
    
    setTimeout(() => {
      const cellsList = Array.from(activeCells).map(fromStr);
      const startPoint = fromStr(start);
      const endPoint = end ? fromStr(end) : null;
      
      const res = solveHamiltonianPath(cellsList, startPoint, endPoint);
      if (res) {
        const solStrs = res.map(toStr);
        setSolution(solStrs);
        setStatus(`Found solution! Length: ${res.length}`);
        playSound('solve');
      } else {
        setSolution(null);
        setStatus("No solution found.");
        playSound('error');
        setTimeout(() => {
          alert("No path found that visits all active cells exactly once without crossing.");
        }, 50);
      }
    }, 10);
  };

  // Calculate SVG Line Path
  let svgPathD = "";
  if (solution && solution.length > 0) {
    const points = solution.map(pStr => {
      const { r, c } = fromStr(pStr);
      const cx = PAD + c * (CELL_SIZE + GAP) + CELL_SIZE / 2;
      const cy = PAD + r * (CELL_SIZE + GAP) + CELL_SIZE / 2;
      return `${cx},${cy}`;
    });
    svgPathD = `M ${points.join(" L ")}`;
  }

  const gridWidth = PAD * 2 + cols * CELL_SIZE + (cols - 1) * GAP;
  const gridHeight = PAD * 2 + rows * CELL_SIZE + (rows - 1) * GAP;

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center select-none bg-[#1e1f24]" onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={particleCanvasRef} className="fixed inset-0 pointer-events-none z-[100]" />
      <div className="max-w-4xl w-full">
        <h1 className="text-3xl md:text-4xl font-bold mb-4 md:mb-6 text-center text-primary tracking-tight">Grid Path Solver</h1>
        
        {/* Status Help Text */}
        <div className="text-center mb-6 text-sm opacity-80 max-w-2xl mx-auto leading-relaxed text-base-content px-4">
          <p className="hidden md:block"><strong>Left Drag:</strong> Paint/Erase | <strong>Right Click:</strong> Set Start | <strong>Shift+Click:</strong> Set End</p>
          <p className="mt-2 text-xl font-semibold text-info">{status}</p>
        </div>

        {/* Toolbar Modes (Mobile & Desktop) */}
        <div className="flex justify-center mb-6">
          <div className="join">
            <button className={`btn join-item ${toolMode === 'paint' ? 'btn-neutral' : 'btn-ghost border border-base-300'}`} onClick={() => setToolMode('paint')}>✏️ Paint</button>
            <button className={`btn join-item ${toolMode === 'start' ? 'btn-info text-info-content' : 'btn-ghost border border-base-300'}`} onClick={() => setToolMode('start')}>🔵 Start</button>
            <button className={`btn join-item ${toolMode === 'end' ? 'btn-warning text-warning-content' : 'btn-ghost border border-base-300'}`} onClick={() => setToolMode('end')}>🟧 End</button>
            <button className="btn join-item btn-ghost border border-base-300 text-secondary font-semibold" onClick={() => { autoCapturedRef.current = false; startCamera(); }}>📷 Scan</button>
          </div>
        </div>

        {/* Control Panel */}
        <div className="bg-base-200/50 p-4 md:p-6 rounded-3xl shadow-xl mb-12 flex flex-wrap gap-2 md:gap-4 items-end justify-center border border-base-300">
          <div className="form-control w-16 md:w-24">
            <label className="label py-1"><span className="label-text font-semibold text-xs md:text-sm">Rows</span></label>
            <input type="number" min={1} max={30} value={rows} onChange={(e) => handleResize(Number(e.target.value) || 1, cols)} className="input input-bordered input-sm md:input-md focus:border-primary px-2" />
          </div>
          <div className="form-control w-16 md:w-24">
            <label className="label py-1"><span className="label-text font-semibold text-xs md:text-sm">Cols</span></label>
            <input type="number" min={1} max={30} value={cols} onChange={(e) => handleResize(rows, Number(e.target.value) || 1)} className="input input-bordered input-sm md:input-md focus:border-primary px-2" />
          </div>
          
          <button className="btn btn-ghost btn-sm md:btn-md" onClick={clearAll}>Clear All</button>
          <button className="btn btn-ghost btn-sm md:btn-md" onClick={fillAll}>Fill</button>
          <button className="btn btn-ghost btn-sm md:btn-md" onClick={clearEndpoints}>Clear Ends</button>
          
          <button className="btn btn-primary btn-sm md:btn-md shadow-lg shadow-primary/30 w-full md:w-auto mt-2 md:mt-0" onClick={solve}>Solve Path</button>
        </div>
        
        {/* Grid Container */}
        <div className="flex justify-center pb-10 w-full overflow-hidden">
          <div 
            className="relative bg-base-300/40 rounded-[2rem] shadow-inner border border-base-100 touch-none"
            style={{ 
              width: gridWidth, 
              height: gridHeight, 
              transform: `scale(${scale})`, 
              transformOrigin: 'top center' 
            }}
            onTouchMove={handleTouchMove}
          >
            {/* SVG Path Overlay */}
            {solution && (
              <svg 
                className="absolute inset-0 pointer-events-none z-10"
                width={gridWidth} 
                height={gridHeight}
              >
                <path 
                  d={svgPathD} 
                  fill="none" 
                  stroke="#2f6fd6" 
                  strokeWidth="10" 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                />
              </svg>
            )}

            {/* Cells */}
            <div 
              className="absolute inset-0 p-8 grid gap-[6px]"
              style={{ 
                gridTemplateColumns: `repeat(${cols}, ${CELL_SIZE}px)`,
                gridTemplateRows: `repeat(${rows}, ${CELL_SIZE}px)`,
              }}
            >
              {Array.from({ length: rows }).map((_, r) => (
                Array.from({ length: cols }).map((_, c) => {
                  const pStr = toStr({ r, c });
                  const isActive = activeCells.has(pStr);
                  const isStart = start === pStr;
                  const isEnd = end === pStr;
                  const pathIndex = solution ? solution.indexOf(pStr) : -1;
                  const isPath = pathIndex !== -1;
                  
                  // Styling to match Python desktop app closely
                  let cellClass = "w-12 h-12 rounded-xl cursor-pointer transition-colors duration-200 relative flex items-center justify-center font-bold text-lg ";
                  let cellStyle: React.CSSProperties = {};
                  
                  if (!isActive) {
                    cellClass += "bg-base-100/10 border border-base-content/5 border-dashed";
                  } else if (isPath) {
                    cellClass += "bg-[#7db8f5] text-slate-900 animate-path shadow-lg shadow-[#7db8f5]/40";
                    cellStyle = { animationDelay: `${pathIndex * 0.05}s`, animationFillMode: 'both' };
                  } else {
                    cellClass += "bg-[#5f6068] text-white hover:bg-neutral-focus animate-pop shadow-md";
                  }

                  return (
                    <div
                      key={pStr}
                      data-r={r}
                      data-c={c}
                      className={cellClass}
                      style={cellStyle}
                      onMouseDown={(e) => handleCellDown(r, c, e)}
                      onMouseEnter={() => handleCellEnter(r, c)}
                      onTouchStart={(e) => handleCellDown(r, c, e)}
                      onContextMenu={(e) => { e.preventDefault(); handleCellDown(r, c, e); }}
                    >
                      {isPath && (
                        <span className="z-20 pointer-events-none drop-shadow-sm">{pathIndex + 1}</span>
                      )}

                      {/* Start indicator (blue circle) */}
                      {isStart && isActive && (
                        <div className="absolute inset-0 m-auto w-8 h-8 rounded-full border-[4px] border-[#3d8bfd] z-20 pointer-events-none"></div>
                      )}
                      
                      {/* End indicator (orange square) */}
                      {isEnd && isActive && (
                        <div className="absolute inset-0 m-auto w-8 h-8 rounded-md border-[4px] border-[#e0a030] z-20 pointer-events-none"></div>
                      )}
                    </div>
                  );
                })
              ))}
            </div>
          </div>
        </div>
        
        {/* Live Camera Overlay with Auto-Detect OpenCV & Manual Calibration */}
        {isCameraActive && (
          <div className="fixed inset-0 z-50 bg-black flex flex-col select-none touch-none">
            {/* Top Navigation / Status Header */}
            <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-between p-3 md:p-4 bg-gradient-to-b from-black/90 via-black/50 to-transparent">
              <div className="flex items-center gap-2">
                {/* Mode Selector */}
                <div className="join bg-black/60 backdrop-blur-md p-0.5 rounded-xl border border-white/15">
                  <button 
                    className={`btn btn-xs join-item ${scanMode === 'auto' ? 'btn-primary font-bold shadow' : 'btn-ghost text-white/80'}`}
                    onClick={() => { resetDetectorState(); autoCapturedRef.current = false; setScanMode('auto'); }}
                  >
                    🤖 Auto AI
                  </button>
                  <button 
                    className={`btn btn-xs join-item ${scanMode === 'manual' ? 'btn-primary font-bold shadow' : 'btn-ghost text-white/80'}`}
                    onClick={() => { resetDetectorState(); setScanMode('manual'); }}
                  >
                    🖐️ ปรับมือ
                  </button>
                </div>

                {scanMode === 'auto' && (
                  <button 
                    className={`btn btn-xs rounded-full gap-1 ${autoSnap ? 'btn-success text-success-content font-bold' : 'btn-neutral text-white/80 border border-white/20'}`}
                    onClick={() => setAutoSnap(prev => !prev)}
                    title="Auto-Snap when locked"
                  >
                    ⚡ Auto-Snap: {autoSnap ? 'ON' : 'OFF'}
                  </button>
                )}
              </div>

              {/* Status Indicator */}
              <div className="hidden sm:flex items-center gap-2">
                {scanMode === 'auto' ? (
                  <span className={`badge badge-md font-bold px-3 py-2 border shadow ${
                    detectionStatus === 'locked' 
                      ? 'badge-success border-success text-white animate-pulse' 
                      : detectionStatus === 'tracking'
                      ? 'badge-info border-info text-white'
                      : 'badge-neutral bg-black/60 text-white/80 border-white/20'
                  }`}>
                    {detectionStatus === 'locked' && `🎯 ล็อกสำเร็จ!${detectedGrid ? ` ${detectedGrid.rows}×${detectedGrid.cols}` : ''}`}
                    {detectionStatus === 'tracking' && `🟡 เจอบอร์ด${detectedGrid ? ` ${detectedGrid.rows}×${detectedGrid.cols}` : ''} (${lockProgress}%)`}
                    {detectionStatus === 'searching' && '🔴 ส่องกล้องไปที่บอร์ดเกม...'}
                  </span>
                ) : (
                  <span className="badge badge-info badge-md font-bold">
                    🔍 ซูม {Math.round(scanScale * 100)}%
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {scanMode === 'manual' && (
                  <button 
                    className={`btn btn-sm btn-circle ${showAdvancedScan ? 'btn-primary' : 'btn-neutral text-white'} border border-white/20 shadow`}
                    onClick={() => setShowAdvancedScan(prev => !prev)}
                    title="Calibration Settings"
                  >
                    ⚙️
                  </button>
                )}
                <button 
                  className="btn btn-sm btn-circle btn-neutral text-white border border-white/20 shadow"
                  onClick={() => {
                    setFrameRotation(prev => (prev + 90) % 360);
                    resetDetectorState();
                    autoRotationDoneRef.current = true;
                    autoCapturedRef.current = false;
                  }}
                  title="หมุนภาพ (Rotate frame)"
                >
                  ⟳
                </button>
                <button 
                  className="btn btn-sm btn-circle btn-neutral text-white border border-white/20 shadow"
                  onClick={toggleCamera}
                  title="Switch Camera"
                >
                  🔄
                </button>
                <button 
                  className="btn btn-sm btn-circle btn-ghost text-white/80 hover:text-white"
                  onClick={stopCamera}
                  title="Close Camera"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Viewport with Canvas & Gestures */}
            <div 
              className="relative flex-1 bg-black overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing"
              onTouchStart={handleCamTouchStart}
              onTouchMove={handleCamTouchMove}
              onTouchEnd={handleCamTouchEnd}
              onMouseDown={handleCamMouseDown}
              onMouseMove={handleCamMouseMove}
              onMouseUp={handleCamMouseUp}
              onMouseLeave={handleCamMouseUp}
              onWheel={handleCamWheel}
            >
              <video 
                ref={videoRef} 
                className="absolute inset-0 w-full h-full object-contain opacity-0 pointer-events-none" 
                playsInline 
                autoPlay 
                muted
              />
              <canvas 
                ref={canvasRef} 
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              />

              {/* Floating Mobile Status */}
              <div className="sm:hidden absolute top-16 pointer-events-none bg-black/60 backdrop-blur-md px-3 py-1 rounded-full text-xs text-white/90 border border-white/15">
                {scanMode === 'auto' ? (
                  detectionStatus === 'locked' ? `🎯 ล็อกสำเร็จ! ${detectedGrid ? `${detectedGrid.rows}×${detectedGrid.cols} • ` : ''}${liveDetectedCount} บล็อก` :
                  detectionStatus === 'tracking' ? `🟡 กำลังล็อกบอร์ด ${detectedGrid ? `${detectedGrid.rows}×${detectedGrid.cols} ` : ''}(${lockProgress}%)` :
                  '🔴 ส่องกล้องไปที่บอร์ดเกม...'
                ) : (
                  'ลากเพื่อเลื่อน • บีบเพื่อปรับขนาด'
                )}
              </div>
            </div>

            {/* Collapsible Advanced Calibration Panel (in Manual Mode) */}
            {showAdvancedScan && scanMode === 'manual' && (
              <div className="bg-neutral-900/95 backdrop-blur-xl border-t border-white/15 p-4 z-20 max-h-[45vh] overflow-y-auto shadow-2xl transition-all animate-fadeIn">
                <div className="max-w-xl mx-auto space-y-3">
                  <div className="flex items-center justify-between border-b border-white/10 pb-2">
                    <span className="font-bold text-sm text-primary flex items-center gap-1.5">
                      ⚙️ ปรับแต่งเลนส์ & ตารางละเอียด (Calibration)
                    </span>
                    <button 
                      className="btn btn-ghost btn-xs text-error font-semibold"
                      onClick={resetScanParams}
                    >
                      คืนค่าเริ่มต้น
                    </button>
                  </div>

                  {/* Rows / Cols Adjuster */}
                  <div className="grid grid-cols-2 gap-3 bg-base-300/40 p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">แถว (Rows):</span>
                      <div className="flex items-center gap-1">
                        <button className="btn btn-xs btn-neutral" onClick={() => handleResize(Math.max(1, rows - 1), cols)}>-</button>
                        <span className="font-bold text-sm w-6 text-center">{rows}</span>
                        <button className="btn btn-xs btn-neutral" onClick={() => handleResize(rows + 1, cols)}>+</button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">คอลัมน์ (Cols):</span>
                      <div className="flex items-center gap-1">
                        <button className="btn btn-xs btn-neutral" onClick={() => handleResize(rows, Math.max(1, cols - 1))}>-</button>
                        <span className="font-bold text-sm w-6 text-center">{cols}</span>
                        <button className="btn btn-xs btn-neutral" onClick={() => handleResize(rows, cols + 1)}>+</button>
                      </div>
                    </div>
                  </div>

                  {/* Width Scale Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-medium">
                      <span>↔️ สเกลแนวนอน (Width Stretch)</span>
                      <span className="text-info font-bold">{Math.round(scanWidthScale * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="btn btn-xs btn-ghost" onClick={() => setScanParam('widthScale', Math.max(0.4, parseFloat((scanWidthScale - 0.05).toFixed(2))))}>-</button>
                      <input 
                        type="range" 
                        min="0.4" 
                        max="2.0" 
                        step="0.02" 
                        value={scanWidthScale} 
                        onChange={(e) => setScanParam('widthScale', parseFloat(e.target.value))}
                        className="range range-xs range-info flex-1" 
                      />
                      <button className="btn btn-xs btn-ghost" onClick={() => setScanParam('widthScale', Math.min(2.0, parseFloat((scanWidthScale + 0.05).toFixed(2))))}>+</button>
                    </div>
                  </div>

                  {/* Height Scale Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-medium">
                      <span>↕️ สเกลแนวตั้ง (Height Stretch)</span>
                      <span className="text-info font-bold">{Math.round(scanHeightScale * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="btn btn-xs btn-ghost" onClick={() => setScanParam('heightScale', Math.max(0.4, parseFloat((scanHeightScale - 0.05).toFixed(2))))}>-</button>
                      <input 
                        type="range" 
                        min="0.4" 
                        max="2.0" 
                        step="0.02" 
                        value={scanHeightScale} 
                        onChange={(e) => setScanParam('heightScale', parseFloat(e.target.value))}
                        className="range range-xs range-info flex-1" 
                      />
                      <button className="btn btn-xs btn-ghost" onClick={() => setScanParam('heightScale', Math.min(2.0, parseFloat((scanHeightScale + 0.05).toFixed(2))))}>+</button>
                    </div>
                  </div>

                  {/* Threshold / Sensitivity Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-medium">
                      <span>💡 ความไวแสงตรวจจับบล็อก (Sensitivity)</span>
                      <span className="text-success font-bold">{scanSensitivity > 0 ? `+${scanSensitivity}` : scanSensitivity}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="btn btn-xs btn-ghost" onClick={() => setScanParam('sensitivity', Math.max(-60, scanSensitivity - 5))}>-</button>
                      <input 
                        type="range" 
                        min="-60" 
                        max="60" 
                        step="2" 
                        value={scanSensitivity} 
                        onChange={(e) => setScanParam('sensitivity', parseInt(e.target.value, 10))}
                        className="range range-xs range-success flex-1" 
                      />
                      <button className="btn btn-xs btn-ghost" onClick={() => setScanParam('sensitivity', Math.min(60, scanSensitivity + 5))}>+</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Controls Bar for Manual Mode */}
            {scanMode === 'manual' && (
              <div className="bg-neutral-900/90 backdrop-blur-md border-t border-white/10 px-4 py-3 z-10">
                <div className="max-w-xl mx-auto space-y-2">
                  <div className="flex items-center justify-between gap-1 overflow-x-auto pb-1">
                    <span className="text-xs font-bold text-white/70 whitespace-nowrap mr-1">🔍 ซูม:</span>
                    {[0.5, 0.75, 1.0, 1.25, 1.5, 1.8].map((preset) => (
                      <button
                        key={preset}
                        className={`btn btn-xs rounded-lg flex-1 ${Math.abs(scanScale - preset) < 0.03 ? 'btn-primary font-bold' : 'btn-neutral bg-white/10 text-white/90 border-0'}`}
                        onClick={() => setScanParam('scale', preset)}
                      >
                        {Math.round(preset * 100)}%
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-3">
                    <button 
                      className="btn btn-xs btn-circle btn-neutral bg-white/10 border-0 text-white font-bold"
                      onClick={() => setScanParam('scale', Math.max(0.25, parseFloat((scanScale - 0.05).toFixed(2))))}
                    >
                      −
                    </button>
                    <input 
                      type="range" 
                      min="0.25" 
                      max="2.2" 
                      step="0.01" 
                      value={scanScale} 
                      onChange={(e) => setScanParam('scale', parseFloat(e.target.value))}
                      className="range range-sm range-primary flex-1" 
                    />
                    <button 
                      className="btn btn-xs btn-circle btn-neutral bg-white/10 border-0 text-white font-bold"
                      onClick={() => setScanParam('scale', Math.min(2.2, parseFloat((scanScale + 0.05).toFixed(2))))}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Bottom Action Footer */}
            <div 
              className="bg-black/95 p-4 flex justify-between items-center z-10 border-t border-white/10"
              style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
            >
              <button className="btn btn-ghost text-error text-base" onClick={stopCamera}>
                ยกเลิก
              </button>

              <div className="flex items-center gap-2">
                {scanMode === 'manual' && (
                  <button 
                    className={`btn btn-sm ${showAdvancedScan ? 'btn-primary' : 'btn-ghost text-white/80 border border-white/20'}`}
                    onClick={() => setShowAdvancedScan(prev => !prev)}
                  >
                    ⚙️ {showAdvancedScan ? 'ซ่อนตั้งค่า' : 'ปรับเลนส์'}
                  </button>
                )}

                <button 
                  className={`btn ${detectionStatus === 'locked' && scanMode === 'auto' ? 'btn-success text-white animate-bounce' : 'btn-primary'} btn-md md:btn-lg shadow-xl shadow-primary/40 font-bold text-base px-6 gap-2`}
                  onClick={confirmScan}
                >
                  <span>📸 {scanMode === 'auto' ? 'ถ่ายรูป (Auto AI)' : 'ถ่ายรูป'}</span>
                  <span className="badge badge-neutral text-xs font-mono font-bold bg-black/40 text-white border-0">
                    {liveDetectedCount} บล็อก
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
