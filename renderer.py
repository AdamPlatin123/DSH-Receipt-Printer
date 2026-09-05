# -*- coding: utf-8 -*-
"""SessionStats -> ESC/POS 字节流渲染器 (58mm / 384 dots / 32 ANK units).

单一职责: 把结构化统计渲染成打印机字节. 不读文件, 不调 API.
适配: 山寨 58mm (VID_0483 STM32) 内置 GB2312 点阵字库:
  - 文本: GBK 编码 (ANS/CJK 双字节)
  - 图块: 仅使用 GB2312 安全字符 ■□ (A1F6/A1F7)
  - 对齐/粗体/倍宽/切刀: 标准 ESC/POS, 兼容性最高
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List, Tuple

from collector import SessionStats, human_tokens

# ===== ESC/POS 命令常量 =====
ESC_INIT = b"\x1b@"            # 初始化
ESC_ALIGN_L = b"\x1ba\x00"
ESC_ALIGN_C = b"\x1ba\x01"
ESC_ALIGN_R = b"\x1ba\x02"
ESC_BOLD_ON = b"\x1bE\x01"
ESC_BOLD_OFF = b"\x1bE\x00"
ESC_DW_ON = b"\x1d!\x11"       # double width + height
ESC_DW_OFF = b"\x1d!\x00"
ESC_RESET = b"\x1b!\x00"       # reset all char modes
FEED_CUT = b"\x1dV\x41\x03"    # auto feed + full cut (无切刀则忽略)

FILLED = "■"   # ■ GB2312 A1F6
EMPTY = "□"    # □ GB2312 A1F7

# 工具名缩写: 8 ANK 内显示完整语义, 避免词中断 (TaskUpda 这种)
TOOL_ALIASES = {
    "TaskUpdate": "TskUpd",
    "TaskCreate": "TskNew",
    "TaskList": "TskLst",
    "TaskGet": "TskGet",
    "TodoWrite": "Todo",
    "WebFetch": "WebFet",
    "WebSearch": "WebSrh",
    "NotebookEdit": "NbEdit",
}

LINE_UNITS = 32  # 58mm: 384 dots / 12 dots per ANK


def vw(text: str) -> int:
    """visual width: ANK=1, CJK/fullwidth=2."""
    w = 0
    for ch in text:
        w += 2 if (
            0x1100 <= ord(ch) <= 0x115F
            or 0x2E80 <= ord(ch) <= 0xA4CF
            or 0xAC00 <= ord(ch) <= 0xD7A3
            or 0xF900 <= ord(ch) <= 0xFAFF
            or 0xFE30 <= ord(ch) <= 0xFE4F
            or 0xFF00 <= ord(ch) <= 0xFF60
            or 0xFFE0 <= ord(ch) <= 0xFFE6
        ) else 1
    return w


# GBK 字库外的常见字符降级表（与 vendor/thermal_bridge.py 同源; 双边同步）
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
}


def to_gbk_safe(text: str) -> str:
    """把 GBK 编不出的字符先查表降级, 仍编不出用 '?' 兜底."""
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


def _enc(text: str) -> bytes:
    """GBK 安全编码: 先用 CHAR_MAP 降级常见符号, 编不出的字符最后变 '?'."""
    return to_gbk_safe(text).encode("gbk", errors="replace")


@dataclass
class ReceiptRenderer:
    """链式构建 receipt 字节流. 所有原语自动追加 newline."""

    parts: List[bytes] = field(default_factory=lambda: [ESC_INIT])

    # ---- 低层原语 ----
    def raw(self, data: bytes) -> "ReceiptRenderer":
        self.parts.append(data)
        return self

    def line(
        self,
        text: str = "",
        align: str = "l",
        bold: bool = False,
        double: bool = False,
    ) -> "ReceiptRenderer":
        """单行输出, 自动对齐 + 模式包装."""
        prefix = {"l": ESC_ALIGN_L, "c": ESC_ALIGN_C, "r": ESC_ALIGN_R}[align]
        self.parts.append(prefix)
        if double:
            self.parts.append(ESC_DW_ON)
        if bold:
            self.parts.append(ESC_BOLD_ON)
        self.parts.append(_enc(text) + b"\n")
        if bold:
            self.parts.append(ESC_BOLD_OFF)
        if double:
            self.parts.append(ESC_DW_OFF)
        return self

    def center(self, text: str, bold: bool = False, double: bool = False):
        return self.line(text, "c", bold, double)

    def divider(self, ch: str = "-", blank: bool = False) -> "ReceiptRenderer":
        """分割线: '- - - -' 等距虚线 (适配 32 ANK 单位)."""
        if ch == "-":
            sym, span, step = "-", 32, 2
        else:
            sym, span, step = ch, LINE_UNITS // vw(ch), 1
        text = (sym + " " if step == 2 else sym) * (span // (2 if step == 2 else 1))
        return self.line(text.strip().ljust(LINE_UNITS)[:LINE_UNITS], "l")

    def kv(self, key: str, value: str, bold_key: bool = False) -> "ReceiptRenderer":
        """key 左 / value 右 两端对齐 (经典小票行)."""
        pad = LINE_UNITS - vw(key) - vw(value)
        if pad < 1:
            # 退化: value 换行右对齐
            self.line(key, "l", bold=bold_key)
            return self.line(value, "r")
        return self.line(key + " " * pad + value, "l", bold=bold_key)

    def section(self, title: str) -> "ReceiptRenderer":
        """小节标题: 空行 + 粗体标题."""
        return self.line().line(title, "l", bold=True)

    def bar(self, label: str, value: int, max_value: int, blocks: int = 10):
        """label + ■/□ 比例条 + 数字. 自适应标签宽度, 32 ANK 不溢出."""
        ratio = 0 if max_value == 0 else value / max_value
        filled = round(ratio * blocks)
        block_str = (FILLED * filled + EMPTY * (blocks - filled))
        # 标签压缩到 8 ANK, 给 bar(10)+数字(4)+空格(2) 留位
        label = TOOL_ALIASES.get(label, label)
        label_pad = label[:8].ljust(8)
        num = f"{value:>4}"
        pad = LINE_UNITS - vw(label_pad) - vw(block_str) - vw(num)
        if pad < 1:
            block_str = block_str[: blocks + pad - 1] if blocks + pad > 1 else ""
            pad = max(1, LINE_UNITS - vw(label_pad) - vw(block_str) - vw(num))
        return self.line(f"{label_pad}{block_str}{' ' * pad}{num}", "l")

    def qr(self, data: str, module_size: int = 5) -> "ReceiptRenderer":
        """标准 ESC/POS QR (model 2, EC=M). 不支持的机型会忽略."""
        d = data.encode("gbk", errors="replace")
        self.parts.append(ESC_ALIGN_C)
        self.parts.append(b"\x1d(k\x04\x00\x31\x41\x32")           # model 2
        self.parts.append(bytes([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, module_size]))
        self.parts.append(b"\x1d(k\x03\x00\x31\x45\x31")           # EC=M
        self.parts.append(
            bytes([0x1d, 0x28, 0x6b]) + len(d).to_bytes(2, "little")
            + b"\x31\x50\x30" + d
        )
        self.parts.append(b"\x1d(k\x03\x00\x31\x51\x30")           # print buffer
        self.parts.append(b"\n")
        return self

    def blank(self, n: int = 1) -> "ReceiptRenderer":
        self.parts.append(b"\n" * n)
        return self

    def cut(self) -> "ReceiptRenderer":
        self.parts.append(b"\n\n\n" + FEED_CUT)
        return self

    def build(self) -> bytes:
        return b"".join(self.parts) + ESC_RESET


# ===== 业务渲染: SessionStats -> receipt =====


def render_receipt(s: SessionStats, with_qr: bool = True) -> bytes:
    """把 SessionStats 渲染为完整 AGENT WORK RECEIPT (58mm)."""
    r = ReceiptRenderer()

    # Header
    r.center("AGENT RECEIPT", bold=True, double=True)
    if s.started_at:
        r.center(s.started_at.strftime("%Y-%m-%d %H:%M"))
    r.center(f"session {s.session_id[:8]}", bold=False)
    r.divider()

    # Project / summary
    r.kv("项目", s.project or "-")
    if s.title:
        r.kv("标题", s.title[:14])
    r.kv("时长", s.duration_hms)
    r.kv("轮次", f"{s.turns or s.user_msgs}")
    r.kv("模型", s.model or "-")

    # Tool usage
    total_calls = sum(s.tool_calls.values())
    if s.tool_calls:
        r.divider()
        r.section(f"工具调用 ({total_calls})")
        top = sorted(s.tool_calls.items(), key=lambda x: -x[1])[:6]
        mx = top[0][1]
        for name, n in top:
            r.bar(name, n, mx)

    # Files written
    if s.files_written:
        r.divider()
        r.section(f"产出文件 ({len(s.files_written)})")
        for fp in s.files_written[:8]:
            name = fp.replace("\\", "/").split("/")[-1]
            r.line(f"+ {name[:LINE_UNITS-2]}", "l")

    # Tokens
    r.divider()
    r.section("TOKEN")
    r.kv("  input", human_tokens(s.input_tokens))
    r.kv("  output", human_tokens(s.output_tokens))
    if s.cache_read_tokens:
        r.kv("  cacheR", human_tokens(s.cache_read_tokens))
    if s.thinking_tokens:
        r.kv("  think", human_tokens(s.thinking_tokens))
    r.kv("  TOTAL", human_tokens(s.total_tokens), bold_key=True)

    # Footer
    r.divider("=")
    r.center("Powered by Claude Code")
    r.center("thermal-printer v1.0")
    if with_qr:
        r.qr(f"claude-session://{s.session_id}")
    r.cut()
    return r.build()


# ===== ASCII 预览 (调试 / dry-run) =====


def preview_text(data: bytes) -> str:
    """把 ESC/POS 字节流降级为可读 ASCII (去掉控制字符), 用于屏显."""
    out = []
    in_double = False
    i = 0
    while i < len(data):
        b = data[i]
        # QR 块: \x1d(k ... 0x31 0x51 0x30, 整段替换为 [QR: data]
        if b == 0x1D and i + 2 < len(data) and data[i + 1] == 0x28 and data[i + 2] == 0x6B:
            end = data.find(b"\x1d(k\x03\x00\x31\x51\x30", i)
            if end == -1:
                i += 1
                continue
            # payload 在 1P0 之后
            p = data.find(b"\x31\x50\x30", i)
            if p != -1 and p + 3 < end:
                out.append("[QR: " + data[p + 3:end].decode("gbk", errors="replace") + "]\n")
            i = end + 8
            continue
        if b == 0x1B and i + 1 < len(data) and data[i + 1] == 0x40:
            i += 2  # ESC @ init, 跳过
            continue
        if b == 0x1D and i + 1 < len(data) and data[i + 1] == 0x56:
            out.append("[CUT]\n")  # GS V 切刀
            i += 4
            continue
        if b == 0x1B and i + 2 < len(data) and data[i + 1] == 0x61:
            align = data[i + 2]
            out.append({"\x00": "[L]", "\x01": "[C]", "\x02": "[R]"}[chr(align)])
            i += 3
        elif b == 0x1D and i + 1 < len(data) and data[i + 1] == 0x21:
            in_double = data[i + 2] == 0x11
            if in_double:
                out.append("[2X]")
            i += 3
        elif b == 0x1B and i + 2 < len(data) and data[i + 1] == 0x45:
            if data[i + 2] == 1:
                out.append("[B]")
            i += 3
        elif b in (0x1B, 0x1D, 0x0A, 0x0D, 0x09):
            if b == 0x0A:
                out.append("\n")
            i += 1
        elif 0x20 <= b < 0x7F:
            out.append(chr(b))
            i += 1
        elif 0xA1 <= b <= 0xFE and i + 1 < len(data) and 0xA1 <= data[i + 1] <= 0xFE:
            try:
                ch = bytes([b, data[i + 1]]).decode("gbk")
                out.append(ch * (2 if in_double else 1))
            except UnicodeDecodeError:
                out.append("?")
            i += 2
        else:
            i += 1
    return "".join(out)


if __name__ == "__main__":
    import sys
    from collector import collect, latest_session

    jsonl = latest_session(sys.argv[1] if len(sys.argv) > 1 else ".")
    stats = collect(jsonl)
    data = render_receipt(stats)
    print(preview_text(data))
