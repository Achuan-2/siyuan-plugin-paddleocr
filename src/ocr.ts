import {PaddleOCR, type OcrResult} from "@paddleocr/paddleocr-js";
import {getModel} from "./modelStore";

export interface Recognition {
    text: string;
    lines: number;
    elapsedMs: number;
}

export class LocalOCR {
    private engine: Awaited<ReturnType<typeof PaddleOCR.create>> | null = null;
    private modelUrls: string[] = [];
    private loading: Promise<void> | null = null;

    constructor(private readonly wasmBaseUrl: string, private readonly workerUrl: string) {}

    get isLoaded(): boolean {
        return this.engine !== null;
    }

    async recognize(image: Blob): Promise<Recognition> {
        await this.ensureLoaded();
        const [result] = await this.engine!.predict(image) as OcrResult[];
        if (!result) {
            throw new Error("识别引擎没有返回结果");
        }
        const lines = result.items.map(item => item.text.trim()).filter(Boolean);
        return {
            text: lines.join("\n"),
            lines: lines.length,
            elapsedMs: result.metrics.totalMs,
        };
    }

    async reload(): Promise<void> {
        await this.dispose();
        await this.ensureLoaded();
    }

    async dispose(): Promise<void> {
        if (this.loading) {
            await this.loading.catch(() => undefined);
        }
        if (this.engine) {
            await this.engine.dispose();
            this.engine = null;
        }
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
        const [det, rec] = await Promise.all([getModel("det"), getModel("rec")]);
        if (!det || !rec) {
            throw new Error("请先导入检测模型和识别模型的 .tar 文件");
        }
        const detUrl = URL.createObjectURL(det);
        const recUrl = URL.createObjectURL(rec);
        this.modelUrls = [detUrl, recUrl];
        try {
            const options = {
                textDetectionModelName: "PP-OCRv6_small_det",
                textRecognitionModelName: "PP-OCRv6_small_rec",
                textDetectionModelAsset: {url: detUrl},
                textRecognitionModelAsset: {url: recUrl},
                ortOptions: {
                    backend: "wasm" as const,
                    wasmPaths: this.wasmBaseUrl,
                    numThreads: 1,
                    simd: true,
                },
            };
            try {
                this.engine = await PaddleOCR.create({
                    ...options,
                    worker: {createWorker: () => new Worker(this.workerUrl, {type: "module"})},
                });
            } catch (workerError) {
                // 不支持模块 Worker 的 WebView 仍可在本机执行识别。
                try {
                    this.engine = await PaddleOCR.create(options);
                } catch (fallbackError) {
                    throw new Error(`后台识别失败：${String(workerError)}；本机识别失败：${String(fallbackError)}`);
                }
            }
        } catch (error) {
            this.modelUrls.forEach(url => URL.revokeObjectURL(url));
            this.modelUrls = [];
            throw error;
        }
    }
}
