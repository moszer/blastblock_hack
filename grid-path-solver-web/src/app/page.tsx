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
    if (e && e.cancelable) e.preventDefault(); 
    const pStr = toStr({ r, c });
    
    if (toolMode === 'start' || (e && 'button' in e && e.button === 2)) {
      if (activeCells.has(pStr)) {
        setStart(pStr);
        setSolution(null);
      }
      if (toolMode === 'start') setToolMode('paint');
      return;
    }
    
    if (toolMode === 'end' || (e && 'shiftKey' in e && e.shiftKey) || (e && 'button' in e && e.button === 1)) {
      if (activeCells.has(pStr)) {
        setEnd(prev => prev === pStr ? null : pStr);
        setSolution(null);
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
      } else {
        setSolution(null);
        setStatus("No solution found.");
        alert("No path found that visits all active cells exactly once without crossing.");
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
                  
                  if (!isActive) {
                    cellClass += "bg-base-100/10 border border-base-content/5 border-dashed";
                  } else if (isPath) {
                    cellClass += "bg-[#7db8f5] text-slate-900";
                  } else {
                    cellClass += "bg-[#5f6068] text-white hover:bg-neutral-focus";
                  }

                  return (
                    <div
                      key={pStr}
                      data-r={r}
                      data-c={c}
                      className={cellClass}
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
        
      </div>
    </div>
  );
}
