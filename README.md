# 学习通学伴（study-buddy）· E 盘部署说明

2026-10-22 从 C 盘整体迁移到这里；同日又把散在 E 盘根的几个相关文件夹、以及 C 盘的三个下载缓存，全部收拢进本目录。
**E 盘上跟 study-buddy 有关的东西，现在只有这一个文件夹。**

整个文件夹可以整体搬走，只要保持内部相对结构不变（程序按"能写就认"探测根目录，见 `app\core\paths.js`）。

## 目录结构

```
E:\StudyBuddy\
├── app\                    程序本体（Electron 源码 + node_modules）
│   ├── main.js             主进程（窗口、IPC、托盘、单实例）
│   ├── preload.js          预加载桥（渲染层能调用的全部接口）
│   ├── core\               抓取 / 转写 / 扩展服务 / 存储 / AI / 路径
│   ├── renderer\           界面（index.html / app.js / style.css）
│   ├── extension\          浏览器扩展（MV3，Edge 里要加载这个目录）
│   └── assets\             图标
├── data\                   你的数据（备份就拷这个）
│   ├── chats.json          对话历史
│   ├── settings.json       API Key / 模型配置 ← 敏感，别外传
│   ├── course-names.json   课程号 → 课程名缓存
│   ├── app.log             运行日志（超过 1MB 自动轮转）
│   └── course-logs\        课程转写稿（每节课一个 .md）
├── runtime\                Electron 运行时数据（Chromium userData，别手动改）
├── browser-profile\        专用浏览器的登录态（不碰日常 Edge）
├── tools\                  转写环境
│   ├── pyenv\              Python 3.14.4 + faster-whisper 1.2.1
│   ├── models\             large-v3-turbo 模型（1.6 GB）
│   ├── transcribe.py       转写脚本
│   └── setup-transcribe.ps1  一键安装脚本（应用设置页也会调它）
├── cache\                  下载缓存（本轮从 C 盘迁来）
│   ├── pip\                Python 包缓存（1.48 GB）
│   ├── electron\           Electron 运行时下载缓存（301 MB）
│   └── npm\                npm 包缓存（33 MB）
├── repo\                   开源发布仓库（含 .git，推 GitHub 用）
├── dist\                   打包产物（study-buddy*.zip）
├── publish\                推送脚本（isomorphic-git）与它的 node_modules
├── archive\                历史归档（上一轮 AI 的会话记录、媒体等，可删）
├── create-shortcut.ps1     创建桌面快捷方式
├── README.md               本文件
└── 启动学习通学伴.cmd       启动入口
```

## 启动方式

- 双击桌面「学习通学伴」快捷方式
- 或双击本目录下的 `启动学习通学伴.cmd`

启动脚本会依次：设好缓存变量 → 检查包内 `app\node_modules\electron\dist\electron.exe`。

- **离线版 / 完整版**：包里自带 Electron 运行时，直接用它启动，**不需要装 Node.js 或 npm**。
- **极简版**：包里没有运行时，脚本会先 `npm install` 再用国内镜像下载 Electron（所以这台机器要先装 Node.js）。

首次运行会顺带在桌面创建快捷方式，之后双击快捷方式即可。

> **为什么不再用 `npm start`**：2026-10-27 接到反馈，用户机器上没有 npm，`call npm start` 直接报
> `'npm' 不是内部或外部命令`，应用起不来。既然包里已经有 `electron.exe`，就没必要经过 npm 这一层。

> **改 `.cmd` 的铁律**：必须是 **GBK 编码 + CRLF 换行**。
> 用 PowerShell 写文件时若只写 LF，cmd 会把含中文的行拆错，报 `'\StudyBuddy\cache\electron"' is not recognized` 这类怪错。
> 检查：`@echo off` 后面的字节必须是 `0d 0a`。

## 缓存为什么都在这里

三个缓存原本在 C 盘（合计约 1.8 GB），已迁到 `E:\StudyBuddy\cache\`，并设好**用户级环境变量**（永久生效）：

| 变量 | 值 |
|---|---|
| `PIP_CACHE_DIR` | `E:\StudyBuddy\cache\pip` |
| `ELECTRON_CACHE` | `E:\StudyBuddy\cache\electron` |
| `npm_config_cache` | `E:\StudyBuddy\cache\npm` |

启动脚本里也显式 `set` 了一遍，所以即使当前窗口是旧环境继承来的，双击 `.cmd` 也一定走 E 盘。
（注册表变量对**已在运行**的进程不生效，需新开窗口——这是 Windows 机制，不是没写进去。）

## 浏览器扩展（换过目录就要重新加载）

1. Edge 地址栏输入 `edge://extensions`
2. 找到「学习通学伴」→ 点「删除」（旧路径已经不存在）
3. 打开左下角「开发人员模式」
4. 点「加载解压缩的扩展」→ 选择 `E:\StudyBuddy\app\extension`

重载后打开学习通网课页面，扩展角标显示「📚 学伴已就绪」即正常。

## 数据备份

- 只备份 `data\`（对话、设置、课程日志）+ `browser-profile\`（登录态）即可
- `runtime\`、`cache\` 是缓存，删了会自动重建
- `tools\`（4.4 GB）除非重装否则不用动

## 发布到 GitHub

发布仓库是 `repo\`，推送脚本在 `publish\`：

```powershell
$env:NODE_EXTRA_CA_CERTS = 'C:\Users\qq155\.git-ca-bundle.crt'
$env:GH_TOKEN = (gh auth token)
node E:\StudyBuddy\publish\push.mjs        # 有变更才提交
node E:\StudyBuddy\publish\forcepush.mjs   # 强制覆盖（首推空仓库用）
```

> 本机便携版 `git.exe` 在 `repo\` 下 `git init` 会报 `Permission denied`（连 `GIT_TEMPLATE_DIR` 都绕不过），
> 所以改用 **isomorphic-git**（纯 JS 实现）。

## 发版本 & 发补丁

小改动不用重发完整包，发几十 KB 的补丁就行：

```powershell
cd E:\StudyBuddy
# ① 先把 app\package.json 的 version 改大，然后重新打包
node tools\pack-full.mjs
# ② 生成补丁（用上一版留档的清单 + 这次的新包）
node tools\make-patch.mjs diff --old-manifest E:\StudyBuddy-Release\manifest-0.6.0.json --new-zip E:\StudyBuddy-Release\study-buddy.zip
```

用户把补丁包解压到应用根目录、双击 `应用补丁.cmd` 即可。
细节（能改哪些文件、版本/占用/回滚怎么把关）见 `tools\补丁说明.md`。

## 常见问题

**Q：应用开着，点桌面图标没反应？**
A：这是单实例锁（`127.0.0.1:39517`）。看任务栏右下角托盘图标，或关掉已经在跑的窗口。

**Q：课程日志在哪？**
A：`data\course-logs\`，每节课一个 `.md`，文件名是「章节号-章节名」。

**Q：转写模型能不能换小的？**
A：改 `tools\setup-transcribe.ps1` 里的 `-Model`（默认 `large-v3-turbo`）后重跑；小模型更快但错字更多。

**Q：整个文件夹搬走后打不开？**
A：保持内部结构不变即可；唯一要手动重做的是桌面快捷方式（重跑 `create-shortcut.ps1`）。
