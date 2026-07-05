import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "extension");
const target = resolve(root, "dist-firefox");

const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}
if (!manifest.permissions?.includes("storage")) {
  throw new Error("storage permission is required");
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const firefoxManifest = {
  ...manifest,
  background: {
    scripts: [manifest.background.service_worker],
    service_worker: manifest.background.service_worker
  },
  browser_specific_settings: {
    gecko: {
      id: "viewer@legalize.kr",
      strict_min_version: "121.0"
    }
  }
};
delete firefoxManifest.key;
delete firefoxManifest.background.type;

await writeFile(resolve(target, "manifest.json"), `${JSON.stringify(firefoxManifest, null, 2)}\n`);

console.log(`built ${target}`);
