# -*- coding: utf-8 -*-
"""解析 Claude Code session JSONL, 提取 SessionStats.

单一职责: JSONL 文件 -> SessionStats dataclass.
不做任何渲染或打印相关的事 (SRP).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

# 提取文件路径的工具 (按对代码的"产出"重要度排序)
FILE_TOOLS = {"Write": "write", "Edit": "edit", "NotebookEdit": "write", "Read": "read"}

# 不计入"产出文件"的临时/工具路径
FILE_BLACKLIST = (".tmp", ".claude/tmp", "__pycache__")


@dataclass
class SessionStats:
    """Claude Code 单次 session 的统计快照."""
    session_id: str = ""
    project: str = ""
    title: str = ""
    started_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    model: str = ""
    user_msgs: int = 0
    agent_msgs: int = 0
    turns: int = 0  # 真实 user->agent 轮次 (promptId 去重)
    tool_calls: Dict[str, int] = field(default_factory=dict)
    files_written: List[str] = field(default_factory=list)
    files_read: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    thinking_tokens: int = 0
    jsonl_path: str = ""

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )

    @property
    def duration_s(self) -> float:
        if not self.started_at or not self.ended_at:
            return 0.0
        return (self.ended_at - self.started_at).total_seconds()

    @property
    def duration_hms(self) -> str:
        s = int(self.duration_s)
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def _parse_ts(raw: str) -> Optional[datetime]:
    """ISO UTC -> 本地 datetime."""
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.astimezone()  # 转本地
    except ValueError:
        return None


def _shorten(path: str, max_len: int = 26) -> str:
    """路径压缩: 仅保留尾部 + 省略号, KISS."""
    return path if len(path) <= max_len else "..." + path[-(max_len - 3):]


def collect(jsonl_path: Path | str) -> SessionStats:
    """读取 session JSONL, 返回 SessionStats. 容错单行解析失败."""
    jsonl_path = Path(jsonl_path)
    stats = SessionStats(session_id=jsonl_path.stem, jsonl_path=str(jsonl_path))
    seen_files: List[str] = []
    prompts: set = set()

    with jsonl_path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("promptId"):
                prompts.add(obj["promptId"])
            _consume(obj, stats, seen_files)

    stats.files_written = seen_files
    stats.turns = len(prompts)
    return stats


def _consume(obj: dict, stats: SessionStats, seen: List[str]) -> None:
    t = obj.get("type")

    if t == "ai-title" and not stats.title:
        stats.title = str(obj.get("title", ""))[:60]

    if t not in ("user", "assistant"):
        return

    ts = _parse_ts(obj.get("timestamp", ""))
    if ts:
        if stats.started_at is None or ts < stats.started_at:
            stats.started_at = ts
        if stats.ended_at is None or ts > stats.ended_at:
            stats.ended_at = ts

    if t == "user":
        # 过滤 tool_result / system 注入, 只统计真人 prompt
        content = obj.get("message", {}).get("content")
        if isinstance(content, str):
            stats.user_msgs += 1
        elif isinstance(content, list):
            if any(b.get("type") == "text" for b in content if isinstance(b, dict)):
                stats.user_msgs += 1
        if not stats.project:
            # 项目名优先取 cwd basename (slug 字段实为 ai-title)
            cwd = obj.get("cwd") or ""
            stats.project = Path(cwd).name if cwd else (obj.get("slug") or "")

    if t != "assistant":
        return

    stats.agent_msgs += 1
    msg = obj.get("message", {})
    if not stats.model and msg.get("model"):
        stats.model = str(msg["model"])

    usage = msg.get("usage") or {}
    stats.input_tokens += int(usage.get("input_tokens") or 0)
    stats.output_tokens += int(usage.get("output_tokens") or 0)
    stats.cache_read_tokens += int(usage.get("cache_read_input_tokens") or 0)
    stats.cache_creation_tokens += int(usage.get("cache_creation_input_tokens") or 0)
    stats.thinking_tokens += int(
        (usage.get("output_tokens_details") or {}).get("thinking_tokens") or 0
    )

    for block in msg.get("content") or []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = str(block.get("name", "?"))
        stats.tool_calls[name] = stats.tool_calls.get(name, 0) + 1
        kind = FILE_TOOLS.get(name)
        if kind == "write":
            fp = (block.get("input") or {}).get("file_path", "")
            if fp and fp not in seen and not any(b in fp for b in FILE_BLACKLIST):
                seen.append(fp)
        elif kind == "read":
            stats.files_read += 1


def latest_session(project_dir: Path | str) -> Path:
    """返回项目 session 目录下 mtime 最新的 .jsonl (用于'当前 session')."""
    project_dir = Path(project_dir)
    jsonls = sorted(
        project_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
    )
    if not jsonls:
        raise FileNotFoundError(f"no .jsonl under {project_dir}")
    return jsonls[0]


# 渲染用: 数字缩写 (1.2K / 3.4M), 避免小票上溢出
def human_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


if __name__ == "__main__":
    import sys

    p = latest_session(sys.argv[1] if len(sys.argv) > 1 else ".")
    print(collect(p))
