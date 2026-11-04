# vendor/hwr —— 离线手写识别资源

这四个文件是「✍ 手写转文字」的离线引擎，页面首次打开手写板时才加载（约 28 MB，全在本机，不联网）。

| 文件 | 大小 | 来源 | 许可 |
|---|---|---|---|
| `rec.onnx` | 16.6 MB | PaddleOCR **PP-OCRv5** 中文识别移动端模型（经 RapidOCR 转成 ONNX） | Apache-2.0 |
| `dict.txt` | 74 KB | 同上，`ppocrv5_dict.txt`，18383 个字/符号 | Apache-2.0 |
| `ort.wasm.min.js` | 49 KB | onnxruntime-web 1.20.1（WASM 后端） | MIT |
| `ort-wasm-simd-threaded.wasm` | 11.2 MB | 同上 | MIT |
| `ort-wasm-simd-threaded.mjs` | 24 KB | 同上（1.20 的 ESM 胶水层，缺了会连不上 WASM 后端） | MIT |

- 模型：https://www.modelscope.cn/models/RapidAI/RapidOCR → `onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx`
- 字典：同仓库 `paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt`
- 运行时：`npm pack onnxruntime-web@1.20.1` → `dist/`

## 为什么是这套

- **PP-OCRv5**（Apache-2.0）官方支持中文手写体、简繁、英文、日文，移动端模型 16.6 MB，单线程 WASM 在手机上跑一行约 50~100 ms。
- **HanziLookupJS / hanzi_lookup**（800 KB，纯笔画结构匹配）体积小得多，但**是 GPL-3.0**，混进 MIT 仓库会传染，只能不用。
- **Google ML Kit Digital Ink** 需要 Google Play 服务，华为设备上装不了。
- **MyScript** 是商业 SDK。

## 许可

`rec.onnx` / `dict.txt` 来自 PaddleOCR，Apache License 2.0；`ort*.js|wasm|mjs` 来自 ONNX Runtime，MIT。
本项目自身仍是 MIT，见仓库根目录 `LICENSE`。
