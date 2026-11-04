#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""增量打包：只替换网页资源，复用上一个 APK 里已经编好的 classes.dex。

用途：这一轮只改了网页（index.html / src/*），Java 源码没动，而离线工具链里的
android.jar / r8.jar 不一定还在手边。这时没必要重新 javac + D8，直接拿上一个
APK 的 dex 当底座，换 assets/www、改版本号、重新签名即可。

  python android/rebuild_web_only.py --ver 0.1.9 --code 9 [--from dist-android/xxx.apk]

完整打包仍是 android/build_apk.py（Java 改了就必须走它）。
"""
import argparse
import glob
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_apk as B  # noqa: E402


def ver_key(path):
    m = re.search(r'(\d+)\.(\d+)\.(\d+)', os.path.basename(path))
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def latest_apk():
    files = glob.glob(os.path.join(B.OUT_DIR, '*.apk'))
    if not files:
        B.die('dist-android 下没有可复用的 APK，请先用 build_apk.py 完整打包一次')
    return sorted(files, key=ver_key)[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='src', default=None, help='底座 APK（默认 dist-android 里版本最高的）')
    ap.add_argument('--ver', required=True)
    ap.add_argument('--code', required=True)
    args = ap.parse_args()

    for p in (B.APKSIG_JAR, B.SIGN_SRC, B.KEYSTORE):
        if not os.path.exists(p):
            B.die('缺少签名相关文件：' + p)

    src = args.src or latest_apk()
    if not os.path.exists(src):
        B.die('底座 APK 不存在：' + src)
    os.makedirs(B.WORK, exist_ok=True)
    os.makedirs(B.OUT_DIR, exist_ok=True)
    B.log('底座 APK: %s' % os.path.basename(src))

    B.log('[1/4] 收集网页资源')
    web = B.collect_web()
    B.log('  %d 个文件，index.html %d 字节' % (len(web), len(web['index.html'])))

    B.log('[2/4] 复用底座里的 dex 与资源')
    with zipfile.ZipFile(src) as z:
        dex = z.read('classes.dex')
        axml = z.read('AndroidManifest.xml')
        arsc = z.read('resources.arsc')
    B.log('  classes.dex %d 字节（未重新编译）' % len(dex))

    B.log('[3/4] 改版本号并重打包')
    axml = B.patch_manifest_ver(axml, args.ver, args.code)
    replace = {'classes.dex': dex, 'AndroidManifest.xml': axml, 'resources.arsc': arsc}
    extras = {'assets/www/' + k: v for k, v in web.items()}
    unsigned = os.path.join(B.WORK, 'kynb-unsigned.apk')
    B.pack_aligned(src, unsigned, replace, extras)

    B.log('[4/4] 签名')
    out = os.path.join(B.OUT_DIR, 'KY-notebook-%s.apk' % args.ver)
    B.sign(unsigned, out)
    size = os.path.getsize(out)
    md5 = B.hashlib.md5(open(out, 'rb').read()).hexdigest()
    B.log('BUILD_WEB_ONLY_OK %s %d B md5=%s' % (out, size, md5))


if __name__ == '__main__':
    main()
