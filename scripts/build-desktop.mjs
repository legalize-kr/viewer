import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "extension");
const target = resolve(root, "dist-desktop");

const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const viewerHtml = await readFile(resolve(source, "viewer.html"), "utf8");
await writeFile(resolve(target, "index.html"), viewerHtml);

console.log(`built ${target}`);
