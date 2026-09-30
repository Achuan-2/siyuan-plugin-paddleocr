import {Dialog, getFrontend, Plugin, Setting, showMessage, type IAssetUploadResult, type IEventBusMap} from "siyuan";
import {assetPathFromImage, getAssetOCR, saveAssetOCR} from "./api";
import {downloadModel, getLegacyModel, listModels, migrateLegacyModels, putModel, removeModels, type DownloadProgress} from "./modelStore";
import {LocalOCR, type Recognition} from "./ocr";
import "./style.css";

const SETTINGS_FILE = "settings.json";
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|bmp|gif)$/i;

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
    private autoPasteOCR = true;
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
        this.ocr = new LocalOCR(wasmBaseUrl, workerUrl);
        const stored = await this.loadData(SETTINGS_FILE).catch(() => null);
        if (stored && typeof stored === "object" && typeof stored.autoPasteOCR === "boolean") {
            this.autoPasteOCR = stored.autoPasteOCR;
        }
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
            const stored = await listModels();
            if (stored.det && stored.rec) {
                this.modelsReady = true;
                return;
            }
            const [det, rec] = await Promise.all([getLegacyModel("det"), getLegacyModel("rec")]);
            this.modelsReady = Boolean((stored.det || det) && (stored.rec || rec));
        } catch {
            this.modelsReady = false;
        }
    }

    private configureSetting(): void {
        this.setting = new Setting({width: `${Math.min(window.innerWidth - 24, 680)}px`});
        this.setting.addItem({
            title: "PP-OCRv6_small ONNX 模型",
            direction: "row",
            description: "模型保存到 data/storage/petal/siyuan-plugin-paddleocr/models，通过思源同步到其他设备。",
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
                    try {
                        const response = await this.saveData(SETTINGS_FILE, {autoPasteOCR: toggle.checked});
                        if (response?.code !== 0) {
                            throw new Error(response?.msg || "内核未保存设置");
                        }
                        this.autoPasteOCR = toggle.checked;
                    } catch (error) {
                        toggle.checked = this.autoPasteOCR;
                        showMessage(`保存设置失败：${errorMessage(error)}`);
                    }
                });
                return toggle;
            },
        });
    }

    private createModelSetting(): HTMLElement {
        const root = document.createElement("div");
        root.className = "paddleocr-models";
        root.innerHTML = `<div class="paddleocr-model-row" data-model="det">
                <div class="paddleocr-model-row__main"><span>检测模型</span><button class="b3-button b3-button--outline" data-action="download-det" disabled>下载模型</button><span class="paddleocr-model-row__state" data-role="state-det" hidden></span></div>
                <small>PP-OCRv6_small_det</small>
                <div class="paddleocr-model-row__progress" data-role="progress-det" hidden><progress max="100"></progress><span aria-live="polite"></span></div>
            </div>
            <div class="paddleocr-model-row" data-model="rec">
                <div class="paddleocr-model-row__main"><span>识别模型</span><button class="b3-button b3-button--outline" data-action="download-rec" disabled>下载模型</button><span class="paddleocr-model-row__state" data-role="state-rec" hidden></span></div>
                <small>PP-OCRv6_small_rec</small>
                <div class="paddleocr-model-row__progress" data-role="progress-rec" hidden><progress max="100"></progress><span aria-live="polite"></span></div>
            </div>
            <label>检测模型 .tar<input class="b3-text-field fn__block" data-role="det" type="file" accept=".tar,application/x-tar"></label>
            <label>识别模型 .tar<input class="b3-text-field fn__block" data-role="rec" type="file" accept=".tar,application/x-tar"></label>
            <div class="paddleocr-panel__actions"><button class="b3-button" data-action="import">导入模型</button><button class="b3-button b3-button--outline" data-action="migrate">迁移旧模型</button><button class="b3-button b3-button--outline" data-action="clear">删除同步模型</button></div>
            <p data-role="models-status" aria-live="polite"></p>`;
        const detInput = root.querySelector('[data-role="det"]') as HTMLInputElement;
        const recInput = root.querySelector('[data-role="rec"]') as HTMLInputElement;
        const status = root.querySelector('[data-role="models-status"]') as HTMLElement;
        const importButton = root.querySelector('[data-action="import"]') as HTMLButtonElement;
        const migrateButton = root.querySelector('[data-action="migrate"]') as HTMLButtonElement;
        const clearButton = root.querySelector('[data-action="clear"]') as HTMLButtonElement;
        const actionButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-action]"));
        const downloadButtons = {} as Record<"det" | "rec", HTMLButtonElement>;
        const modelStates = {} as Record<"det" | "rec", HTMLElement>;
        const progressRows = {} as Record<"det" | "rec", HTMLElement>;
        for (const kind of ["det", "rec"] as const) {
            downloadButtons[kind] = root.querySelector(`[data-action="download-${kind}"]`) as HTMLButtonElement;
            modelStates[kind] = root.querySelector(`[data-role="state-${kind}"]`) as HTMLElement;
            progressRows[kind] = root.querySelector(`[data-role="progress-${kind}"]`) as HTMLElement;
        }
        let canMigrate = false;
        const updateStatus = async () => {
            const stored = await listModels();
            const [legacyDet, legacyRec] = stored.det && stored.rec
                ? [null, null]
                : await Promise.all([getLegacyModel("det"), getLegacyModel("rec")]);
            for (const kind of ["det", "rec"] as const) {
                const legacy = kind === "det" ? legacyDet : legacyRec;
                const available = stored[kind] || Boolean(legacy);
                downloadButtons[kind].hidden = available;
                downloadButtons[kind].disabled = available;
                modelStates[kind].hidden = !available;
                modelStates[kind].textContent = stored[kind] ? "已下载" : "已下载（旧版存储）";
            }
            this.modelsReady = Boolean((stored.det || legacyDet) && (stored.rec || legacyRec));
            canMigrate = Boolean(legacyDet && legacyRec && (!stored.det || !stored.rec));
            migrateButton.disabled = !canMigrate;
        };
        void updateStatus().catch(error => {
            status.textContent = `读取模型失败：${errorMessage(error)}`;
        });
        const runModelAction = async (message: string, action: () => Promise<void>) => {
            actionButtons.forEach(button => button.disabled = true);
            status.textContent = message;
            try {
                await this.recognitionQueue;
                await action();
                await this.ocr?.dispose();
                await updateStatus();
                status.textContent = "模型已更新";
            } catch (error) {
                await updateStatus().catch(() => this.refreshModelsReady());
                status.textContent = `${message}失败：${errorMessage(error)}`;
            } finally {
                actionButtons.forEach(button => button.disabled = false);
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
                void runModelAction("下载模型", () => downloadModel(kind, showProgress))
                    .finally(() => { progressRow.hidden = true; });
            });
        }
        importButton.addEventListener("click", () => {
            const det = detInput.files?.[0];
            const rec = recInput.files?.[0];
            if (!det || !rec || !det.name.toLowerCase().endsWith(".tar") || !rec.name.toLowerCase().endsWith(".tar")) {
                status.textContent = "请选择检测和识别两个 .tar 模型包";
                return;
            }
            void runModelAction("正在导入模型...", async () => {
                await putModel("det", det);
                await putModel("rec", rec);
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
            if (window.confirm("删除同步模型后，其他设备同步时也会删除模型。确定继续吗？")) {
                void runModelAction("正在删除同步模型...", removeModels);
            }
        });
        return root;
    }

    private recognize(image: Blob): Promise<Recognition> {
        const task = this.recognitionQueue.then(() => {
            if (this.unloading || !this.ocr) {
                throw new Error("插件已卸载");
            }
            return this.ocr.recognize(image);
        });
        this.recognitionQueue = task.catch(() => undefined);
        return task;
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
                if (recognition.text && !this.unloading && !(await getAssetOCR(path))) {
                    await saveAssetOCR(path, recognition.text);
                }
            } catch (error) {
                showMessage(`PaddleOCR 粘贴识别失败：${errorMessage(error)}`);
            }
        }
    }

    private openOCRDialog(assetPath?: string): void {
        const dialog = new Dialog({
            title: "PaddleOCR 图片识别",
            width: `${Math.min(window.innerWidth - 24, 680)}px`,
            height: `${Math.min(window.innerHeight - 24, 520)}px`,
            disableAnimation: true,
            content: `<div class="paddleocr-panel">
                ${assetPath ? "" : '<label>选择图片<input class="b3-text-field fn__block" data-role="image" type="file" accept="image/*"></label>'}
                <p data-role="image-status"></p>
                <div class="paddleocr-panel__actions"><button class="b3-button b3-button--outline" data-action="retry" disabled>重新识别</button><button class="b3-button b3-button--outline" data-action="copy" disabled>复制文字</button>${assetPath ? '<button class="b3-button" data-action="save" disabled>保存到思源 OCR</button>' : ""}</div>
                <textarea class="b3-text-field fn__block paddleocr-panel__result" data-role="result" spellcheck="false" placeholder="识别结果可在这里修改后保存"></textarea>
                <p data-role="status" aria-live="polite"></p>
            </div>`,
        });
        const root = dialog.element.querySelector(".paddleocr-panel") as HTMLElement;
        const imageInput = root.querySelector('[data-role="image"]') as HTMLInputElement | null;
        const imageStatus = root.querySelector('[data-role="image-status"]') as HTMLElement;
        const result = root.querySelector('[data-role="result"]') as HTMLTextAreaElement;
        const status = root.querySelector('[data-role="status"]') as HTMLElement;
        const retryButton = root.querySelector('[data-action="retry"]') as HTMLButtonElement;
        const copyButton = root.querySelector('[data-action="copy"]') as HTMLButtonElement;
        const saveButton = root.querySelector('[data-action="save"]') as HTMLButtonElement | null;
        let selectedImage: Blob | null = null;
        let busy = false;
        let recognized = false;

        const runRecognition = async () => {
            if (busy) {
                return;
            }
            busy = true;
            recognized = false;
            retryButton.disabled = true;
            copyButton.disabled = true;
            if (imageInput) {
                imageInput.disabled = true;
            }
            if (saveButton) {
                saveButton.disabled = true;
            }
            result.value = "";
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
                const recognition = await this.recognize(image);
                if (!root.isConnected) {
                    return;
                }
                recognized = true;
                result.value = recognition.text;
                copyButton.disabled = !recognition.text;
                if (saveButton) {
                    saveButton.disabled = !recognition.text;
                }
                status.textContent = `识别完成：${recognition.lines} 行，耗时 ${Math.round(recognition.elapsedMs)} 毫秒`;
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
        result.addEventListener("input", () => {
            copyButton.disabled = !result.value;
            if (saveButton) {
                saveButton.disabled = !recognized || !result.value.trim();
            }
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
