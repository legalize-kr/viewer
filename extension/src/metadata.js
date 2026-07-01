const manifestPath = "metadata/index.json";
const cachePrefix = "legalize.viewer.plugins.metadata:";
const memoryCache = new Map();

function packageUrl(path) {
  return globalThis.chrome?.runtime?.getURL
    ? globalThis.chrome.runtime.getURL(path)
    : new URL(`../${path}`, import.meta.url).toString();
}

function readCachedJson(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  try {
    const raw = globalThis.sessionStorage?.getItem(`${cachePrefix}${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCachedJson(key, value) {
  memoryCache.set(key, value);
  try {
    globalThis.sessionStorage?.setItem(`${cachePrefix}${key}`, JSON.stringify(value));
  } catch {
    // Metadata cache is a performance hint only.
  }
}

async function fetchPackagedJson(path) {
  const response = await fetch(packageUrl(path), { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`metadata load failed: HTTP ${response.status}`);
  }
  return response.json();
}

export async function loadMetadataManifest() {
  const cached = readCachedJson("manifest");
  if (cached) return cached;
  const manifest = await fetchPackagedJson(manifestPath);
  writeCachedJson("manifest", manifest);
  return manifest;
}

export async function loadMetadataShard(repo) {
  const key = `shard:${repo}`;
  const cached = readCachedJson(key);
  if (cached) return cached;
  const manifest = await loadMetadataManifest();
  const shard = manifest.shards?.[repo];
  if (!shard?.path) {
    return { repo, documents: [], generatedAt: manifest.generatedAt ?? "", sourceRef: manifest.sourceRef ?? "" };
  }
  const payload = await fetchPackagedJson(shard.path);
  const result = {
    repo,
    generatedAt: manifest.generatedAt ?? "",
    sourceRef: manifest.sourceRef ?? "",
    documents: Array.isArray(payload.documents) ? payload.documents : []
  };
  writeCachedJson(key, result);
  return result;
}

export function filterMetadataDocuments(documents, query, limit = 20) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return documents
    .filter((item) => `${item.title ?? ""} ${item.path ?? ""} ${item.kind ?? ""}`.toLowerCase().includes(needle))
    .slice(0, limit);
}
