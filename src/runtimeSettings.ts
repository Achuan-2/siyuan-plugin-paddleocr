export const DETECTION_MAX_SIDE_OPTIONS = [0, 640, 960, 1280, 1920] as const;
export const RECOGNITION_BATCH_OPTIONS = [1, 4, 8, 16] as const;

export interface RuntimeSettings {
    detectionThreshold: number;
    recognitionThreshold: number;
    detectionMaxSide: typeof DETECTION_MAX_SIDE_OPTIONS[number];
    recognitionBatchSize: typeof RECOGNITION_BATCH_OPTIONS[number];
}

// 保留插件原来的识别行为；0 表示沿用模型中的检测尺寸配置。
export const DEFAULT_RUNTIME_SETTINGS: Readonly<RuntimeSettings> = {
    detectionThreshold: 0.7,
    recognitionThreshold: 0.6,
    detectionMaxSide: 0,
    recognitionBatchSize: 8,
};

export function normalizeRuntimeSettings(value: unknown): RuntimeSettings {
    const stored = value && typeof value === "object" ? value as Partial<RuntimeSettings> : {};
    const threshold = (value: unknown, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
    return {
        detectionThreshold: threshold(stored.detectionThreshold, DEFAULT_RUNTIME_SETTINGS.detectionThreshold),
        recognitionThreshold: threshold(stored.recognitionThreshold, DEFAULT_RUNTIME_SETTINGS.recognitionThreshold),
        detectionMaxSide: DETECTION_MAX_SIDE_OPTIONS.find(size => size === stored.detectionMaxSide)
            ?? DEFAULT_RUNTIME_SETTINGS.detectionMaxSide,
        recognitionBatchSize: RECOGNITION_BATCH_OPTIONS.find(size => size === stored.recognitionBatchSize)
            ?? DEFAULT_RUNTIME_SETTINGS.recognitionBatchSize,
    };
}

export function getPredictOptions(settings: RuntimeSettings) {
    return {
        textDetBoxThresh: settings.detectionThreshold,
        textRecScoreThresh: settings.recognitionThreshold,
        // 最大边长必须配合 max，避免继承模型的 min 模式而放大小图。
        ...(settings.detectionMaxSide === 0 ? {} : {
            textDetLimitType: "max" as const,
            textDetLimitSideLen: settings.detectionMaxSide,
            textDetMaxSideLimit: settings.detectionMaxSide,
        }),
    };
}
