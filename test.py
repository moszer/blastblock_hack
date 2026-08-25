#!/usr/bin/env python3
"""
Grid Path Solver
=================
โปรแกรม GUI (tkinter, ไม่ต้องติดตั้งไลบรารีเพิ่ม) สำหรับแก้ปริศนาเกม
"ลากเส้นให้ผ่านทุกช่องสีเทาครบโดยไม่ทับเส้นซ้ำ" (คล้ายเกม Zip/Flow)

วิธีใช้งาน
----------
1. รันไฟล์นี้ด้วย  python3 grid_path_solver.py
2. ตั้งจำนวนแถว/คอลัมน์ที่ช่อง "แถว" "คอลัมน์" แล้วกด "ปรับขนาดกริด"
3. คลิกซ้ายที่ช่อง = เปิด/ปิดช่อง  หรือ "กดค้างแล้วลาก" เพื่อระบายหลายช่องรวดเดียว
   (ช่องแรกที่กดเป็นตัวกำหนดโหมด: กดบนช่องที่ปิดอยู่ = ลากเปิด, กดบนช่องที่เปิดอยู่ = ลากปิด)
4. คลิกขวาที่ช่อง = กำหนดเป็น "จุดเริ่มต้น" (วงกลม)
5. คลิกกลาง (หรือ Shift+คลิกซ้าย) ที่ช่อง = กำหนดเป็น "จุดจบ" (ถ้ารู้ล่วงหน้า, ไม่บังคับ)
6. กด "หาคำตอบ" เพื่อคำนวณเส้นทางที่ผ่านทุกช่องที่เปิดไว้ครบ 1 ครั้ง ไม่ซ้ำ ไม่ข้าม
7. กด "บันทึกกริด" / "โหลดกริด" เพื่อเซฟ/โหลดด่านเป็นไฟล์ .json สำหรับด่านต่อ ๆ ไป

อัลกอริทึม: DFS + pruning (เช็คว่าช่องว่างที่เหลือยังเชื่อมต่อกันเป็นก้อนเดียว
และไม่มีช่องตันเกิน 1 ช่องที่ไม่ใช่จุดจบ) เหมือนที่ใช้แก้ปริศนาในแชทก่อนหน้านี้
"""

import json
import os
import shutil
import subprocess
import sys
import time
import tkinter as tk
from tkinter import filedialog, messagebox

# ---------------------------------------------------------------- solver ---

def solve_hamiltonian_path(cells, start, end=None):
    """
    คืนค่า list ของ (row, col) ที่เป็นเส้นทางผ่านทุกช่องใน cells ครบ 1 ครั้ง
    เริ่มจาก start ถ้ากำหนด end ไว้ต้องจบที่ end พอดี ถ้าไม่กำหนด จบที่ไหนก็ได้
    คืนค่า None ถ้าหาไม่เจอ
    """
    cells = set(cells)
    if start not in cells:
        return None
    if end is not None and end not in cells:
        return None

    def neighbors(p):
        r, c = p
        cand = [(r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)]
        return [q for q in cand if q in cells]

    nbrs_cache = {p: neighbors(p) for p in cells}

    total = len(cells)
    free = set(cells)
    free.discard(start)
    path = [start]

    def connected_ok(cur):
        if not free:
            return True
        start_node = next(iter(free))
        seen = {start_node}
        stack = [start_node]
        while stack:
            x = stack.pop()
            for y in nbrs_cache[x]:
                if y in free and y not in seen:
                    seen.add(y)
                    stack.append(y)
        if len(seen) != len(free):
            return False
        return any(n in free for n in nbrs_cache[cur])

    def deadend_ok(cur):
        bad = 0
        for p in free:
            d = sum(1 for n in nbrs_cache[p] if n in free or n == cur)
            if d == 0:
                return False
            if d == 1:
                if end is not None and p != end:
                    return False
                bad += 1
                if bad > 1:
                    return False
        return True

    def dfs(cur):
        if len(path) == total:
            return end is None or cur == end
        if not connected_ok(cur) or not deadend_ok(cur):
            return False
        cand = [n for n in nbrs_cache[cur] if n in free]
        # heuristic: ไปช่องที่มีทางเลือกน้อยที่สุดก่อน (Warnsdorff-like)
        cand.sort(key=lambda n: sum(1 for m in nbrs_cache[n] if m in free))
        for n in cand:
            if end is not None and n == end and len(free) > 1:
                continue
            free.discard(n)
            path.append(n)
            if dfs(n):
                return True
            path.pop()
            free.add(n)
        return False

    ok = dfs(start)
    return path if ok else None


# ------------------------------------------------------------------ sound ---

class SoundPlayer:
    """เล่นเสียงเอฟเฟกต์สั้น ๆ แบบไม่บล็อก UI

    macOS  -> afplay + เสียงระบบใน /System/Library/Sounds
    Windows -> winsound
    อื่น ๆ  -> bell ของ Tk (หรือเงียบถ้าไม่รองรับ)
    """

    MIN_INTERVAL = 0.055     # กันเสียงรัวเกินไปตอนลากเร็ว ๆ (วินาที)
    VOLUME = "0.35"          # afplay -v

    MAC_SOUNDS = {
        "add": "/System/Library/Sounds/Tink.aiff",
        "remove": "/System/Library/Sounds/Pop.aiff",
    }

    def __init__(self, root):
        self.root = root
        self.enabled = True
        self._last = 0.0
        self._procs = []
        if sys.platform == "darwin" and shutil.which("afplay"):
            self._backend = "afplay"
        elif sys.platform.startswith("win"):
            self._backend = "winsound"
        else:
            self._backend = "bell"

    def play(self, name):
        if not self.enabled:
            return
        now = time.monotonic()
        if now - self._last < self.MIN_INTERVAL:
            return
        self._last = now
        try:
            if self._backend == "afplay":
                path = self.MAC_SOUNDS.get(name)
                if not path or not os.path.exists(path):
                    return
                self._procs = [q for q in self._procs if q.poll() is None][-8:]
                self._procs.append(subprocess.Popen(
                    ["afplay", "-v", self.VOLUME, path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            elif self._backend == "winsound":
                import winsound
                winsound.Beep(880 if name == "add" else 440, 40)
            else:
                self.root.bell()
        except Exception:
            # เสียงเป็นของเสริม ห้ามทำให้โปรแกรมพัง
            pass


# ------------------------------------------------------------------- GUI ---

CELL = 56
GAP = 6
PAD = 30

COL_BG = "#1e1f24"
COL_OFF = "#1e1f24"          # ช่องปิด (ไม่ใช่ส่วนหนึ่งของปริศนา) = โปร่งกับพื้นหลัง
COL_ON = "#5f6068"           # ช่องเทาปกติ
COL_START = "#3d8bfd"
COL_END = "#e0a030"
COL_PATH = "#7db8f5"
COL_TEXT = "#e8e8ea"
COL_GUIDE = "#32343c"        # เส้นกริดพื้นหลัง (guideline)
COL_GUIDE_LABEL = "#55575f"  # เลขแถว/คอลัมน์ริมขอบ


class GridPathApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Grid Path Solver — แก้ปริศนาลากเส้นครบทุกช่อง")
        self.root.configure(bg=COL_BG)

        self.rows = 9
        self.cols = 8
        self.active = set()      # ช่องที่เปิดใช้งาน (r,c)
        self.start = None
        self.end = None
        self.solution = None
        self.show_guide = tk.BooleanVar(value=True)   # เปิด/ปิดเส้นกริดพื้นหลัง
        self.sound_on = tk.BooleanVar(value=True)     # เปิด/ปิดเสียงเอฟเฟกต์
        self.sound = SoundPlayer(root)

        # สถานะการลากเมาส์เพื่อ "ระบาย" ช่อง
        self._drag_mode = None       # "add" = เปิดช่อง, "remove" = ปิดช่อง
        self._drag_seen = set()      # ช่องที่แตะไปแล้วในการลากรอบนี้
        self._drag_last = None       # พิกัดพิกเซลล่าสุดของเมาส์

        self._build_controls()
        self.canvas = tk.Canvas(root, bg=COL_BG, highlightthickness=0)
        self.canvas.pack(padx=10, pady=10)
        self.canvas.bind("<Button-1>", self.on_left_press)
        self.canvas.bind("<B1-Motion>", self.on_left_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_left_release)
        self.canvas.bind("<Button-3>", self.on_right_click)
        self.canvas.bind("<Button-2>", self.on_middle_click)
        self.canvas.bind("<Shift-Button-1>", self.on_middle_click)

        self._default_layout()
        self.redraw()

    # ---------------------------------------------------- default layout ---
    def _default_layout(self):
        """ตั้งค่าเริ่มต้นให้ตรงกับปริศนาในภาพตัวอย่าง (แก้ทีหลังผ่าน GUI ได้)"""
        layout = {
            0: [1, 2, 3, 4, 5, 6],
            1: [1, 2, 3, 4, 5, 6, 7],
            2: [1, 2, 3, 4, 6, 7],
            3: [2, 4, 5, 6, 7],
            4: [2, 3, 4, 5, 6, 7],
            5: [2, 3, 4, 5, 6, 7],
            6: [1, 2, 3, 4, 5, 6],
            7: [1, 2, 3, 4, 5, 6],
            8: [0, 1],
        }
        self.active = {(r, c) for r, cs in layout.items() for c in cs}
        self.start = (1, 2)
        self.end = None
        self.solution = None

    # --------------------------------------------------------- controls ---
    def _build_controls(self):
        bar = tk.Frame(self.root, bg=COL_BG)
        bar.pack(fill="x", padx=10, pady=(10, 0))

        def lbl(text):
            return tk.Label(bar, text=text, bg=COL_BG, fg=COL_TEXT)

        lbl("แถว:").grid(row=0, column=0, padx=(0, 4))
        self.rows_var = tk.IntVar(value=self.rows)
        tk.Spinbox(bar, from_=1, to=30, width=4, textvariable=self.rows_var).grid(row=0, column=1)

        lbl("คอลัมน์:").grid(row=0, column=2, padx=(10, 4))
        self.cols_var = tk.IntVar(value=self.cols)
        tk.Spinbox(bar, from_=1, to=30, width=4, textvariable=self.cols_var).grid(row=0, column=3)

        tk.Button(bar, text="ปรับขนาดกริด", command=self.resize_grid).grid(row=0, column=4, padx=10)
        tk.Button(bar, text="ล้างทั้งหมด", command=self.clear_all).grid(row=0, column=5, padx=4)
        tk.Button(bar, text="เปิดทั้งหมด", command=self.fill_all).grid(row=0, column=6, padx=4)

        tk.Checkbutton(bar, text="เส้นกริดช่วย", variable=self.show_guide,
                       command=self.redraw, bg=COL_BG, fg=COL_TEXT,
                       activebackground=COL_BG, activeforeground=COL_TEXT,
                       selectcolor=COL_BG, highlightthickness=0,
                       ).grid(row=0, column=7, padx=(10, 0))

        tk.Checkbutton(bar, text="เสียง", variable=self.sound_on,
                       command=self._sync_sound, bg=COL_BG, fg=COL_TEXT,
                       activebackground=COL_BG, activeforeground=COL_TEXT,
                       selectcolor=COL_BG, highlightthickness=0,
                       ).grid(row=0, column=8, padx=(6, 0))

        bar2 = tk.Frame(self.root, bg=COL_BG)
        bar2.pack(fill="x", padx=10, pady=6)

        tk.Button(bar2, text="หาคำตอบ", command=self.solve, bg="#3d8bfd", fg="white").grid(row=0, column=0, padx=4)
        tk.Button(bar2, text="ล้างจุดเริ่ม/จบ", command=self.clear_endpoints).grid(row=0, column=1, padx=4)
        tk.Button(bar2, text="บันทึกกริด", command=self.save_grid).grid(row=0, column=2, padx=4)
        tk.Button(bar2, text="โหลดกริด", command=self.load_grid).grid(row=0, column=3, padx=4)

        self.status = tk.Label(self.root, text=self._help_text(), bg=COL_BG, fg="#9a9aa2",
                                justify="left", anchor="w")
        self.status.pack(fill="x", padx=10, pady=(0, 6))

    def _sync_sound(self):
        self.sound.enabled = self.sound_on.get()
        if self.sound.enabled:
            self.sound.play("add")      # เล่นตัวอย่างให้ได้ยินตอนเปิดเสียง

    def _help_text(self):
        return ("ลากเมาส์ซ้าย = ระบายเปิด/ปิดช่องต่อเนื่อง (คลิกช่องแรกเป็นตัวกำหนดว่าจะเปิดหรือปิด)  |  "
                "คลิกขวา = ตั้งจุดเริ่ม (วงกลมฟ้า)  |  "
                "คลิกกลาง/Shift+คลิกซ้าย = ตั้งจุดจบ (สี่เหลี่ยมส้ม, ไม่บังคับ)")

    # ------------------------------------------------------------ canvas ---
    def canvas_size(self):
        w = PAD * 2 + self.cols * CELL + (self.cols - 1) * GAP
        h = PAD * 2 + self.rows * CELL + (self.rows - 1) * GAP
        return w, h

    def cell_at(self, x, y):
        col = int((x - PAD) // (CELL + GAP))
        row = int((y - PAD) // (CELL + GAP))
        if 0 <= row < self.rows and 0 <= col < self.cols:
            # ตรวจว่าคลิกโดนช่องจริง ไม่ใช่ช่องว่างระหว่าง gap
            cx = PAD + col * (CELL + GAP)
            cy = PAD + row * (CELL + GAP)
            if cx <= x <= cx + CELL and cy <= y <= cy + CELL:
                return (row, col)
        return None

    def cell_at_loose(self, x, y):
        """หาช่องจากพิกัด โดยนับช่องว่างระหว่างช่อง (gap) เป็นของช่องที่ใกล้ที่สุด
        ใช้ตอนลากเมาส์ เพื่อไม่ให้ลากผ่านรอยต่อแล้วหลุด"""
        if x < PAD or y < PAD:
            return None
        col = int((x - PAD) // (CELL + GAP))
        row = int((y - PAD) // (CELL + GAP))
        if 0 <= row < self.rows and 0 <= col < self.cols:
            return (row, col)
        return None

    def px(self, r, c):
        return PAD + c * (CELL + GAP), PAD + r * (CELL + GAP)

    def _draw_guides(self):
        """วาดกริดพื้นหลังจาง ๆ ทุกช่อง (รวมช่องที่ปิดอยู่) พร้อมเลขแถว/คอลัมน์ริมขอบ
        เพื่อให้เล็งตำแหน่งตอนลากระบายได้ง่าย"""
        for r in range(self.rows):
            for c in range(self.cols):
                x, y = self.px(r, c)
                self.canvas.create_rectangle(x, y, x + CELL, y + CELL,
                                             outline=COL_GUIDE, width=1,
                                             dash=(2, 4), tags="guide")

        font = ("TkDefaultFont", 8)
        for c in range(self.cols):
            x, _ = self.px(0, c)
            self.canvas.create_text(x + CELL / 2, PAD / 2, text=str(c),
                                    fill=COL_GUIDE_LABEL, font=font, tags="guide")
        for r in range(self.rows):
            _, y = self.px(r, 0)
            self.canvas.create_text(PAD / 2, y + CELL / 2, text=str(r),
                                    fill=COL_GUIDE_LABEL, font=font, tags="guide")

    def redraw(self):
        w, h = self.canvas_size()
        self.canvas.config(width=w, height=h)
        self.canvas.delete("all")

        if self.show_guide.get():
            self._draw_guides()

        path_index = {}
        if self.solution:
            for i, p in enumerate(self.solution):
                path_index[p] = i

        for r in range(self.rows):
            for c in range(self.cols):
                p = (r, c)
                x, y = self.px(r, c)
                if p not in self.active:
                    continue
                fill = COL_ON
                if p in path_index:
                    fill = COL_PATH
                self.canvas.create_rectangle(x, y, x + CELL, y + CELL, fill=fill,
                                              outline="", width=0, tags="cell")

        # เส้นทางคำตอบ
        if self.solution:
            pts = []
            for (r, c) in self.solution:
                x, y = self.px(r, c)
                pts.extend([x + CELL / 2, y + CELL / 2])
            if len(pts) >= 4:
                self.canvas.create_line(*pts, fill="#2f6fd6", width=9,
                                         capstyle="round", joinstyle="round")

        # จุดเริ่ม / จุดจบ
        if self.start in self.active:
            x, y = self.px(*self.start)
            cx, cy = x + CELL / 2, y + CELL / 2
            self.canvas.create_oval(cx - 14, cy - 14, cx + 14, cy + 14,
                                     outline=COL_START, width=4, fill=COL_BG)
        if self.end and self.end in self.active:
            x, y = self.px(*self.end)
            self.canvas.create_rectangle(x + 14, y + 14, x + CELL - 14, y + CELL - 14,
                                          outline=COL_END, width=4, fill=COL_BG)

        # ตัวเลขลำดับ (ถ้ามีคำตอบ) เพื่อให้เดินตามง่าย
        if self.solution:
            for i, (r, c) in enumerate(self.solution):
                x, y = self.px(r, c)
                self.canvas.create_text(x + CELL / 2, y + CELL / 2, text=str(i + 1),
                                         fill="white", font=("TkDefaultFont", 10, "bold"))

    # ------------------------------------------------------------ events ---
    @staticmethod
    def _points_between(a, b, step=8):
        """คืนจุดตัวอย่างระหว่างพิกัด a -> b เพื่อไม่ให้ลากเร็วแล้วข้ามช่อง"""
        if a is None:
            return [b]
        (x0, y0), (x1, y1) = a, b
        n = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) // step))
        return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(1, n + 1)]

    def _paint(self, p):
        """ระบายช่อง p ตามโหมดที่กำลังลากอยู่ คืน True ถ้ามีการเปลี่ยนแปลง"""
        if p is None or p in self._drag_seen:
            return False
        self._drag_seen.add(p)
        if self._drag_mode == "add":
            if p in self.active:
                return False
            self.active.add(p)
        else:
            if p not in self.active:
                return False
            self.active.discard(p)
            if self.start == p:
                self.start = None
            if self.end == p:
                self.end = None
        self.solution = None
        return True

    def on_left_press(self, event):
        if event.state & 0x0001:  # Shift held -> set end
            p = self.cell_at(event.x, event.y)
            if p is not None:
                self.end = None if self.end == p else p
                self.redraw()
            return
        p = self.cell_at_loose(event.x, event.y)
        if p is None:
            return
        # ช่องแรกที่กดเป็นตัวกำหนดโหมด: กดบนช่องที่เปิดอยู่ = ลากลบ, ไม่งั้น = ลากเปิด
        self._drag_mode = "remove" if p in self.active else "add"
        self._drag_seen = set()
        self._drag_last = (event.x, event.y)
        if self._paint(p):
            self.sound.play(self._drag_mode)
            self.redraw()

    def on_left_drag(self, event):
        if self._drag_mode is None:
            return
        changed = False
        for (x, y) in self._points_between(self._drag_last, (event.x, event.y)):
            if self._paint(self.cell_at_loose(x, y)):
                changed = True
        self._drag_last = (event.x, event.y)
        if changed:
            self.sound.play(self._drag_mode)
            self.redraw()

    def on_left_release(self, event):
        self._drag_mode = None
        self._drag_seen = set()
        self._drag_last = None

    def on_right_click(self, event):
        p = self.cell_at(event.x, event.y)
        if p is None or p not in self.active:
            return
        self.start = p
        self.solution = None
        self.redraw()

    def on_middle_click(self, event):
        p = self.cell_at(event.x, event.y)
        if p is None or p not in self.active:
            return
        self.end = None if self.end == p else p
        self.solution = None
        self.redraw()

    # ------------------------------------------------------------ actions ---
    def resize_grid(self):
        self.rows = max(1, self.rows_var.get())
        self.cols = max(1, self.cols_var.get())
        self.active = {p for p in self.active if p[0] < self.rows and p[1] < self.cols}
        if self.start and self.start not in self.active:
            self.start = None
        if self.end and self.end not in self.active:
            self.end = None
        self.solution = None
        self.redraw()

    def clear_all(self):
        self.active = set()
        self.start = None
        self.end = None
        self.solution = None
        self.redraw()

    def fill_all(self):
        self.active = {(r, c) for r in range(self.rows) for c in range(self.cols)}
        self.solution = None
        self.redraw()

    def clear_endpoints(self):
        self.start = None
        self.end = None
        self.solution = None
        self.redraw()

    def solve(self):
        if not self.active:
            messagebox.showinfo("แจ้งเตือน", "ยังไม่มีช่องที่เปิดใช้งานเลย")
            return
        if self.start is None:
            messagebox.showinfo("แจ้งเตือน", "กรุณาคลิกขวาเพื่อกำหนดจุดเริ่มต้นก่อน")
            return
        self.status.config(text="กำลังคำนวณ...")
        self.root.update_idletasks()
        result = solve_hamiltonian_path(self.active, self.start, self.end)
        if result is None:
            self.solution = None
            self.status.config(text="ไม่พบคำตอบ — ลองเปลี่ยนจุดเริ่ม/จุดจบ หรือตรวจสอบรูปร่างกริดอีกครั้ง")
            messagebox.showwarning("ไม่พบคำตอบ", "ปริศนานี้ไม่มีเส้นทางที่ผ่านทุกช่องครบโดยไม่ทับเส้นซ้ำ\n"
                                                    "ลองเปลี่ยนจุดเริ่มต้น/จุดจบ หรือตรวจสอบว่าเปิดช่องถูกต้องหรือไม่")
        else:
            self.solution = result
            self.status.config(text=f"พบคำตอบแล้ว! เส้นทางยาว {len(result)} ช่อง")
        self.redraw()

    def save_grid(self):
        path = filedialog.asksaveasfilename(defaultextension=".json",
                                             filetypes=[("JSON", "*.json")])
        if not path:
            return
        data = {
            "rows": self.rows,
            "cols": self.cols,
            "active": sorted(list(self.active)),
            "start": self.start,
            "end": self.end,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.status.config(text=f"บันทึกแล้ว: {path}")

    def load_grid(self):
        path = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if not path:
            return
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.rows = data["rows"]
        self.cols = data["cols"]
        self.rows_var.set(self.rows)
        self.cols_var.set(self.cols)
        self.active = {tuple(p) for p in data["active"]}
        self.start = tuple(data["start"]) if data.get("start") else None
        self.end = tuple(data["end"]) if data.get("end") else None
        self.solution = None
        self.status.config(text=f"โหลดแล้ว: {path}")
        self.redraw()


def main():
    root = tk.Tk()
    app = GridPathApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()