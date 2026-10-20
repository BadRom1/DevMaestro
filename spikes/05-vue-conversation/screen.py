#!/usr/bin/env python3
"""Émulateur de terminal minimal : rejoue pty-raw.bin (jusqu'à un instant donné) et affiche l'écran.

Usage : screen.py <sortie> [--at <ts epoch>] [--rows 50 --cols 160]
Sert à piloter les sessions (voir l'écran courant) et à l'analyse (instant où un texte devient visible).
"""
import json
import os
import re
import sys
import unicodedata

CSI = re.compile(rb"\x1b\[([?>=!]?)([0-9;:]*)([ -/]*)([@-~])")
OSC = re.compile(rb"\x1b\][^\x07\x1b]*(\x07|\x1b\\)")


class Screen:
    def __init__(self, rows=50, cols=160):
        self.rows, self.cols = rows, cols
        self.reset()

    def reset(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.y = self.x = 0
        self.top, self.bot = 0, self.rows - 1
        self.saved = (0, 0)
        self.pending = b""

    def scroll_up(self, n=1):
        for _ in range(n):
            del self.grid[self.top]
            self.grid.insert(self.bot, [" "] * self.cols)

    def scroll_down(self, n=1):
        for _ in range(n):
            del self.grid[self.bot]
            self.grid.insert(self.top, [" "] * self.cols)

    def lf(self):
        if self.y == self.bot:
            self.scroll_up()
        elif self.y < self.rows - 1:
            self.y += 1

    def put(self, ch):
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if self.x + w > self.cols:
            self.x = 0
            self.lf()
        self.grid[self.y][self.x] = ch
        if w == 2 and self.x + 1 < self.cols:
            self.grid[self.y][self.x + 1] = ""
        self.x += w

    def csi(self, priv, params, final):
        ps = [int(p) if p.isdigit() else 0 for p in params.replace(":", ";").split(";")] if params else []
        p1 = ps[0] if ps and ps[0] else 1
        if priv == "?":
            if final in "hl" and any(p in (1049, 47, 1047) for p in ps):
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
            return
        if priv:
            return
        if final == "A":
            self.y = max(self.top if self.y >= self.top else 0, self.y - p1)
        elif final == "B":
            self.y = min(self.rows - 1, self.y + p1)
        elif final == "C":
            self.x = min(self.cols - 1, self.x + p1)
        elif final == "D":
            self.x = max(0, self.x - p1)
        elif final == "E":
            self.y, self.x = min(self.rows - 1, self.y + p1), 0
        elif final == "F":
            self.y, self.x = max(0, self.y - p1), 0
        elif final == "G":
            self.x = min(self.cols - 1, p1 - 1)
        elif final == "d":
            self.y = min(self.rows - 1, p1 - 1)
        elif final in "Hf":
            r = ps[0] if len(ps) > 0 and ps[0] else 1
            c = ps[1] if len(ps) > 1 and ps[1] else 1
            self.y, self.x = min(self.rows - 1, r - 1), min(self.cols - 1, c - 1)
        elif final == "J":
            m = ps[0] if ps else 0
            if m == 0:
                self.grid[self.y][self.x:] = [" "] * (self.cols - self.x)
                for r in range(self.y + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
            elif m == 1:
                for r in range(self.y):
                    self.grid[r] = [" "] * self.cols
                self.grid[self.y][: self.x + 1] = [" "] * (self.x + 1)
            else:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
        elif final == "K":
            m = ps[0] if ps else 0
            row = self.grid[self.y]
            if m == 0:
                row[self.x:] = [" "] * (self.cols - self.x)
            elif m == 1:
                row[: self.x + 1] = [" "] * (self.x + 1)
            else:
                self.grid[self.y] = [" "] * self.cols
        elif final == "r":
            self.top = (ps[0] - 1) if ps and ps[0] else 0
            self.bot = (ps[1] - 1) if len(ps) > 1 and ps[1] else self.rows - 1
            self.y = self.x = 0
        elif final == "S":
            self.scroll_up(p1)
        elif final == "T":
            self.scroll_down(p1)
        elif final == "L":
            for _ in range(p1):
                del self.grid[self.bot]
                self.grid.insert(self.y, [" "] * self.cols)
        elif final == "M":
            for _ in range(p1):
                del self.grid[self.y]
                self.grid.insert(self.bot, [" "] * self.cols)
        elif final == "P":
            row = self.grid[self.y]
            del row[self.x: self.x + p1]
            row.extend([" "] * (self.cols - len(row)))
        elif final == "X":
            row = self.grid[self.y]
            for i in range(self.x, min(self.cols, self.x + p1)):
                row[i] = " "
        elif final == "@":
            row = self.grid[self.y]
            for _ in range(p1):
                row.insert(self.x, " ")
            del row[self.cols:]

    def feed(self, data):
        data = self.pending + data
        self.pending = b""
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == 0x1b:
                m = CSI.match(data, i)
                if m:
                    self.csi(m.group(1).decode(), m.group(2).decode(), m.group(4).decode())
                    i = m.end()
                    continue
                m = OSC.match(data, i)
                if m:
                    i = m.end()
                    continue
                if i + 1 >= n or (data[i + 1:i + 2] in (b"[", b"]") and n - i < 64):
                    self.pending = data[i:]
                    return
                nxt = data[i + 1:i + 2]
                if nxt == b"7":
                    self.saved = (self.y, self.x)
                elif nxt == b"8":
                    self.y, self.x = self.saved
                elif nxt == b"M":
                    if self.y == self.top:
                        self.scroll_down()
                    else:
                        self.y = max(0, self.y - 1)
                elif nxt == b"c":
                    self.reset()
                elif nxt in (b"(", b")"):
                    i += 1
                elif nxt == b"]":  # OSC tronqué : on saute jusqu'à BEL
                    j = data.find(b"\x07", i)
                    i = j if j > 0 else n - 1
                i += 2
                continue
            if b == 0x0d:
                self.x = 0
            elif b == 0x0a:
                self.lf()
            elif b == 0x08:
                self.x = max(0, self.x - 1)
            elif b == 0x09:
                self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
            elif b < 0x20 or b == 0x7f:
                pass
            else:
                # UTF-8 : longueur du caractère d'après l'octet de tête
                ln = 1 if b < 0x80 else 2 if b < 0xe0 else 3 if b < 0xf0 else 4
                if i + ln > n:
                    self.pending = data[i:]
                    return
                self.put(data[i:i + ln].decode("utf-8", "replace"))
                i += ln
                continue
            i += 1

    def text(self):
        return "\n".join("".join(r).rstrip() for r in self.grid)


def replay(out, until=None, rows=50, cols=160, on_chunk=None):
    scr = Screen(rows, cols)
    with open(os.path.join(out, "pty-raw.bin"), "rb") as raw, open(os.path.join(out, "pty-index.jsonl")) as idx:
        for line in idx:
            c = json.loads(line)
            if until is not None and c["ts"] > until:
                break
            raw.seek(c["off"])
            scr.feed(raw.read(c["n"]))
            if on_chunk:
                on_chunk(c["ts"], scr)
    return scr


if __name__ == "__main__":
    a = sys.argv[1:]
    at = float(a[a.index("--at") + 1]) if "--at" in a else None
    print(replay(a[0], at).text())
