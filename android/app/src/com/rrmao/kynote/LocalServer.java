package com.rrmao.kynote;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 只监听 127.0.0.1 的迷你 HTTP 服务：
 *  · GET 任意路径 → 读 assets/www 下的静态文件（index.html / src/*.js …）
 *  · POST /proxy?u=<目标地址> → 原样转发，给 AI 接口绕 CORS
 * 端口固定（默认 18342），因为 IndexedDB / localStorage 按 origin 隔离，端口一变数据就"丢"了。
 */
class LocalServer {
  private static final String TAG = "kynote";
  private static final int[] PORTS = {18342, 18343, 18344, 18345};

  private final AssetManager am;
  private ServerSocket ss;
  private int port;
  private volatile boolean running = true;

  LocalServer(AssetManager am) {
    this.am = am;
  }

  void start() throws IOException {
    IOException last = null;
    for (int p : PORTS) {
      try {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 16);
        ss = s;
        port = p;
        break;
      } catch (IOException e) {
        last = e;
      }
    }
    if (ss == null) throw last == null ? new IOException("没有可用端口") : last;
    Thread t = new Thread(new Runnable() { public void run() { loop(); } }, "kynb-http");
    t.setDaemon(true);
    t.start();
    Log.i(TAG, "serving at " + baseUrl());
  }

  String baseUrl() {
    return "http://127.0.0.1:" + port;
  }

  void stop() {
    running = false;
    try { ss.close(); } catch (Throwable ignored) {}
  }

  private void loop() {
    while (running) {
      Socket c = null;
      try {
        c = ss.accept();
        handle(c);
      } catch (Throwable e) {
        if (running) Log.w(TAG, "request failed: " + e);
      } finally {
        try { if (c != null) c.close(); } catch (Throwable ignored) {}
      }
    }
  }

  private static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    int ch;
    while ((ch = in.read()) != -1) {
      if (ch == '\n') break;
      if (ch != '\r') b.write(ch);
    }
    if (ch == -1 && b.size() == 0) return null;
    return new String(b.toByteArray(), StandardCharsets.UTF_8);
  }

  private void handle(Socket c) throws IOException {
    c.setSoTimeout(120000);
    InputStream in = new BufferedInputStream(c.getInputStream());
    OutputStream out = c.getOutputStream();
    String line = readLine(in);
    if (line == null || line.trim().length() == 0) return;
    String[] parts = line.trim().split(" ");
    if (parts.length < 2) { writeText(out, 400, "bad request"); return; }
    String method = parts[0].toUpperCase(Locale.ROOT);
    String target = parts[1];

    Map<String, String> hdr = new HashMap<String, String>();
    String h;
    while ((h = readLine(in)) != null && h.length() > 0) {
      int i = h.indexOf(':');
      if (i > 0) hdr.put(h.substring(0, i).trim().toLowerCase(Locale.ROOT), h.substring(i + 1).trim());
    }
    int len = 0;
    try { len = Integer.parseInt(hdr.containsKey("content-length") ? hdr.get("content-length") : "0"); } catch (Throwable ignored) {}
    byte[] body = new byte[0];
    if (len > 0) {
      body = new byte[len];
      int off = 0;
      while (off < len) {
        int n = in.read(body, off, len - off);
        if (n < 0) break;
        off += n;
      }
    }

    int q = target.indexOf('?');
    String path = q >= 0 ? target.substring(0, q) : target;
    String query = q >= 0 ? target.substring(q + 1) : "";

    if (path.equals("/proxy")) { proxy(out, query, hdr, body); return; }
    if (method.equals("OPTIONS")) {
      cors(out);
      writeText(out, 200, "");
      return;
    }
    serveStatic(out, path);
  }

  private static void cors(OutputStream out) throws IOException {
    out.write(("Access-Control-Allow-Origin: *\r\n"
        + "Access-Control-Allow-Headers: *\r\n"
        + "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n").getBytes(StandardCharsets.UTF_8));
  }

  private static String mime(String name) {
    String n = name.toLowerCase(Locale.ROOT);
    if (n.endsWith(".html")) return "text/html; charset=utf-8";
    if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript; charset=utf-8";
    if (n.endsWith(".css")) return "text/css; charset=utf-8";
    if (n.endsWith(".json")) return "application/json; charset=utf-8";
    if (n.endsWith(".png")) return "image/png";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
    if (n.endsWith(".svg")) return "image/svg+xml";
    if (n.endsWith(".ico")) return "image/x-icon";
    if (n.endsWith(".pdf")) return "application/pdf";
    if (n.endsWith(".woff2")) return "font/woff2";
    if (n.endsWith(".webmanifest")) return "application/manifest+json";
    return "application/octet-stream";
  }

  private void serveStatic(OutputStream out, String rawPath) throws IOException {
    String p;
    try { p = URLDecoder.decode(rawPath, "UTF-8"); } catch (Throwable t) { p = rawPath; }
    if (p.contains("..")) { writeText(out, 400, "bad path"); return; }
    if (p.equals("/") || p.endsWith("/")) p = p + "index.html";
    String asset = "www" + p;
    byte[] data = readAsset(asset);
    if (data == null) data = readAsset(asset + "/index.html");
    if (data == null) {
      writeText(out, 404, "not found: " + p);
      return;
    }
    byte[] head = ("HTTP/1.1 200 OK\r\n"
        + "Content-Type: " + mime(p) + "\r\n"
        + "Content-Length: " + data.length + "\r\n"
        + "Cache-Control: no-cache\r\n"
        + "Access-Control-Allow-Origin: *\r\n"
        + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8);
    out.write(head);
    out.write(data);
    out.flush();
  }

  private byte[] readAsset(String path) {
    try (InputStream is = am.open(path)) {
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[16384];
      int n;
      while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
      return bos.toByteArray();
    } catch (Throwable t) {
      return null;
    }
  }

  private void proxy(OutputStream out, String query, Map<String, String> hdr, byte[] body) throws IOException {
    String url = null;
    for (String kv : query.split("&")) {
      int i = kv.indexOf('=');
      if (i > 0 && kv.substring(0, i).equals("u")) {
        try { url = URLDecoder.decode(kv.substring(i + 1), "UTF-8"); } catch (Throwable t) { url = kv.substring(i + 1); }
      }
    }
    if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
      writeText(out, 400, "proxy: bad url");
      return;
    }
    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(url).openConnection();
      conn.setConnectTimeout(20000);
      conn.setReadTimeout(300000);
      conn.setRequestMethod(body.length > 0 ? "POST" : "GET");
      conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
      for (Map.Entry<String, String> e : hdr.entrySet()) {
        String k = e.getKey();
        if (k.equals("authorization") || k.equals("content-type") || k.equals("accept")
            || k.equals("x-opencode-session") || k.equals("anthropic-version")
            || k.startsWith("x-") || k.startsWith("openai-")) {
          conn.setRequestProperty(e.getKey(), e.getValue());
        }
      }
      if (body.length > 0) {
        conn.setDoOutput(true);
        OutputStream os = conn.getOutputStream();
        os.write(body);
        os.flush();
        os.close();
      }
      int code = conn.getResponseCode();
      InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      if (is != null) {
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
      }
      byte[] data = bos.toByteArray();
      String ct = conn.getContentType();
      if (ct == null) ct = "application/json; charset=utf-8";
      byte[] head = ("HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "ERR") + "\r\n"
          + "Content-Type: " + ct + "\r\n"
          + "Content-Length: " + data.length + "\r\n"
          + "Cache-Control: no-store\r\n"
          + "Access-Control-Allow-Origin: *\r\n"
          + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8);
      out.write(head);
      out.write(data);
      out.flush();
    } catch (Throwable t) {
      writeText(out, 502, "proxy failed: " + t);
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  private static void writeText(OutputStream out, int code, String text) throws IOException {
    byte[] b = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
    byte[] head = ("HTTP/1.1 " + code + " X\r\n"
        + "Content-Type: text/plain; charset=utf-8\r\n"
        + "Content-Length: " + b.length + "\r\n"
        + "Access-Control-Allow-Origin: *\r\n"
        + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8);
    out.write(head);
    out.write(b);
    out.flush();
  }
}
