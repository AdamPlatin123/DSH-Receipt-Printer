# -*- coding: utf-8 -*-
"""通过 Win32 Spooler raw API 直发 ESC/POS 字节到热敏打印机.

单一职责: bytes -> 物理打印机. 不解析内容, 不重试业务逻辑.
依赖: 仅标准库 ctypes + winspool.drv (零第三方包).
原理: OpenPrinterW + StartDocPrinterW(datatype=RAW) 让 Generic/Text Only
驱动把字节透传到 USB002, 不做任何 OEM 拦截.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from pathlib import Path

# winspool 常量
PRINTER_ACCESS_USE = 0x00000008
JOB_CONTROL_DELETE = 0x00000005  # 保留: 必要时清队列


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


def _load_winspool():
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
    return wp


def raw_print(printer_name: str, data: bytes, doc_name: str = "Agent Receipt") -> int:
    """发送 raw bytes 到指定打印队列, 返回写入字节数. 失败抛 OSError.

    完整 spooler 事务: Open -> StartDoc(RAW) -> StartPage ->
    Write -> EndPage -> EndDoc -> Close. 任一步失败立即关闭句柄.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("data must be bytes")
    data = bytes(data)
    wp = _load_winspool()

    handle = wintypes.HANDLE()
    defaults = PRINTER_DEFAULTSW(None, None, PRINTER_ACCESS_USE)
    if not wp.OpenPrinterW(printer_name, ctypes.byref(handle), ctypes.byref(defaults)):
        raise OSError(
            ctypes.get_last_error(),
            f"OpenPrinterW('{printer_name}') failed - check queue name",
        )

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


def save_bytes(path: Path | str, data: bytes) -> None:
    """dry-run 模式: 把原始字节落盘供后续检视/回放."""
    Path(path).write_bytes(data)


def self_test(printer_name: str) -> None:
    """最小打印测试: 一行初始化 + 文本 + 切刀."""
    escpos = b"\x1b@" + "Thermal-58 self test OK\n".encode("gbk") + b"\n\n\n" + b"\x1dV\x41\x03"
    n = raw_print(printer_name, escpos, doc_name="self_test")
    print(f"sent {n} bytes to {printer_name}")


if __name__ == "__main__":
    import sys

    self_test(sys.argv[1] if len(sys.argv) > 1 else "Thermal-58")
