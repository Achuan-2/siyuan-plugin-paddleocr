import {cp, lstat, mkdir, readdir, readFile, stat} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(projectDir, "dist");
const defaultPluginsDir = String.raw`D:\Notes\Siyuan\Achuan-2\data\plugins`;
const configuredPluginsDir = process.env.SIYUAN_PLUGIN_DIR || defaultPluginsDir;

if (process.platform !== "win32" && !process.env.SIYUAN_PLUGIN_DIR) {
    throw new Error("请设置 SIYUAN_PLUGIN_DIR 为思源工作空间的 data/plugins 目录");
}

const pluginsDir = resolve(configuredPluginsDir);
const manifest = JSON.parse(await readFile(join(buildDir, "plugin.json"), "utf8"));
if (manifest.name !== "siyuan-plugin-paddleocr") {
    throw new Error("构建产物中的插件名称不正确，已停止复制");
}
if (!(await stat(pluginsDir)).isDirectory()) {
    throw new Error(`思源插件目录不存在：${pluginsDir}`);
}

const targetDir = join(pluginsDir, manifest.name);
try {
    const target = await lstat(targetDir);
    if (!target.isDirectory() || target.isSymbolicLink()) {
        throw new Error(`插件安装目录不是普通目录，已停止复制：${targetDir}`);
    }
} catch (error) {
    if (error.code !== "ENOENT") {
        throw error;
    }
    await mkdir(targetDir);
}

for (const entry of await readdir(buildDir)) {
    await cp(join(buildDir, entry), join(targetDir, entry), {recursive: true, force: true});
}

console.log(`已复制构建产物到 ${targetDir}`);
