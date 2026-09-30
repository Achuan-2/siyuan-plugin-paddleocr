import {lstat, readdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {zipSync} from "fflate";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(projectDir, "dist");
const manifest = JSON.parse(await readFile(join(buildDir, "plugin.json"), "utf8"));
const packageInfo = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
if (manifest.name !== packageInfo.name) {
    throw new Error(`插件名称不一致：dist/plugin.json 为 ${manifest.name}，package.json 为 ${packageInfo.name}，已停止打包`);
}
if (manifest.version !== packageInfo.version) {
    throw new Error(`插件版本不一致：dist/plugin.json 为 ${manifest.version}，package.json 为 ${packageInfo.version}。请同步修改根目录的 plugin.json 和 package.json 后重新构建`);
}

// ZIP 根目录直接放置插件文件，不能包含外层 dist 目录。
const files = {};
async function collectFiles(directory, prefix = "") {
    for (const entry of (await readdir(directory)).sort()) {
        const path = join(directory, entry);
        const info = await lstat(path);
        const zipPath = prefix + entry;
        if (info.isSymbolicLink()) {
            throw new Error(`构建目录不能包含符号链接：${zipPath}`);
        }
        if (info.isDirectory()) {
            await collectFiles(path, `${zipPath}/`);
        } else if (info.isFile()) {
            files[zipPath] = new Uint8Array(await readFile(path));
        } else {
            throw new Error(`构建目录包含不支持的文件：${zipPath}`);
        }
    }
}
await collectFiles(buildDir);

for (const required of ["index.js", "index.css", "plugin.json", "README.md", "icon.png", "preview.png", "ocr-worker.js"]) {
    if (!files[required]?.length) {
        throw new Error(`发布包缺少必要文件：${required}`);
    }
}
if (!Object.keys(files).some(path => path.startsWith("wasm/") && path.endsWith(".wasm")) ||
    !Object.keys(files).some(path => path.startsWith("wasm/") && path.endsWith(".mjs"))) {
    throw new Error("发布包缺少 ONNX Runtime WASM 运行文件");
}

const outputPath = join(projectDir, "package.zip");
await writeFile(outputPath, zipSync(files, {level: 6}));
console.log(`已打包 ${manifest.name} v${manifest.version}：${outputPath}（${Object.keys(files).length} 个文件）`);
