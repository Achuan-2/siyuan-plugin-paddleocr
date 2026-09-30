import {readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const numericPart = "(?:0|[1-9]\\d*)";
const prereleasePart = `(?:${numericPart}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(`^${numericPart}\\.${numericPart}\\.${numericPart}(?:-${prereleasePart}(?:\\.${prereleasePart})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

// plugin.json 是发布版本的来源，package.json 只同步版本，不修改其他字段。
export async function syncVersion(directory = projectDir) {
    const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
    const packagePath = join(directory, "package.json");
    const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
    if (manifest.name !== packageInfo.name) {
        throw new Error(`插件名称不一致：plugin.json 为 ${manifest.name}，package.json 为 ${packageInfo.name}`);
    }
    if (typeof manifest.version !== "string" || !versionPattern.test(manifest.version)) {
        throw new Error(`plugin.json 版本格式无效：${JSON.stringify(manifest.version)}，请使用 0.1.0 或 0.1.0-beta.1 等格式`);
    }
    if (manifest.version !== packageInfo.version) {
        const previousVersion = packageInfo.version;
        packageInfo.version = manifest.version;
        await writeFile(packagePath, JSON.stringify(packageInfo, null, 2) + "\n");
        console.log(`已同步 package.json 版本：${previousVersion} → ${manifest.version}`);
    }
    return manifest.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await syncVersion();
    } catch (error) {
        console.error(`版本检查失败：${error.message}`);
        process.exitCode = 1;
    }
}
