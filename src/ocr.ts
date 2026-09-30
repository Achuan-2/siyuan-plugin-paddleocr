import {PaddleOCR, type OcrResult, type OcrResultItem, type PaddleOCRCreateOptions} from "@paddleocr/paddleocr-js";
import {getModel, modelName, type ModelVariant} from "./modelStore";
import {getPredictOptions, type OCRBackend, type RuntimeSettings} from "./runtimeSettings";

export interface Recognition {
    text: string;
    lines: number;
    elapsedMs: number;
    detectionMs: number;
    recognitionMs: number;
    runtime: OcrResult["runtime"];
    image: OcrResult["image"];
    items: Pick<OcrResultItem, "text" | "poly">[];
}

export class LocalOCR {
    private engine: Awaited<ReturnType<typeof PaddleOCR.create>> | null = null;
    private modelUrls: string[] = [];
    private loading: Promise<void> | null = null;

    constructor(
        private readonly wasmBaseUrl: string,
        private readonly workerUrl: string,
        private variant: ModelVariant,
        private runtimeSettings: RuntimeSettings,
    ) {}

    get isLoaded(): boolean {
        return this.engine !== null;
    }

    async recognize(image: Blob): Promise<Recognition> {
        await this.ensureLoaded();
        const options = getPredictOptions(this.runtimeSettings);
        let results: OcrResult[];
        try {
            results = await this.engine!.predict(image, options);
        } catch (gpuError) {
            const summary = this.engine!.getInitializationSummary();
            if (summary?.detProvider !== "webgpu" && summary?.recProvider !== "webgpu") {
                throw gpuError;
            }
            // 部分 GPU/模型组合创建会话成功，但在首次推理或设备丢失后失败。
            // 整个引擎切到 WASM 后只重试一次，并复用到下次更改设置或重新加载。
            console.warn("WebGPU 识别失败，回退到 WASM", gpuError);
            await this.disposeEngine();
            try {
                this.engine = await this.createEngine("wasm");
                results = await this.engine.predict(image, options);
            } catch (fallbackError) {
                await this.dispose();
                throw new Error(`WebGPU 识别失败：${String(gpuError)}；WASM 回退失败：${String(fallbackError)}`);
            }
        }
        const [result] = results;
        if (!result) {
            throw new Error("识别引擎没有返回结果");
        }
        const items = result.items.map(item => ({text: item.text.trim(), poly: item.poly})).filter(item => item.text);
        return {
            text: items.map(item => item.text).join("\n"),
            lines: items.length,
            elapsedMs: result.metrics.totalMs,
            detectionMs: result.metrics.detMs,
            recognitionMs: result.metrics.recMs,
            runtime: result.runtime,
            image: result.image,
            items,
        };
    }

    async reload(): Promise<void> {
        await this.dispose();
        await this.ensureLoaded();
    }

    async setVariant(variant: ModelVariant): Promise<void> {
        if (this.variant === variant) {
            return;
        }
        await this.dispose();
        this.variant = variant;
    }

    async setRuntimeSettings(settings: RuntimeSettings): Promise<void> {
        // 后端与批量大小在创建引擎时配置，其余参数在每次识别时直接应用。
        if (settings.backend !== this.runtimeSettings.backend ||
            settings.recognitionBatchSize !== this.runtimeSettings.recognitionBatchSize) {
            await this.dispose();
        }
        this.runtimeSettings = {...settings};
    }

    async dispose(): Promise<void> {
        if (this.loading) {
            await this.loading.catch(() => undefined);
        }
        await this.disposeEngine();
        this.modelUrls.forEach(url => URL.revokeObjectURL(url));
        this.modelUrls = [];
    }

    private ensureLoaded(): Promise<void> {
        if (this.engine) {
            return Promise.resolve();
        }
        if (!this.loading) {
            this.loading = this.load().finally(() => {
                this.loading = null;
            });
        }
        return this.loading;
    }

    private async load(): Promise<void> {
        const [det, rec] = await Promise.all([getModel(this.variant, "det"), getModel(this.variant, "rec")]);
        if (!det || !rec) {
            throw new Error("请先导入检测模型和识别模型的 .tar 文件");
        }
        const detUrl = URL.createObjectURL(det);
        const recUrl = URL.createObjectURL(rec);
        this.modelUrls = [detUrl, recUrl];
        try {
            try {
                this.engine = await this.createEngine(this.runtimeSettings.backend);
            } catch (backendError) {
                if (this.runtimeSettings.backend === "wasm") {
                    throw backendError;
                }
                console.warn("WebGPU 初始化失败，回退到 WASM", backendError);
                try {
                    this.engine = await this.createEngine("wasm");
                } catch (fallbackError) {
                    throw new Error(`加速引擎初始化失败：${String(backendError)}；WASM 回退失败：${String(fallbackError)}`);
                }
            }
        } catch (error) {
            this.modelUrls.forEach(url => URL.revokeObjectURL(url));
            this.modelUrls = [];
            throw error;
        }
    }

    private async disposeEngine(): Promise<void> {
        const engine = this.engine;
        this.engine = null;
        if (engine) {
            // GPU 设备丢失后的释放失败不应阻止重新创建 WASM 引擎。
            await engine.dispose().catch(error => console.warn("释放 OCR 引擎失败", error));
        }
    }

    private async createEngine(backend: OCRBackend): Promise<NonNullable<LocalOCR["engine"]>> {
        const [detUrl, recUrl] = this.modelUrls;
        const options: PaddleOCRCreateOptions = {
            // 先取得实例再初始化，以便在初始化失败时释放 Worker 和模型会话。
            initialize: false,
            textDetectionModelName: modelName(this.variant, "det"),
            textRecognitionModelName: modelName(this.variant, "rec"),
            textDetectionModelAsset: {url: detUrl},
            textRecognitionModelAsset: {url: recUrl},
            // SDK 默认每次只识别一行；按宽度排序后批量推理可减少调用次数。
            textRecognitionBatchSize: this.runtimeSettings.recognitionBatchSize,
            ortOptions: {
                backend,
                wasmPaths: this.wasmBaseUrl,
                numThreads: 0,
                simd: true,
            },
        };
        const initialize = async (worker: boolean): Promise<NonNullable<LocalOCR["engine"]>> => {
            const engine = await PaddleOCR.create({
                ...options,
                worker: worker ? {createWorker: () => new Worker(this.workerUrl, {type: "module"})} : false,
            });
            try {
                await engine.initialize();
                return engine;
            } catch (error) {
                await engine.dispose().catch(disposeError => console.warn("释放初始化失败的 OCR 引擎失败", disposeError));
                throw error;
            }
        };
        try {
            return await initialize(true);
        } catch (workerError) {
            // 不支持模块 Worker 或 Worker 中 WebGPU 的 WebView 改在主线程尝试。
            try {
                return await initialize(false);
            } catch (fallbackError) {
                throw new Error(`后台识别失败：${String(workerError)}；主线程识别失败：${String(fallbackError)}`);
            }
        }
    }
}
