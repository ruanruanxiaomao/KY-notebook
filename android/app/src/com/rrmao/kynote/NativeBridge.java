package com.rrmao.kynote;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 网页 ↔ 原生的小桥：导出 PNG / JSON 时网页拿不到下载目录，交给原生落盘。
 */
class NativeBridge {
  private final Activity act;

  NativeBridge(Activity act) {
    this.act = act;
  }

  @JavascriptInterface
  public void toast(final String msg) {
    act.runOnUiThread(new Runnable() {
      public void run() { Toast.makeText(act, msg == null ? "" : msg, Toast.LENGTH_SHORT).show(); }
    });
  }

  /** 返回落盘后的可读位置（如 "下载/KY-notebook/xxx.png"），失败返回 "ERR: …" */
  @JavascriptInterface
  public String saveFile(String name, String base64) {
    try {
      String safe = name == null ? "kynb-export" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
      byte[] data = Base64.decode(base64, Base64.DEFAULT);
      String sub = "KY-notebook";
      if (Build.VERSION.SDK_INT >= 29) {
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, mime(safe));
        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + sub);
        Uri uri = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (uri == null) return "ERR: MediaStore 返回空";
        OutputStream os = act.getContentResolver().openOutputStream(uri);
        os.write(data);
        os.close();
        return "下载/" + sub + "/" + safe;
      }
      File dir = new File(act.getExternalFilesDir(null), sub);
      if (!dir.exists()) dir.mkdirs();
      File f = new File(dir, safe);
      FileOutputStream fos = new FileOutputStream(f);
      fos.write(data);
      fos.close();
      return f.getAbsolutePath();
    } catch (Throwable t) {
      Log.w("kynote", "saveFile failed", t);
      return "ERR: " + t;
    }
  }

  private static String mime(String n) {
    String s = n.toLowerCase();
    if (s.endsWith(".png")) return "image/png";
    if (s.endsWith(".json")) return "application/json";
    if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
    if (s.endsWith(".pdf")) return "application/pdf";
    return "application/octet-stream";
  }

  @JavascriptInterface
  public String platform() {
    return "android";
  }

  @JavascriptInterface
  public String version() {
    try {
      return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
    } catch (Throwable t) {
      return "";
    }
  }
}
