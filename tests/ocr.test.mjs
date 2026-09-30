import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {createContext, SourceTextModule, SyntheticModule} from "node:vm";
import ts from "typescript";

// 在隔离上下文中运行实际 TS 源码，仅替换模型文件和 SDK，验证回退与缓存行为。
async function setup(behavior = {}) {
    const calls = [];
    const disposed = [];
    const revoked = [];
    const predictions = [];
    let nextUrl = 0;
    const context = createContext({
        console: {warn() {}},
        URL: {
            createObjectURL: () => `blob:model-${nextUrl++}`,
            revokeObjectURL: url => revoked.push(url),
        },
    });
    const compile = async file => {
        const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
        const {outputText} = ts.transpileModule(source, {
            compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
        });
        return new SourceTextModule(outputText, {context});
    };
    const settingsModule = await compile("runtimeSettings");
    await settingsModule.link(() => { throw new Error("Unexpected settings import"); });
    await settingsModule.evaluate();
    const sdkModule = new SyntheticModule(["PaddleOCR"], function () {
        this.setExport("PaddleOCR", {
            async create(options) {
                calls.push(options);
                const provider = options.ortOptions.backend === "wasm" ? "wasm" : (behavior.provider ?? "webgpu");
                return {
                    async initialize() {
                        await behavior.initialize?.(options);
                    },
                    getInitializationSummary: () => ({detProvider: provider, recProvider: provider}),
                    async predict(image, params) {
                        predictions.push({image, params, provider});
                        await behavior.predict?.(options);
                        return [{
                            items: [{text: " 测试文字 ", poly: []}],
                            image: {width: 1920, height: 1080},
                            metrics: {totalMs: 20, detMs: 8, recMs: 12},
                            runtime: {detProvider: provider, recProvider: provider},
                        }];
                    },
                    async dispose() {
                        disposed.push(options);
                        await behavior.dispose?.(options);
                    },
                };
            },
        });
    }, {context});
    const modelModule = new SyntheticModule(["getModel", "modelName"], function () {
        this.setExport("getModel", async () => ({}));
        this.setExport("modelName", (variant, kind) => `PP-OCRv6_${variant}_${kind}`);
    }, {context});
    const ocrModule = await compile("ocr");
    await ocrModule.link(specifier => {
        if (specifier === "@paddleocr/paddleocr-js") return sdkModule;
        if (specifier === "./modelStore") return modelModule;
        if (specifier === "./runtimeSettings") return settingsModule;
        throw new Error(`Unexpected import ${specifier}`);
    });
    await ocrModule.evaluate();
    const settings = settingsModule.namespace;
    const create = overrides => new ocrModule.namespace.LocalOCR(
        "/wasm/", "/worker.js", "small", {...settings.DEFAULT_RUNTIME_SETTINGS, ...overrides},
    );
    return {create, settings, calls, disposed, revoked, predictions};
}

test("默认检测长边 960、自动后端，并保留已有显式设置", async () => {
    const {settings} = await setup();
    const defaults = settings.normalizeRuntimeSettings(null);
    assert.equal(defaults.detectionMaxSide, 960);
    assert.equal(defaults.backend, "auto");
    const params = settings.getPredictOptions(defaults);
    assert.equal(params.textDetLimitType, "max");
    assert.equal(params.textDetLimitSideLen, 960);
    assert.equal(params.textDetMaxSideLimit, 960);
    const saved = settings.normalizeRuntimeSettings({detectionMaxSide: 0, backend: "wasm"});
    assert.equal(saved.detectionMaxSide, 0);
    assert.equal(saved.backend, "wasm");
    assert.equal(settings.normalizeRuntimeSettings({backend: "invalid"}).backend, "auto");
});

test("自动后端保留实际 GPU 信息，连续识别复用引擎", async () => {
    const {create, calls, predictions, revoked} = await setup();
    const ocr = create();
    const result = await ocr.recognize({});
    await ocr.recognize({});
    assert.equal(result.runtime.detProvider, "webgpu");
    assert.equal(result.text, "测试文字");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ortOptions.backend, "auto");
    assert.equal(predictions[0].params.textDetLimitSideLen, 960);
    await ocr.dispose();
    assert.equal(revoked.length, 2);
});

test("WebGPU 初始化失败后释放实例并回退 WASM", async () => {
    const {create, calls, disposed} = await setup({
        initialize(options) {
            if (options.ortOptions.backend === "webgpu") throw new Error("GPU unavailable");
        },
    });
    const ocr = create({backend: "webgpu"});
    const result = await ocr.recognize({});
    assert.equal(result.runtime.detProvider, "wasm");
    assert.deepEqual(calls.map(call => call.ortOptions.backend), ["webgpu", "webgpu", "wasm"]);
    assert.equal(disposed.length, 2);
    await ocr.dispose();
});

test("Worker 初始化失败后仍可在主线程使用 WebGPU", async () => {
    const {create, calls, disposed} = await setup({
        initialize(options) {
            if (options.worker) throw new Error("Worker unavailable");
        },
    });
    const ocr = create();
    const result = await ocr.recognize({});
    assert.equal(result.runtime.recProvider, "webgpu");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].worker, false);
    assert.equal(disposed.length, 1);
    await ocr.dispose();
});

test("GPU 推理及释放失败后仅回退一次，后续复用 WASM", async () => {
    const {create, calls, predictions} = await setup({
        predict(options) {
            if (options.ortOptions.backend !== "wasm") throw new Error("GPU device lost");
        },
        dispose(options) {
            if (options.ortOptions.backend !== "wasm") throw new Error("GPU release failed");
        },
    });
    const ocr = create();
    const result = await ocr.recognize({});
    await ocr.recognize({});
    assert.equal(result.runtime.detProvider, "wasm");
    assert.equal(calls.length, 2);
    assert.deepEqual(predictions.map(call => call.provider), ["webgpu", "wasm", "wasm"]);
    await ocr.dispose();
});

test("WASM 推理失败直接报告，不重复创建引擎", async () => {
    const failure = new Error("Invalid image");
    const {create, calls} = await setup({provider: "wasm", predict() { throw failure; }});
    const ocr = create();
    await assert.rejects(ocr.recognize({}), error => error === failure);
    assert.equal(calls.length, 1);
    await ocr.dispose();
});

test("GPU 与 WASM 都失败时报告两次错误并释放模型文件", async () => {
    const {create, calls, revoked} = await setup({
        predict() { throw new Error("GPU inference failed"); },
        initialize(options) {
            if (options.ortOptions.backend === "wasm") throw new Error("WASM init failed");
        },
    });
    const ocr = create();
    await assert.rejects(ocr.recognize({}), /GPU inference failed.*WASM init failed/);
    assert.equal(calls.length, 3);
    assert.equal(ocr.isLoaded, false);
    assert.equal(revoked.length, 2);
    await ocr.dispose();
    assert.equal(revoked.length, 2);
});

test("更改后端重新创建引擎，更改长边直接应用且不重新加载", async () => {
    const {create, settings, calls, predictions, disposed} = await setup();
    const ocr = create();
    await ocr.recognize({});
    await ocr.setRuntimeSettings({...settings.DEFAULT_RUNTIME_SETTINGS, detectionMaxSide: 1280});
    await ocr.recognize({});
    assert.equal(calls.length, 1);
    assert.equal(predictions[1].params.textDetLimitSideLen, 1280);
    await ocr.setRuntimeSettings({...settings.DEFAULT_RUNTIME_SETTINGS, backend: "wasm"});
    assert.equal(ocr.isLoaded, false);
    assert.equal(disposed.length, 1);
    await ocr.recognize({});
    assert.equal(calls.length, 2);
    assert.equal(calls[1].ortOptions.backend, "wasm");
    await ocr.dispose();
});
