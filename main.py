# -*- coding: utf-8 -*-
"""agent-receipt CLI: Claude Code session -> 热敏小票.

用法:
  python main.py                       # 最新 session -> Thermal-58
  python main.py --preview             # 仅屏显, 不打印
  python main.py --dry-run out.bin     # 保存原始字节, 不打印
  python main.py --session PATH.jsonl  # 指定 session
  python main.py --project DIR         # 指定 .claude/projects/ 子目录
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from collector import collect, latest_session
from printer import raw_print, save_bytes
from renderer import preview_text, render_receipt

DEFAULT_PRINTER = "Thermal-58"
# Claude Code 在 Windows 下按项目分目录存放 session JSONL
CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def guess_current_project_dir() -> Path:
    """按 mtime 选最新有 .jsonl 的项目目录 (即'当前 session')."""
    candidates = []
    if not CLAUDE_PROJECTS.is_dir():
        return CLAUDE_PROJECTS
    for d in CLAUDE_PROJECTS.iterdir():
        if d.is_dir() and any(d.glob("*.jsonl")):
            latest = max(p.stat().st_mtime for p in d.glob("*.jsonl"))
            candidates.append((latest, d))
    if not candidates:
        raise FileNotFoundError(f"no sessions under {CLAUDE_PROJECTS}")
    return max(candidates)[1]


def main() -> int:
    # Windows 控制台默认 GBK, 强制 UTF-8 让中文预览可读
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    ap = argparse.ArgumentParser(description="Agent Receipt")
    ap.add_argument("--session", type=Path, help="session .jsonl 路径")
    ap.add_argument("--project", type=Path, help=".claude/projects/<dir>")
    ap.add_argument("--printer", default=DEFAULT_PRINTER)
    ap.add_argument("--preview", action="store_true", help="仅屏显不打印")
    ap.add_argument("--dry-run", type=Path, help="保存原始字节到文件")
    ap.add_argument("--no-qr", action="store_true")
    args = ap.parse_args()

    jsonl = args.session
    if not jsonl:
        proj_dir = args.project or guess_current_project_dir()
        jsonl = latest_session(proj_dir)
    print(f"[main] session: {jsonl}", file=sys.stderr)

    stats = collect(jsonl)
    print(
        f"[main] {stats.project} msgs={stats.user_msgs}/{stats.agent_msgs} "
        f"tools={sum(stats.tool_calls.values())} files={len(stats.files_written)} "
        f"tok={stats.total_tokens}",
        file=sys.stderr,
    )

    data = render_receipt(stats, with_qr=not args.no_qr)

    if args.dry_run:
        save_bytes(args.dry_run, data)
        print(f"[main] saved {len(data)} bytes -> {args.dry_run}", file=sys.stderr)

    print(preview_text(data))

    if args.preview or args.dry_run:
        return 0

    n = raw_print(args.printer, data, doc_name=f"receipt-{stats.session_id[:8]}")
    print(f"[main] printed {n} bytes -> {args.printer}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
