import {resolve} from "node:path";
import {defineConfig} from "vite";
import {viteStaticCopy} from "vite-plugin-static-copy";

export default defineConfig({
    resolve: {conditions: ["onnxruntime-web-use-extern-wasm"]},
    plugins: [viteStaticCopy({
        targets: [
            {src: "plugin.json", dest: "."},
            {src: "README.md", dest: "."},
            {src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{mjs,wasm}", dest: "wasm"},
            {src: "node_modules/@paddleocr/paddleocr-js/dist/assets/worker-entry-*.js", dest: ".", rename: "ocr-worker.js"},
        ],
    })],
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
