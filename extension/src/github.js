export const repos = [
  { name: "legalize-kr", label: "법령", kind: "law", startPath: "kr" },
  { name: "precedent-kr", label: "판례", kind: "precedent" },
  { name: "admrule-kr", label: "행정규칙", kind: "admrule" },
  { name: "ordinance-kr", label: "자치법규", kind: "ordinance" }
];

const cachePrefix = "legalize.viewer.plugins.githubCache:";
const cacheTtlMs = 5 * 60 * 1000;

function repoPath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function githubHeaders(token, accept = "application/vnd.github+json") {
  const requestToken = githubTokenForRequest(token);
  return {
    Accept: accept,
    ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {})
  };
}

export function githubTokenForRequest(token) {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) return "";
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : "";
}

function cacheKey(url, type) {
  return `${cachePrefix}${type}:${url}`;
}

function readCache(url, type) {
  try {
    const raw = globalThis.sessionStorage?.getItem(cacheKey(url, type));
    if (!raw) return undefined;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.savedAt > cacheTtlMs) {
      globalThis.sessionStorage?.removeItem(cacheKey(url, type));
      return undefined;
    }
    return cached.payload;
  } catch {
    return undefined;
  }
}

function writeCache(url, type, payload) {
  try {
    globalThis.sessionStorage?.setItem(cacheKey(url, type), JSON.stringify({ savedAt: Date.now(), payload }));
  } catch {
    // Cache writes are best-effort and must never block document loading.
  }
}

async function cachedJson(url, request, context, token) {
  const accept = request?.headers?.Accept ?? "";
  const cacheType = accept ? `json:${accept}` : "json";
  if (!githubTokenForRequest(token)) {
    const cached = readCache(url.toString(), cacheType);
    if (cached !== undefined) return cached;
    const payload = await checkedJson(await fetch(url, request), context);
    writeCache(url.toString(), cacheType, payload);
    return payload;
  }
  return checkedJson(await fetch(url, request), context);
}

async function cachedText(url, request, context) {
  const cacheUrl = url.toString();
  const cached = readCache(cacheUrl, "text");
  if (cached !== undefined) return cached;
  const payload = await checkedText(await fetch(url, request), context);
  writeCache(cacheUrl, "text", payload);
  return payload;
}

async function checkedJson(response, context) {
  if (response.ok) {
    return response.json();
  }
  if (response.status === 401) {
    throw new Error(`${context}: GitHub 접근 토큰 인증 실패`);
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error(`${context}: GitHub 요청 한도 초과`);
  }
  if (response.status === 404) {
    throw new Error(`${context}: 문서를 찾을 수 없음`);
  }
  throw new Error(`${context}: HTTP ${response.status}`);
}

async function checkedText(response, context) {
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${context}: 문서를 찾을 수 없음`);
    }
    throw new Error(`${context}: HTTP ${response.status}`);
  }
  return response.text();
}

export function rawUrl({ owner, repo, ref, path }) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(
    ref
  )}/${repoPath(path)}`;
}

export function githubBlobUrl({ owner, repo, ref, path }) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(
    ref
  )}/${repoPath(path)}`;
}

async function fetchContentsObject({ owner, repo, path = "", ref, token, context }) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${repoPath(path)}`);
  url.searchParams.set("ref", ref);
  return cachedJson(
    url,
    { headers: githubHeaders(token, "application/vnd.github.object+json") },
    context ?? `${repo} GitHub tree 조회`,
    token
  );
}

function contentEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.entries)) return payload.entries;
  return payload ? [payload] : [];
}

function mapContentEntry(item) {
  return {
    type: item.type === "dir" ? "dir" : "file",
    name: item.name,
    path: item.path,
    sha: item.sha,
    size: item.size,
    htmlUrl: item.html_url,
    downloadUrl: item.download_url
  };
}

function mapTreeEntry({ owner, repo, ref, basePath, item }) {
  const fullPath = basePath ? `${basePath}/${item.path}` : item.path;
  const isDir = item.type === "tree";
  return {
    type: isDir ? "dir" : "file",
    name: item.path.split("/").pop() ?? item.path,
    path: fullPath,
    sha: item.sha,
    size: item.size,
    htmlUrl: isDir ? undefined : githubBlobUrl({ owner, repo, ref, path: fullPath }),
    downloadUrl: isDir ? undefined : rawUrl({ owner, repo, ref, path: fullPath })
  };
}

async function listGithubTreeBySha({ owner, repo, path, ref, token, sha }) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}`);
  const payload = await cachedJson(url, { headers: githubHeaders(token) }, `${repo} GitHub tree fallback 조회`, token);
  if (payload.truncated) {
    throw new Error(`${repo} GitHub tree 조회: 응답이 잘렸습니다.`);
  }
  return (payload.tree ?? [])
    .filter((item) => item.type === "tree" || item.type === "blob")
    .map((item) => mapTreeEntry({ owner, repo, ref, basePath: path, item }));
}

async function resolveDirectoryTreeSha({ owner, repo, path, ref, token }) {
  if (!path) return ref;
  const parts = path.split("/").filter(Boolean);
  const name = parts.at(-1);
  const parentPath = parts.slice(0, -1).join("/");
  const parentPayload = await fetchContentsObject({
    owner,
    repo,
    path: parentPath,
    ref,
    token,
    context: `${repo} GitHub tree parent 조회`
  });
  const entry = contentEntries(parentPayload).find((item) => item.name === name && item.type === "dir");
  return entry?.sha ?? "";
}

export async function listGithubTree({ owner, repo, path = "", ref, token }) {
  const payload = await fetchContentsObject({ owner, repo, path, ref, token });
  const entries = contentEntries(payload).map(mapContentEntry);
  if (entries.length >= 1000) {
    const sha = payload?.sha ?? (await resolveDirectoryTreeSha({ owner, repo, path, ref, token }));
    if (sha) {
      return listGithubTreeBySha({ owner, repo, path, ref, token, sha });
    }
  }
  return entries;
}

export async function fetchGithubMarkdown({ owner, repo, ref, path, token }) {
  if (githubTokenForRequest(token)) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${repoPath(path)}`);
    url.searchParams.set("ref", ref);
    const response = await fetch(url, { headers: githubHeaders(token, "application/vnd.github.raw") });
    return checkedText(response, `${repo} Markdown 조회`);
  }
  return cachedText(rawUrl({ owner, repo, ref, path }), undefined, `${repo} Markdown 조회`);
}

export async function fetchGithubHistory({ owner, repo, path, token, limit = 80, until }) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set("path", path);
  url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 100)));
  if (until) {
    url.searchParams.set("until", until);
  }
  const payload = await cachedJson(url, { headers: githubHeaders(token) }, `${repo} 개정 이력 조회`, token);
  return payload.map((item) => ({
    sha: item.sha,
    shortSha: item.sha.slice(0, 10),
    date: item.commit?.author?.date ?? item.commit?.committer?.date ?? "",
    author: item.commit?.author?.name ?? item.commit?.committer?.name ?? "",
    message: (item.commit?.message ?? item.sha).split("\n")[0],
    messageBody: item.commit?.message ?? item.sha,
    htmlUrl: item.html_url
  }));
}

export function localBridgeRawUrl({ bridgeUrl, repo, path, ref }) {
  const url = new URL(`${bridgeUrl.replace(/\/+$/, "")}/api/raw`);
  url.searchParams.set("repo", repo);
  url.searchParams.set("path", path);
  url.searchParams.set("ref", ref);
  return url.toString();
}

export function localBridgeCommitsUrl({ bridgeUrl, repo, path, limit = 80, until }) {
  const url = new URL(`${bridgeUrl.replace(/\/+$/, "")}/api/commits`);
  url.searchParams.set("repo", repo);
  url.searchParams.set("path", path);
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
  if (until) {
    url.searchParams.set("until", until);
  }
  return url.toString();
}

export async function fetchLocalBridgeMarkdown({ bridgeUrl, repo, path, ref }) {
  return checkedText(await fetch(localBridgeRawUrl({ bridgeUrl, repo, path, ref })), `${repo} Local Bridge Markdown 조회`);
}

export async function fetchLocalBridgeHistory({ bridgeUrl, repo, path, limit = 80, until }) {
  const response = await fetch(localBridgeCommitsUrl({ bridgeUrl, repo, path, limit, until }));
  return checkedJson(response, `${repo} Local Bridge history 조회`);
}
