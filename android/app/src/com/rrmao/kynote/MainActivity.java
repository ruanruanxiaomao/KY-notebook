package com.rrmao.kynote;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * KY-notebook 安卓壳：不是加载 file://（那样 ES module 会被拦），
 * 而是在本机起一个只监听 127.0.0.1 的小静态服务器，WebView 用 http 访问它。
 * 好处：模块 / fetch / IndexedDB 都按正常网页规则工作，AI 请求也能同源走 /proxy 绕 CORS。
 */
public class MainActivity extends Activity {
  private static final String TAG = "kynote";
  private static final int REQ_FILE = 2001;
  private WebView wv;
  private LocalServer server;
  private ValueCallback<Uri[]> fileCb;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);   // 方便 adb + CDP 调试
    try {
      server = new LocalServer(getAssets());
      server.start();
    } catch (Throwable t) {
      Log.e(TAG, "local server failed", t);
      Toast.makeText(this, "本地服务启动失败：" + t, Toast.LENGTH_LONG).show();
      finish();
      return;
    }
    wv = new WebView(this);
    WebSettings s = wv.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);
    if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    wv.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
        if (url != null && url.startsWith("http://127.0.0.1")) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Throwable ignored) {}
        return true;
      }
    });
    wv.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
        if (fileCb != null) fileCb.onReceiveValue(null);
        fileCb = cb;
        try {
          Intent i = new Intent(Intent.ACTION_GET_CONTENT);
          i.addCategory(Intent.CATEGORY_OPENABLE);
          i.setType("*/*");
          if (p != null && p.getAcceptTypes() != null && p.getAcceptTypes().length > 0) {
            String a = p.getAcceptTypes()[0];
            if (a != null && a.length() > 0 && !a.contains(",")) i.setType(a);
          }
          i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p != null && p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
          startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
        } catch (Throwable t) {
          fileCb = null;
          cb.onReceiveValue(null);
          return false;
        }
        return true;
      }
    });
    wv.addJavascriptInterface(new NativeBridge(this), "KYNative");
    // 状态栏/导航栏不吃掉顶部那一行：把系统栏高度让成 WebView 的内边距
    wv.setFitsSystemWindows(false);
    if (Build.VERSION.SDK_INT >= 21) {
      wv.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
        @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
          v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                       insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
          return insets;
        }
      });
    }
    setContentView(wv, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    wv.loadUrl(server.baseUrl());
  }

  @Override protected void onActivityResult(int req, int res, Intent data) {
    super.onActivityResult(req, res, data);
    if (req != REQ_FILE) return;
    Uri[] out = null;
    if (res == RESULT_OK && data != null) {
      if (data.getClipData() != null) {
        int n = data.getClipData().getItemCount();
        out = new Uri[n];
        for (int i = 0; i < n; i++) out[i] = data.getClipData().getItemAt(i).getUri();
      } else if (data.getData() != null) {
        out = new Uri[]{data.getData()};
      }
    }
    if (fileCb != null) { fileCb.onReceiveValue(out); fileCb = null; }
  }

  @Override public void onBackPressed() {
    /* 先问网页「这个返回你要不要自己吃」：弹窗 / 编辑器 → 笔记库 / 非笔记本标签页。
       网页返回 '1' 表示它处理了；否则才真正退出 App。 */
    if (wv == null) { super.onBackPressed(); return; }
    wv.evaluateJavascript("(window.__kynbHandleBack && window.__kynbHandleBack()) ? '1' : '0'",
        new ValueCallback<String>() {
          @Override public void onReceiveValue(String v) {
            boolean handled = v != null && v.contains("1");
            if (!handled) MainActivity.super.onBackPressed();
          }
        });
  }

  @Override protected void onDestroy() {
    if (server != null) server.stop();
    super.onDestroy();
  }
}
