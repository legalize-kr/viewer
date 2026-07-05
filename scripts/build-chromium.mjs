import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "extension");
const target = resolve(root, "dist-chromium");
const legacyTarget = resolve(root, "dist-extension");

const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}
if (!manifest.permissions?.includes("storage")) {
  throw new Error("storage permission is required");
}

await rm(legacyTarget, { recursive: true, force: true });
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const webStoreManifest = { ...manifest };
delete webStoreManifest.key;
await writeFile(resolve(target, "manifest.json"), `${JSON.stringify(webStoreManifest, null, 2)}\n`);

console.log(`built ${target}`);
