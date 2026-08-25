export type Point = { r: number; c: number };
export type PointStr = `${number},${number}`;

export function toStr(p: Point): PointStr {
  return `${p.r},${p.c}`;
}

export function fromStr(s: string): Point {
  const [r, c] = s.split(',').map(Number);
  return { r, c };
}

export function solveHamiltonianPath(
  cellsList: Point[],
  start: Point | null,
  end: Point | null = null
): Point[] | null {
  if (!start) return null;
  const cells = new Set<PointStr>(cellsList.map(toStr));
  const startStr = toStr(start);
  const endStr = end ? toStr(end) : null;

  if (!cells.has(startStr)) return null;
  if (endStr && !cells.has(endStr)) return null;

  const nbrsCache = new Map<PointStr, PointStr[]>();

  for (const cStr of cells) {
    const { r, c } = fromStr(cStr);
    const cand = [
      `${r - 1},${c}`,
      `${r + 1},${c}`,
      `${r},${c - 1}`,
      `${r},${c + 1}`,
    ] as PointStr[];
    nbrsCache.set(cStr, cand.filter((q) => cells.has(q)));
  }

  const total = cells.size;
  const free = new Set(cells);
  free.delete(startStr);
  const path: PointStr[] = [startStr];

  function connectedOk(cur: PointStr): boolean {
    if (free.size === 0) return true;
    const startNode = free.values().next().value as PointStr;
    const seen = new Set<PointStr>([startNode]);
    const stack = [startNode];
    while (stack.length > 0) {
      const x = stack.pop()!;
      for (const y of nbrsCache.get(x) || []) {
        if (free.has(y) && !seen.has(y)) {
          seen.add(y);
          stack.push(y);
        }
      }
    }
    if (seen.size !== free.size) return false;
    return (nbrsCache.get(cur) || []).some((n) => free.has(n));
  }

  function deadendOk(cur: PointStr): boolean {
    let bad = 0;
    for (const p of free) {
      let d = 0;
      for (const n of nbrsCache.get(p) || []) {
        if (free.has(n) || n === cur) {
          d++;
        }
      }
      if (d === 0) return false;
      if (d === 1) {
        if (endStr && p !== endStr) return false;
        bad++;
        if (bad > 1) return false;
      }
    }
    return true;
  }

  function dfs(cur: PointStr): boolean {
    if (path.length === total) {
      return !endStr || cur === endStr;
    }
    if (!connectedOk(cur) || !deadendOk(cur)) return false;

    const nbrs = nbrsCache.get(cur) || [];
    const cand = nbrs.filter((n) => free.has(n));
    cand.sort((a, b) => {
      const degA = (nbrsCache.get(a) || []).filter((m) => free.has(m)).length;
      const degB = (nbrsCache.get(b) || []).filter((m) => free.has(m)).length;
      return degA - degB;
    });

    for (const n of cand) {
      if (endStr && n === endStr && free.size > 1) continue;
      free.delete(n);
      path.push(n);
      if (dfs(n)) return true;
      path.pop();
      free.add(n);
    }
    return false;
  }

  const ok = dfs(startStr);
  if (ok) {
    return path.map(fromStr);
  }
  return null;
}
