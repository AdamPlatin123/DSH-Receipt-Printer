# -*- coding: utf-8 -*-
"""thermal_bridge.py - DSH plugin 的自包含打印桥.

stdin: ReceiptStats JSON (从 src/collector.ts 传过来)
stdout: 一行 OK / ERR:... (供 TS 端诊断)

职责单一: stats JSON -> ESC/POS 字节 -> Win32 spooler raw print.
零第三方 Python 依赖 (仅标准库 ctypes + winspool.drv).

为什么单文件自包含: DSH 插件分发要满足 Git 安装即用, 不依赖外部仓库路径.
渲染逻辑与根目录 renderer.py 同源 (58mm / 384 dots / GBK / ■□ 安全字符),
但此处刻意不 import 根目录模块, 保证插件包单独可分发.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import sys
from ctypes import wintypes
from datetime import datetime

# ===== ESC/POS 常量 =====
ESC_INIT = b"\x1b@"
ESC_ALIGN_L = b"\x1ba\x00"
ESC_ALIGN_C = b"\x1ba\x01"
ESC_ALIGN_R = b"\x1ba\x02"
ESC_BOLD_ON = b"\x1bE\x01"
ESC_BOLD_OFF = b"\x1bE\x00"
ESC_DW_ON = b"\x1d!\x11"
ESC_DW_OFF = b"\x1d!\x00"
ESC_RESET = b"\x1b!\x00"
FEED_CUT = b"\x1dV\x41\x03"
FILLED, EMPTY = "■", "□"  # ■ / □ (GB2312 A1F6 / A1F7)
LINE_UNITS = 32  # 58mm: 384 dots / 12 dots per ANK char
RECAP_MAX_LINES = 8  # paper-length cap for the merged auto-recap section

# GBK-safe downgrade map: LLM output often carries symbols the 58mm printer's
# GB2312 font does not have. Map the common ones to ASCII equivalents; anything
# still unmappable falls back to '?' in enc().
CHAR_MAP = {
    "→": "->", "←": "<-", "↑": "^", "↓": "v", "↔": "<->",
    "…": "...", "─": "-", "━": "=", "│": "|", "┌": "+", "┐": "+",
    "└": "+", "┘": "+", "├": "+", "┤": "+",
    "✓": "OK", "✔": "OK", "✗": "XX", "✘": "XX", "❌": "XX", "✅": "[OK]",
    "⭐": "*", "★": "*", "☆": "*", "🔥": "[!]", "⚡": "[!]",
    "🎯": "[*]", "📌": "[*]", "💡": "[*]",
    "—": "--", "–": "-", "•": "*", "·": ".",
    "𝑥": "x", "𝑦": "y", "𝑛": "n",
    "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "∈": "in",
    "×": "x", "÷": "/", "±": "+-",
    "α": "a", "β": "b", "γ": "g", "δ": "d", "λ": "L", "μ": "u", "π": "pi",
    "¥": "Y", "￥": "Y",
    "（": "(", "）": ")", "【": "[", "】": "]", "《": "<", "》": ">",
    "｛": "{", "｝": "}", "：": ":", "；": ";",
}

TOOL_ALIASES = {
    "read": "Read", "write": "Write", "edit": "Edit",
    "bash": "Bash", "grep": "Grep", "glob": "Glob",
    "TaskUpdate": "TskUpd", "TaskCreate": "TskNew",
    "TaskList": "TskLst", "TodoWrite": "Todo",
    "WebFetch": "WebFet", "WebSearch": "WebSrh",
}


def vw(text: str) -> int:
    """visual width: ANK=1, CJK=2."""
    w = 0
    for ch in text:
        w += 2 if (
            0x2E80 <= ord(ch) <= 0xA4CF
            or 0xAC00 <= ord(ch) <= 0xD7A3
            or 0xF900 <= ord(ch) <= 0xFAFF
            or 0xFE30 <= ord(ch) <= 0xFE4F
            or 0xFF00 <= ord(ch) <= 0xFF60
            or 0xFFE0 <= ord(ch) <= 0xFFE6
        ) else 1
    return w


def to_gbk_safe(text: str) -> str:
    """Downgrade every char the GBK font cannot render: CHAR_MAP first,
    then '?' for whatever is still unmappable (emoji, rare scripts)."""
    out = []
    for ch in text:
        try:
            ch.encode("gbk")
            out.append(ch)
            continue
        except UnicodeEncodeError:
            pass
        out.append(CHAR_MAP.get(ch, "?"))
    return "".join(out)


def enc(text: str) -> bytes:
    return to_gbk_safe(text).encode("gbk", errors="replace")


def human(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def wrap_text(text: str, width: int = LINE_UNITS, max_lines=None) -> list:
    """Wrap GBK-safe text to `width` visual units per line.
    max_lines=None wraps the full text (caller caps the total); an int caps
    per call and appends '...' on overflow. ANK=1 unit, CJK=2 units (same
    table as vw()). English words stay whole; CJK breaks anywhere."""
    if not text:
        return []
    safe = to_gbk_safe(" ".join(text.split()))
    lines, cur, cur_w = [], "", 0
    overflow = False
    last_space = -1  # index in cur where the most recent space sits
    for ch in safe:
        w = vw(ch)
        if cur_w + w > width:
            if max_lines is not None and len(lines) + 1 >= max_lines:
                overflow = True
                break
            # Prefer breaking at the last space so English words stay whole
            if ch != " " and last_space > 0:
                head, tail = cur[:last_space], cur[last_space + 1:]
                lines.append(head.rstrip())
                cur, cur_w = tail + ch, vw(tail) + w
            else:
                lines.append(cur.rstrip())
                cur, cur_w = ("" if ch == " " else ch), (0 if ch == " " else w)
            last_space = -1
        else:
            cur += ch
            cur_w += w
            if ch == " ":
                last_space = len(cur) - 1
    if cur.strip() and (max_lines is None or len(lines) < max_lines):
        lines.append(cur.rstrip())
    if overflow:
        last = lines[-1] if lines else ""
        keep = max(0, len(last) - 3)
        lines[-1] = last[:keep] + "..."
    return [l for l in lines if l]


class R:
    """链式 ESC/POS 构建器 (与根目录 renderer.py 同形, 自包含副本)."""

    def __init__(self):
        self.parts = [ESC_INIT]

    def line(self, text="", align="l", bold=False, double=False):
        self.parts.append({"l": ESC_ALIGN_L, "c": ESC_ALIGN_C, "r": ESC_ALIGN_R}[align])
        if double:
            self.parts.append(ESC_DW_ON)
        if bold:
            self.parts.append(ESC_BOLD_ON)
        self.parts.append(enc(text) + b"\n")
        if bold:
            self.parts.append(ESC_BOLD_OFF)
        if double:
            self.parts.append(ESC_DW_OFF)
        return self

    def center(self, text, bold=False, double=False):
        return self.line(text, "c", bold, double)

    def divider(self, ch="-"):
        if ch == "-":
            text = ("- " * 17).rstrip()
        else:
            text = ch * (LINE_UNITS // vw(ch))
        return self.line(text[:LINE_UNITS], "l")

    def kv(self, key, value, bold=False):
        pad = LINE_UNITS - vw(key) - vw(value)
        if pad < 1:
            self.line(key, "l", bold=bold)
            return self.line(value, "r")
        return self.line(key + " " * pad + value, "l", bold=bold)

    def section(self, title):
        return self.line().line(title, "l", bold=True)

    def bar(self, label, value, max_value, blocks=10):
        ratio = 0 if max_value == 0 else value / max_value
        filled = round(ratio * blocks)
        blk = FILLED * filled + EMPTY * (blocks - filled)
        label = TOOL_ALIASES.get(label, label)[:8].ljust(8)
        num = f"{value:>4}"
        pad = max(1, LINE_UNITS - vw(label) - vw(blk) - vw(num))
        return self.line(f"{label}{blk}{' ' * pad}{num}", "l")

    def qr(self, data, module_size=5):
        d = data.encode("gbk", errors="replace")
        self.parts.append(ESC_ALIGN_C)
        self.parts.append(b"\x1d(k\x04\x00\x31\x41\x32")
        self.parts.append(bytes([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, module_size]))
        self.parts.append(b"\x1d(k\x03\x00\x31\x45\x31")
        self.parts.append(
            bytes([0x1d, 0x28, 0x6b]) + len(d).to_bytes(2, "little") + b"\x31\x50\x30" + d
        )
        self.parts.append(b"\x1d(k\x03\x00\x31\x51\x30\n")
        return self

    def cut(self):
        self.parts.append(b"\n\n\n" + FEED_CUT)
        return self

    def build(self):
        return b"".join(self.parts) + ESC_RESET


def render_receipt(s: dict) -> bytes:
    """stats JSON dict -> 完整小票字节流."""
    r = R()
    recap = s.get("recap") or None
    # 'auto' = task receipt with merged LLM summary (stats + recap in one)
    # 'btw'/'recap' = standalone side-call receipt (Q/A only, no stats)
    is_side = bool(recap) and str(recap.get("kind", "")) in ("btw", "recap")

    # Header (different title for standalone side-call receipts)
    title = "RECAP RECEIPT" if is_side else "DSH RECEIPT"
    r.center(title, bold=True, double=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    r.center(ts)
    r.center(f"host {s.get('host', 'dsh')}")
    r.divider()

    # Session summary (skip for standalone side-call receipts)
    if not is_side:
        r.kv("项目", str(s.get("project", "-"))[:LINE_UNITS - 8])
        dur = int(s.get("durationSec", 0))
        r.kv("时长", f"{dur // 3600:02d}:{(dur % 3600) // 60:02d}:{dur % 60:02d}")
        r.kv("轮次", str(s.get("turns", 0)))
        model = str(s.get("model", "") or "-")
        r.kv("模型", model[:LINE_UNITS - 8])
        trigger = str(s.get("trigger", ""))
        if trigger:
            r.kv("触发", trigger)

    # Standalone /btw + /recap side-call receipt: Q + A wrapped
    if is_side:
        kind = str(recap.get("kind", "btw"))
        r.center(f"[/{kind}]", bold=True)
        r.divider()
        q = str(recap.get("question", ""))
        if q:
            r.line("Q:", "l", bold=True)
            for ln in wrap_text(q, max_lines=3):
                r.line(ln, "l")
        a = str(recap.get("answer", ""))
        if a:
            r.line("A:", "l", bold=True)
            for ln in wrap_text(a, max_lines=8):
                r.line(ln, "l")
        r.kv("模型", str(recap.get("model", "-"))[:LINE_UNITS - 8])

    # Tool calls (skip for standalone side-call receipts - they have no tools)
    tool_calls = {} if is_side else (s.get("toolCalls") or {})
    if tool_calls:
        r.divider()
        total = sum(tool_calls.values())
        r.section(f"工具调用 ({total})")
        top = sorted(tool_calls.items(), key=lambda x: -x[1])[:6]
        mx = top[0][1] if top else 0
        for name, n in top:
            r.bar(name, n, mx)

    # Files
    files = [] if is_side else (s.get("filesWritten") or [])
    if files:
        r.divider()
        r.section(f"产出文件 ({len(files)})")
        for fp in files[:6]:
            name = str(fp).replace("\\", "/").split("/")[-1]
            r.line(f"+ {name[:LINE_UNITS - 2]}", "l")

    # Tokens (skip for side-call receipts - those calls report no usage)
    total_tok = int(s.get("inputTokens", 0)) + int(s.get("outputTokens", 0)) + int(s.get("cacheReadTokens", 0))
    if not is_side and total_tok > 0:
        r.divider()
        r.section("TOKEN")
        r.kv("  input", human(int(s.get("inputTokens", 0))))
        r.kv("  output", human(int(s.get("outputTokens", 0))))
        cache = int(s.get("cacheReadTokens", 0))
        if cache:
            r.kv("  cacheR", human(cache))
        think = int(s.get("thinkingTokens", 0))
        if think:
            r.kv("  think", human(think))
        r.kv("  TOTAL", human(total_tok), bold=True)

        # Cost block: turn cost (peak-aware CNY, dsh-tui pricing snapshot
        # 2026-08) + account balance (CNY from /user/balance).
        # Peak = Beijing weekday 9-12 & 14-18 (weekends always off-peak).
        cost = s.get("costCny")
        peak = s.get("isPeak")
        balance = s.get("balanceCny")
        if cost is not None or balance:
            label = "COST"
            if peak is True:
                label += " [峰]"
            elif peak is False:
                label += " [谷]"
            r.kv(label, f"Y{float(cost):.4f}" if cost is not None else "-", bold=True)
            if balance:
                r.kv("  余额", f"¥{balance}")

    # Merged auto-recap (kind='auto'): task summary between stats and footer.
    # The LLM is asked for brief/sharp 3-section output, but it can ignore the
    # per-line cap or emit one long unbroken run - so we ALWAYS re-wrap the
    # full answer (never trust the model's own newlines) and cap the total
    # at RECAP_MAX_LINES with a trailing '...' when content still remains.
    if recap and not is_side:
        answer = str(recap.get("answer", ""))
        if answer:
            r.divider()
            r.center("RECAP", bold=True)
            wrapped: list = []
            for raw_line in answer.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                wrapped.extend(wrap_text(line, max_lines=None))
            if len(wrapped) > RECAP_MAX_LINES:
                last = wrapped[RECAP_MAX_LINES - 1]
                wrapped = wrapped[:RECAP_MAX_LINES]
                wrapped[-1] = last[: max(0, len(last) - 3)] + "..."
            for ln in wrapped:
                r.line(ln, "l")

    # Footer + QR
    r.divider("=")
    r.center("dsh-thermal-receipt")
    r.center(f"session {str(s.get('sessionId', ''))[:8]}")
    r.qr(f"dsh-session://{s.get('sessionId', 'unknown')}")
    r.cut()
    return r.build()


# ===== Win32 spooler raw print =====

class DOC_INFO_1W(ctypes.Structure):
    _fields_ = [
        ("pDocName", wintypes.LPWSTR),
        ("pOutputFile", wintypes.LPWSTR),
        ("pDatatype", wintypes.LPWSTR),
    ]


class PRINTER_DEFAULTSW(ctypes.Structure):
    _fields_ = [
        ("pDatatype", wintypes.LPWSTR),
        ("pDevMode", ctypes.c_void_p),
        ("DesiredAccess", wintypes.DWORD),
    ]


def raw_print(printer_name: str, data: bytes, doc_name: str = "DSH Receipt") -> int:
    PRINTER_ACCESS_USE = 0x00000008
    wp = ctypes.WinDLL("winspool.drv", use_last_error=True)
    wp.OpenPrinterW.restype = wintypes.BOOL
    wp.OpenPrinterW.argtypes = [
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.HANDLE),
        ctypes.POINTER(PRINTER_DEFAULTSW),
    ]
    wp.StartDocPrinterW.restype = wintypes.DWORD
    wp.StartDocPrinterW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(DOC_INFO_1W)
    ]
    wp.StartPagePrinter.restype = wintypes.BOOL
    wp.StartPagePrinter.argtypes = [wintypes.HANDLE]
    wp.WritePrinter.restype = wintypes.BOOL
    wp.WritePrinter.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    wp.EndPagePrinter.restype = wintypes.BOOL
    wp.EndPagePrinter.argtypes = [wintypes.HANDLE]
    wp.EndDocPrinter.restype = wintypes.BOOL
    wp.EndDocPrinter.argtypes = [wintypes.HANDLE]
    wp.ClosePrinter.restype = wintypes.BOOL
    wp.ClosePrinter.argtypes = [wintypes.HANDLE]

    handle = wintypes.HANDLE()
    defaults = PRINTER_DEFAULTSW(None, None, PRINTER_ACCESS_USE)
    if not wp.OpenPrinterW(printer_name, ctypes.byref(handle), ctypes.byref(defaults)):
        raise OSError(ctypes.get_last_error(), f"OpenPrinterW('{printer_name}') failed")

    written = wintypes.DWORD(0)
    try:
        doc = DOC_INFO_1W(doc_name, None, "RAW")
        if wp.StartDocPrinterW(handle, 1, ctypes.byref(doc)) == 0:
            raise OSError(ctypes.get_last_error(), "StartDocPrinterW failed")
        if not wp.StartPagePrinter(handle):
            raise OSError(ctypes.get_last_error(), "StartPagePrinter failed")
        buf = ctypes.create_string_buffer(data, len(data))
        if not wp.WritePrinter(handle, buf, len(data), ctypes.byref(written)):
            raise OSError(ctypes.get_last_error(), "WritePrinter failed")
        wp.EndPagePrinter(handle)
        wp.EndDocPrinter(handle)
    finally:
        wp.ClosePrinter(handle)
    return written.value


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--printer", default="Thermal-58")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="render only, print ASCII to stderr")
    args = ap.parse_args()

    # The TS side (bridge.ts) writes JSON.stringify(stats) with Node's default
    # utf8 encoding. Windows Python's text-mode sys.stdin decodes as cp936/GBK
    # (system locale), which mangles every multi-byte CJK char in the recap
    # answer. Read raw bytes and decode utf-8 explicitly.
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    if not raw.strip():
        print("ERR:empty stdin", flush=True)
        return 1
    try:
        stats = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERR:bad json: {e}", flush=True)
        return 1

    try:
        data = render_receipt(stats)
    except Exception as e:
        print(f"ERR:render: {e}", flush=True)
        return 1

    if args.dry_run:
        # ASCII preview on stderr so the caller can inspect without paper
        preview = []
        i = 0
        while i < len(data):
            b = data[i]
            if b in (0x1B, 0x1D):
                i += 2
                if i < len(data) and data[i] in (0x21, 0x45, 0x61, 0x40, 0x28, 0x6B, 0x56, 0x55):
                    i += 1
                continue
            if b == 0x0A:
                preview.append("\n")
                i += 1
                continue
            if 0x20 <= b < 0x7F:
                preview.append(chr(b))
                i += 1
                continue
            if 0xA1 <= b <= 0xFE and i + 1 < len(data) and 0xA1 <= data[i + 1] <= 0xFE:
                try:
                    preview.append(bytes([b, data[i + 1]]).decode("gbk"))
                except UnicodeDecodeError:
                    preview.append("?")
                i += 2
                continue
            i += 1
        sys.stderr.write("".join(preview) + "\n")
        print(f"OK rendered {len(data)} bytes (dry-run)", flush=True)
        return 0

    try:
        n = raw_print(args.printer, data, doc_name=f"dsh-receipt-{str(stats.get('sessionId', ''))[:8]}")
        print(f"OK printed {n} bytes -> {args.printer}", flush=True)
        return 0
    except Exception as e:
        print(f"ERR:print: {e}", flush=True)
        return 1


if __name__ == "__main__":
    # stderr carries the dry-run ASCII/GBK preview back to bridge.ts, which
    # decodes with toString('utf8'). Align both ends so the debug log preview
    # stays readable instead of double-mojibake.
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass  # Python < 3.7
    sys.exit(main())
