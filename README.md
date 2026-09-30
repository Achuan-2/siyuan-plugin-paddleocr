# PaddleOCR 图片识别

使用 PaddleOCR 官方浏览器 SDK 和 PP-OCRv6 ONNX 模型，在思源界面所在设备上识别图片文字。可在插件设置中选择 tiny 或 small（默认 small）；插件包不包含检测或识别模型，用户可在设置中下载。识别过程无需把图片发往第三方服务。

## 准备模型

在插件设置中选择 tiny 或 small 后，检测模型和识别模型分别显示下载按钮或“已下载”状态。tiny 更省空间和算力，small 通常有更好的识别效果。点击“下载模型”后会显示进度条：设备允许直接访问模型地址时显示下载百分比；若需通过思源代理下载，则显示不带百分比的进度条。插件会将两个未压缩的 `.tar` 文件保存到 `data/storage/petal/siyuan-plugin-paddleocr/models/`。两档模型分别保存，切换时会使用各自的模型文件；模型参与思源同步，手机端同步完成后即可使用。也可以从下面的官方地址手动下载，再展开设置中的“手动导入与管理”导入对应模型：

- [PP-OCRv6_tiny 检测模型](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar)
- [PP-OCRv6_tiny 识别模型](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar)
- [PP-OCRv6_small 检测模型](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_det_onnx_infer.tar)
- [PP-OCRv6_small 识别模型](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_rec_onnx_infer.tar)

旧版插件导入到浏览器存储中的 small 模型仍可用于识别；选择 small 后，在原设备的插件设置中展开“手动导入与管理”并点击“迁移旧模型”，即可将它们复制到思源同步目录。small 模型下载会占用约 30 MB 的工作空间和同步空间。

## 使用

通过命令面板打开识别窗口，选择本机图片后自动识别。在思源正文里的普通资源图片上打开图片菜单：桌面端选择 OCR - PaddleOCR，移动端直接选择 PaddleOCR。弹窗左侧显示可编辑的识别文字，右侧显示原图；可在图片上划选多行识别文字，按 Ctrl+C 复制。检查或修改左侧结果后，可选择“保存到思源 OCR”，供搜索使用。识别在 Worker 中运行，WebView 不支持模块 Worker 时回退到本机主线程。加密笔记本图片不提供此入口。

识别窗口可选择“自动”“去除换行符”“原本”三种排版方式。自动排版结合识别文字和图片中的文字框位置，合并连续正文，保留列表、短标签和段落间的换行；“原本”保留识别引擎返回的逐行结果。切换排版时，各选项下的手动修改会分别保留；复制和保存使用当前显示的文字。

设置中的“高级运行设置”默认折叠，修改后自动保存，并在下次识别时生效。可调整检测置信度阈值（默认 0.7）和识别置信度阈值（默认 0.6），取值范围为 0–1；调低可以保留更多不确定文字，调高可以减少误检。默认阈值用于减少截图图标、箭头被误识别成生僻字，模糊、很小的真实文字也可能被过滤。

检测图像最大边长可选择“模型默认”或 640、960、1280、1920 像素，默认沿用模型配置；显式选择边长时，大图会按最长边上限缩小。较小通常更省资源，较大有利于保留小字细节。文字识别批量大小可选 1、4、8、16 行，默认 8；较小更省内存，较大可能加快多行识别。点击“恢复默认”可重置这四项参数。

WASM 线程数由运行环境自动选择。识别完成后会显示总耗时及检测、文字识别各自的耗时；实际速度取决于图片尺寸、文字行数和设备性能。

默认开启“粘贴图片后自动识别”。在编辑器中粘贴新图片并成功上传到普通资源目录后，插件会按自动排版识别并保存 OCR 文字；已有 OCR 文字时跳过。可在插件设置中关闭此功能。插件仅在思源界面打开时处理粘贴，不处理同步、导入或内核后台写入，也不覆盖内核的后台 OCR。移动端的运行速度与内存使用取决于设备 WebView；鸿蒙端仍需真机验证。

## 构建与安装

在本目录执行 `pnpm install`、`pnpm run build`。构建成功后会自动把 `dist` 内容复制到 `D:\Notes\Siyuan\Achuan-2\data\plugins\siyuan-plugin-paddleocr\`，然后在集市插件页面启用。若使用其他工作空间，先将环境变量 `SIYUAN_PLUGIN_DIR` 设为该工作空间的 `data/plugins` 目录；复制脚本会检查目标目录是否存在。`dist` 包含运行代码和 ONNX Runtime Web 的 WASM 文件，不包含 PP-OCRv6 模型。

模型来源：[PaddleOCR 官方 Android ONNX 部署文档](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/cross_platform/android_deployment.html)。运行接口来自 [PaddleOCR.js](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js)。
