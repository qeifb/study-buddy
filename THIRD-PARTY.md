# 第三方依赖与数据来源

本项目自身代码以 MIT 协议发布（见 [LICENSE](LICENSE)）。
下列是随仓库分发的第三方代码与数据，各自遵循其原始许可。

---

## app/extension/typr-lite.js

- **来源**：[photopea/Typr.js](https://github.com/photopea/Typr.js)
- **许可**：MIT
- **用途**：解析 TrueType 字体，取出每个字形的轮廓路径（`glyphToPath`）。
- **为什么内联**：扩展不能 `require`，也无法依赖 CDN（离线可用、避免 CSP 与网络问题）。
- **文件说明**：为 `Typr.min.js` + `Typr.U.min.js` 的打包，仅保留字体解析所需部分。

## app/extension/md5-mini.js

- **来源**：[blueimp-md5](https://github.com/blueimp/JavaScript-MD5) v2.19.0
- **许可**：MIT
- **用途**：计算字形轮廓字符串的 MD5，用于查字体映射表。
- **为什么不用自实现**：我曾手写 MD5，与标准实现对照只通过 1/6，会导致映射全部失效；
  blueimp-md5 是成熟实现，且与同类解码脚本所用一致，保证 hash 与映射表匹配。

## 便携版 Python（tools/python/，运行时自动下载，不随仓库分发）

- **来源**：[python-build-standalone](https://github.com/astral-sh/python-build-standalone)（astral-sh 维护）
- **许可**：Python Software Foundation License（与原版 Python 一致）
- **用途**：当用户电脑没有 Python 时，自动下载便携版，解压到 `tools\python\`，用于创建转写虚拟环境。
- **为什么不用官方 embeddable zip**：官方 `python-3.x-embed-amd64.zip` **不带 pip、不支持 venv**（`ensurepip` 与 `venv` 模块被裁剪），无法创建本项目要求的 `tools\pyenv` 虚拟环境。
- **下载地址模板**：
  ```
  https://registry.npmmirror.com/-/binary/python-build-standalone/<版本日期>/cpython-3.12.15+20261021-x86_64-pc-windows-msvc-install_only.tar.gz
  ```
  约 44MB，解压后用 Windows 自带 `tar.exe -xzf`，解压出的顶层目录就叫 `python/`。
- **不写注册表、不装系统、不需要管理员权限。**

## 语音模型（tools/models/，运行时自动下载或随 offline 版分发）

> **分发方式**：标准版 `study-buddy.zip` 不含模型（运行时下载）；
> `study-buddy-offline.zip` **内置模型**，方便网络不稳的用户。两者许可一致。

- **来源**：HuggingFace 仓库 `Systran/faster-whisper-<模型名>`
- **许可**：模型各自遵循其原始许可（faster-whisper 系列为 MIT）
- **用途**：语音转写。默认 `large-v3-turbo` 约 1.6GB。
- **镜像**：国内默认走 <https://hf-mirror.com>，失败自动切换官方源并重试。

## app/extension/font-table.js

- **数据来源**：<https://www.forestpolice.org/ttf/2.0/table.json>
- **许可**：该表由社区整理并公开分发，用于超星/学习通字体解码。本项目仅做格式转换（JSON → 可内联的 JS 字符串）。
- **内容**：20902 条 `字形轮廓 MD5（后 8 位） → 汉字 Unicode 码位` 的映射。
- **用途**：把学习通题面里的混淆字符还原为真实汉字（确定性还原，非字形相似度猜测）。
- **如需更新**：重新下载上述 JSON，运行 `tools/build-font-table.mjs` 生成。

## app/extension/cand-chars.js

- **本项目自制**：候选汉字表（用于解混淆的**回退路径**，即映射表未命中时才启用的字形相似度比对）。
- 字集来自 GB2312 全字表 + 本项目课程日志中实际出现的汉字。

---

## 关于字体解码方案的说明

学习通在章节测验页面内联一个 `@font-face`（字体名 `font-cxsecret`）子集字体，
DOM 中的文字是「字形正确、码位错误」的乱码。本项目采用**确定性**还原：

```
glyphIndex = Typr.U.codeToGlyph(font, code)
path       = Typr.U.glyphToPath(font, glyphIndex)
hash       = md5(JSON.stringify(path)).slice(24)   // 注意：后 8 位
真实汉字   = fontTable[hash]
```

因为同一汉字的字形轮廓恒定，其 MD5 也恒定，所以一张固定的映射表即可 100% 精确还原，
不需要「置信度」或「相似度阈值」。实测真实题目字体 31/31 全部命中。

若映射表未命中（字体版本变化等），代码会自动回退到 `cand-chars.js` + canvas 字形比对的近似路径，
并在界面标注可信度，交人工复核。
