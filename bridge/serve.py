#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KY-notebook 电脑桥（bridge）
============================

手机上的 KY-notebook 通过局域网连到这台电脑，把「指令 + 语料文件」发过来，
由电脑读文件、调模型（或你本机的 Ollama），生成 Markdown 笔记 / 思维导图大纲，再回传给手机存下来。

为什么要电脑端：手机读不到你电脑里的 PDF/Word/课件文件夹，也跑不动大模型；
而笔记又存在手机本地（IndexedDB），所以让电脑当「生成端」、手机当「存储端」最合适。
参考的是 Joplin Data API / Obsidian Local REST API 的做法：本机 HTTP 服务 + token。

用法
----
  # 1) 最简：只在本机/局域网起服务，语料根目录默认是你的用户主目录
  python bridge/serve.py

  # 2) 指定语料目录（手机端只能读这个目录里的文件，读不到别处）
  python bridge/serve.py --root "D:/考研资料"

  # 3) 指定模型（不填就读环境变量 KYNB_API_BASE / KYNB_API_KEY / KYNB_MODEL）
  python bridge/serve.py --api-base https://api.deepseek.com/v1 --api-key sk-xxx --model deepseek-chat

  # 4) 固定 token（手机端「电脑 Agent」里填同一个；不填会自动生成并打印）
  python bridge/serve.py --token 8f3a21

  # 5) 用本机 Ollama（不用 API Key）
  python bridge/serve.py --api-base http://127.0.0.1:11434/v1 --model qwen2.5:7b

接口（都要求 token，放在 X-KYNB-Token 头或 ?token=）
--------------------------------------------------
  GET  /ping
        → {ok, name, version, root, model, hasKey, files}
  GET  /files?dir=&q=
        → {dir, items:[{name, path, type, size, mtime}]}   path 是相对 root 的路径
  POST /generate
        {instruction, files:[相对路径], kind:"note"|"map", title?, maxChars?}
        → {title, markdown, outline, sources:[...], ms}

零依赖：只用 Python 标准库。PDF 要装 pypdf 或系统有 pdftotext 才能读文字层；
DOCX / PPTX / MD / TXT 开箱即用。
"""

import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import zipfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

try:  # Windows 控制台默认 GBK，中文提示会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VERSION = "1.0"
NAME = "KY-notebook bridge"

TEXT_EXT = {".md", ".markdown", ".txt", ".csv", ".json", ".html", ".htm", ".py", ".js", ".css", ".tex"}
DOC_EXT = {".docx", ".pptx", ".pdf"}
ALLOW_EXT = TEXT_EXT | DOC_EXT

MAX_FILE_CHARS = 24000          # 单个文件最多喂给模型多少字
MAX_TOTAL_CHARS = 60000         # 一次请求所有语料的上限
MAX_BODY = 4 * 1024 * 1024      # 请求体上限 4MB

CFG = {
    "root": os.path.expanduser("~"),
    "token": "",
    "api_base": os.environ.get("KYNB_API_BASE", "").strip(),
    "api_key": os.environ.get("KYNB_API_KEY", "").strip(),
    "model": os.environ.get("KYNB_MODEL", "").strip(),
}

# 发件箱：电脑端（包括 WorkBuddy 通过 MCP）生成的笔记先放这儿，
# 平板下次打开「✨ 生成」时一键收下。平板没有对外服务，只能它自己来拉。
QUEUE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outbox.json")


def load_queue():
    try:
        with open(QUEUE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except Exception:
        return []


def save_queue(items):
    try:
        with open(QUEUE_FILE, "w", encoding="utf-8") as f:
            json.dump(items[-200:], f, ensure_ascii=False, indent=1)
    except Exception as e:
        log("save queue failed: %s" % e)


# ---------------------------------------------------------------- 工具

def log(msg):
    print("[bridge] " + str(msg), flush=True)


def safe_join(root, rel):
    """把手机传来的相对路径拼到 root 下，并挡住 ../ 越界。"""
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    full = os.path.realpath(os.path.join(root, rel))
    root_real = os.path.realpath(root)
    if full != root_real and not full.startswith(root_real + os.sep):
        raise ValueError("路径越界：" + rel)
    return full


def rel_of(root, full):
    return os.path.relpath(full, os.path.realpath(root)).replace("\\", "/")


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%.0f%s" % (n, unit)) if unit == "B" else ("%.1f%s" % (n, unit))
        n /= 1024.0


def read_text_file(path):
    for enc in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            with open(path, "r", encoding=enc, errors="strict") as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def read_docx(path):
    """DOCX：word/document.xml 里 <w:t> 的文字，段落用换行分开。"""
    out = []
    with zipfile.ZipFile(path) as z:
        try:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        except KeyError:
            return ""
    xml = re.sub(r"<w:p[ >]", "\n<w:p ", xml)
    for para in re.split(r"<w:p[ >]", xml):
        texts = re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, re.S)
        if texts:
            line = "".join(texts)
            line = (line.replace("&amp;", "&").replace("&lt;", "<")
                        .replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'"))
            out.append(line)
    return "\n".join(out)


def read_pptx(path):
    """PPTX：每页 slide 的 <a:t> 文字。"""
    out = []
    with zipfile.ZipFile(path) as z:
        names = sorted([n for n in z.namelist()
                        if re.match(r"ppt/slides/slide\d+\.xml$", n)],
                       key=lambda s: int(re.findall(r"\d+", s)[-1]))
        for n in names:
            xml = z.read(n).decode("utf-8", "replace")
            texts = re.findall(r"<a:t>(.*?)</a:t>", xml, re.S)
            if texts:
                out.append("【第 %s 页】\n" % re.findall(r"\d+", n)[-1] + "\n".join(texts))
    return "\n\n".join(out)


def read_pdf(path):
    """PDF：优先 pypdf，其次 pdftotext，最后退化成「提取可见字符串」（只对没压缩的 PDF 有用）。"""
    try:
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(path)
        pages = []
        for i, page in enumerate(reader.pages[:80]):
            try:
                pages.append("【第 %d 页】\n%s" % (i + 1, page.extract_text() or ""))
            except Exception:
                continue
        txt = "\n\n".join(pages).strip()
        if txt:
            return txt
    except Exception:
        pass
    try:
        r = subprocess.run(["pdftotext", "-layout", "-q", path, "-"],
                           capture_output=True, timeout=40)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.decode("utf-8", "replace")
    except Exception:
        pass
    try:
        raw = open(path, "rb").read()
    except Exception:
        return ""
    if b"/FlateDecode" in raw:
        return ""       # 压缩过的文本流，标准库解不了
    chunks = re.findall(rb"\((?:[^()\\]|\\.)*\)", raw)
    txt = b" ".join(chunks).decode("latin-1", "replace")
    return re.sub(r"[^\x20-\x7e\u4e00-\u9fff\n]", " ", txt)


def extract_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".md", ".markdown", ".txt", ".csv", ".json", ".html", ".htm",
               ".py", ".js", ".css", ".tex"):
        return read_text_file(path)
    if ext == ".docx":
        return read_docx(path)
    if ext == ".pptx":
        return read_pptx(path)
    if ext == ".pdf":
        return read_pdf(path)
    return ""


# ---------------------------------------------------------------- 模型

def chat(messages, max_tokens=2000, temperature=0.3):
    base = CFG["api_base"].rstrip("/")
    if not base:
        raise RuntimeError("电脑桥还没配模型：启动时加 --api-base/--api-key/--model，"
                           "或设环境变量 KYNB_API_BASE / KYNB_API_KEY / KYNB_MODEL")
    url = base + "/chat/completions"
    body = {
        "model": CFG["model"] or "gpt-4o-mini",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if CFG["api_key"]:
        req.add_header("Authorization", "Bearer " + CFG["api_key"])
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            obj = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError("模型接口返回 %s：%s" % (e.code, detail))
    except Exception as e:
        raise RuntimeError("连不上模型接口（%s）：%s" % (url, e))
    try:
        txt = obj["choices"][0]["message"]["content"]
    except Exception:
        raise RuntimeError("模型返回格式不认识：" + json.dumps(obj, ensure_ascii=False)[:300])
    return txt, int((time.time() - t0) * 1000)


def strip_fence(s):
    s = (s or "").strip()
    m = re.match(r"^```[a-zA-Z]*\s*\n(.*?)\n```\s*$", s, re.S)
    return m.group(1).strip() if m else s


# ---------------------------------------------------------------- 生成

def build_messages(instruction, docs, kind, title, max_chars):
    total = 0
    parts = []
    used = []
    for name, text in docs:
        if not text:
            continue
        text = text.strip()
        if not text:
            continue
        cut = text[:MAX_FILE_CHARS]
        if total + len(cut) > max_chars:
            cut = cut[: max(0, max_chars - total)]
        if not cut:
            break
        total += len(cut)
        parts.append("### 语料：%s\n%s" % (name, cut))
        used.append({"name": name, "chars": len(cut)})

    corpus = "\n\n".join(parts) if parts else "（这次没有选语料，请只按指令写）"
    ins = (instruction or "").strip() or "把下面的语料整理成一份条理清晰的笔记"

    if kind == "map":
        sys_p = ("你是把知识整理成树状大纲的助手。你只输出一个 JSON 对象，"
                 "绝不解释、不寒暄、不写代码块围栏。")
        user = (
            "任务：根据下面的语料和指令，生成思维导图大纲。\n"
            "指令：%s\n\n%s\n\n"
            "输出格式（严格遵守）：\n"
            '{"topic":"中心主题","children":[{"topic":"一级节点","children":[{"topic":"二级节点","children":[]}]}]}\n'
            "要求：2~3 层；每个节点不超过 14 个字；同一层 3~6 个；只输出 JSON。"
            % (ins, corpus)
        )
        return [{"role": "system", "content": sys_p}, {"role": "user", "content": user}], used

    sys_p = ("你是学习笔记整理助手，服务对象是考研学生。你只输出 Markdown 正文，"
             "不寒暄、不解释你在做什么。")
    user = (
        "任务：根据下面的语料和指令，整理成一份可以直接复习的笔记。\n"
        "指令：%s\n\n%s\n\n"
        "写作要求：\n"
        "1. 第一行用 `# 标题`（标题不超过 20 字，可参考指令里的主题）；\n"
        "2. 用二级标题分块，要点用短句 + 列表，别写大段散文；\n"
        "3. 公式用 $...$ 或 $$...$$，符号、术语保留原文；\n"
        "4. 只写语料里有的内容和由此直接推出的结论，缺信息就写「语料未涉及」，不要编造；\n"
        "5. 最后加一节 `## 来源`，列出用到的语料文件名。\n"
        "只输出 Markdown，不要代码块围栏。"
        % (ins, corpus)
    )
    return [{"role": "system", "content": sys_p}, {"role": "user", "content": user}], used


def parse_outline(text, fallback_topic):
    s = strip_fence(text)
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    if not isinstance(obj, dict) or "topic" not in obj:
        return None

    def norm(node, depth=0):
        if depth > 4:
            return None
        kids = []
        for c in (node.get("children") or [])[:12]:
            if isinstance(c, dict) and c.get("topic"):
                n = norm(c, depth + 1)
                if n:
                    kids.append(n)
            elif isinstance(c, str) and c.strip():
                kids.append({"topic": c.strip(), "children": []})
        return {"topic": str(node.get("topic", "")).strip()[:60] or "节点", "children": kids}

    root = norm(obj)
    if root and not root["topic"]:
        root["topic"] = fallback_topic or "思维导图"
    return root


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "KYNBBridge/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log("%s - %s" % (self.address_string(), fmt % args))

    # ---- 响应
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-KYNB-Token, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, msg):
        self.send_json(code, {"ok": False, "error": msg})

    def authed(self, query):
        token = CFG["token"]
        if not token:
            return True
        got = self.headers.get("X-KYNB-Token") or ""
        if not got:
            got = (query.get("token") or [""])[0]
        return secrets.compare_digest(str(got), str(token))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- GET
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self.authed(q):
            return self.fail(401, "token 不对：手机端「电脑 Agent」里的口令要和电脑上启动时的一致")

        if u.path in ("/", "/ping"):
            root = os.path.realpath(CFG["root"])
            try:
                n = len([x for x in os.listdir(root) if not x.startswith(".")])
            except Exception:
                n = 0
            return self.send_json(200, {
                "ok": True, "name": NAME, "version": VERSION,
                "root": root, "rootName": os.path.basename(root) or root,
                "model": CFG["model"] or "", "hasKey": bool(CFG["api_key"]),
                "apiBase": CFG["api_base"], "items": n,
                "lan": lan_ip(),
            })

        if u.path == "/files":
            return self.list_files(q)

        if u.path == "/queue":
            items = load_queue()
            return self.send_json(200, {"ok": True, "items": items})

        return self.fail(404, "没有这个接口：" + u.path)

    def list_files(self, q):
        rel_dir = (q.get("dir") or [""])[0]
        kw = ((q.get("q") or [""])[0] or "").strip().lower()
        try:
            full = safe_join(CFG["root"], rel_dir)
        except ValueError as e:
            return self.fail(403, str(e))
        if not os.path.isdir(full):
            return self.fail(404, "目录不存在：" + rel_dir)
        items = []
        try:
            entries = sorted(os.listdir(full))
        except PermissionError:
            return self.fail(403, "这个目录没权限读")
        for name in entries:
            if name.startswith("."):
                continue
            p = os.path.join(full, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if os.path.isdir(p):
                items.append({"name": name, "path": rel_of(CFG["root"], p),
                              "type": "dir", "size": 0, "mtime": int(st.st_mtime)})
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in ALLOW_EXT:
                continue
            if kw and kw not in name.lower():
                continue
            items.append({"name": name, "path": rel_of(CFG["root"], p), "type": "file",
                          "size": st.st_size, "mtime": int(st.st_mtime),
                          "sizeText": human_size(st.st_size)})
        # 目录在前，文件按时间新→旧
        items.sort(key=lambda x: (0 if x["type"] == "dir" else 1,
                                  -(x["mtime"] if x["type"] == "file" else 0)))
        return self.send_json(200, {
            "ok": True, "dir": rel_dir, "parent": os.path.dirname(rel_dir.strip("/")),
            "root": os.path.realpath(CFG["root"]), "items": items[:400],
        })

    # ---- POST
    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self.authed(q):
            return self.fail(401, "token 不对")
        if u.path not in ("/generate", "/queue", "/queue/ack"):
            return self.fail(404, "没有这个接口：" + u.path)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self.fail(400, "请求体为空或太大")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except Exception as e:
            return self.fail(400, "请求不是合法 JSON：" + str(e))

        # 发件箱：电脑端（含 WorkBuddy 的 MCP 工具）把生成好的笔记放这儿，平板来拉
        if u.path == "/queue":
            md = str(payload.get("markdown") or "").strip()
            if not md:
                return self.fail(400, "没有内容（markdown 为空）")
            item = {
                "id": secrets.token_hex(4),
                "title": (str(payload.get("title") or "").strip() or "AI 笔记")[:60],
                "markdown": md,
                "kind": str(payload.get("kind") or "note")[:12],
                "source": str(payload.get("source") or "")[:200],
                "ts": int(time.time()),
            }
            queue = load_queue()
            queue.append(item)
            save_queue(queue)
            log("queue += %s (%s)" % (item["id"], item["title"]))
            return self.send_json(200, {"ok": True, "id": item["id"], "pending": len(queue)})

        if u.path == "/queue/ack":
            ids = set(str(x) for x in (payload.get("ids") or []))
            queue = load_queue()
            left = [x for x in queue if x.get("id") not in ids]
            save_queue(left)
            return self.send_json(200, {"ok": True, "removed": len(queue) - len(left),
                                        "pending": len(left)})

        instruction = str(payload.get("instruction") or "")[:4000]
        kind = "map" if payload.get("kind") == "map" else "note"
        title = str(payload.get("title") or "")[:80]
        files = payload.get("files") or []
        max_chars = int(payload.get("maxChars") or MAX_TOTAL_CHARS)
        max_chars = max(2000, min(MAX_TOTAL_CHARS, max_chars))

        if not CFG["api_base"]:
            return self.fail(501, "电脑桥还没配模型：重启时加 --api-base/--api-key/--model，"
                                  "或设环境变量 KYNB_API_BASE 等（也可以用本机 Ollama）")

        docs = []
        sources = []
        for rel in files[:20]:
            try:
                full = safe_join(CFG["root"], str(rel))
            except ValueError:
                continue
            if not os.path.isfile(full):
                sources.append({"path": str(rel), "ok": False, "error": "文件不存在"})
                continue
            ext = os.path.splitext(full)[1].lower()
            if ext not in ALLOW_EXT:
                sources.append({"path": str(rel), "ok": False, "error": "不支持的格式"})
                continue
            try:
                text = extract_text(full)
            except Exception as e:
                sources.append({"path": str(rel), "ok": False, "error": str(e)[:120]})
                continue
            if not text.strip():
                sources.append({"path": str(rel), "ok": False,
                                "error": "读不出文字（PDF 可能是扫描件/压缩文本，装 pypdf 或 pdftotext）"})
                continue
            docs.append((os.path.basename(full), text))
            sources.append({"path": str(rel), "ok": True, "chars": len(text)})

        if not docs and not instruction.strip():
            return self.fail(400, "既没有语料也没有指令，没东西可写")

        messages, used = build_messages(instruction, docs, kind, title, max_chars)
        try:
            raw, ms = chat(messages, max_tokens=(1600 if kind == "map" else 3000))
        except Exception as e:
            return self.fail(502, str(e))

        if kind == "map":
            outline = parse_outline(raw, title or "思维导图")
            if not outline:
                return self.fail(502, "模型没按 JSON 输出，没敢画。原始返回：" + strip_fence(raw)[:300])
            return self.send_json(200, {
                "ok": True, "kind": "map", "title": outline["topic"],
                "outline": outline, "sources": sources, "ms": ms, "used": used,
            })

        md = strip_fence(raw).strip()
        if not md:
            return self.fail(502, "模型返回空内容")
        if not re.match(r"^\s*#", md):
            md = "# " + (title or (instruction[:20] if instruction else "AI 笔记")) + "\n\n" + md
        got_title = title
        if not got_title:
            m = re.match(r"^\s*#\s+(.+)", md)
            got_title = (m.group(1).strip() if m else "AI 笔记")[:60]
        return self.send_json(200, {
            "ok": True, "kind": "note", "title": got_title,
            "markdown": md, "sources": sources, "ms": ms, "used": used,
        })


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def load_token(arg):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".bridge_token")
    if arg:
        # 写回文件：MCP 服务器 / 其它客户端会自动读同一个口令
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(arg)
        except Exception:
            pass
        return arg
    if os.path.isfile(path):
        t = open(path, "r", encoding="utf-8").read().strip()
        if t:
            return t
    t = secrets.token_hex(3)          # 6 位十六进制，手输不费劲
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(t)
    except Exception:
        pass
    return t


def main():
    ap = argparse.ArgumentParser(description="KY-notebook 电脑桥")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = 局域网可访问；127.0.0.1 = 只本机")
    ap.add_argument("--root", default=CFG["root"], help="语料根目录（手机只能读这个目录里的文件）")
    ap.add_argument("--token", default="", help="访问口令；不填自动生成并写入 bridge/.bridge_token")
    ap.add_argument("--api-base", default=CFG["api_base"])
    ap.add_argument("--api-key", default=CFG["api_key"])
    ap.add_argument("--model", default=CFG["model"])
    args = ap.parse_args()

    CFG["root"] = os.path.realpath(os.path.expanduser(args.root))
    if not os.path.isdir(CFG["root"]):
        print("语料目录不存在：", CFG["root"])
        sys.exit(2)
    CFG["token"] = load_token(args.token)
    CFG["api_base"] = (args.api_base or "").strip()
    CFG["api_key"] = (args.api_key or "").strip()
    CFG["model"] = (args.model or "").strip()

    ip = lan_ip()
    print("=" * 62)
    print("  KY-notebook 电脑桥  v%s" % VERSION)
    print("  语料目录 : %s" % CFG["root"])
    print("  监听     : %s:%d" % (args.host, args.port))
    print("  手机填   : http://%s:%d" % (ip, args.port))
    print("  口令     : %s" % CFG["token"])
    print("  模型     : %s" % (CFG["model"] or "（未配置，/generate 会报错）"))
    print("  自检     : http://%s:%d/ping?token=%s" % (ip, args.port, CFG["token"]))
    print("=" * 62)
    print("  手机和电脑要在同一个 WiFi；Windows 第一次会弹防火墙，选「允许」。")
    print("  按 Ctrl+C 停止。")
    print("=" * 62, flush=True)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
