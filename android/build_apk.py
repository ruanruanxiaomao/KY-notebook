#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""KY-notebook 安卓壳打包脚本。

不依赖 Android Studio / Gradle / SDK：复用 KY-Toolkit 主项目那套离线工具链
（android.jar + r8 的 D8 + apksig 的 SignApk + 基座 APK + keystore）。

流程：
  1. 把仓库根目录的网页（index.html + src/ + 注入的 android-shim.js）收进 assets/www
  2. javac --release 8 → D8 → classes.dex
  3. 拿基座 APK 当模板：换 dex、换 assets、改包名（等长替换）、改版本号、改应用名
  4. resources.arsc 保持 STORED 且 4 字节对齐，最后 SignApk 签名

用法：
  python android/build_apk.py [--base phone|tab] [--ver 0.1.0] [--code 1]
环境变量：
  KY_TOOLKIT  壳层源码_v8 目录（默认 C:\\Users\\OYC\\Desktop\\app\\壳层源码_v8）
  KY_JDK      JDK 的 bin 目录（默认 C:\\Users\\OYC\\.jdks\\jdk-17.0.20.1+1\\bin）
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)                     # KY-notebook 仓库根
TOOLKIT = os.environ.get('KY_TOOLKIT', r'C:\Users\OYC\Desktop\app\壳层源码_v8')
JDK = os.environ.get('KY_JDK', r'C:\Users\OYC\.jdks\jdk-17.0.20.1+1\bin')

ANDROID_JAR = os.path.join(TOOLKIT, 'tools', 'android.jar')
R8_JAR = os.path.join(TOOLKIT, 'tools', 'r8-8.3.37.jar')
APKSIG_JAR = os.path.join(TOOLKIT, 'tools', 'apksig-8.7.3.jar')
SIGN_SRC = os.path.join(TOOLKIT, 'build', 'SignApk.java')
KEYSTORE = os.path.join(TOOLKIT, 'kaoyan_v6.jks')
KS_PASS = 'kaoyan2026'
ALIAS = 'kaoyan'
KEY_PASS = 'kaoyan2026'
TOOLS_PY = os.path.join(TOOLKIT, 'tools')

OLD_PKG = 'com.kaoyan.phone'
NEW_PKG = 'com.rrmao.kynote'                        # 必须和旧包名等长（二进制清单里就地替换）
APP_NAME = 'KY-notebook'

WORK = os.path.join(HERE, '_work')
OUT_DIR = os.path.join(PROJECT, 'dist-android')
SRC_JAVA = os.path.join(HERE, 'app', 'src')
SHIM = os.path.join(HERE, 'app', 'assets', 'www', 'android-shim.js')

# 网页要打进去的东西：index.html + src/*.js（demo 没有打包步骤，直接照搬）
WEB_FILES = ['index.html']
WEB_DIRS = ['src']


def log(msg):
    print(msg, flush=True)


def die(msg):
    print('ERR ' + msg, flush=True)
    sys.exit(1)


def run(cmd):
    log('  $ ' + ' '.join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd))[:160])
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        sys.stderr.write(p.stdout.decode('utf-8', 'replace')[-4000:])
        sys.stderr.write(p.stderr.decode('utf-8', 'replace')[-4000:])
        die('命令失败：%s' % os.path.basename(cmd[0]))


def tool(name):
    p = os.path.join(JDK, name + ('.exe' if os.name == 'nt' else ''))
    if not os.path.exists(p):
        die('找不到 %s（设置 KY_JDK）' % p)
    return p


# ---------------------------------------------------------------- 网页资源
def collect_web():
    """返回 {asset 相对路径: bytes}，路径相对 assets/www。"""
    out = {}
    for fn in WEB_FILES:
        p = os.path.join(PROJECT, fn)
        out[fn] = read(p)
    for d in WEB_DIRS:
        root = os.path.join(PROJECT, d)
        for dirpath, _, files in os.walk(root):
            for fn in files:
                if not fn.endswith(('.js', '.css', '.json', '.png', '.svg', '.woff2', '.webmanifest')):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, PROJECT).replace('\\', '/')
                out[rel] = read(full)
    out['android-shim.js'] = read(SHIM)
    html = out['index.html'].decode('utf-8')
    if 'android-shim.js' not in html:
        tag = '<script src="/android-shim.js"></script>'
        # 放在 </body> 前；它是普通脚本，会先于 module 执行
        html = html.replace('</body>', '  ' + tag + '\n</body>', 1) if '</body>' in html else html + tag
        out['index.html'] = html.encode('utf-8')
    return out


def read(p):
    with open(p, 'rb') as f:
        return f.read()


# ---------------------------------------------------------------- 编译
def compile_dex():
    classes = os.path.join(WORK, 'classes')
    if os.path.isdir(classes):
        shutil.rmtree(classes)
    os.makedirs(classes)
    javas = []
    for dirpath, _, files in os.walk(SRC_JAVA):
        for fn in files:
            if fn.endswith('.java'):
                javas.append(os.path.join(dirpath, fn))
    if not javas:
        die('没有 Java 源码')
    run([tool('javac'), '--release', '8', '-encoding', 'UTF-8', '-cp', ANDROID_JAR, '-d', classes] + javas)
    jar = os.path.join(WORK, 'classes.jar')
    run([tool('jar'), 'cf', jar, '-C', classes, '.'])
    dex_dir = os.path.join(WORK, 'dex')
    if os.path.isdir(dex_dir):
        shutil.rmtree(dex_dir)
    os.makedirs(dex_dir)
    run([tool('java'), '-cp', R8_JAR, 'com.android.tools.r8.D8',
         '--release', '--lib', ANDROID_JAR, '--min-api', '21', '--output', dex_dir, jar])
    return read(os.path.join(dex_dir, 'classes.dex'))


# ---------------------------------------------------------------- 清单 / 资源
def patch_package(axml):
    """二进制清单里包名是 UTF-16LE 定长字符串，等长替换即可。"""
    old = OLD_PKG.encode('utf-16-le')
    new = NEW_PKG.encode('utf-16-le')
    if len(old) != len(new):
        die('新旧包名长度不同，无法就地替换')
    if old not in axml:
        die('清单里找不到旧包名 %s' % OLD_PKG)
    return axml.replace(old, new)


def patch_arsc_pkg(arsc):
    old = OLD_PKG.encode('utf-16-le')
    new = NEW_PKG.encode('utf-16-le')
    return arsc.replace(old, new)


def patch_arsc_label(arsc, name):
    sys.path.insert(0, TOOLS_PY)
    import arsc_label  # noqa: E402
    new_arsc, idx, old = arsc_label.patch_app_name(arsc, name)
    log('  应用名: %r -> %r' % (old, name))
    return new_arsc


def patch_manifest_ver(axml, ver, code):
    sys.path.insert(0, TOOLS_PY)
    import manifest_ver  # noqa: E402
    new_axml, changed = manifest_ver.patch_manifest(axml, ver, code)
    log('  清单版本: %s' % '; '.join(changed))
    try:
        new_axml, cc = manifest_ver.patch_cleartext(new_axml)
        log('  明文 HTTP: %s' % cc)
    except Exception as e:      # 基座可能已经允许明文
        log('  明文 HTTP: 跳过（%s）' % e)
    return new_axml


# ---------------------------------------------------------------- 打包
def build_zip(base_path, out_path, replace, extras, arsc_extra=b''):
    with zipfile.ZipFile(base_path) as z:
        infos = z.infolist()
        with zipfile.ZipFile(out_path, 'w') as out:
            written = set()
            for zi in infos:
                n = zi.filename
                if n == 'classes.dex' or n.startswith('assets/') or n.startswith('META-INF/'):
                    continue
                if n in replace:
                    data = replace[n]
                else:
                    data = z.read(n)
                ni = zipfile.ZipInfo(n, date_time=(2026, 1, 1, 0, 0, 0))
                ni.external_attr = zi.external_attr
                if n == 'resources.arsc':
                    ni.compress_type = zipfile.ZIP_STORED
                    ni.extra = arsc_extra
                else:
                    ni.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(ni, data)
                written.add(n)
            for n in ('classes.dex',):
                if n in replace:
                    ni = zipfile.ZipInfo(n, date_time=(2026, 1, 1, 0, 0, 0))
                    ni.compress_type = zipfile.ZIP_DEFLATED
                    out.writestr(ni, replace[n])
                    written.add(n)
            for n in sorted(extras):
                ni = zipfile.ZipInfo(n, date_time=(2026, 1, 1, 0, 0, 0))
                ni.compress_type = zipfile.ZIP_DEFLATED
                out.writestr(ni, extras[n])
                written.add(n)


def local_data_offset(apk_path, name):
    with zipfile.ZipFile(apk_path) as z:
        zi = z.getinfo(name)
        with open(apk_path, 'rb') as f:
            f.seek(zi.header_offset)
            hdr = f.read(30)
        fnlen, extralen = struct.unpack_from('<HH', hdr, 26)
        return zi.header_offset + 30 + fnlen + extralen


def pack_aligned(base_path, out_path, replace, extras):
    tmp = out_path + '.pass1'
    build_zip(base_path, tmp, replace, extras)
    off = local_data_offset(tmp, 'resources.arsc')
    pad = (4 - (off % 4)) % 4
    if pad < 4:
        pad += 4
    extra = struct.pack('<HH', 0xD935, pad - 4) + b'\x00' * (pad - 4)
    os.remove(tmp)
    build_zip(base_path, out_path, replace, extras, arsc_extra=extra)
    off2 = local_data_offset(out_path, 'resources.arsc')
    if off2 % 4 != 0:
        die('resources.arsc 未对齐（%d）' % off2)
    log('  resources.arsc STORED，data_off=%d（%%4==0）' % off2)


def sign(unsigned, final_path):
    signcp = os.path.join(WORK, 'signcp')
    if not os.path.isdir(signcp):
        os.makedirs(signcp)
    run([tool('javac'), '-encoding', 'UTF-8', '-cp', APKSIG_JAR, '-d', signcp, SIGN_SRC])
    cp = APKSIG_JAR + os.pathsep + signcp
    run([tool('java'), '-cp', cp, 'SignApk', KEYSTORE, KS_PASS, ALIAS, KEY_PASS, unsigned, final_path])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='phone', choices=['phone', 'tab'])
    ap.add_argument('--ver', default='0.1.0')
    ap.add_argument('--code', default='1')
    args = ap.parse_args()

    for p in (ANDROID_JAR, R8_JAR, APKSIG_JAR, SIGN_SRC, KEYSTORE):
        if not os.path.exists(p):
            die('缺少工具链文件：' + p)
    base_name = '基座_手机端.apk' if args.base == 'phone' else '基座_平板端.apk'
    base = os.path.join(TOOLKIT, 'build', '基座', base_name)
    if not os.path.exists(base):
        die('缺少基座 APK：' + base)

    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    log('[1/5] 收集网页资源')
    web = collect_web()
    log('  %d 个文件，index.html %d 字节' % (len(web), len(web['index.html'])))

    log('[2/5] 编译 dex')
    dex = compile_dex()
    log('  classes.dex %d 字节' % len(dex))

    log('[3/5] 改清单 / 应用名 / 版本')
    with zipfile.ZipFile(base) as z:
        axml = z.read('AndroidManifest.xml')
        arsc = z.read('resources.arsc')
    axml = patch_package(axml)
    axml = patch_manifest_ver(axml, args.ver, str(args.code))
    arsc = patch_arsc_label(arsc, APP_NAME)
    arsc = patch_arsc_pkg(arsc)

    replace = {'classes.dex': dex, 'AndroidManifest.xml': axml, 'resources.arsc': arsc}
    extras = {'assets/www/' + k: v for k, v in web.items()}
    unsigned = os.path.join(WORK, 'kynb-unsigned.apk')
    log('[4/5] 打包（%d 个 assets）' % len(extras))
    pack_aligned(base, unsigned, replace, extras)

    final = os.path.join(OUT_DIR, 'KY-notebook-%s.apk' % args.ver)
    if os.path.exists(final):
        os.remove(final)
    log('[5/5] 签名')
    sign(unsigned, final)
    data = read(final)
    log('OUT %s  %d B  md5=%s' % (os.path.basename(final), len(data), hashlib.md5(data).hexdigest()))
    with zipfile.ZipFile(final) as z:
        bad = z.testzip()
        if bad:
            die('APK 压缩包损坏：' + bad)
        names = z.namelist()
        log('  entries=%d  dex=%d B  assets/www=%d' % (
            len(names), len(z.read('classes.dex')),
            sum(1 for n in names if n.startswith('assets/www/'))))
    log('BUILD_ANDROID_OK')


if __name__ == '__main__':
    main()
