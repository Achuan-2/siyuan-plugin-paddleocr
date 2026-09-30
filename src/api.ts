import {fetchPost} from "siyuan";

interface APIResponse {
    code: number;
    msg: string;
    data?: {text?: string};
}

function post(path: string, body: object): Promise<APIResponse> {
    return new Promise(resolve => fetchPost(path, body, resolve));
}

export async function saveAssetOCR(path: string, text: string): Promise<void> {
    const response = await post("/api/asset/setImageOCRText", {path, text});
    if (response.code !== 0) {
        throw new Error(response.msg || "保存 OCR 文字失败");
    }
    const readback = await post("/api/asset/getImageOCRText", {path});
    if (readback.code !== 0 || readback.data?.text !== text) {
        throw new Error("内核没有保存此图片的 OCR 文字；请检查资源是否属于加密笔记本");
    }
}

export async function getAssetOCR(path: string): Promise<string> {
    const response = await post("/api/asset/getImageOCRText", {path});
    if (response.code !== 0) {
        throw new Error(response.msg || "读取 OCR 文字失败");
    }
    return response.data?.text ?? "";
}

export function assetPathFromImage(image: HTMLImageElement): string | null {
    const source = image.dataset.src || image.getAttribute("src") || "";
    try {
        const url = new URL(source, location.origin);
        if (url.origin !== location.origin) {
            return null;
        }
        if (url.searchParams.has("box")) {
            return null;
        }
        const path = decodeURI(url.pathname).replace(/^\//, "");
        return path.startsWith("assets/") ? path : null;
    } catch {
        return null;
    }
}
