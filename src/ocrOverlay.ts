import type {Recognition} from "./ocr";

export function renderOcrOverlay(layer: HTMLElement, recognition: Recognition): () => void {
    layer.replaceChildren();
    const {width, height} = recognition.image;
    if (width <= 0 || height <= 0) {
        return () => undefined;
    }

    const boxes: Array<{element: HTMLSpanElement; width: number; height: number; text: string}> = [];
    for (const item of recognition.items) {
        if (!item.poly.length || item.poly.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
            continue;
        }
        const left = Math.max(0, Math.min(...item.poly.map(point => point[0])));
        const top = Math.max(0, Math.min(...item.poly.map(point => point[1])));
        const right = Math.min(width, Math.max(...item.poly.map(point => point[0])));
        const bottom = Math.min(height, Math.max(...item.poly.map(point => point[1])));
        if (right <= left || bottom <= top) {
            continue;
        }

        const element = document.createElement("span");
        element.className = "paddleocr-panel__ocr-line";
        element.textContent = item.text;
        element.title = "拖选文字后按 Ctrl+C 复制";
        element.style.left = `${left / width * 100}%`;
        element.style.top = `${top / height * 100}%`;
        element.style.width = `${(right - left) / width * 100}%`;
        element.style.height = `${(bottom - top) / height * 100}%`;
        layer.append(element);
        boxes.push({element, width: right - left, height: bottom - top, text: item.text});
    }

    const measure = document.createElement("canvas").getContext("2d");
    const resize = () => {
        const scale = layer.clientWidth / width;
        for (const box of boxes) {
            const fontSize = box.height * scale * 0.9;
            if (measure) {
                measure.font = `${fontSize}px sans-serif`;
            }
            const textWidth = measure?.measureText(box.text).width || 0;
            box.element.style.fontSize = `${textWidth > box.width * scale ? fontSize * box.width * scale / textWidth : fontSize}px`;
        }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    resize();
    return () => observer.disconnect();
}
