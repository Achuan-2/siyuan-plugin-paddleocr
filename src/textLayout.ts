import type {Recognition} from "./ocr";

export type TextLayout = "auto" | "removeNewlines" | "original";

interface TextRow {
    text: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    valid: boolean;
}

function appendInline(left: string, right: string): string {
    const needsSpace = /[A-Za-z0-9,.;:!?)]$/.test(left) && /^[A-Za-z0-9]/.test(right);
    return `${left}${needsSpace ? " " : ""}${right}`;
}

function median(values: number[]): number {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function makeRows(items: Recognition["items"]): TextRow[] {
    const rows: TextRow[] = [];
    for (const item of items) {
        const points = item.poly;
        const valid = points.length > 0 && points.every(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
        const row: TextRow = valid ? {
            text: item.text,
            left: Math.min(...points.map(point => point[0])),
            right: Math.max(...points.map(point => point[0])),
            top: Math.min(...points.map(point => point[1])),
            bottom: Math.max(...points.map(point => point[1])),
            valid: true,
        } : {text: item.text, left: 0, right: 0, top: 0, bottom: 0, valid: false};
        const previous = rows.at(-1);
        if (previous?.valid && row.valid) {
            const height = Math.min(previous.bottom - previous.top, row.bottom - row.top);
            const overlap = Math.min(previous.bottom, row.bottom) - Math.max(previous.top, row.top);
            const horizontalGap = row.left - previous.right;
            if (height > 0 && overlap >= height * 0.5 &&
                horizontalGap >= -height * 0.5 && horizontalGap <= height * 2) {
                previous.text = appendInline(previous.text, row.text);
                previous.right = Math.max(previous.right, row.right);
                previous.top = Math.min(previous.top, row.top);
                previous.bottom = Math.max(previous.bottom, row.bottom);
                continue;
            }
        }
        rows.push(row);
    }
    return rows;
}

function startsListItem(text: string): boolean {
    return /^(?:[•●◦▪▫■□☐☑✓✔▶►>›→-]|\d{1,3}[.、)）]|[（(]\d{1,3}[)）])\s*/u.test(text);
}

function shouldJoinParagraph(previous: TextRow, next: TextRow, blockRight: number, blockWidth: number, typicalHeight: number): boolean {
    if (!previous.valid || !next.valid || startsListItem(next.text)) {
        return false;
    }
    const gap = next.top - previous.bottom;
    if (gap < -typicalHeight * 0.3 || gap > typicalHeight * 0.8) {
        return false;
    }
    const leftShift = Math.abs(next.left - previous.left);
    const firstLineIndent = previous.left > next.left && leftShift <= typicalHeight * 2.5;
    if (leftShift > typicalHeight * 1.25 && !firstLineIndent) {
        return false;
    }
    if (previous.right < blockRight - typicalHeight * 1.5 ||
        previous.right - previous.left < blockWidth * 0.6 || previous.text.length < 8) {
        return false;
    }
    if (/[。！？!?：:]$/u.test(previous.text) && leftShift > typicalHeight * 0.5) {
        return false;
    }
    return true;
}

export function formatOcrText(recognition: Recognition, layout: TextLayout): string {
    if (layout === "original") {
        return recognition.text;
    }
    if (layout === "removeNewlines") {
        return recognition.items.reduce((text, item) => text ? appendInline(text, item.text) : item.text, "");
    }

    const rows = makeRows(recognition.items);
    if (rows.length === 0) {
        return "";
    }
    const validRows = rows.filter(row => row.valid);
    if (validRows.length < 2) {
        return rows.map(row => row.text).join("\n");
    }
    const blockRight = Math.max(...validRows.map(row => row.right));
    const blockLeft = Math.min(...validRows.map(row => row.left));
    const blockWidth = blockRight - blockLeft;
    const typicalHeight = median(validRows.map(row => row.bottom - row.top));
    const longRows = validRows.filter(row => row.text.length >= 12 && row.right - row.left >= blockWidth * 0.7).length;
    const proseLike = (longRows >= 2 && longRows / validRows.length >= 0.4) ||
        (validRows.length <= 3 && longRows >= 1);

    let formatted = rows[0].text;
    for (let index = 1; index < rows.length; index++) {
        const previous = rows[index - 1];
        const current = rows[index];
        formatted = proseLike && shouldJoinParagraph(previous, current, blockRight, blockWidth, typicalHeight)
            ? appendInline(formatted, current.text)
            : `${formatted}\n${current.text}`;
    }
    return formatted;
}
