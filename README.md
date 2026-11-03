# KY-notebook

浏览器里直接用的手写笔记 / 拍题 / 图片·PDF 批注工具。纯前端，无构建步骤；AI 用你自己填的 **OpenAI 兼容接口**（可以接云端，也可以接本机 ollama），图片只发给你配置的接口。

从 KY-Toolkit 安卓壳层工程里把手写笔记、拍题、批注三条链路拆出来做成一个独立的小工具，方便单独用、单独改、单独开源。

![笔记本](docs/screenshots/editor.png)

![拍题](docs/screenshots/shot.png)

## 三个页面

**① 笔记本**
- 手写：单 canvas 二次曲线 + 压感（粗细随按压力度变化），笔 / 荧光笔 / 橡皮
- 8 色、3 档粗细、撤销 / 重做（每页 100 步）、4 种纸面模板（空白 / 横线 / 方格 / 点阵）
- 多页：翻页、加页、每页独立笔迹，页脚显示「第 N 页 / 共 M 页」
- 笔记库：缩略图、页数、时间、收藏 ★、删除 ✕、点标题就地改名
- 来源：从「拍题」「批注」存过来的笔记，编辑器顶部有一行来源（可点回原页面），库里卡片带徽标 `📄 文件名 p3` / `🖼 图片名` / `📷 拍题`
- 导出 PNG（2× 分辨率）/ JSON（备份，能再导入），导入 JSON 新建一本笔记，自动保存（700ms 防抖）到 IndexedDB

**② 拍题**
- 拍照（getUserMedia，失败回退文件选择）/ 选择图片 / 拖拽图片进来
- 选一个提示词，或临时补充要求，然后「问 AI」
- 结果按 Markdown 渲染，公式走 MathJax
- 「存为笔记底图」把这张题图铺进一张新笔记，直接在题面上写过程

**③ 图片 / PDF 批注**
- 导入图片或 PDF（pdf.js 渲染每页成底图），逐页手写批注
- 缩放、翻页、导出 PNG / JSON
- **PDF 文字层**：右侧「本页文字」把每页文字按行聚成段落，点一段就在页面上盖一个半透明高亮，还能只对这一段「AI 解析这段 / 翻译这段」；没有文字层的扫描件给提示、不报错
- 「存为笔记」：把当前页（含笔迹）存进笔记本，同时记下来源（文件名 + 页码）
- 「让 AI 解析本页」用同一套提示词解析当前页

**提示词**（点右上角「提示词」）
- 内置 6 条：题目解析（分题作答）• 只抄题（不解答）• 公式 → LaTeX • 整页翻译（一句原文一句译文）• 整页结构化 • 自定义
- 每条 = 名字 + 系统提示（可选）+ 要求；可以新建、编辑、恢复默认
- 三个页面共用同一份，拍题页和批注页都能选

## 导入 / 导出 JSON

编辑器右上角「JSON」导出整本笔记（对话框里可以勾「包含页面底图」），笔记库顶部「导入 JSON」把它读回来（自己导出的文件能原样导入，底图也一起恢复）。

```json
{
  "app": "KY-notebook",
  "v": 1,
  "exportedAt": "2026-11-03T11:52:00.000Z",
  "note": { "title": "线性代数", "star": 0, "createdAt": 1762000000000, "pageCount": 2,
            "src": { "kind": "pdf", "name": "textbook.pdf", "page": 3 } },
  "pages": [{ "no": 0, "template": "lines",
              "bg": "data:image/jpeg;base64,…",
              "strokes": [{ "t": "pen", "c": "#1f1c18", "w": 4, "pts": [x, y, pressure, …] }] }]
}
```

- `v` 是 schema 版本（当前 `1`）；导入按它判断，比 `1` 新的版本直接拒绝并提示。老文件里只有 `version` 时也按它读。`bg` 和 `note.src` 是 v1 里的**可选**字段，没有也照常导入。
- **底图**：只有在导出对话框里勾了「包含页面底图」才写 `bg`（压到长边 ≤1400、JPEG q0.7，单页超过 250 KB 再降一档质量）；不勾就是 `false`，导入后那几页是白纸 + 笔迹。缩略图始终不导出（卡片一开始空白，进编辑器写一笔就补上）。
- `note.src` 是来源锚定：`{ kind: "pdf" | "img" | "shot", name, page }`，导入后卡片徽标和编辑器来源行都会恢复。
- 导入是**新建**一本笔记：新 id，标题取 `note.title`（空则用文件名），`star` / `createdAt` / `src` 尽量沿用；已有笔记不动。
- 结构不合法（不是 JSON、缺 `pages`、笔迹字段类型不对、版本过新…）只弹一条底部提示，说明是第几页第几笔出错，不写入、不抛异常。
- 批注页（图片 / PDF）自己的「导出批注 JSON」是另一份更简单的格式，只含笔迹和页码，同样不含底图；要连底图一起留，用「存为笔记」再导出笔记本 JSON，或直接导出 PNG。

## 快速开始

```bash
cd KY-notebook
python serve.py            # 默认 http://127.0.0.1:8765/
# 或换端口： python serve.py 9000
```

然后浏览器打开 `http://127.0.0.1:8765/`，点右上角「设置」填接口。

**为什么不能直接双击 index.html**：一是用了 ES module，`file://` 下会被拦；二是浏览器直连第三方 AI 接口时，如果对方没给 CORS 头，fetch 会失败——`serve.py` 内置了一个同源代理（`POST /proxy?u=<目标地址>`），页面直连被拦时会自动改走它，所以你只需要跑这一个命令。

## 配置 AI

| 字段 | 说明 |
|---|---|
| Base URL | `https://xxx/v1`、`…/v1/chat/completions`、ollama 的 `http://127.0.0.1:11434` 都行，会自动补 `/chat/completions` |
| API Key | 本机 ollama 可以留空 |
| 模型 | 例如 `gpt-4o-mini`、`qwen2.5-vl-7b`、`deepseek-v4.1-flash` 等 |
| 支持看图 | 拍题、图片/PDF 解析必须勾上，并且模型本身得是视觉模型 |

几个坑：

- **推理型模型会先花 token 思考**。如果报「模型输出被 max_tokens 截断」，把 `src/shot.js`、`src/annot.js` 里的 `maxTokens` 调大（当前 3000）。
- **CORS**：直连被拦时自动走 `/proxy`，所以 `serve.py` 必须用这个而不是 `http.server`；接口如果在本机（如 ollama）通常直连就通。
- **OpenCode Go**（`https://opencode.ai/zen/go/v1`）：需要 `x-opencode-session` 头，代码在目标地址含 `opencode.ai` 时会自动加。

## 数据存在哪

- 笔记与页面：IndexedDB `kynb`（`notes` / `pages` 两个 store），清浏览器站点数据就没了
- 配置：localStorage `kynb_ai`
- 提示词：localStorage `kynb_prompts`

## 目录

```
index.html        三个页面 + 设置/提示词对话框
serve.py          静态服务 + /proxy CORS 代理（无第三方依赖）
src/ai.js         OpenAI 兼容适配（含代理回退、会话头、错误提示）
src/prompts.js    提示词的读写与默认值
src/md.js         Markdown → DOM + MathJax 排版 + 输出清洗
src/store.js      IndexedDB 封装
src/inkboard.js   手写引擎（页面坐标 1414×1000、二次曲线、压感、撤销、导出）
src/notejson.js   笔记 JSON 的结构 / 版本号 / 导入校验（纯数据，不碰 DOM）
src/notebook.js   笔记库 + 编辑器
src/shot.js       拍题
src/annot.js      图片 / PDF 批注（含 PDF 文字层抽取、逐段 AI、存为笔记）
src/main.js       标签切换、设置与提示词对话框
docs/screenshots/ 截图
```

## 已知限制

- 拍题和图片解析依赖**视觉模型**；模型不支持看图时会明确报错，不会静默失败。
- PDF 的文字层只认 PDF 自带的：扫描件没有文字层，只能手写批注，**不做 OCR**。
- 段落是按几何位置聚的（相邻行距 > 1.9×行高就断段）：多栏、表格、图注夹排会切得糙，双栏 PDF 的行序会串；高亮框用 text item 的 transform 估，字距很密的行会略窄。
- 没有云同步 / 多人协作；导出有 PNG 和 JSON，手写笔记的 JSON 能导回，勾选后底图也能带（见上「导入 / 导出 JSON」）。
- 底图导出会二次压缩（本来就是 JPEG 的图会再压一次，轻微掉画质）；250 KB 上限是按 base64 长度估算的，不是精确字节。
- 窄屏（≤760px）下三个页面改成单列堆叠、整页滚动，手写画布会跟着缩小；桌面 / 平板横屏才是主要使用形态。
- MathJax、pdf.js 走 CDN，要完全离线得自己换成本地文件。

## 许可

MIT。参考过的实现：perfect-freehand（压感轮廓思路）、pdf.js（Apache-2.0）、MathJax（Apache-2.0）。

## 安卓版（可选）

仓库里带了 `android/` 一套**不依赖 Android Studio** 的打包壳：

- 原生壳不打 `file://`（那样 ES module 会被拦），而是在 App 内起一个只监听 `127.0.0.1` 的静态服务器（端口 18342），WebView 用 `http://127.0.0.1:18342/` 打开同一套网页；`/proxy` 也由这个本地服务器转发，所以网页里的 CORS 兜底在手机上同样生效。
- 导出 PNG / JSON 时，`android-shim.js` 会把 Blob 交给原生，存进手机「下载/KY-notebook/」。
- 拍照、选图走系统文件选择器；AI 接口和网页版一样在「设置」里填。

自己打包（需要 JDK 8+ 和一个 Android 基座 APK，见 `android/build_apk.py` 顶部常量）：

```bash
python android/build_apk.py --ver 0.1.2 --code 3
# 输出 dist-android/KY-notebook-<ver>.apk
```

已构建的安装包见 [Releases](https://github.com/ruanruanxiaomao/KY-notebook/releases)。
