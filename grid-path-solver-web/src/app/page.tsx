"use client";

import { useState, useCallback, useEffect, useRef } from 'react';
import { Point, PointStr, toStr, fromStr, solveHamiltonianPath } from '@/utils/solver';

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
  
  // Camera state
  const [isCameraActive, setIsCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const liveCellsRef = useRef<Set<PointStr>>(new Set());

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

  const startCamera = async () => {
    setIsCameraActive(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      processVideo();
    } catch (err) {
      alert("Could not access camera: " + err);
      setIsCameraActive(false);
    }
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

  const processVideo = () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Calculate a centered box for the grid based on its true aspect ratio
        const padding = 20;
        const availableW = canvas.width - padding * 2;
        const availableH = canvas.height - padding * 2;
        const gridRatio = cols / rows;
        
        let boxW = availableW;
        let boxH = boxW / gridRatio;
        
        if (boxH > availableH) {
          boxH = availableH;
          boxW = boxH * gridRatio;
        }
        
        const startX = (canvas.width - boxW) / 2;
        const startY = (canvas.height - boxH) / 2;
        const cellW = boxW / cols;
        const cellH = boxH / rows;

        // Draw grid overlay
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1;
        
        for(let r = 0; r <= rows; r++) {
          ctx.beginPath();
          ctx.moveTo(startX, startY + r * cellH);
          ctx.lineTo(startX + boxW, startY + r * cellH);
          ctx.stroke();
        }
        for(let c = 0; c <= cols; c++) {
          ctx.beginPath();
          ctx.moveTo(startX + c * cellW, startY);
          ctx.lineTo(startX + c * cellW, startY + boxH);
          ctx.stroke();
        }

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        // Collect samples to find the adaptive threshold
        const samples: {r: number, c: number, b: number, px: number, py: number}[] = [];
        
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const px = Math.floor(startX + c * cellW + cellW / 2);
            const py = Math.floor(startY + r * cellH + cellH / 2);
            
            const idx = (py * canvas.width + px) * 4;
            const brightness = (data[idx] + data[idx+1] + data[idx+2]) / 3;
            samples.push({ r, c, b: brightness, px, py });
          }
        }
        
        // Adaptive Thresholding: sort by brightness and find the biggest gap
        samples.sort((a, b) => a.b - b.b);
        let maxGap = 0;
        let threshold = 60; // fallback
        
        if (samples.length > 0) {
          for (let i = 0; i < samples.length - 1; i++) {
            const gap = samples[i+1].b - samples[i].b;
            // Ignore gaps at the very extremes (e.g. 1 dead pixel)
            if (gap > maxGap && i > samples.length * 0.1 && i < samples.length * 0.9) {
              maxGap = gap;
              threshold = samples[i].b + gap / 2;
            }
          }
        }
        
        const newCells = new Set<PointStr>();
        
        for (const s of samples) {
          // If brightness is above the adaptive threshold, it's a block
          if (s.b > threshold) {
            newCells.add(toStr({ r: s.r, c: s.c }));
            // Draw highlight
            ctx.fillStyle = 'rgba(61, 139, 253, 0.5)';
            ctx.fillRect(startX + s.c * cellW + 2, startY + s.r * cellH + 2, cellW - 4, cellH - 4);
          }
          
          // Draw center sampling dot
          ctx.fillStyle = s.b > threshold ? '#4ade80' : '#ff4d4f';
          ctx.beginPath();
          ctx.arc(s.px, s.py, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        
        liveCellsRef.current = newCells;
      }
    }
    animationRef.current = requestAnimationFrame(processVideo);
  };

  const confirmScan = () => {
    setActiveCells(new Set(liveCellsRef.current));
    setStart(null);
    setEnd(null);
    setSolution(null);
    setStatus(`Scanned! Found ${liveCellsRef.current.size} blocks.`);
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
            <button className="btn join-item btn-ghost border border-base-300 text-secondary font-semibold" onClick={startCamera}>📷 Scan</button>
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
        
        {/* Live Camera Overlay */}
        {isCameraActive && (
          <div className="fixed inset-0 z-50 bg-black flex flex-col">
            <div className="relative flex-1 bg-black overflow-hidden flex items-center justify-center">
              <video 
                ref={videoRef} 
                className="absolute inset-0 w-full h-full object-contain opacity-0 pointer-events-none" 
                playsInline 
                autoPlay 
                muted
              />
              <canvas 
                ref={canvasRef} 
                className="absolute inset-0 w-full h-full object-contain"
              />
            </div>
            
            <div className="bg-base-300 p-6 flex justify-between items-center z-10 border-t border-base-100" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
              <button className="btn btn-ghost text-error text-lg" onClick={stopCamera}>Cancel</button>
              <p className="text-sm font-semibold opacity-80 max-w-[150px] text-center leading-tight">Line up grid with game</p>
              <button className="btn btn-primary btn-lg shadow-lg shadow-primary/30" onClick={confirmScan}>Capture</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
