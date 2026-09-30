import assert from "node:assert/strict";
import {test} from "node:test";
import {DEFAULT_RUNTIME_SETTINGS, getPredictOptions, normalizeRuntimeSettings} from "../src/runtimeSettings.ts";

test("旧设置或无效运行配置沿用原来的识别默认值", () => {
    assert.deepEqual(normalizeRuntimeSettings(undefined), DEFAULT_RUNTIME_SETTINGS);
    assert.deepEqual(normalizeRuntimeSettings({
        detectionThreshold: NaN,
        recognitionThreshold: 1.1,
        detectionMaxSide: 800,
        recognitionBatchSize: 0,
    }), DEFAULT_RUNTIME_SETTINGS);
});

test("阈值接受 0 和 1，部分配置保留其余默认值", () => {
    assert.deepEqual(normalizeRuntimeSettings({detectionThreshold: 0, recognitionThreshold: 1}), {
        ...DEFAULT_RUNTIME_SETTINGS,
        detectionThreshold: 0,
        recognitionThreshold: 1,
    });
});

test("模型默认模式不覆盖模型中的检测尺寸配置", () => {
    assert.deepEqual(getPredictOptions({...DEFAULT_RUNTIME_SETTINGS}), {
        textDetBoxThresh: 0.7,
        textRecScoreThresh: 0.6,
    });
});

test("显式最大边长采用 max 模式并传入用户阈值", () => {
    const settings = normalizeRuntimeSettings({
        detectionThreshold: 0.45,
        recognitionThreshold: 0.8,
        detectionMaxSide: 1280,
        recognitionBatchSize: 4,
    });
    assert.equal(settings.recognitionBatchSize, 4);
    assert.deepEqual(getPredictOptions(settings), {
        textDetBoxThresh: 0.45,
        textRecScoreThresh: 0.8,
        textDetLimitType: "max",
        textDetLimitSideLen: 1280,
        textDetMaxSideLimit: 1280,
    });
});
