import {Dialog, getFrontend, Plugin, Setting, showMessage, type IAssetUploadResult, type IEventBusMap} from "siyuan";
import {assetPathFromImage, getAssetOCR, saveAssetOCR} from "./api";
import {downloadModel, getLegacyModel, listModels, migrateLegacyModels, modelName, putModel, removeModels, type DownloadProgress, type ModelVariant} from "./modelStore";
import {LocalOCR, type Recognition} from "./ocr";
import {renderOcrOverlay} from "./ocrOverlay";
import {formatOcrText, type TextLayout} from "./textLayout";
import {DEFAULT_RUNTIME_SETTINGS, DETECTION_MAX_SIDE_OPTIONS, RECOGNITION_BATCH_OPTIONS, normalizeRuntimeSettings, type RuntimeSettings} from "./runtimeSettings";
import "./style.css";

const SETTINGS_FILE = "settings.json";
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|bmp|gif)$/i;

interface PluginSettings {
    autoPasteOCR: boolean;
    modelVariant: ModelVariant;
    runtimeSettings: RuntimeSettings;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === "object" && "msg" in error && typeof error.msg === "string") {
        return error.msg;
    }
    return String(error);
}

function isImageAssetPath(path: string): boolean {
    return path.startsWith("assets/") && !path.split("/").includes("..") && IMAGE_EXTENSIONS.test(path);
}

async function readAssetImage(assetPath: string): Promise<Blob> {
    const response = await fetch(new URL(`/${assetPath}`, location.origin), {credentials: "same-origin"});
    if (!response.ok) {
        throw new Error(`读取思源图片失败：HTTP ${response.status}`);
    }
    return response.blob();
}

function waitForDialogPaint(): Promise<void> {
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            window.setTimeout(resolve, 0);
        });
    });
}

export default class PaddleOCRPlugin extends Plugin {
    private ocr: LocalOCR | null = null;
    private modelsReady = false;
    private modelVariant: ModelVariant = "small";
    private autoPasteOCR = true;
    private runtimeSettings: RuntimeSettings = {...DEFAULT_RUNTIME_SETTINGS};
    private unloading = false;
    private recognitionQueue: Promise<unknown> = Promise.resolve();

    private readonly imageMenuHandler = ({detail}: CustomEvent<IEventBusMap["open-menu-image"]>) => {
        const image = detail.element.matches("img") ? detail.element : detail.element.querySelector("img");
        if (!(image instanceof HTMLImageElement)) {
            return;
        }
        const assetPath = assetPathFromImage(image);
        if (!assetPath) {
            return;
        }
        const menus = window.siyuan.menus;
        if (!menus) {
            return;
        }
        const menu = menus.menu as typeof menus.menu & {remove(): void};
        const isMobile = ["mobile", "browser-mobile"].includes(getFrontend());
        const anchor = isMobile
            ? menu.element.querySelector('.b3-menu__items > [data-id="copyAsPNG"]')
            : menu.element.querySelector('[data-id="ocr"] > .b3-menu__submenu > .b3-menu__items > [data-id="reOCR"]');
        if (!(anchor instanceof HTMLButtonElement)) {
            return;
        }
        const paddleItem = anchor.cloneNode(true) as HTMLButtonElement;
        paddleItem.dataset.id = "paddleOCR";
        paddleItem.querySelector(".b3-menu__accelerator")?.remove();
        const label = paddleItem.querySelector(".b3-menu__label");
        if (!label) {
            return;
        }
        label.textContent = "PaddleOCR";
        paddleItem.addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.openOCRDialog(assetPath);
            menu.remove();
        });
        anchor.after(paddleItem);
    };

    private readonly pasteHandler = ({detail}: CustomEvent<IEventBusMap["before-upload-assets"]>) => {
        if (!this.autoPasteOCR || !this.modelsReady || detail.source !== "paste" ||
            (detail.target !== "editor" && detail.target !== "av-cell")) {
            return;
        }
        detail.onComplete(result => {
            if (this.unloading || (result.status !== "success" && result.status !== "partial")) {
                return;
            }
            void this.recognizePastedAssets(result);
        });
    };

    async onload(): Promise<void> {
        const wasmBaseUrl = new URL(`/plugins/${this.name}/wasm/`, location.origin).href;
        const workerUrl = new URL(`/plugins/${this.name}/ocr-worker.js`, location.origin).href;
        const stored = await this.loadData(SETTINGS_FILE).catch(() => null);
        if (stored && typeof stored === "object" && typeof stored.autoPasteOCR === "boolean") {
            this.autoPasteOCR = stored.autoPasteOCR;
        }
        if (stored && typeof stored === "object" && (stored.modelVariant === "tiny" || stored.modelVariant === "small")) {
            this.modelVariant = stored.modelVariant;
        }
        this.runtimeSettings = normalizeRuntimeSettings(stored?.runtimeSettings);
        this.ocr = new LocalOCR(wasmBaseUrl, workerUrl, this.modelVariant, this.runtimeSettings);
        await this.refreshModelsReady();
        this.configureSetting();
        this.eventBus.on("open-menu-image", this.imageMenuHandler);
        this.eventBus.on("before-upload-assets", this.pasteHandler);
        this.addCommand({
            langKey: "paddleOCR",
            langText: "打开 PaddleOCR 图片识别",
            execute: () => this.openOCRDialog(),
        });
    }

    async onunload(): Promise<void> {
        this.unloading = true;
        this.eventBus.off("open-menu-image", this.imageMenuHandler);
        this.eventBus.off("before-upload-assets", this.pasteHandler);
        await this.recognitionQueue;
        await this.ocr?.dispose();
        this.ocr = null;
    }

    private async refreshModelsReady(): Promise<void> {
        try {
            const stored = await listModels(this.modelVariant);
            if (stored.det && stored.rec) {
                this.modelsReady = true;
                return;
            }
            const [det, rec] = this.modelVariant === "small"
                ? await Promise.all([getLegacyModel("det"), getLegacyModel("rec")])
                : [null, null];
            this.modelsReady = Boolean((stored.det || det) && (stored.rec || rec));
        } catch {
            this.modelsReady = false;
        }
    }

    private configureSetting(): void {
        this.setting = new Setting({width: `${Math.min(window.innerWidth - 24, 680)}px`});
        this.setting.addItem({
            title: "OCR 模型",
            direction: "row",
            description: "选择模型后下载检测和识别文件；模型会通过思源同步。",
            createActionElement: () => this.createModelSetting(),
        });
        this.setting.addItem({
            title: "粘贴图片后自动识别",
            description: "仅处理编辑器中成功上传的普通图片资源；已有 OCR 文字时保留原内容。",
            createActionElement: () => {
                const toggle = document.createElement("input");
                toggle.type = "checkbox";
                toggle.className = "b3-switch";
                toggle.checked = this.autoPasteOCR;
                toggle.addEventListener("change", async () => {
                    toggle.disabled = true;
                    try {
                        await this.queueTask(async () => {
                            await this.saveSettings({autoPasteOCR: toggle.checked});
                            this.autoPasteOCR = toggle.checked;
                        });
                    } catch (error) {
                        toggle.checked = this.autoPasteOCR;
                        showMessage(`保存设置失败：${errorMessage(error)}`);
                    } finally {
                        toggle.disabled = false;
                    }
                });
                return toggle;
            },
        });
    }

    private async saveSettings(changes: Partial<PluginSettings> = {}): Promise<void> {
        const response = await this.saveData(SETTINGS_FILE, {
            autoPasteOCR: this.autoPasteOCR,
            modelVariant: this.modelVariant,
            runtimeSettings: this.runtimeSettings,
            ...changes,
        });
        if (response?.code !== 0) {
            throw new Error(response?.msg || "内核未保存设置");
        }
    }

    private createRuntimeSetting(): HTMLElement {
        const root = document.createElement("details");
        root.className = "paddleocr-runtime-settings";
        root.innerHTML = `<summary>高级运行设置</summary>
            <div class="paddleocr-runtime-settings__fields">
                <label><span>检测置信度阈值<small>调低减少漏检，调高减少误检</small></span><input class="b3-text-field" data-role="detection-threshold" type="number" min="0" max="1" step="0.01" required></label>
                <label><span>识别置信度阈值<small>过滤低置信度的识别文字</small></span><input class="b3-text-field" data-role="recognition-threshold" type="number" min="0" max="1" step="0.01" required></label>
                <label><span>检测图像最大边长<small>较小更省资源，较大保留更多小字细节</small></span><select class="b3-select" data-role="max-side">${DETECTION_MAX_SIDE_OPTIONS.map(size => `<option value="${size}">${size === 0 ? "模型默认" : `${size} px`}</option>`).join("")}</select></label>
                <label><span>文字识别批量大小<small>较小更省内存，较大可能加快多行识别</small></span><select class="b3-select" data-role="batch-size">${RECOGNITION_BATCH_OPTIONS.map(size => `<option value="${size}">${size} 行</option>`).join("")}</select></label>
            </div>
            <div class="paddleocr-runtime-settings__footer"><button class="b3-button b3-button--outline" data-role="reset">恢复默认</button><span data-role="status" aria-live="polite"></span></div>`;
        const detectionThreshold = root.querySelector('[data-role="detection-threshold"]') as HTMLInputElement;
        const recognitionThreshold = root.querySelector('[data-role="recognition-threshold"]') as HTMLInputElement;
        const maxSide = root.querySelector('[data-role="max-side"]') as HTMLSelectElement;
        const batchSize = root.querySelector('[data-role="batch-size"]') as HTMLSelectElement;
        const resetButton = root.querySelector('[data-role="reset"]') as HTMLButtonElement;
        const status = root.querySelector('[data-role="status"]') as HTMLElement;
        const controls = [detectionThreshold, recognitionThreshold, maxSide, batchSize, resetButton];
        const syncValues = () => {
            detectionThreshold.value = String(this.runtimeSettings.detectionThreshold);
            recognitionThreshold.value = String(this.runtimeSettings.recognitionThreshold);
            maxSide.value = String(this.runtimeSettings.detectionMaxSide);
            batchSize.value = String(this.runtimeSettings.recognitionBatchSize);
        };
        const applySettings = async (settings: RuntimeSettings) => {
            controls.forEach(control => control.disabled = true);
            status.textContent = "正在保存…";
            try {
                await this.queueTask(async () => {
                    const previous = this.runtimeSettings;
                    await this.ocr?.setRuntimeSettings(settings);
                    try {
                        await this.saveSettings({runtimeSettings: settings});
                    } catch (error) {
                        await this.ocr?.setRuntimeSettings(previous);
                        throw error;
                    }
                    this.runtimeSettings = settings;
                });
                status.textContent = "已保存，下次识别生效";
            } catch (error) {
                status.textContent = `保存失败：${errorMessage(error)}`;
            } finally {
                syncValues();
                controls.forEach(control => control.disabled = false);
            }
        };
        root.addEventListener("change", () => {
            const invalid = [detectionThreshold, recognitionThreshold].find(input => !input.checkValidity());
            if (invalid) {
                status.textContent = "阈值请输入 0 到 1 之间的数值";
                invalid.reportValidity();
                return;
            }
            void applySettings(normalizeRuntimeSettings({
                detectionThreshold: Number(detectionThreshold.value),
                recognitionThreshold: Number(recognitionThreshold.value),
                detectionMaxSide: Number(maxSide.value),
                recognitionBatchSize: Number(batchSize.value),
            }));
        });
        resetButton.addEventListener("click", () => void applySettings({...DEFAULT_RUNTIME_SETTINGS}));
        syncValues();
        return root;
    }

    private createModelSetting(): HTMLElement {
        const root = document.createElement("div");
        root.className = "paddleocr-models";
        root.innerHTML = `<label class="paddleocr-model-select">模型大小<select class="b3-select" data-role="variant" aria-label="OCR 模型大小"><option value="tiny">tiny（轻量）</option><option value="small">small（默认）</option></select></label>
            <div class="paddleocr-model-row" data-model="det">
                <div class="paddleocr-model-row__main"><span>检测模型</span><button class="b3-button b3-button--outline" data-action="download-det" disabled>下载模型</button><span class="paddleocr-model-row__state" data-role="state-det" hidden></span></div>
                <small data-role="name-det"></small>
                <div class="paddleocr-model-row__progress" data-role="progress-det" hidden><progress max="100"></progress><span aria-live="polite"></span></div>
            </div>
            <div class="paddleocr-model-row" data-model="rec">
                <div class="paddleocr-model-row__main"><span>识别模型</span><button class="b3-button b3-button--outline" data-action="download-rec" disabled>下载模型</button><span class="paddleocr-model-row__state" data-role="state-rec" hidden></span></div>
                <small data-role="name-rec"></small>
                <div class="paddleocr-model-row__progress" data-role="progress-rec" hidden><progress max="100"></progress><span aria-live="polite"></span></div>
            </div>
            <details class="paddleocr-model-manage"><summary>手动导入与管理</summary>
                <label>检测模型 .tar<input class="b3-text-field fn__block" data-role="det" type="file" accept=".tar,application/x-tar"></label>
                <label>识别模型 .tar<input class="b3-text-field fn__block" data-role="rec" type="file" accept=".tar,application/x-tar"></label>
                <div class="paddleocr-panel__actions"><button class="b3-button" data-action="import">导入模型</button><button class="b3-button b3-button--outline" data-action="migrate">迁移旧模型</button><button class="b3-button b3-button--outline" data-action="clear">删除当前模型</button></div>
            </details>
            <p data-role="models-status" aria-live="polite"></p>`;
        const variantSelect = root.querySelector('[data-role="variant"]') as HTMLSelectElement;
        variantSelect.value = this.modelVariant;
        const detInput = root.querySelector('[data-role="det"]') as HTMLInputElement;
        const recInput = root.querySelector('[data-role="rec"]') as HTMLInputElement;
        const status = root.querySelector('[data-role="models-status"]') as HTMLElement;
        root.insertBefore(this.createRuntimeSetting(), status);
        const importButton = root.querySelector('[data-action="import"]') as HTMLButtonElement;
        const migrateButton = root.querySelector('[data-action="migrate"]') as HTMLButtonElement;
        const clearButton = root.querySelector('[data-action="clear"]') as HTMLButtonElement;
        migrateButton.hidden = this.modelVariant !== "small";
        migrateButton.disabled = true;
        const actionButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-action]"));
        const downloadButtons = {} as Record<"det" | "rec", HTMLButtonElement>;
        const modelStates = {} as Record<"det" | "rec", HTMLElement>;
        const modelNames = {} as Record<"det" | "rec", HTMLElement>;
        const progressRows = {} as Record<"det" | "rec", HTMLElement>;
        for (const kind of ["det", "rec"] as const) {
            downloadButtons[kind] = root.querySelector(`[data-action="download-${kind}"]`) as HTMLButtonElement;
            modelStates[kind] = root.querySelector(`[data-role="state-${kind}"]`) as HTMLElement;
            modelNames[kind] = root.querySelector(`[data-role="name-${kind}"]`) as HTMLElement;
            progressRows[kind] = root.querySelector(`[data-role="progress-${kind}"]`) as HTMLElement;
        }
        let canMigrate = false;
        const updateStatus = async () => {
            const variant = this.modelVariant;
            const stored = await listModels(variant);
            const [legacyDet, legacyRec] = variant !== "small" || (stored.det && stored.rec)
                ? [null, null]
                : await Promise.all([getLegacyModel("det"), getLegacyModel("rec")]);
            if (variant !== this.modelVariant) {
                return;
            }
            for (const kind of ["det", "rec"] as const) {
                modelNames[kind].textContent = modelName(variant, kind);
                const legacy = kind === "det" ? legacyDet : legacyRec;
                const available = stored[kind] || Boolean(legacy);
                downloadButtons[kind].hidden = available;
                downloadButtons[kind].disabled = available;
                modelStates[kind].hidden = !available;
                modelStates[kind].textContent = stored[kind] ? "已下载" : "已下载（旧版存储）";
            }
            this.modelsReady = Boolean((stored.det || legacyDet) && (stored.rec || legacyRec));
            canMigrate = variant === "small" && Boolean(legacyDet && legacyRec && (!stored.det || !stored.rec));
            migrateButton.hidden = variant !== "small";
            migrateButton.disabled = !canMigrate;
        };
        void updateStatus().catch(error => {
            status.textContent = `读取模型失败：${errorMessage(error)}`;
        });
        variantSelect.addEventListener("change", async () => {
            const variant = variantSelect.value as ModelVariant;
            variantSelect.disabled = true;
            actionButtons.forEach(button => button.disabled = true);
            const switchTask = this.queueTask(async () => {
                const previous = this.modelVariant;
                await this.ocr?.setVariant(variant);
                try {
                    await this.saveSettings({modelVariant: variant});
                } catch (error) {
                    await this.ocr?.setVariant(previous);
                    throw error;
                }
                this.modelVariant = variant;
                this.modelsReady = false;
                await updateStatus();
            });
            try {
                await switchTask;
                status.textContent = "";
            } catch (error) {
                variantSelect.value = this.modelVariant;
                status.textContent = `切换模型失败：${errorMessage(error)}`;
            } finally {
                variantSelect.disabled = false;
                for (const kind of ["det", "rec"] as const) {
                    downloadButtons[kind].disabled = downloadButtons[kind].hidden;
                }
                migrateButton.disabled = !canMigrate;
                importButton.disabled = false;
                clearButton.disabled = false;
            }
        });
        const runModelAction = async (message: string, action: () => Promise<void>) => {
            actionButtons.forEach(button => button.disabled = true);
            variantSelect.disabled = true;
            status.textContent = message;
            try {
                await this.queueTask(async () => {
                    await action();
                    await this.ocr?.dispose();
                    await updateStatus();
                });
                status.textContent = "模型已更新";
            } catch (error) {
                await updateStatus().catch(() => this.refreshModelsReady());
                status.textContent = `${message}失败：${errorMessage(error)}`;
            } finally {
                actionButtons.forEach(button => button.disabled = false);
                variantSelect.disabled = false;
                for (const kind of ["det", "rec"] as const) {
                    downloadButtons[kind].disabled = downloadButtons[kind].hidden;
                }
                migrateButton.disabled = !canMigrate;
            }
        };
        for (const kind of ["det", "rec"] as const) {
            downloadButtons[kind].addEventListener("click", () => {
                const progressRow = progressRows[kind];
                const progressBar = progressRow.querySelector("progress") as HTMLProgressElement;
                const progressText = progressRow.querySelector("span") as HTMLElement;
                progressRow.hidden = false;
                progressBar.removeAttribute("value");
                progressText.textContent = "正在连接模型下载地址...";
                const showProgress = (progress: DownloadProgress) => {
                    if (progress.stage === "downloading") {
                        if (progress.total) {
                            const percent = Math.min(100, Math.round(progress.loaded / progress.total * 100));
                            progressBar.value = percent;
                            progressText.textContent = `下载中 ${percent}%`;
                        } else {
                            progressBar.removeAttribute("value");
                            progressText.textContent = `下载中 ${(progress.loaded / 1024 / 1024).toFixed(1)} MB`;
                        }
                    } else if (progress.stage === "proxy") {
                        progressBar.removeAttribute("value");
                        progressText.textContent = "正在通过思源下载，暂无法获取百分比...";
                    } else {
                        progressBar.value = 100;
                        progressText.textContent = "下载完成，正在保存模型...";
                    }
                };
                void runModelAction("下载模型", () => downloadModel(this.modelVariant, kind, showProgress))
                    .finally(() => { progressRow.hidden = true; });
            });
        }
        importButton.addEventListener("click", () => {
            const det = detInput.files?.[0];
            const rec = recInput.files?.[0];
            if (!det || !rec ||
                det.name !== `${modelName(this.modelVariant, "det")}_onnx_infer.tar` ||
                rec.name !== `${modelName(this.modelVariant, "rec")}_onnx_infer.tar`) {
                status.textContent = `请选择 ${this.modelVariant} 对应的检测和识别 .tar 模型包`;
                return;
            }
            void runModelAction("正在导入模型...", async () => {
                await putModel(this.modelVariant, "det", det);
                await putModel(this.modelVariant, "rec", rec);
            });
        });
        migrateButton.addEventListener("click", () => {
            void runModelAction("正在迁移旧模型...", async () => {
                if (!await migrateLegacyModels()) {
                    throw new Error("旧版浏览器存储中没有完整的模型包");
                }
            });
        });
        clearButton.addEventListener("click", () => {
            if (window.confirm(`删除 ${this.modelVariant} 同步模型后，其他设备同步时也会删除。确定继续吗？`)) {
                void runModelAction("正在删除同步模型...", () => removeModels(this.modelVariant));
            }
        });
        return root;
    }

    private queueTask<T>(action: () => Promise<T>): Promise<T> {
        const task = this.recognitionQueue.then(action);
        this.recognitionQueue = task.catch(() => undefined);
        return task;
    }

    private recognize(image: Blob): Promise<Recognition> {
        return this.queueTask(() => {
            if (this.unloading || !this.ocr) {
                throw new Error("插件已卸载");
            }
            return this.ocr.recognize(image);
        });
    }

    private async recognizePastedAssets(result: IAssetUploadResult): Promise<void> {
        const successfulPaths = result.succFiles?.map(file => file.path) ?? Object.values(result.succMap ?? {});
        const paths = new Set(successfulPaths.filter(isImageAssetPath));
        for (const path of paths) {
            if (this.unloading || !this.modelsReady || !this.autoPasteOCR) {
                return;
            }
            try {
                if (await getAssetOCR(path)) {
                    continue;
                }
                const image = await readAssetImage(path);
                const recognition = await this.recognize(image);
                const text = formatOcrText(recognition, "auto");
                if (text && !this.unloading && !(await getAssetOCR(path))) {
                    await saveAssetOCR(path, text);
                }
            } catch (error) {
                showMessage(`PaddleOCR 粘贴识别失败：${errorMessage(error)}`);
            }
        }
    }

    private openOCRDialog(assetPath?: string): void {
        let previewUrl: string | null = null;
        let stopOverlay: () => void = () => undefined;
        let removeCopyHandlers: () => void = () => undefined;
        const dialog = new Dialog({
            title: "PaddleOCR 图片识别",
            width: `${Math.min(window.innerWidth - 24, 1100)}px`,
            height: `${Math.min(window.innerHeight - 24, 720)}px`,
            disableAnimation: true,
            destroyCallback: () => {
                stopOverlay();
                removeCopyHandlers();
                if (previewUrl) {
                    URL.revokeObjectURL(previewUrl);
                }
            },
            content: `<div class="paddleocr-panel">
                <div class="paddleocr-panel__toolbar">
                    ${assetPath ? "" : '<label>选择图片<input class="b3-text-field" data-role="image" type="file" accept="image/*"></label>'}
                    <label class="paddleocr-panel__layout">排版<select class="b3-select" data-role="layout" aria-label="排版方式"><option value="auto">自动</option><option value="removeNewlines">去除换行符</option><option value="original">原本</option></select></label>
                    <div class="paddleocr-panel__actions"><button class="b3-button b3-button--outline" data-action="retry" disabled>重新识别</button><button class="b3-button b3-button--outline" data-action="copy" disabled>复制文字</button>${assetPath ? '<button class="b3-button" data-action="save" disabled>保存到思源 OCR</button>' : ""}</div>
                </div>
                <div class="paddleocr-panel__workspace">
                    <div class="paddleocr-panel__text"><textarea class="paddleocr-panel__result" data-role="result" spellcheck="false" aria-label="识别文字，可编辑" placeholder="识别结果可在这里修改后保存"></textarea></div>
                    <div class="paddleocr-panel__preview"><span data-role="preview-empty">选择图片后在这里预览</span><div class="paddleocr-panel__image" data-role="preview-image" hidden><img alt="待识别图片" draggable="false"><div class="paddleocr-panel__ocr-layer" data-role="ocr-layer" tabindex="-1"></div></div></div>
                </div>
                <div class="paddleocr-panel__footer"><span data-role="image-status"></span><span data-role="status" aria-live="polite"></span></div>
            </div>`,
        });
        const root = dialog.element.querySelector(".paddleocr-panel") as HTMLElement;
        const imageInput = root.querySelector('[data-role="image"]') as HTMLInputElement | null;
        const layoutSelect = root.querySelector('[data-role="layout"]') as HTMLSelectElement;
        const imageStatus = root.querySelector('[data-role="image-status"]') as HTMLElement;
        const result = root.querySelector('[data-role="result"]') as HTMLTextAreaElement;
        const status = root.querySelector('[data-role="status"]') as HTMLElement;
        const previewEmpty = root.querySelector('[data-role="preview-empty"]') as HTMLElement;
        const previewStage = root.querySelector('[data-role="preview-image"]') as HTMLElement;
        const previewImage = previewStage.querySelector("img") as HTMLImageElement;
        const ocrLayer = root.querySelector('[data-role="ocr-layer"]') as HTMLElement;
        const retryButton = root.querySelector('[data-action="retry"]') as HTMLButtonElement;
        const copyButton = root.querySelector('[data-action="copy"]') as HTMLButtonElement;
        const saveButton = root.querySelector('[data-action="save"]') as HTMLButtonElement | null;
        let selectedImage: Blob | null = null;
        let busy = false;
        let recognized = false;
        let currentRecognition: Recognition | null = null;
        let currentLayout: TextLayout = "auto";
        let drafts: Partial<Record<TextLayout, string>> = {};

        ocrLayer.addEventListener("pointerdown", () => ocrLayer.focus({preventScroll: true}));

        const selectedImageText = (target: EventTarget | null): string => {
            if (target instanceof HTMLElement &&
                (target.closest("textarea, input, [contenteditable]") || target.isContentEditable)) {
                return "";
            }
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                return "";
            }
            const range = selection.getRangeAt(0);
            if (!ocrLayer.contains(range.startContainer) || !ocrLayer.contains(range.endContainer)) {
                return "";
            }
            const selectedLines = Array.from(range.cloneContents().querySelectorAll<HTMLElement>(".paddleocr-panel__ocr-line"))
                .map(line => line.textContent ?? "")
                .filter(Boolean);
            return selectedLines.length > 1 ? selectedLines.join("\n") : selection.toString();
        };
        const onCopyShortcut = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c" &&
                selectedImageText(event.target)) {
                event.stopImmediatePropagation();
            }
        };
        const onImageCopy = (event: ClipboardEvent) => {
            const text = selectedImageText(event.target);
            if (!text || !event.clipboardData) {
                return;
            }
            event.clipboardData.setData("text/plain", text);
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        window.addEventListener("keydown", onCopyShortcut, true);
        window.addEventListener("copy", onImageCopy, true);
        removeCopyHandlers = () => {
            window.removeEventListener("keydown", onCopyShortcut, true);
            window.removeEventListener("copy", onImageCopy, true);
        };

        const updateTextActions = () => {
            copyButton.disabled = !result.value;
            if (saveButton) {
                saveButton.disabled = busy || !recognized || !result.value.trim();
            }
        };

        previewImage.addEventListener("load", () => {
            previewStage.style.width = `${previewImage.naturalWidth}px`;
        });

        const showPreview = (image: Blob) => {
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
            previewUrl = URL.createObjectURL(image);
            previewImage.src = previewUrl;
            previewStage.hidden = false;
            previewEmpty.hidden = true;
        };

        const runRecognition = async () => {
            if (busy) {
                return;
            }
            busy = true;
            recognized = false;
            currentRecognition = null;
            drafts = {};
            retryButton.disabled = true;
            copyButton.disabled = true;
            if (imageInput) {
                imageInput.disabled = true;
            }
            if (saveButton) {
                saveButton.disabled = true;
            }
            result.value = "";
            stopOverlay();
            ocrLayer.replaceChildren();
            status.textContent = this.ocr?.isLoaded
                ? "正在识别..."
                : "正在识别，首次加载模型可能需要较长时间...";
            try {
                await waitForDialogPaint();
                if (!root.isConnected) {
                    return;
                }
                const image = selectedImage ?? (assetPath ? await readAssetImage(assetPath) : null);
                if (!image) {
                    throw new Error("请先选择图片");
                }
                showPreview(image);
                const recognition = await this.recognize(image);
                if (!root.isConnected) {
                    return;
                }
                recognized = true;
                currentRecognition = recognition;
                result.value = formatOcrText(recognition, currentLayout);
                stopOverlay = renderOcrOverlay(ocrLayer, recognition);
                updateTextActions();
                status.textContent = `识别完成：${recognition.lines} 行，耗时 ${Math.round(recognition.elapsedMs)} 毫秒（检测 ${Math.round(recognition.detectionMs)}，文字识别 ${Math.round(recognition.recognitionMs)}）。可在图片上划选多行，按 Ctrl+C 复制`;
            } catch (error) {
                if (root.isConnected) {
                    status.textContent = `识别失败：${errorMessage(error)}。模型可在插件设置中导入。`;
                }
            } finally {
                busy = false;
                if (root.isConnected) {
                    retryButton.disabled = false;
                    if (imageInput) {
                        imageInput.disabled = false;
                    }
                    updateTextActions();
                }
            }
        };

        imageStatus.textContent = assetPath ? `思源图片：${assetPath}` : "选择图片后自动识别";
        imageInput?.addEventListener("change", () => {
            selectedImage = imageInput.files?.[0] ?? null;
            imageStatus.textContent = selectedImage instanceof File ? `本机图片：${selectedImage.name}` : "选择图片后自动识别";
            if (selectedImage) {
                void runRecognition();
            }
        });
        layoutSelect.addEventListener("change", () => {
            currentLayout = layoutSelect.value as TextLayout;
            if (currentRecognition) {
                result.value = drafts[currentLayout] ?? formatOcrText(currentRecognition, currentLayout);
                updateTextActions();
            }
        });
        result.addEventListener("input", () => {
            drafts[currentLayout] = result.value;
            updateTextActions();
        });
        retryButton.addEventListener("click", () => void runRecognition());
        copyButton.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(result.value);
                showMessage("OCR 文字已复制");
            } catch (error) {
                status.textContent = `复制失败：${errorMessage(error)}`;
            }
        });
        saveButton?.addEventListener("click", async () => {
            if (!assetPath || busy) {
                return;
            }
            saveButton.disabled = true;
            try {
                await saveAssetOCR(assetPath, result.value);
                status.textContent = "OCR 文字已保存到思源，可用于搜索";
            } catch (error) {
                status.textContent = `保存失败：${errorMessage(error)}`;
            } finally {
                saveButton.disabled = false;
            }
        });
        if (assetPath) {
            void runRecognition();
        }
    }
}
