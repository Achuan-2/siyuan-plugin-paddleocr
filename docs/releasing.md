# 构建与发布

构建与发布沿用 `siyuan-plugin-template` 的插件目录约定：发布包根目录包含 `index.js`、`index.css`、`plugin.json`、`README.md`、`icon.png` 和 `preview.png`。本插件还包含 OCR Worker 和 ONNX Runtime 的 WASM 文件；识别模型由用户另外下载，不包含在发布包中。

## 本地构建

使用 `pnpm install --frozen-lockfile` 安装依赖。`pnpm build` 会生成 `dist/` 和根目录的 `package.zip`，然后沿用原有流程复制到本机思源插件目录。可通过环境变量 `SIYUAN_PLUGIN_DIR` 指定思源工作空间的 `data/plugins` 目录。

`pnpm build:release` 只构建并生成发布包，不复制到思源；`pnpm make_dev_copy` 单独复制已有的 `dist/`。构建前以 `plugin.json` 为准检查版本格式并同步 `package.json`，也可以用 `pnpm sync-version` 单独同步。打包前会检查插件名称、版本、必要资源和 WASM 文件；ZIP 内没有外层 `dist/` 目录。

## GitHub Release

Windows 下在 Git Bash 中执行脚本，也可以在 PowerShell 中运行 `& 'C:\Program Files\Git\bin\bash.exe' ./gh_release.sh --dry-run`。环境需要 Node.js、pnpm、Git；正式发布还需要安装 GitHub CLI，并执行 `gh auth login` 登录。

只需修改 `plugin.json` 的版本号，再执行 `bash gh_release.sh --dry-run`。预检会先同步 `package.json` 的版本，然后运行类型检查、测试和发布构建，允许存在未提交改动，不会推送代码、创建标签或 Release，也不会复制到思源。无效版本会显示具体值并停止，不会改写 `package.json`。

检查 `package.zip` 后，自行提交需要发布的改动（包括同步后的 `package.json`），执行 `bash gh_release.sh`。脚本确认工作区干净、`origin` 与插件仓库地址一致、版本尚未发布后，推送当前分支，并在对应提交上创建 `v版本号` 标签和 Release，上传 `package.zip`。脚本不会自动暂存或提交文件，也不会删除或覆盖已有 Release。

如果添加了 `CHANGELOG.md`，可使用 `## v0.3.0` 或 `## 0.3.0` 这样的版本标题，脚本会提取对应章节作为发布说明；没有当前版本说明时使用 GitHub 自动生成的说明。再次发布需要更新版本号。

## 图片资源

`icon.png` 为 160 × 160 的插件图标，`preview.png` 为 1024 × 576 的集市预览图；两者会复制到 `dist/` 并包含在 `package.zip` 中。预览图是功能示意图。

两张图片均由内置 imagegen 工具生成。图标提示词为“靛蓝背景、白色文档、青色 OCR 扫描角与扫描线、简洁几何风格、无文字”；预览图提示词为“浅色背景、靛蓝与青色配色、图片转文字示意，展示 PaddleOCR 图片识别、本地运行、模型同步和粘贴自动识别”。生成后缩放至上述交付尺寸。
