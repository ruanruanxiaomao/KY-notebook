#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KY-notebook 的 MCP 服务器（stdio）
=================================

给电脑上的 Agent（WorkBuddy / Claude Desktop / Cursor 等）用：
让它能「看电脑里的语料 → 生成笔记 → 放进发件箱 → 平板来收」。

为什么是「发件箱」而不是直接写平板：平板 App 的数据在 WebView 的 IndexedDB 里，
Android 不允许外部进程直接写；平板也没有对外服务。所以走「电脑入队、平板来拉」，
这也是唯一稳的方向（和 Joplin / Obsidian 那种「桌面端有服务、手机连桌面」正好相反）。

依赖：bridge/serve.py 要先跑起来（MCP 只是它的客户端）。
配置：bridge/.bridge_token 里的口令会自动读；也可用环境变量 KYNB_BRIDGE_URL / KYNB_TOKEN。

在 ~/.workbuddy/mcp.json 里加（路径换成你自己的仓库位置）：
  "kynb-bridge": {
    "command": "python",
    "args": ["/path/to/KY-notebook/bridge/mcp_server.py"]
  }
然后到「连接器」页面点「信任」。
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("KYNB_BRIDGE_URL", "http://127.0.0.1:8787").rstrip("/")


def load_token():
    t = os.environ.get("KYNB_TOKEN", "").strip()
    if t:
        return t
    try:
        with open(os.path.join(HERE, ".bridge_token"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


TOKEN = load_token()


def call(path, body=None, method=None):
    url = BASE + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("X-KYNB-Token", TOKEN)
    if data:
        req.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=200) as r:
            obj = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("电脑桥返回 %s：%s" % (e.code, detail))
    except Exception as e:
        raise RuntimeError("连不上电脑桥（%s）：%s\n先跑 python bridge/serve.py" % (BASE, e))
    if isinstance(obj, dict) and obj.get("ok") is False:
        raise RuntimeError(obj.get("error") or "电脑桥报错")
    return obj


TOOLS = [
    {
        "name": "kynb_list_corpus",
        "description": ("列出电脑上 KY-notebook 电脑桥能读的语料文件（md/txt/docx/pptx/pdf/csv）。"
                        "返回的是相对语料根目录的路径，可直接传给 kynb_generate_note 的 files。"),
        "inputSchema": {
            "type": "object",
            "properties": {
                "dir": {"type": "string", "description": "相对语料根目录的子目录，空字符串表示根目录"},
                "q": {"type": "string", "description": "文件名关键词过滤，可选"},
            },
        },
    },
    {
        "name": "kynb_generate_note",
        "description": ("让电脑桥读指定语料、按指令写成一份 Markdown 笔记，并把正文返回给你（不入队）。"
                        "适合先在对话里给用户看内容、再决定要不要推送。"),
        "inputSchema": {
            "type": "object",
            "properties": {
                "instruction": {"type": "string", "description": "要写成什么，例如「整理成考研复习提纲，按章节分」"},
                "files": {"type": "array", "items": {"type": "string"}, "description": "语料文件相对路径"},
                "title": {"type": "string", "description": "可选，标题"},
                "kind": {"type": "string", "enum": ["note", "map"], "description": "note=文字笔记，map=思维导图大纲"},
            },
            "required": ["instruction"],
        },
    },
    {
        "name": "kynb_push_note",
        "description": ("把一段 Markdown 放进「发件箱」。平板下次打开「✨ 生成」时会在待收列表里看到，"
                        "点一下就存进笔记本。适合你在对话里已经写好内容、只差送到平板。"),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "笔记标题"},
                "markdown": {"type": "string", "description": "Markdown 正文"},
                "source": {"type": "string", "description": "可选，来源说明（文件名 / 链接）"},
            },
            "required": ["title", "markdown"],
        },
    },
    {
        "name": "kynb_generate_and_push",
        "description": ("一步到位：读电脑上的语料 → 生成笔记 → 放进发件箱。"
                        "用户说「把这份资料整理成笔记推到我平板」时用这个。"),
        "inputSchema": {
            "type": "object",
            "properties": {
                "instruction": {"type": "string", "description": "要写成什么"},
                "files": {"type": "array", "items": {"type": "string"}, "description": "语料文件相对路径"},
                "title": {"type": "string", "description": "可选，标题"},
            },
            "required": ["instruction", "files"],
        },
    },
    {
        "name": "kynb_outbox",
        "description": "查看发件箱里还有哪些笔记没被平板收走（标题、时间、字数）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def tool_text(s):
    return {"content": [{"type": "text", "text": s}]}


def run_tool(name, args):
    if name == "kynb_list_corpus":
        d = call("/files?dir=%s&q=%s" % (
            urllib.parse.quote(str(args.get("dir") or "")),
            urllib.parse.quote(str(args.get("q") or ""))))
        lines = []
        for it in d.get("items", []):
            if it.get("type") == "dir":
                lines.append("[目录] " + it["path"])
            else:
                lines.append("%s  (%s)" % (it["path"], it.get("sizeText") or ""))
        head = "语料根目录：%s\n共 %d 项：\n" % (d.get("root"), len(d.get("items", [])))
        return tool_text(head + "\n".join(lines[:200]))

    if name == "kynb_generate_note":
        kind = "map" if args.get("kind") == "map" else "note"
        d = call("/generate", {
            "instruction": args.get("instruction") or "",
            "files": args.get("files") or [],
            "kind": kind,
            "title": args.get("title") or "",
        })
        if kind == "map":
            return tool_text("思维导图大纲（JSON）：\n" + json.dumps(d.get("outline"), ensure_ascii=False, indent=1))
        return tool_text("标题：%s\n\n%s" % (d.get("title"), d.get("markdown")))

    if name == "kynb_push_note":
        d = call("/queue", {
            "title": args.get("title") or "AI 笔记",
            "markdown": args.get("markdown") or "",
            "source": args.get("source") or "",
        })
        return tool_text("已放进发件箱（id=%s），当前待收 %d 条。平板打开「✨ 生成」就能看到。"
                         % (d.get("id"), d.get("pending", 0)))

    if name == "kynb_generate_and_push":
        d = call("/generate", {
            "instruction": args.get("instruction") or "",
            "files": args.get("files") or [],
            "kind": "note",
            "title": args.get("title") or "",
        })
        src = ", ".join([s["path"] for s in (d.get("sources") or []) if s.get("ok")])
        q = call("/queue", {"title": d.get("title"), "markdown": d.get("markdown"), "source": src})
        return tool_text("已生成「%s」（%d 字，用了 %s）并放进发件箱（id=%s，待收 %d 条）。"
                         % (d.get("title"), len(d.get("markdown") or ""), src or "无",
                            q.get("id"), q.get("pending", 0)))

    if name == "kynb_outbox":
        d = call("/queue")
        items = d.get("items") or []
        if not items:
            return tool_text("发件箱是空的。")
        out = ["待收 %d 条：" % len(items)]
        for it in items:
            out.append("- [%s] %s（%d 字，%s）" % (
                it.get("id"), it.get("title"), len(it.get("markdown") or ""),
                time_str(it.get("ts"))))
        return tool_text("\n".join(out))

    raise RuntimeError("没有这个工具：" + name)


def time_str(ts):
    try:
        import datetime
        return datetime.datetime.fromtimestamp(int(ts)).strftime("%m-%d %H:%M")
    except Exception:
        return "?"


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode("utf-8", "replace"))
        except Exception:
            continue
        mid = msg.get("id")
        method = msg.get("method") or ""
        params = msg.get("params") or {}

        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": params.get("protocolVersion") or "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "kynb-bridge", "version": "1.0"},
            }})
        elif method in ("notifications/initialized", "initialized"):
            continue
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            name = params.get("name") or ""
            args = params.get("arguments") or {}
            try:
                send({"jsonrpc": "2.0", "id": mid, "result": run_tool(name, args)})
            except Exception as e:
                send({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": "失败：" + str(e)}], "isError": True}})
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32601, "message": "Method not found: " + method}})


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    main()
