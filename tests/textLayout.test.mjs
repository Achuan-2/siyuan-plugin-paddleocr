import assert from "node:assert/strict";
import {test} from "node:test";
import {formatOcrText} from "../src/textLayout.ts";

function item(text, left, top, right, bottom) {
    return {text, poly: [[left, top], [right, top], [right, bottom], [left, bottom]]};
}

function recognition(items) {
    return {
        text: items.map(entry => entry.text).join("\n"),
        lines: items.length,
        elapsedMs: 0,
        image: {width: 300, height: 300},
        items,
    };
}

test("自动排版保留截图中的短标签和列表换行", () => {
    const result = recognition([
        item("文档", 20, 0, 60, 20),
        item("置顶", 20, 27, 60, 47),
        item("个人主控台Console", 20, 54, 180, 74),
        item("研究生", 20, 81, 80, 101),
        item("专业精进Area", 20, 108, 150, 128),
    ]);
    assert.equal(formatOcrText(result, "auto"), result.text);
});

test("自动排版合并连续正文，按图片中的大行距分段", () => {
    const result = recognition([
        item("这是一段需要自动合并的中文正文第一行", 10, 0, 210, 20),
        item("这一行紧接着前面的内容并继续说明情况", 10, 24, 210, 44),
        item("这一段的最后一行。", 10, 48, 130, 68),
        item("另一段文字从这里重新开始并且较长", 10, 100, 210, 120),
    ]);
    assert.equal(formatOcrText(result, "auto"),
        "这是一段需要自动合并的中文正文第一行这一行紧接着前面的内容并继续说明情况这一段的最后一行。\n另一段文字从这里重新开始并且较长");
});

test("两行短段落也能按连续正文合并", () => {
    const result = recognition([
        item("第一行文字较长，需要接着下一行阅读", 10, 0, 210, 20),
        item("第二行是段落结尾。", 10, 24, 130, 44),
    ]);
    assert.equal(formatOcrText(result, "auto"), "第一行文字较长，需要接着下一行阅读第二行是段落结尾。");
});

test("自动排版不合并新列表项", () => {
    const result = recognition([
        item("1. 第一条内容比较长并且占满当前行", 10, 0, 210, 20),
        item("2. 第二条内容也比较长并且占满当前行", 10, 24, 210, 44),
    ]);
    assert.equal(formatOcrText(result, "auto"), result.text);
});

test("同一视觉行的片段可合并，原本模式保留 OCR 行", () => {
    const result = recognition([
        item("Hello", 10, 0, 60, 20),
        item("world", 65, 0, 120, 20),
    ]);
    assert.equal(formatOcrText(result, "auto"), "Hello world");
    assert.equal(formatOcrText(result, "original"), "Hello\nworld");
});

test("去除换行符保留英文词间空格", () => {
    const result = recognition([
        item("第一行", 0, 0, 60, 20),
        item("第二行", 0, 24, 60, 44),
        item("Hello", 0, 48, 60, 68),
        item("world", 0, 72, 60, 92),
    ]);
    assert.equal(formatOcrText(result, "removeNewlines"), "第一行第二行Hello world");
});
