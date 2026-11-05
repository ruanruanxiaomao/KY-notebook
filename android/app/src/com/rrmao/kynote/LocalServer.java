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
    if (path.equals("/sysfonts")) { serveSysFonts(out); return; }
    if (path.equals("/sysfont")) { serveSysFont(out, query); return; }
    serveStatic(out, path);
  }

  /* ---------- 系统字体 ----------
     用户在外面换了「字体样式」之后，WebView 里用 font-family 名字是拿不到那个字体的，
     所以这里把手机里实际装着的字体文件列出来、按需求原样吐给网页，由网页用 FontFace 装进去。 */

  private static String jesc(String s) {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20) b.append(' ');
      else b.append(c);
    }
    return b.toString();
  }

  private void serveSysFonts(OutputStream out) throws IOException {
    StringBuilder sb = new StringBuilder("[");
    boolean first = true;
    try {
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        java.util.TreeMap<String, java.io.File> map = new java.util.TreeMap<String, java.io.File>();
        for (android.graphics.fonts.Font f : android.graphics.fonts.SystemFonts.getAvailableFonts()) {
          java.io.File file = f.getFile();
          if (file == null) continue;
          String n = file.getName();
          String ln = n.toLowerCase(Locale.ROOT);
          if (!ln.endsWith(".ttf") && !ln.endsWith(".otf")) continue;
          if (!file.canRead()) continue;
          map.put(n, file);
        }
        for (Map.Entry<String, java.io.File> e : map.entrySet()) {
          String n = e.getKey();
          String label = n.replaceAll("(?i)\\.(ttf|otf)$", "");
          if (!first) sb.append(',');
          first = false;
          sb.append("{\"name\":\"").append(jesc(n))
            .append("\",\"label\":\"").append(jesc(label))
            .append("\",\"path\":\"").append(jesc(e.getValue().getAbsolutePath()))
            .append("\",\"size\":").append(e.getValue().length())
            .append(",\"theme\":").append(e.getValue().getAbsolutePath().startsWith("/data/skin/fonts/") ? "true" : "false")
            .append("}");
        }
      }
    } catch (Throwable t) {
      Log.w(TAG, "list fonts: " + t);
    }
    sb.append(']');
    byte[] b = sb.toString().getBytes(StandardCharsets.UTF_8);
    byte[] head = ("HTTP/1.1 200 X\r\n"
        + "Content-Type: application/json; charset=utf-8\r\n"
        + "Content-Length: " + b.length + "\r\n"
        + "Access-Control-Allow-Origin: *\r\n"
        + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8);
    out.write(head);
    out.write(b);
    out.flush();
  }

  private void serveSysFont(OutputStream out, String query) throws IOException {
    String raw = "";
    for (String kv : query.split("&")) {
      int i = kv.indexOf('=');
      if (i <= 0) continue;
      if (kv.substring(0, i).equals("path")) {
        try { raw = URLDecoder.decode(kv.substring(i + 1), "UTF-8"); }
        catch (Throwable t) { raw = kv.substring(i + 1); }
      }
    }
    /* 只允许读系统字体目录里的文件，别变成任意文件读取 */
    String ok[] = { "/system/", "/product/", "/vendor/", "/cust/", "/data/fonts/", "/data/themes/", "/data/skin/fonts/" };
    boolean allowed = false;
    for (String pre : ok) if (raw.startsWith(pre)) { allowed = true; break; }
    if (!allowed || raw.contains("..")) { writeText(out, 403, "forbidden"); return; }
    java.io.File f = new java.io.File(raw);
    if (!f.isFile()) { writeText(out, 404, "no such font"); return; }
    long size = f.length();
    if (size > 48L * 1024 * 1024) { writeText(out, 413, "font too big"); return; }
    byte[] data = new byte[(int) size];
    java.io.FileInputStream in = null;
    try {
      in = new java.io.FileInputStream(f);
      int off = 0;
      while (off < data.length) {
        int n = in.read(data, off, data.length - off);
        if (n < 0) break;
        off += n;
      }
    } finally {
      try { if (in != null) in.close(); } catch (Throwable ignored) {}
    }
    byte[] head = ("HTTP/1.1 200 X\r\n"
        + "Content-Type: font/ttf\r\n"
        + "Content-Length: " + data.length + "\r\n"
        + "Cache-Control: max-age=86400\r\n"
        + "Access-Control-Allow-Origin: *\r\n"
        + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8);
    out.write(head);
    out.write(data);
    out.flush();
    Log.i(TAG, "served font " + raw + " (" + data.length + " B)");
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
    if (n.endsWith(".wasm")) return "application/wasm";   // 少了它 WebAssembly.instantiateStreaming 会失败（虽然会回落，但慢一截）
    if (n.endsWith(".onnx")) return "application/octet-stream";
    if (n.endsWith(".txt")) return "text/plain; charset=utf-8";
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
    /* http 目标走原始 Socket：Android 9+ 默认禁止明文 HTTP，HttpURLConnection 连局域网会被
       NetworkSecurityPolicy 拦掉；Socket 层没这个限制（也是「连电脑」能用起来的前提）。 */
    if (url.startsWith("http://")) { proxyRaw(out, url, hdr, body); return; }
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

  private static int indexOfFrom(byte[] all, byte[] pat, int from) {
    outer:
    for (int i = Math.max(0, from); i + pat.length <= all.length; i++) {
      for (int j = 0; j < pat.length; j++) if (all[i + j] != pat[j]) continue outer;
      return i;
    }
    return -1;
  }

  private static byte[] dechunk(byte[] all, int start) {
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] crlf = "\r\n".getBytes(StandardCharsets.UTF_8);
    int p = start;
    while (p < all.length) {
      int e = indexOfFrom(all, crlf, p);
      if (e < 0) break;
      String line = new String(all, p, e - p, StandardCharsets.UTF_8).trim();
      int semi = line.indexOf(';');
      if (semi >= 0) line = line.substring(0, semi);
      int len;
      try { len = Integer.parseInt(line, 16); } catch (Throwable t) { break; }
      if (len <= 0) break;
      int s0 = e + 2;
      int s1 = Math.min(all.length, s0 + len);
      bos.write(all, s0, s1 - s0);
      p = s1 + 2;
    }
    return bos.toByteArray();
  }

  /** http:// 目标：自己发请求、自己读响应，绕开明文限制 */
  private void proxyRaw(OutputStream out, String url, Map<String, String> hdr, byte[] body) throws IOException {
    java.net.Socket s = new java.net.Socket();
    try {
      java.net.URL u = new java.net.URL(url);
      String host = u.getHost();
      int port = u.getPort() > 0 ? u.getPort() : 80;
      String path = u.getFile();
      if (path == null || path.isEmpty()) path = "/";
      s.connect(new java.net.InetSocketAddress(host, port), 20000);
      s.setSoTimeout(300000);

      StringBuilder h = new StringBuilder();
      h.append(body.length > 0 ? "POST " : "GET ").append(path).append(" HTTP/1.1\r\n");
      h.append("Host: ").append(host);
      if (port != 80) h.append(':').append(port);
      h.append("\r\nConnection: close\r\nAccept-Encoding: identity\r\nUser-Agent: KY-notebook\r\n");
      for (Map.Entry<String, String> e : hdr.entrySet()) {
        String k = e.getKey().toLowerCase(Locale.ROOT);
        if (k.equals("host") || k.equals("connection") || k.equals("content-length")
            || k.equals("accept-encoding")) continue;
        if (k.equals("authorization") || k.equals("content-type") || k.equals("accept") || k.startsWith("x-")) {
          h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        }
      }
      if (body.length > 0) h.append("Content-Length: ").append(body.length).append("\r\n");
      h.append("\r\n");

      OutputStream os = s.getOutputStream();
      os.write(h.toString().getBytes(StandardCharsets.UTF_8));
      if (body.length > 0) os.write(body);
      os.flush();

      InputStream is = s.getInputStream();
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[16384];
      int n;
      while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
      byte[] all = bos.toByteArray();
      int sep = indexOfFrom(all, "\r\n\r\n".getBytes(StandardCharsets.UTF_8), 0);
      if (sep < 0) { writeText(out, 502, "proxy: 电脑返回的内容不完整"); return; }

      String headText = new String(all, 0, sep, StandardCharsets.UTF_8);
      int bodyStart = sep + 4;
      int code = 200;
      String ct = "application/json; charset=utf-8";
      boolean chunked = false;
      String[] lines = headText.split("\r\n");
      if (lines.length > 0) {
        String[] parts = lines[0].split(" ");
        if (parts.length >= 2) { try { code = Integer.parseInt(parts[1]); } catch (Throwable t) { /* 忽略 */ } }
      }
      for (int i = 1; i < lines.length; i++) {
        int c = lines[i].indexOf(':');
        if (c <= 0) continue;
        String k = lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT);
        String v = lines[i].substring(c + 1).trim();
        if (k.equals("content-type")) ct = v;
        else if (k.equals("transfer-encoding") && v.toLowerCase(Locale.ROOT).contains("chunked")) chunked = true;
      }
      byte[] data = chunked ? dechunk(all, bodyStart)
          : java.util.Arrays.copyOfRange(all, bodyStart, all.length);

      byte[] head = ("HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "ERR") + "\r\n"
          + "Content-Type: " + ct + "\r\n"
          + "Content-Length: " + data.length + "\r\n"
          + "Cache-Control: no-store\r\n"
          + "Access-Control-Allow-Origin: *\r\n"
          + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8);
      out.write(head);
      out.write(data);
      out.flush();
      Log.i(TAG, "proxy raw " + host + ":" + port + path + " -> " + code + " " + data.length + "B");
    } catch (Throwable t) {
      writeText(out, 502, "proxy failed: " + t);
    } finally {
      try { s.close(); } catch (Throwable ignored) { /* 忽略 */ }
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
