import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const chromiumManifest = await readJson(resolve(root, "dist-chromium", "manifest.json"));
const firefoxManifest = await readJson(resolve(root, "dist-firefox", "manifest.json"));
const desktopIndex = resolve(root, "dist-desktop", "index.html");
const legacyChromiumTarget = resolve(root, "dist-extension");

assert(chromiumManifest.version === "0.1.2", "Chromium artifact version mismatch");
assert(!chromiumManifest.key, "Chromium artifact must not include the development extension key");
assert(chromiumManifest.manifest_version === 3, "Chromium artifact must be MV3");
assert(chromiumManifest.background?.service_worker === "service-worker.js", "Chromium service worker path mismatch");
assert(chromiumManifest.background?.type === "module", "Chromium service worker must stay module-based");
assert(!chromiumManifest.browser_specific_settings, "Chromium artifact must not include Firefox-specific settings");

assert(firefoxManifest.version === "0.1.2", "Firefox artifact version mismatch");
assert(!firefoxManifest.key, "Firefox artifact must not include the development extension key");
assert(firefoxManifest.background?.scripts?.[0] === "service-worker.js", "Firefox artifact must include background.scripts fallback");
assert(firefoxManifest.background?.service_worker === "service-worker.js", "Firefox service worker path mismatch");
assert(!firefoxManifest.background?.type, "Firefox artifact must not require module service workers");
assert(firefoxManifest.browser_specific_settings?.gecko?.id === "viewer@legalize.kr", "Firefox Gecko ID mismatch");
assert(firefoxManifest.browser_specific_settings?.gecko?.strict_min_version === "121.0", "Firefox minimum version mismatch");

assert(await exists(desktopIndex), "Desktop artifact must expose dist-desktop/index.html");
assert(!(await exists(legacyChromiumTarget)), "Legacy dist-extension artifact must not remain after Chromium build");

console.log("legalize-kr-viewer artifacts verified");
