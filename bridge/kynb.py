#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KY-notebook 电脑桥的命令行客户端
================================

给 WorkBuddy / 脚本 / 定时任务用：不用 MCP，直接跑命令就能「看语料 → 生成笔记 → 放进发件箱」。

  python bridge/kynb.py ping
  python bridge/kynb.py ls --dir "考研资料/运筹学" --q 讲义
  python bridge/kynb.py gen --ins "整理成考研复习提纲" --files "考研资料/运筹学/讲义.pdf"
  python bridge/kynb.py genpush --ins "整理成复习提纲" --files a.pdf,b.docx --title "运筹学"
  python bridge/kynb.py push --title "随手记" --md "# 标题\n正文"
  python bridge/kynb.py outbox

前置：bridge/serve.py 要跑着；口令自动读 bridge/.bridge_token，
也可以用环境变量 KYNB_BRIDGE_URL / KYNB_TOKEN 覆盖。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("KYNB_BRIDGE_URL", "http://127.0.0.1:8787").rstrip("/")


def token():
    t = os.environ.get("KYNB_TOKEN", "").strip()
    if t:
        return t
    try:
        with open(os.path.join(HERE, ".bridge_token"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def call(path, body=None):
    url = BASE + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("X-KYNB-Token", token())
    if data:
        req.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 本机/局域网不走系统代理
    try:
        with opener.open(req, timeout=240) as r:
            obj = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        sys.exit("失败：电脑桥返回 %s %s" % (e.code, detail))
    except Exception as e:
        sys.exit("失败：连不上 %s（%s）\n先把电脑桥跑起来：python bridge/serve.py" % (BASE, e))
    if isinstance(obj, dict) and obj.get("ok") is False:
        sys.exit("失败：" + str(obj.get("error")))
    return obj


def cmd_ping(a):
    d = call("/ping")
    print("已连上：%s v%s" % (d.get("name"), d.get("version")))
    print("语料根目录：%s" % d.get("root"))
    print("模型：%s" % (d.get("model") or "（未配置）"))
    print("局域网地址：http://%s:%s" % (d.get("lan"), BASE.rsplit(":", 1)[-1]))


def cmd_ls(a):
    q = "/files?dir=%s&q=%s" % (urllib.parse.quote(a.dir or ""), urllib.parse.quote(a.q or ""))
    d = call(q)
    print("根目录：%s" % d.get("root"))
    for it in d.get("items", []):
        if it.get("type") == "dir":
            print("[目录] %s" % it["path"])
        else:
            print("       %s  (%s)" % (it["path"], it.get("sizeText") or ""))


def split_files(s):
    out = []
    for x in (s or "").replace("；", ",").replace(";", ",").split(","):
        x = x.strip().strip('"')
        if x:
            out.append(x)
    return out


def cmd_gen(a):
    d = call("/generate", {"instruction": a.ins, "files": split_files(a.files),
                           "kind": a.kind, "title": a.title or ""})
    if d.get("kind") == "map":
        text = json.dumps(d.get("outline"), ensure_ascii=False, indent=1)
    else:
        text = d.get("markdown") or ""
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        print("已写入 %s（%d 字）" % (a.out, len(text)))
    else:
        print(text)
    used = [s["path"] for s in (d.get("sources") or []) if s.get("ok")]
    if used:
        print("\n---\n用了：%s" % ", ".join(used), file=sys.stderr)


def cmd_push(a):
    md = a.md
    if a.file:
        with open(a.file, "r", encoding="utf-8") as f:
            md = f.read()
    if not md:
        sys.exit("失败：要给 --md 或 --file")
    d = call("/queue", {"title": a.title or "AI 笔记", "markdown": md, "source": a.source or ""})
    print("已放进发件箱（id=%s），待收 %d 条。平板打开「✨ 生成」点一下就能收下。" % (d.get("id"), d.get("pending", 0)))


def cmd_genpush(a):
    d = call("/generate", {"instruction": a.ins, "files": split_files(a.files),
                           "kind": "note", "title": a.title or ""})
    src = ", ".join([s["path"] for s in (d.get("sources") or []) if s.get("ok")])
    q = call("/queue", {"title": d.get("title"), "markdown": d.get("markdown"), "source": src})
    print("已生成「%s」（%d 字，用了 %s）" % (d.get("title"), len(d.get("markdown") or ""), src or "无"))
    print("已放进发件箱（id=%s），待收 %d 条。平板打开「✨ 生成」收下。" % (q.get("id"), q.get("pending", 0)))


def cmd_outbox(a):
    d = call("/queue")
    items = d.get("items") or []
    if not items:
        print("发件箱是空的。")
        return
    print("待收 %d 条：" % len(items))
    for it in items:
        print("- [%s] %s（%d 字）" % (it.get("id"), it.get("title"), len(it.get("markdown") or "")))


def main():
    ap = argparse.ArgumentParser(description="KY-notebook 电脑桥命令行")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ping", help="看看桥通不通").set_defaults(fn=cmd_ping)

    p = sub.add_parser("ls", help="列电脑上的语料")
    p.add_argument("--dir", default="")
    p.add_argument("--q", default="")
    p.set_defaults(fn=cmd_ls)

    p = sub.add_parser("gen", help="生成笔记（只打印/写文件，不入队）")
    p.add_argument("--ins", required=True)
    p.add_argument("--files", default="")
    p.add_argument("--kind", default="note", choices=["note", "map"])
    p.add_argument("--title", default="")
    p.add_argument("--out", default="")
    p.set_defaults(fn=cmd_gen)

    p = sub.add_parser("push", help="把一段 Markdown 放进发件箱")
    p.add_argument("--title", default="AI 笔记")
    p.add_argument("--md", default="")
    p.add_argument("--file", default="")
    p.add_argument("--source", default="")
    p.set_defaults(fn=cmd_push)

    p = sub.add_parser("genpush", help="生成并放进发件箱（一步到位）")
    p.add_argument("--ins", required=True)
    p.add_argument("--files", default="")
    p.add_argument("--title", default="")
    p.set_defaults(fn=cmd_genpush)

    sub.add_parser("outbox", help="看发件箱").set_defaults(fn=cmd_outbox)

    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    a.fn(a)


if __name__ == "__main__":
    main()
