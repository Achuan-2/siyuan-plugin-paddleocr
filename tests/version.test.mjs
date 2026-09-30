import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {syncVersion} from "../scripts/sync-version.mjs";

async function fixture(t, plugin, packageInfo) {
    const prefix = join(tmpdir(), "paddleocr-version-");
    const directory = await mkdtemp(prefix);
    t.after(async () => {
        assert.ok(directory.startsWith(prefix));
        await rm(directory, {recursive: true, force: true});
    });
    await writeFile(join(directory, "plugin.json"), JSON.stringify(plugin));
    await writeFile(join(directory, "package.json"), JSON.stringify(packageInfo));
    return directory;
}

test("保留用户在 plugin.json 设置的版本，同步 package.json 并保留其他字段", async t => {
    const manifest = {name: "siyuan-plugin-paddleocr", version: "0.1.0"};
    const packageInfo = {...manifest, version: "0.3.0", scripts: {test: "node --test"}, private: true};
    const directory = await fixture(t, manifest, packageInfo);
    assert.equal(await syncVersion(directory), "0.1.0");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "package.json"), "utf8")), {...packageInfo, version: "0.1.0"});
    assert.deepEqual(JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")), manifest);
});

test("无效版本提供具体报错，不改写 package.json", async t => {
    for (const version of ["0..0", "01.0.0", "0.1.0-beta..1", "0.1.0-01", 1]) {
        const directory = await fixture(t, {name: "plugin", version}, {name: "plugin", version: "0.3.0"});
        const before = await readFile(join(directory, "package.json"), "utf8");
        await assert.rejects(syncVersion(directory), /plugin\.json 版本格式无效/);
        assert.equal(await readFile(join(directory, "package.json"), "utf8"), before);
    }
});

test("名称不一致时停止同步，不改写 package.json", async t => {
    const directory = await fixture(t, {name: "plugin-a", version: "0.1.0"}, {name: "plugin-b", version: "0.3.0"});
    const before = await readFile(join(directory, "package.json"), "utf8");
    await assert.rejects(syncVersion(directory), /plugin-a.*plugin-b/);
    assert.equal(await readFile(join(directory, "package.json"), "utf8"), before);
});

test("支持预发布和构建元数据，已一致时不重写文件", async t => {
    const manifest = {name: "plugin", version: "0.1.0-beta.1+build.2"};
    const directory = await fixture(t, manifest, manifest);
    const before = await readFile(join(directory, "package.json"), "utf8");
    assert.equal(await syncVersion(directory), manifest.version);
    assert.equal(await readFile(join(directory, "package.json"), "utf8"), before);
});
