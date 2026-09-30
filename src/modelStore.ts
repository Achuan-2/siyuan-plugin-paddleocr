export type ModelKind = "det" | "rec";
export type DownloadProgress =
    | {stage: "downloading"; loaded: number; total: number | null}
    | {stage: "proxy"}
    | {stage: "saving"};

const MODEL_DIRECTORY = "data/storage/petal/siyuan-plugin-paddleocr/models";
const MODEL_NAMES: Record<ModelKind, string> = {
    det: "PP-OCRv6_small_det_onnx_infer.tar",
    rec: "PP-OCRv6_small_rec_onnx_infer.tar",
};
const MODEL_URL_BASE = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/";
const DATABASE_NAME = "siyuan-plugin-paddleocr-models";
const STORE_NAME = "archives";

interface FileResponse {
    code: number;
    msg: string;
    data?: Array<{name: string; isDir: boolean}>;
}

async function post(path: string, body: object | FormData): Promise<FileResponse> {
    const response = await fetch(path, {
        method: "POST",
        body: body instanceof FormData ? body : JSON.stringify(body),
        headers: body instanceof FormData ? undefined : {"Content-Type": "application/json"},
        credentials: "same-origin",
    });
    if (!response.ok) {
        throw new Error(`内核请求失败：HTTP ${response.status}`);
    }
    return response.json();
}

function modelPath(kind: ModelKind): string {
    return `${MODEL_DIRECTORY}/${MODEL_NAMES[kind]}`;
}

export async function listModels(): Promise<Record<ModelKind, boolean>> {
    const response = await post("/api/file/readDir", {path: MODEL_DIRECTORY});
    if (response.code === 404) {
        return {det: false, rec: false};
    }
    if (response.code !== 0) {
        throw new Error(response.msg || "读取模型目录失败");
    }
    const names = new Set(response.data?.filter(entry => !entry.isDir).map(entry => entry.name));
    return {det: names.has(MODEL_NAMES.det), rec: names.has(MODEL_NAMES.rec)};
}

export async function getModel(kind: ModelKind): Promise<Blob | null> {
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        body: JSON.stringify({path: modelPath(kind)}),
        headers: {"Content-Type": "application/json"},
        credentials: "same-origin",
    });
    if (response.headers.get("Content-Type")?.includes("application/json")) {
        const result = await response.json() as FileResponse;
        if (result.code === 404) {
            return getLegacyModel(kind);
        }
        throw new Error(result.msg || "读取同步模型失败");
    }
    if (!response.ok) {
        throw new Error(`读取同步模型失败：HTTP ${response.status}`);
    }
    return response.blob();
}

export async function putModel(kind: ModelKind, file: Blob): Promise<void> {
    const form = new FormData();
    form.append("path", modelPath(kind));
    form.append("isDir", "false");
    form.append("file", file, MODEL_NAMES[kind]);
    const response = await post("/api/file/putFile", form);
    if (response.code !== 0) {
        throw new Error(response.msg || "保存模型失败");
    }
}

async function downloadDirectly(url: string, onProgress: (progress: DownloadProgress) => void): Promise<Blob> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`模型下载失败：HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("Content-Length"));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    onProgress({stage: "downloading", loaded: 0, total});
    if (!response.body) {
        return response.blob();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
        const {done, value} = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({stage: "downloading", loaded, total});
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new Blob([bytes], {type: "application/x-tar"});
}

async function downloadThroughProxy(url: string): Promise<Blob> {
    const response = await fetch("/api/network/forwardProxy", {
        method: "POST",
        body: JSON.stringify({
            url,
            method: "GET",
            timeout: 300000,
            responseEncoding: "base64",
        }),
        headers: {"Content-Type": "application/json"},
        credentials: "same-origin",
    });
    if (!response.ok) {
        throw new Error(`模型下载失败：HTTP ${response.status}`);
    }
    const result = await response.json() as {
        code: number;
        msg: string;
        data?: {status: number; body: string};
    };
    if (result.code !== 0 || result.data?.status !== 200 || !result.data.body) {
        throw new Error(result.msg || `模型下载失败：HTTP ${result.data?.status ?? "未知"}`);
    }
    const binary = atob(result.data.body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    if (bytes.length < 1024 * 1024) {
        throw new Error("下载的模型包不完整");
    }
    return new Blob([bytes], {type: "application/x-tar"});
}

export async function downloadModel(kind: ModelKind, onProgress: (progress: DownloadProgress) => void): Promise<void> {
    const url = `${MODEL_URL_BASE}${MODEL_NAMES[kind]}`;
    let model: Blob;
    try {
        model = await downloadDirectly(url, onProgress);
    } catch (error) {
        // 部分思源 WebView 不允许跨域访问模型地址，交由思源内核代理下载。
        if (!(error instanceof TypeError)) {
            throw error;
        }
        onProgress({stage: "proxy"});
        model = await downloadThroughProxy(url);
    }
    if (model.size < 1024 * 1024) {
        throw new Error("下载的模型包不完整");
    }
    onProgress({stage: "saving"});
    await putModel(kind, model);
}

export async function removeModels(): Promise<void> {
    const existing = await listModels();
    for (const kind of ["det", "rec"] as const) {
        if (existing[kind]) {
            const response = await post("/api/file/removeFile", {path: modelPath(kind)});
            if (response.code !== 0) {
                throw new Error(response.msg || "删除同步模型失败");
            }
        }
    }
    await withStore("readwrite", store => store.clear());
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("无法打开旧模型存储"));
    });
}

function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDatabase().then(db => new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => {
            db.close();
            resolve(request.result);
        };
        transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error("旧模型存储失败"));
        };
    }));
}

export async function getLegacyModel(kind: ModelKind): Promise<Blob | null> {
    const value = await withStore<unknown>("readonly", store => store.get(kind));
    return value instanceof Blob ? value : null;
}

export async function migrateLegacyModels(): Promise<boolean> {
    const existing = await listModels();
    const kinds = (["det", "rec"] as const).filter(kind => !existing[kind]);
    if (kinds.length === 0) {
        return false;
    }
    const legacy = await Promise.all(kinds.map(getLegacyModel));
    if (legacy.some(model => !model)) {
        return false;
    }
    for (let index = 0; index < kinds.length; index++) {
        await putModel(kinds[index], legacy[index]!);
    }
    return true;
}
