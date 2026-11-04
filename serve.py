#!/usr/bin/env python3
"""KY-notebook 本地服务：静态文件 + OpenAI 兼容接口的 CORS 代理。

用法：
  python serve.py          # http://127.0.0.1:8765/
  python serve.py 9000     # 换端口

为什么要代理：
  浏览器直连第三方 AI 接口时，如果对方没给 Access-Control-Allow-Origin，
  fetch 会被浏览器的同源策略拦掉（控制台报 CORS）。本服务把请求转发一遍，
  并补上 CORS 头，页面就能用同源的 POST /proxy?u=<目标地址> 调接口。

代理规则：
  POST /proxy?u=https%3A%2F%2Fhost%2Fv1%2Fchat%2Fcompletions
  → 原样转发 body，透传 Content-Type / Authorization / x-opencode-session，
    把上游的状态码与响应体回给页面，并加 Access-Control-Allow-*。
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PASS_HEADERS = ("Content-Type", "Authorization", "x-opencode-session", "Accept")

# 手写识别要用：wasm 必须给 application/wasm，不然 WebAssembly.instantiateStreaming 会失败回落
SimpleHTTPRequestHandler.extensions_map.update({
    ".wasm": "application/wasm",
    ".mjs": "text/javascript",
    ".onnx": "application/octet-stream",
})


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy"):
            self._proxy("GET", b"")
            return
        super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/proxy"):
            self.send_error(404, "only /proxy is proxied")
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        self._proxy("POST", body)

    def _proxy(self, method, body):
        target = (parse_qs(urlparse(self.path).query).get("u") or [""])[0]
        if not target.startswith(("http://", "https://")):
            self._reply(400, b'{"error":{"message":"missing ?u=<url>"}}')
            return
        req = urllib.request.Request(
            target, data=body if method == "POST" else None, method=method
        )
        # 有些服务会按 UA 拦脚本请求，这里伪装成浏览器
        req.add_header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        for k in PASS_HEADERS:
            v = self.headers.get(k)
            if v:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data, code = r.read(), r.status
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
        except Exception as e:  # 网络/证书/超时
            data, code = json.dumps(
                {"error": {"message": "代理请求失败：%s" % e}}, ensure_ascii=False
            ).encode("utf-8"), 502
        self._reply(code, data)

    def _reply(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingTCPServer.allow_reuse_address = True
    with ThreadingTCPServer(("127.0.0.1", port), Handler) as srv:
        print("KY-notebook → http://127.0.0.1:%d/   (proxy: GET/POST /proxy?u=...)" % port)
        print("Ctrl+C 停止")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
