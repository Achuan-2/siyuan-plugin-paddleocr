import {readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {zipSync} from "fflate";
import {defineConfig} from "vite";
import {viteStaticCopy} from "vite-plugin-static-copy";

const pluginName = JSON.parse(readFileSync(resolve(__dirname, "plugin.json"), "utf8")).name;
let buildWritten = false;

export default defineConfig({
    resolve: {conditions: ["onnxruntime-web-use-extern-wasm"]},
    plugins: [{
        name: "external-paddleocr-worker",
        enforce: "pre",
        transform(source, id) {
            if (!id.split("?")[0].replace(/\\/g, "/").endsWith("/@paddleocr/paddleocr-js/dist/index.mjs")) {
                return;
            }
            // SDK 自带默认 Worker URL；库构建会将其内联，重复打包整套 OCR 依赖。
            // 改用同源文件，与 LocalOCR 显式传入的 Worker 路径保持一致。
            const workerUrl = /new URL\("\.\/assets\/worker-entry-[^"/]+\.js", import\.meta\.url\)/g;
            if (!workerUrl.test(source)) {
                this.error("PaddleOCR SDK 的 Worker 入口发生变化，请检查打包适配后再构建");
            }
            return {
                code: source.replace(workerUrl, `new URL(${JSON.stringify(`/plugins/${pluginName}/ocr-worker.js`)}, globalThis.location.origin)`),
                map: null,
            };
        },
    }, viteStaticCopy({
        targets: [
            {src: "plugin.json", dest: "."},
            {src: "README.md", dest: "."},
            {src: "icon.png", dest: "."},
            {src: "preview.png", dest: "."},
            // 当前主线程入口与 SDK 预构建 Worker 都加载 JSEP 版本。
            // 两者仍使用 WASM 后端；无需同时携带普通、Asyncify 和 JSPI 版本。
            {src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.{mjs,wasm}", dest: "wasm"},
            {src: "node_modules/@paddleocr/paddleocr-js/dist/assets/worker-entry-*.js", dest: ".", rename: "ocr-worker.js"},
        ],
    }), {
        name: "package-plugin",
        apply: "build",
        buildStart() {
            buildWritten = false;
        },
        writeBundle() {
            buildWritten = true;
        },
        closeBundle: {
            order: "post",
            sequential: true,
            handler() {
                if (!buildWritten || this.meta.watchMode) {
                    return;
                }
                // 等静态资源复制完成再打包，确保 Release 上传的是本次构建产物。
                const files: Record<string, Uint8Array> = {};
                const collect = (directory: string, prefix = "") => {
                    for (const entry of readdirSync(directory).sort()) {
                        const path = resolve(directory, entry);
                        if (statSync(path).isDirectory()) {
                            collect(path, `${prefix}${entry}/`);
                        } else {
                            files[`${prefix}${entry}`] = readFileSync(path);
                        }
                    }
                };
                collect(resolve(__dirname, "dist"));
                const archive = zipSync(files, {level: 9});
                writeFileSync(resolve(__dirname, "package.zip"), archive);
                console.log(`已生成 package.zip：${(archive.length / 1024 / 1024).toFixed(2)} MiB`);
            },
        },
    }],
    build: {
        outDir: "dist",
        emptyOutDir: true,
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["cjs"],
            fileName: () => "index.js",
            cssFileName: "index",
        },
        rollupOptions: {
            external: ["siyuan"],
            output: {inlineDynamicImports: true},
        },
    },
});
