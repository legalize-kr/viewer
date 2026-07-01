import { buildDiffRows, renderDiff } from "./diff.js";
import {
  fetchGithubHistory,
  fetchGithubMarkdown,
  fetchLocalBridgeHistory,
  fetchLocalBridgeMarkdown,
  githubBlobUrl,
  listGithubTree,
  rawUrl,
  repos
} from "./github.js";
import {
  escapeHtml,
  extractAttachments,
  extractReferences,
  extractToc,
  renderAttachmentList,
  renderMarkdown,
  splitFrontmatter
} from "./markdown.js";
import { filterMetadataDocuments, loadMetadataShard } from "./metadata.js";
import {
  clearToken,
  loadSettings,
  loadToken,
  normalizeFontSize,
  normalizeTheme,
  saveSettings,
  saveToken
} from "./storage.js";

const $ = (id) => document.getElementById(id);
const panelWidthKey = "legalize.viewer.plugins.panelWidths";
const defaultPanelWidths = { left: 320, right: 280 };
const panelWidthBounds = { min: 220, max: 520 };
const treeSectionThreshold = 500;
const timelineMaxItemsPerRow = 10;
const treeSectionOrder = ["#", "ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅅ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const koreanInitialSections = ["ㄱ", "ㄱ", "ㄴ", "ㄷ", "ㄷ", "ㄹ", "ㅁ", "ㅂ", "ㅂ", "ㅅ", "ㅅ", "ㅇ", "ㅈ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const themeOrder = ["light", "dark", "system"];
const themeIcons = { light: "#icon-theme-light", dark: "#icon-theme-dark", system: "#icon-theme-system" };
const themeLabels = { light: "밝게 보기", dark: "어둡게 보기", system: "시스템 설정" };
const themeActionLabels = { light: "밝게 보기로", dark: "어둡게 보기로", system: "시스템 설정으로" };
let pdfjsModulePromise = null;
let rhwpModulePromise = null;

const state = {
  settings: null,
  token: "",
  repo: repos[0],
  path: "",
  treeEntries: [],
  expandedTreePaths: new Set(),
  expandedTreeEntries: new Map(),
  expandedTreeErrors: new Map(),
  expandedTreeSections: new Set(),
  metadataDocsByRepo: new Map(),
  metadataLoadingRepo: "",
  metadataErrors: new Map(),
  localFiles: [],
  localFileMap: new Map(),
  document: null,
  history: [],
  selectedCommits: [],
  expandedHistorySha: "",
  favoriteIds: loadFavorites(),
  recentDocs: loadRecentDocs(),
  panelWidths: loadPanelWidths(),
  attachmentPreviewFile: null
};

function loadFavorites() {
  try {
    const saved = localStorage.getItem("legalize.viewer.plugins.favorites");
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem("legalize.viewer.plugins.favorites", JSON.stringify([...new Set(state.favoriteIds)]));
}

function loadRecentDocs() {
  try {
    const saved = localStorage.getItem("legalize.viewer.plugins.recentDocs");
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item?.repo && item?.path).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function saveRecentDocs() {
  localStorage.setItem("legalize.viewer.plugins.recentDocs", JSON.stringify(state.recentDocs.slice(0, 12)));
}

function loadPanelWidths() {
  try {
    const saved = localStorage.getItem(panelWidthKey);
    const parsed = saved ? JSON.parse(saved) : {};
    return {
      left: clampPanelWidth(parsed.left ?? defaultPanelWidths.left, defaultPanelWidths.left),
      right: clampPanelWidth(parsed.right ?? defaultPanelWidths.right, defaultPanelWidths.right)
    };
  } catch {
    return { ...defaultPanelWidths };
  }
}

function savePanelWidths() {
  localStorage.setItem(panelWidthKey, JSON.stringify(state.panelWidths));
}

function clampPanelWidth(value, fallback = defaultPanelWidths.left) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(panelWidthBounds.max, Math.max(panelWidthBounds.min, Math.round(parsed)));
}

function documentId(repo, path) {
  return `${repo}:${path}`;
}

function setStatus(message, isError = false) {
  $("sourceStatus").textContent = message;
  $("sourceStatus").classList.toggle("error", isError);
}

function selectedRepoName() {
  return state.repo.name;
}

function repoStartPath(repo = state.repo) {
  return repo.startPath ?? "";
}

function isRepoStartPath(path = state.path) {
  return path === repoStartPath();
}

function sourceLabel() {
  if (state.settings.sourceMode === "local-bridge") return "로컬 Git 연결";
  if (state.settings.sourceMode === "local-folder") return "로컬 폴더";
  return "GitHub";
}

function isGithubRateLimitError(message = "") {
  return message.includes("GitHub 요청 한도 초과");
}

function renderRateLimitHelpButton() {
  return '<button class="ghost-button rate-limit-help-button" type="button" data-rate-limit-help>해결방법</button>';
}

function renderErrorLine(message) {
  const text = escapeHtml(message);
  return `<div class="state-line error${isGithubRateLimitError(message) ? " with-action" : ""}"><span>${text}</span>${
    isGithubRateLimitError(message) ? renderRateLimitHelpButton() : ""
  }</div>`;
}

function showRateLimitHelp() {
  const dialog = $("rateLimitHelpDialog");
  if (!dialog.open) dialog.showModal();
}

function openTokenSettings() {
  $("rateLimitHelpDialog").close();
  applySettingsToForm();
  $("sourceMode").value = "github";
  applySettingsVisibility();
  activatePanelTab("settings", "settingsSourceTab");
  $("settingsDialog").showModal();
  requestAnimationFrame(() => $("githubToken").focus());
}

function applyRuntimeBadge() {
  const runtime = globalThis.chrome?.runtime;
  const manifest = runtime?.getManifest ? runtime.getManifest() : null;
  const version = manifest?.version_name ?? manifest?.version ?? "web";
  const id = runtime?.id ?? "web-preview";
  $("runtimeBadge").textContent = runtime?.id ? `v${version} · ${id.slice(0, 8)}` : "web preview";
  $("runtimeBadge").title = runtime?.id
    ? `Extension ID: ${id}`
    : "Chrome extension context가 아닌 미리보기입니다.";
}

function effectiveTheme(theme) {
  const normalized = normalizeTheme(theme);
  if (normalized !== "system") return normalized;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function nextTheme(theme) {
  const normalized = normalizeTheme(theme);
  return themeOrder[(themeOrder.indexOf(normalized) + 1) % themeOrder.length];
}

function applyTheme() {
  const preferred = normalizeTheme(state.settings?.theme);
  const effective = effectiveTheme(preferred);
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themePref = preferred;
  document.documentElement.style.colorScheme = effective;
  const next = nextTheme(preferred);
  $("themeToggle").querySelector("use")?.setAttribute("href", themeIcons[preferred]);
  $("themeToggle").title = `테마: ${themeLabels[preferred]} · 클릭하면 ${themeActionLabels[next]} 전환`;
  $("themeToggle").setAttribute("aria-label", `테마: ${themeLabels[preferred]}. 클릭하면 ${themeActionLabels[next]} 전환`);
  $("themeToggle").dataset.themePref = preferred;
  if ($("themeSetting")) $("themeSetting").value = preferred;
}

function updateSettingsPreview() {
  const preview = $("settingsPreview");
  if (!preview) return;
  const theme = normalizeTheme($("themeSetting")?.value ?? state.settings?.theme);
  preview.dataset.theme = effectiveTheme(theme);
  preview.style.setProperty("--preview-content-font-size", `${normalizeFontSize($("fontSizeSetting")?.value ?? state.settings?.fontSize)}px`);
  preview.style.setProperty(
    "--preview-left-panel-font-size",
    `${normalizeFontSize($("leftPanelFontSizeSetting")?.value ?? state.settings?.leftPanelFontSize)}px`
  );
  preview.style.setProperty(
    "--preview-right-panel-font-size",
    `${normalizeFontSize($("rightPanelFontSizeSetting")?.value ?? state.settings?.rightPanelFontSize)}px`
  );
}

function applyFontSize() {
  const fontSize = normalizeFontSize(state.settings?.fontSize);
  const leftPanelFontSize = normalizeFontSize(state.settings?.leftPanelFontSize);
  const rightPanelFontSize = normalizeFontSize(state.settings?.rightPanelFontSize);
  document.documentElement.style.setProperty("--content-font-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--left-panel-font-size", `${leftPanelFontSize}px`);
  document.documentElement.style.setProperty("--right-panel-font-size", `${rightPanelFontSize}px`);
  if ($("fontSizeSetting")) $("fontSizeSetting").value = String(fontSize);
  if ($("fontSizeValue")) $("fontSizeValue").textContent = `${fontSize}px`;
  if ($("leftPanelFontSizeSetting")) $("leftPanelFontSizeSetting").value = String(leftPanelFontSize);
  if ($("leftPanelFontSizeValue")) $("leftPanelFontSizeValue").textContent = `${leftPanelFontSize}px`;
  if ($("rightPanelFontSizeSetting")) $("rightPanelFontSizeSetting").value = String(rightPanelFontSize);
  if ($("rightPanelFontSizeValue")) $("rightPanelFontSizeValue").textContent = `${rightPanelFontSize}px`;
  updateSettingsPreview();
}

function applyPanelWidths() {
  $("layout").style.setProperty("--left-panel-width", `${state.panelWidths.left}px`);
  $("layout").style.setProperty("--right-panel-width", `${state.panelWidths.right}px`);
}

function applySourceStatus() {
  setStatus("", false);
}

function populateRepos() {
  $("repoSelect").innerHTML = repos
    .map((repo) => `<option value="${repo.name}">${repo.label}</option>`)
    .join("");
  $("repoSelect").value = state.repo.name;
}

function applySettingsToForm() {
  $("sourceMode").value = state.settings.sourceMode;
  $("bridgeUrl").value = state.settings.bridgeUrl;
  $("themeSetting").value = normalizeTheme(state.settings.theme);
  applyFontSize();
  $("localFolderPath").value = state.settings.localFolderName ?? "";
  $("githubToken").value = state.token;
  applySettingsVisibility();
  updateSettingsPreview();
}

function applySettingsVisibility() {
  const sourceMode = $("sourceMode").value;
  $("githubTokenField").hidden = sourceMode !== "github";
  $("localBridgeUrlField").hidden = sourceMode !== "local-bridge";
  $("localFolderField").hidden = sourceMode !== "local-folder";
  $("clearTokenButton").hidden = sourceMode !== "github";
  const notes = {
    github: "",
    "local-bridge": "로컬 Git 연결 URL은 이 원문 소스에서만 사용됩니다.",
    "local-folder": "찾아보기로 선택한 폴더의 Markdown 문서를 읽습니다."
  };
  $("settingsNote").textContent = notes[sourceMode] ?? "";
}

async function saveTheme(theme) {
  state.settings = { ...state.settings, theme: normalizeTheme(theme) };
  applyTheme();
  await saveSettings(state.settings);
}

async function saveSettingsFromForm() {
  const currentDocumentPath = state.document?.path;
  state.settings = {
    ...state.settings,
    sourceMode: $("sourceMode").value,
    githubOwner: "legalize-kr",
    githubRef: "main",
    bridgeUrl: $("bridgeUrl").value.trim() || "http://127.0.0.1:8765",
    theme: normalizeTheme($("themeSetting").value),
    fontSize: normalizeFontSize($("fontSizeSetting").value),
    leftPanelFontSize: normalizeFontSize($("leftPanelFontSizeSetting").value),
    rightPanelFontSize: normalizeFontSize($("rightPanelFontSizeSetting").value),
    localFolderName: $("localFolderPath").value.trim()
  };
  if (state.settings.sourceMode === "github") {
    state.token = $("githubToken").value;
  }
  await saveSettings(state.settings);
  await saveToken(state.token);
  applyTheme();
  applyFontSize();
  applySourceStatus();
  $("settingsDialog").close();
  await loadTree(state.path);
  if (currentDocumentPath && state.settings.sourceMode !== "local-folder") {
    await openDocument(currentDocumentPath);
  }
}

async function loadTree(path = repoStartPath()) {
  state.path = path;
  state.expandedTreePaths = new Set();
  state.expandedTreeEntries = new Map();
  state.expandedTreeErrors = new Map();
  state.expandedTreeSections = new Set();
  renderFavorites();
  renderRecentDocs();
  $("tree").innerHTML = '<div class="state-line">목록을 불러오는 중</div>';
  try {
    if (state.settings.sourceMode === "local-folder") {
      renderLocalFiles();
      return;
    }
    const entries = await listGithubTree({
      owner: state.settings.githubOwner,
      repo: selectedRepoName(),
      path,
      ref: state.settings.githubRef,
      token: state.token
    });
    state.treeEntries = sortTreeEntries(navigationEntries(entries));
    renderTree();
  } catch (error) {
    $("tree").innerHTML = renderErrorLine(error.message);
  }
}

function filteredEntries(entries) {
  const visibleEntries = navigationEntries(entries);
  const query = searchQuery();
  if (!query) return visibleEntries;
  return visibleEntries.filter((entry) => `${entry.name} ${entry.path}`.toLowerCase().includes(query));
}

function searchQuery() {
  return $("searchInput").value.trim().toLowerCase();
}

function renderSearchPanel({ treeCount = 0, metadataCount = 0, loadingMetadata = false, metadataError = "" } = {}) {
  const query = searchQuery();
  if (!query) {
    $("searchPanel").classList.add("hidden");
    $("searchSummary").textContent = "";
    return;
  }
  $("searchPanel").classList.remove("hidden");
  $("searchTitle").textContent = `검색: ${query}`;
  const parts = [`현재 경로 ${treeCount}개`];
  if (query.length < 2) {
    parts.push("전체 검색은 2글자 이상 입력");
  } else if (loadingMetadata) {
    parts.push("전체 metadata 검색 중");
  } else {
    parts.push(`전체 metadata ${metadataCount}개`);
  }
  if (metadataError) parts.push(metadataError);
  $("searchSummary").textContent = parts.join(" · ");
  $("searchSummary").classList.toggle("error", Boolean(metadataError));
}

function sortTreeEntries(entries, nested = false) {
  const lawOrder = ["법률.md", "시행령.md", "시행규칙.md"];
  return [...entries].sort((left, right) => {
    if (nested) {
      const leftRank = lawOrder.indexOf(left.name);
      const rightRank = lawOrder.indexOf(right.name);
      if (leftRank !== rightRank) return (leftRank === -1 ? 99 : leftRank) - (rightRank === -1 ? 99 : rightRank);
    }
    if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
    return left.name.localeCompare(right.name, "ko");
  });
}

function isHiddenNavigationEntry(entry) {
  return entry.name === ".gitignore";
}

function navigationEntries(entries) {
  return entries.filter((entry) => !isHiddenNavigationEntry(entry));
}

function isMarkdownEntry(entry) {
  return entry.type === "file" && entry.path.toLowerCase().endsWith(".md");
}

function initialSectionLabel(name) {
  for (const char of name.trim()) {
    if (/[0-9A-Za-z]/.test(char)) return "#";
    const code = char.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) continue;
    return koreanInitialSections[Math.floor((code - 0xac00) / 588)] ?? "#";
  }
  return "#";
}

function sectionTreeEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const label = initialSectionLabel(entry.name);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(entry);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => treeSectionOrder.indexOf(left) - treeSectionOrder.indexOf(right))
    .map(([label, sectionEntries]) => ({ label, entries: sectionEntries }));
}

function treeSectionKey(scope, label) {
  return `${selectedRepoName()}:${scope || "/"}:${label}`;
}

function bindTreeSectionToggles(render) {
  $("tree").querySelectorAll(".tree-section-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sectionKey ?? "";
      if (state.expandedTreeSections.has(key)) {
        state.expandedTreeSections.delete(key);
      } else {
        state.expandedTreeSections.add(key);
      }
      render();
    });
  });
}

function renderTreeEntries(entries, { child = false, scope = state.path, forceExpanded = false } = {}) {
  if (entries.length <= treeSectionThreshold) {
    return entries.map((entry) => renderTreeEntry(entry, child)).join("");
  }
  return `<div class="tree-sections">${sectionTreeEntries(entries)
    .map(({ label, entries: sectionEntries }) => {
      const key = treeSectionKey(scope, label);
      const expanded = forceExpanded || state.expandedTreeSections.has(key);
      return `<section class="tree-section"><button type="button" class="tree-section-toggle" data-section-key="${escapeHtml(
        key
      )}" aria-expanded="${expanded}"><span>${expanded ? "▾" : "▸"}</span><strong>${escapeHtml(label)}</strong><em>${
        sectionEntries.length
      }</em></button>${
        expanded ? `<div class="tree-section-body">${sectionEntries.map((entry) => renderTreeEntry(entry, child)).join("")}</div>` : ""
      }</section>`;
    })
    .join("")}</div>`;
}

function renderTree() {
  const query = searchQuery();
  const entries = filteredEntries(state.treeEntries);
  const metadataMatches = metadataSearchMatches(query);
  const loadingMetadata = query.length >= 2 && state.metadataLoadingRepo === selectedRepoName();
  const metadataError = query.length >= 2 ? state.metadataErrors.get(selectedRepoName()) : "";
  const sections = [];
  renderSearchPanel({ treeCount: entries.length, metadataCount: metadataMatches.length, loadingMetadata, metadataError });
  if (entries.length) {
    sections.push(renderTreeEntries(entries, { scope: state.path, forceExpanded: Boolean(query) }));
  }
  if (metadataMatches.length) {
    sections.push('<div class="state-line metadata-label">metadata 검색 결과</div>');
    sections.push(metadataMatches.map((item) => renderMetadataEntry(item)).join(""));
  } else if (loadingMetadata) {
    sections.push('<div class="state-line">metadata를 불러오는 중</div>');
  } else if (metadataError) {
    sections.push(renderErrorLine(metadataError));
  }
  if (!sections.length) {
    $("tree").innerHTML = '<div class="empty-state small">표시할 항목이 없습니다.</div>';
    return;
  }
  $("tree").innerHTML = sections.join("");
  bindTreeSectionToggles(renderTree);
  $("tree").querySelectorAll(".tree-row").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.action === "directory") {
        openDirectoryEntry(button.dataset.path ?? "").catch((error) => {
          setStatus(error.message, true);
        });
      } else if ((button.dataset.path ?? "").toLowerCase().endsWith(".md")) {
        openDocument(button.dataset.path ?? "");
      }
    });
  });
}

function metadataSearchMatches(query) {
  if (query.length < 2) return [];
  const docs = state.metadataDocsByRepo.get(selectedRepoName()) ?? [];
  const treePaths = new Set(state.treeEntries.map((entry) => entry.path));
  return filterMetadataDocuments(docs, query, 24).filter((item) => !treePaths.has(item.path));
}

function renderMetadataEntry(item) {
  const current = treeEntryIsCurrent({ path: item.path, type: "file" });
  return `<button type="button" class="tree-row file metadata-row${current ? " current" : ""}" data-action="open" data-type="file" data-path="${escapeHtml(
    item.path
  )}" title="${escapeHtml(item.path)}"${current ? ' aria-current="location"' : ""}><span>${escapeHtml(item.kind ?? "MD")}</span><strong>${escapeHtml(
    item.title ?? item.path
  )}</strong></button>`;
}

async function ensureMetadataForCurrentRepo() {
  if (state.settings.sourceMode === "local-folder") return;
  const repo = selectedRepoName();
  if (state.metadataDocsByRepo.has(repo) || state.metadataLoadingRepo === repo) return;
  state.metadataLoadingRepo = repo;
  state.metadataErrors.delete(repo);
  renderTree();
  try {
    const shard = await loadMetadataShard(repo);
    state.metadataDocsByRepo.set(repo, shard.documents);
  } catch (error) {
    state.metadataDocsByRepo.set(repo, []);
    state.metadataErrors.set(repo, error.message);
  } finally {
    if (state.metadataLoadingRepo === repo) {
      state.metadataLoadingRepo = "";
    }
    if (searchQuery()) renderTree();
  }
}

function treeEntryIsCurrent(entry) {
  const current = state.document?.repo === selectedRepoName() ? state.document.path : "";
  if (!current || !entry.path) return false;
  return current === entry.path || (entry.type === "dir" && current.startsWith(`${entry.path}/`));
}

function renderTreeEntry(entry, child = false) {
  const expanded = entry.type === "dir" && state.expandedTreePaths.has(entry.path);
  const current = treeEntryIsCurrent(entry);
  const icon = entry.type === "dir" ? "📁" : entry.kind ?? "MD";
  const action = entry.type === "dir" ? "directory" : "open";
  const aria = entry.type === "dir" ? ` aria-expanded="${expanded}"` : "";
  return `<div class="tree-node${child ? " child-node" : ""}"><button type="button" class="tree-row ${entry.type}${
    child ? " child-row" : ""
  }${expanded ? " inline-dir" : ""}${current ? " current" : ""}" data-action="${action}" data-type="${entry.type}" data-path="${escapeHtml(
    entry.path
  )}" title="${escapeHtml(entry.path)}"${aria}${current ? ' aria-current="location"' : ""}><span>${icon}</span><strong>${escapeHtml(
    entry.name
  )}</strong></button>${expanded ? renderInlineDirectory(entry.path) : ""}</div>`;
}

function renderInlineDirectory(path) {
  const error = state.expandedTreeErrors.get(path);
  if (error) {
    return `<div class="tree-children">${renderErrorLine(error)}</div>`;
  }
  const entries = state.expandedTreeEntries.get(path);
  if (!entries) {
    return '<div class="tree-children"><div class="state-line">내용을 불러오는 중</div></div>';
  }
  return `<div class="tree-children">${
    entries.length
      ? renderTreeEntries(entries, { child: true, scope: path })
      : '<div class="empty-state small">표시할 항목이 없습니다.</div>'
  }</div>`;
}

async function openDirectoryEntry(path) {
  if (!path) return;
  if (state.expandedTreePaths.has(path)) {
    state.expandedTreePaths.delete(path);
    renderTree();
    return;
  }
  if (state.expandedTreeEntries.has(path)) {
    await openDirectoryEntries(path, state.expandedTreeEntries.get(path) ?? []);
    return;
  }
  try {
    const sorted = await fetchDirectoryEntries(path);
    state.expandedTreeEntries.set(path, sorted);
    state.expandedTreeErrors.delete(path);
    await openDirectoryEntries(path, sorted);
  } catch (error) {
    state.expandedTreePaths.add(path);
    state.expandedTreeErrors.set(path, error.message);
    renderTree();
  }
}

async function fetchDirectoryEntries(path) {
  const entries = await listGithubTree({
    owner: state.settings.githubOwner,
    repo: selectedRepoName(),
    path,
    ref: state.settings.githubRef,
    token: state.token
  });
  return sortTreeEntries(navigationEntries(entries), true);
}

async function openDirectoryEntries(path, entries) {
  if (entries.length === 1) {
    await openSingleChildEntry(path, entries[0]);
    return;
  }
  state.expandedTreePaths.add(path);
  renderTree();
}

async function openSingleChildEntry(parentPath, entry) {
  if (isMarkdownEntry(entry)) {
    state.expandedTreePaths.add(parentPath);
    renderTree();
    await openDocument(entry.path);
    return;
  }
  if (entry.type !== "dir") {
    state.expandedTreePaths.add(parentPath);
    renderTree();
    return;
  }
  const entries = state.expandedTreeEntries.get(entry.path) ?? (await fetchDirectoryEntries(entry.path));
  state.expandedTreeEntries.set(entry.path, entries);
  state.expandedTreeErrors.delete(entry.path);
  state.expandedTreePaths.add(parentPath);
  await openDirectoryEntries(entry.path, entries);
}

async function selectRepository(repo, { openReadme = false, query } = {}) {
  state.repo = repo;
  $("repoSelect").value = repo.name;
  if (query !== undefined) $("searchInput").value = query;
  state.path = repoStartPath();
  applySourceStatus();
  await loadTree(state.path);
  if (openReadme && state.settings.sourceMode !== "local-folder") {
    await openDocument("README.md");
  }
}

async function pickLocalFolder() {
  if (typeof showDirectoryPicker !== "function") {
    setStatus("이 Chrome context에서는 File System Access API를 사용할 수 없습니다.", true);
    return;
  }
  const handle = await showDirectoryPicker({ mode: "read" });
  state.localFiles = [];
  state.localFileMap = new Map();
  await scanDirectory(handle, "");
  state.settings.sourceMode = "local-folder";
  state.settings.localFolderName = handle.name;
  await saveSettings(state.settings);
  applySettingsToForm();
  applySourceStatus();
  renderLocalFiles();
}

async function scanDirectory(handle, prefix, count = { value: 0 }) {
  for await (const [name, child] of handle.entries()) {
    if (count.value > 1200) return;
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.kind === "directory") {
      await scanDirectory(child, path, count);
    } else if (name.toLowerCase().endsWith(".md")) {
      count.value += 1;
      const entry = { type: "file", name, path, handle: child };
      state.localFiles.push(entry);
      state.localFileMap.set(path, child);
    }
  }
}

function renderLocalFiles() {
  const files = filteredEntries(state.localFiles);
  renderSearchPanel({ treeCount: files.length });
  $("tree").innerHTML = files.length
    ? renderTreeEntries(files, { scope: "local-folder", forceExpanded: Boolean(searchQuery()) })
    : '<div class="empty-state small">로컬 폴더를 선택했거나 Markdown 파일이 없습니다.</div>';
  bindTreeSectionToggles(renderLocalFiles);
  $("tree").querySelectorAll(".tree-row").forEach((button) => {
    button.addEventListener("click", () => openDocument(button.dataset.path ?? ""));
  });
}

async function readLocalMarkdown(path) {
  const handle = state.localFileMap.get(path);
  if (!handle) throw new Error("로컬 파일 handle을 찾을 수 없습니다.");
  const file = await handle.getFile();
  return file.text();
}

async function fetchMarkdownAtRef(path, ref) {
  if (state.settings.sourceMode === "local-folder") {
    return readLocalMarkdown(path);
  }
  if (state.settings.sourceMode === "local-bridge") {
    return fetchLocalBridgeMarkdown({ bridgeUrl: state.settings.bridgeUrl, repo: selectedRepoName(), path, ref });
  }
  return fetchGithubMarkdown({
    owner: state.settings.githubOwner,
    repo: selectedRepoName(),
    ref,
    path,
    token: state.token
  });
}

function markdownDocumentTitle(body) {
  return extractToc(body).find((item) => item.level === 1)?.title ?? "";
}

function frontmatterDocumentTitle(frontmatter) {
  for (const key of ["행정규칙명", "자치법규명", "사건명", "제목", "title"]) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function containingDirectoryName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-2) ?? parts.at(-1) ?? path;
}

function documentDisplayTitle({ body, frontmatter, path }) {
  return markdownDocumentTitle(body) || frontmatterDocumentTitle(frontmatter) || containingDirectoryName(path);
}

function frontmatterSourceUrl(frontmatter) {
  const value = frontmatter["출처"];
  if (typeof value !== "string") return "";
  const match = value.trim().match(/https?:\/\/[^\s"'<>]+/i);
  return match && /^https?:\/\/(?:www\.)?law\.go\.kr(?:\/|$)/i.test(match[0]) ? match[0] : "";
}

function normalizedDate(value) {
  const match = String(value ?? "")
    .trim()
    .match(/(\d{4})[-.](\d{1,2})[-.](\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function displayHistoryDate(date) {
  if (state.document?.repo !== "precedent-kr" || String(date ?? "").slice(0, 10) !== "1970-01-01") {
    return date ?? "";
  }
  return normalizedDate(state.document.frontmatter?.["선고일자"]) || date || "";
}

function documentTypeLabel() {
  const repo = state.document?.repo ?? selectedRepoName();
  return repos.find((item) => item.name === repo)?.label ?? state.repo.label;
}

function isEmptyFrontmatterValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  const text = String(value).trim();
  return !text || text === "[]" || text === "{}";
}

function setSourceViewMenuOpen(open) {
  $("sourceViewMenu").hidden = !open;
  $("sourceViewButton").setAttribute("aria-expanded", String(open));
}

function updateSourceViewLinks({ frontmatter, path }) {
  $("sourceGithubLink").href = githubBlobUrl({
    owner: state.settings.githubOwner,
    repo: selectedRepoName(),
    ref: state.settings.githubRef,
    path
  });

  const lawUrl = frontmatterSourceUrl(frontmatter);
  $("sourceLawLink").hidden = !lawUrl;
  if (lawUrl) {
    $("sourceLawLink").href = lawUrl;
  } else {
    $("sourceLawLink").removeAttribute("href");
  }
  setSourceViewMenuOpen(false);
}

async function openDocument(path) {
  $("emptyState").classList.add("hidden");
  $("documentView").classList.remove("hidden");
  $("docTitle").textContent = path.split("/").pop() ?? path;
  $("docPath").textContent = path;
  $("docMeta").textContent = "원문을 불러오는 중";
  resetDocumentPanels();
  try {
    const markdown = await fetchMarkdownAtRef(path, state.settings.githubRef);
    const { frontmatter, body } = splitFrontmatter(markdown);
    const markdownTitle = markdownDocumentTitle(body);
    const title = documentDisplayTitle({ body, frontmatter, path });
    const skipTitleHeading = Boolean(markdownTitle) && markdownTitle === title;
    state.document = { repo: selectedRepoName(), path, title, markdown, body, frontmatter };
    $("docTitle").textContent = title;
    $("docMeta").textContent = `${state.repo.label} · ${sourceLabel()}`;
    $("frontmatter").innerHTML = renderFrontmatter(frontmatter);
    $("markdownBody").innerHTML = renderMarkdown(body, { skipFirstHeading: skipTitleHeading });
    renderToc(body, { skipFirstHeading: skipTitleHeading });
    renderAttachments();
    renderReferences();
    rememberRecentDocument();
    updateFavoriteButton();
    updateSourceViewLinks({ frontmatter, path });
    state.settings.sourceMode === "local-folder" ? renderLocalFiles() : renderTree();
    activateTab("body");
  } catch (error) {
    $("docMeta").textContent = "";
    $("markdownBody").innerHTML = renderErrorLine(error.message);
  }
}

function resetDocumentPanels() {
  resetAttachmentPreviewHost();
  clearAttachmentPreview();
  state.history = [];
  state.selectedCommits = [];
  state.expandedHistorySha = "";
  $("frontmatter").innerHTML = "";
  $("markdownBody").innerHTML = "";
  $("toc").innerHTML = "";
  $("historyTimeline").innerHTML = "";
  $("historyList").innerHTML = '<div class="empty-state small">변경 내역 탭을 열면 자동으로 불러옵니다.</div>';
  $("compareStatus").textContent = "비교할 개정 이력을 2개 선택하세요.";
  $("compareView").innerHTML = '<div class="empty-state small">비교할 개정 이력을 2개 선택하세요.</div>';
  $("attachmentsList").innerHTML = "";
  $("referenceGraph").innerHTML = "";
  $("sourceGithubLink").removeAttribute("href");
  $("sourceLawLink").removeAttribute("href");
  $("sourceLawLink").hidden = true;
  setSourceViewMenuOpen(false);
}

function renderFrontmatter(frontmatter) {
  const entries = Object.entries(frontmatter)
    .filter(([, value]) => !isEmptyFrontmatterValue(value))
    .slice(0, 12);
  if (!entries.length) return "";
  return entries
    .map(([key, value]) => `<span><strong>${escapeHtml(key)}</strong>${escapeHtml(String(value))}</span>`)
    .join("");
}

function renderToc(markdown, options = {}) {
  const toc = extractToc(markdown, options).slice(0, 500);
  $("toc").innerHTML = toc.length
    ? toc
        .map(
          (item) =>
            `<a href="#${escapeHtml(item.anchor)}" data-anchor="${escapeHtml(item.anchor)}" class="toc-row level-${item.level}">${escapeHtml(item.title)}</a>`
        )
        .join("")
    : '<div class="muted">목차 없음</div>';
  $("toc").querySelectorAll(".toc-row").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openTocTarget(link.dataset.anchor ?? "");
    });
  });
}

function openTocTarget(anchor) {
  if (!anchor) return;
  activateTab("body");
  requestAnimationFrame(() => {
    const target = document.getElementById(anchor);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    history.replaceState(null, "", `#${encodeURIComponent(anchor)}`);
  });
}

function renderAttachments() {
  resetAttachmentPreviewHost();
  clearAttachmentPreview();
  const base = rawUrl({
    owner: state.settings.githubOwner,
    repo: selectedRepoName(),
    ref: state.settings.githubRef,
    path: state.document?.path ?? ""
  });
  const attachments = extractAttachments(state.document?.markdown ?? "", base);
  $("attachmentsList").innerHTML = attachments.length
    ? renderAttachmentList(attachments)
    : `<div class="empty-state small">현재 ${escapeHtml(documentTypeLabel())} 문서에 첨부 파일이 없습니다.</div>`;
}

function extensionResourceUrl(path) {
  return globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : new URL(`../${path}`, import.meta.url).toString();
}

function attachmentFileFromButton(button) {
  return {
    url: button.dataset.url ?? "",
    extension: (button.dataset.extension ?? "").toLowerCase(),
    label: button.dataset.label ?? "첨부파일"
  };
}

function setAttachmentPreviewStatus(message, isError = false) {
  $("attachmentPreviewStatus").textContent = message;
  $("attachmentPreviewStatus").classList.toggle("error", isError);
}

function resetAttachmentPreviewHost() {
  const preview = $("attachmentPreview");
  const tab = $("attachmentsTab");
  if (preview.parentElement !== tab) tab.append(preview);
}

function placeAttachmentPreview(target) {
  const attachment = target?.closest(".attachment");
  if (attachment) {
    attachment.append($("attachmentPreview"));
    return;
  }
  resetAttachmentPreviewHost();
}

function clearAttachmentPreview() {
  state.attachmentPreviewFile = null;
  $("attachmentPreview").classList.add("hidden");
  $("attachmentPreviewTitle").textContent = "첨부 미리보기";
  $("attachmentPreviewStatus").textContent = "";
  $("attachmentPreviewStatus").classList.remove("error");
  $("attachmentPreviewBody").innerHTML = "";
  $("downloadAttachmentPreview").disabled = true;
}

function attachmentFilename(file, contentDisposition = "") {
  const disposition = contentDisposition ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const fromHeader = encoded ? decodeURIComponent(encoded) : plain;
  const fallback = `${file.label || "attachment"}.${file.extension || "bin"}`;
  return (fromHeader || fallback).replace(/[\\/:*?"<>|]+/g, "_");
}

function base64ToArrayBuffer(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function isExtensionRuntimeAvailable() {
  const runtime = globalThis.chrome?.runtime;
  return Boolean(runtime?.id && runtime?.sendMessage);
}

function isMissingRuntimeReceiverError(error) {
  return /Could not establish connection|Receiving end does not exist/i.test(error?.message ?? "");
}

function sendRuntimeMessageOnce(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function sendRuntimeMessage(message) {
  try {
    return await sendRuntimeMessageOnce(message);
  } catch (error) {
    if (!isMissingRuntimeReceiverError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 120));
    return sendRuntimeMessageOnce(message);
  }
}

function attachmentProxyUrl(file) {
  if (!isExtensionRuntimeAvailable() || !globalThis.chrome?.runtime?.getURL) return "";
  const url = new URL(chrome.runtime.getURL("__legalize_attachment__"));
  url.searchParams.set("url", file.url);
  return url.toString();
}

async function fetchAttachmentThroughProxy(file) {
  const proxyUrl = attachmentProxyUrl(file);
  if (!proxyUrl) return null;
  let response;
  try {
    response = await fetch(proxyUrl);
  } catch {
    return null;
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error((await response.text()) || `첨부 파일을 불러오지 못했습니다. (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return {
    buffer,
    blob: new Blob([buffer], { type: response.headers.get("content-type") || "application/octet-stream" }),
    filename: attachmentFilename(file, response.headers.get("x-content-disposition") || response.headers.get("content-disposition"))
  };
}

async function fetchAttachmentThroughRuntime(file) {
  if (!isExtensionRuntimeAvailable()) return null;
  const result = await sendRuntimeMessage({ type: "fetch-attachment", url: file.url });
  if (!result) return null;
  if (!result.ok) {
    throw new Error(result.error || "첨부 파일을 불러오지 못했습니다.");
  }
  const buffer = base64ToArrayBuffer(result.data);
  const contentType = result.contentType || "application/octet-stream";
  return {
    buffer,
    blob: new Blob([buffer], { type: contentType }),
    filename: attachmentFilename(file, result.contentDisposition)
  };
}

async function fetchAttachmentDirect(file) {
  const response = await fetch(file.url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`첨부 파일을 불러오지 못했습니다. (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return {
    buffer,
    blob: new Blob([buffer], { type: response.headers.get("content-type") || "application/octet-stream" }),
    filename: attachmentFilename(file, response.headers.get("content-disposition"))
  };
}

async function fetchAttachmentFile(file) {
  let directError = null;
  try {
    return await fetchAttachmentDirect(file);
  } catch (error) {
    directError = error;
  }
  try {
    const proxyResult = await fetchAttachmentThroughProxy(file);
    if (proxyResult) return proxyResult;
  } catch (error) {
    directError = error;
  }
  let runtimeReceiverError = null;
  try {
    const runtimeResult = await fetchAttachmentThroughRuntime(file);
    if (runtimeResult) return runtimeResult;
  } catch (error) {
    if (!isMissingRuntimeReceiverError(error)) throw error;
    runtimeReceiverError = error;
  }
  try {
    return await fetchAttachmentDirect(file);
  } catch (error) {
    if (runtimeReceiverError) {
      throw new Error("첨부 파일 프록시가 연결되지 않았습니다. 확장 프로그램을 새로고침한 뒤 뷰어 탭을 다시 열어주세요.");
    }
    throw directError || error;
  }
}

async function loadPdfjs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("../vendor/pdfjs/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = extensionResourceUrl("vendor/pdfjs/pdf.worker.mjs");
      return pdfjs;
    });
  }
  return pdfjsModulePromise;
}

async function loadRhwp() {
  if (!rhwpModulePromise) {
    rhwpModulePromise = import("../vendor/rhwp/rhwp.js").then(async (rhwp) => {
      let context = null;
      let lastFont = "";
      globalThis.measureTextWidth = (font, text) => {
        if (!context) context = document.createElement("canvas").getContext("2d");
        if (!context) return text.length * 12;
        if (font !== lastFont) {
          context.font = font;
          lastFont = font;
        }
        return context.measureText(text).width;
      };
      await rhwp.default({ module_or_path: extensionResourceUrl("vendor/rhwp/rhwp_bg.wasm") });
      return rhwp;
    });
  }
  return rhwpModulePromise;
}

async function renderPdfPreview(file, buffer) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const body = $("attachmentPreviewBody");
  body.innerHTML = '<div class="pdf-viewer-pages"></div>';
  const pages = body.querySelector(".pdf-viewer-pages");
  setAttachmentPreviewStatus(`${pdf.numPages}쪽 PDF를 렌더링하는 중`);
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.setAttribute("aria-label", `${file.label} ${pageNumber}쪽`);
    pages.append(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
  setAttachmentPreviewStatus(`${pdf.numPages}쪽 PDF`);
}

async function renderHwpPreview(file, buffer) {
  const rhwp = await loadRhwp();
  const documentBytes = new Uint8Array(buffer);
  const hwpDocument = new rhwp.HwpDocument(documentBytes);
  try {
    const pageCount = hwpDocument.pageCount();
    const body = $("attachmentPreviewBody");
    body.innerHTML = '<div class="hwp-viewer-pages"></div>';
    const pages = body.querySelector(".hwp-viewer-pages");
    setAttachmentPreviewStatus(`${pageCount}쪽 HWP를 렌더링하는 중`);
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
      const page = document.createElement("div");
      page.className = "hwp-page-svg";
      page.innerHTML = hwpDocument.renderPageSvg(pageNumber);
      pages.append(page);
    }
    setAttachmentPreviewStatus(`${pageCount}쪽 HWP`);
  } finally {
    hwpDocument.free?.();
  }
}

async function previewAttachment(file, target) {
  if (!file.url) return;
  clearAttachmentPreview();
  state.attachmentPreviewFile = file;
  $("downloadAttachmentPreview").disabled = false;
  placeAttachmentPreview(target);
  $("attachmentPreview").classList.remove("hidden");
  $("attachmentPreviewTitle").textContent = `${file.label} · ${file.extension.toUpperCase()}`;
  setAttachmentPreviewStatus("첨부 파일을 다운로드하는 중");
  try {
    const { buffer } = await fetchAttachmentFile(file);
    if (file.extension === "pdf") {
      await renderPdfPreview(file, buffer);
    } else if (file.extension === "hwp" || file.extension === "hwpx") {
      await renderHwpPreview(file, buffer);
    } else {
      throw new Error("지원하지 않는 첨부 형식입니다.");
    }
  } catch (error) {
    $("attachmentPreviewBody").innerHTML = `<div class="empty-state small"><a class="button link-button" href="${escapeHtml(
      file.url
    )}" target="_blank" rel="noreferrer">원문 열기</a></div>`;
    setAttachmentPreviewStatus(error.message, true);
  }
}

async function downloadAttachment(file) {
  if (!file.url) return;
  try {
    setAttachmentPreviewStatus("첨부 파일을 다운로드하는 중");
    const { blob, filename } = await fetchAttachmentFile(file);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setAttachmentPreviewStatus("다운로드를 시작했습니다.");
  } catch (error) {
    setAttachmentPreviewStatus(error.message, true);
    window.open(file.url, "_blank", "noreferrer");
  }
}

function renderReferences() {
  const base = rawUrl({
    owner: state.settings.githubOwner,
    repo: selectedRepoName(),
    ref: state.settings.githubRef,
    path: state.document?.path ?? ""
  });
  const references = extractReferences(state.document?.markdown ?? "", base, state.document?.path ?? "");
  $("referenceGraph").innerHTML = references.length
    ? references
        .map((item) => {
          const target = item.targetPath || item.url || item.href;
          const action = item.targetPath
            ? `<button type="button" class="ghost-button open-reference" data-path="${escapeHtml(item.targetPath)}">열기</button>`
            : `<a class="button link-button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">열기</a>`;
          return `<div class="reference-node"><span>${escapeHtml(item.kind)}</span><strong>${escapeHtml(
            item.label
          )}</strong><code>${escapeHtml(target)}</code>${action}</div>`;
        })
        .join("")
    : `<div class="empty-state small">현재 ${escapeHtml(documentTypeLabel())} 문서에 포함된 링크가 없습니다.</div>`;
  $("referenceGraph").querySelectorAll(".open-reference").forEach((button) => {
    button.addEventListener("click", () => openDocument(button.dataset.path ?? ""));
  });
}

async function loadHistory(until) {
  if (!state.document) {
    $("historyList").innerHTML = '<div class="empty-state small">문서를 선택하세요.</div>';
    return;
  }
  $("historyList").innerHTML = '<div class="state-line">변경 내역을 불러오는 중</div>';
  try {
    const args = { repo: state.document.repo, path: state.document.path, limit: until ? 1 : 80, until };
    const history =
      state.settings.sourceMode === "local-bridge"
        ? await fetchLocalBridgeHistory({ ...args, bridgeUrl: state.settings.bridgeUrl })
        : await fetchGithubHistory({
            ...args,
            owner: state.settings.githubOwner,
            token: state.token
          });
    state.history = normalizeHistoryCommits(history);
    renderHistory();
  } catch (error) {
    $("historyList").innerHTML = renderErrorLine(error.message);
  }
}

function normalizeHistoryCommits(commits) {
  return commits.map((commit) => {
    const messageBody = commit.messageBody ?? commit.body ?? commit.fullMessage ?? commit.message ?? commit.sha;
    const date = displayHistoryDate(commit.date);
    return {
      ...commit,
      date,
      message: commit.message ?? String(messageBody).split("\n")[0],
      messageBody
    };
  });
}

function renderHistory() {
  const ordered = [...state.history].sort(compareCommitChronology);
  renderHistoryTimeline(ordered);
  $("historyList").innerHTML = renderHistoryRows(ordered);
  document.querySelectorAll(".pick-commit").forEach((button) => {
    button.addEventListener("click", () => selectCommit(button.dataset.sha));
  });
  document.querySelectorAll(".commit-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button,a")) return;
      toggleHistoryMessage(row.dataset.historySha ?? "");
    });
    row.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button,a") && target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleHistoryMessage(row.dataset.historySha ?? "");
    });
  });
}

function renderHistoryRows(commits) {
  const selectedShas = new Set(state.selectedCommits.map((commit) => commit.sha));
  return commits.length
    ? commits
        .map(
          (commit, index) => {
            const selected = selectedShas.has(commit.sha);
            const expanded = state.expandedHistorySha === commit.sha;
            return `<div class="commit-item${expanded ? " expanded" : ""}"><div class="commit-row${
              selected ? " selected" : ""
            }" data-history-sha="${escapeHtml(commit.sha)}" role="button" tabindex="0" aria-expanded="${expanded}"><button type="button" class="ghost-button pick-commit" data-sha="${
              commit.sha
            }" aria-pressed="${selected}">${selected ? "선택됨" : "선택"}</button><code>${escapeHtml(`개정 ${index + 1}`)}</code><strong>${escapeHtml(
              commit.message ?? ""
            )}</strong><span>${escapeHtml(commitDateLabel(commit))}</span><a href="${escapeHtml(
              commit.htmlUrl ?? "#"
            )}" target="_blank" rel="noreferrer">변경 기록</a></div>${
              expanded ? `<div class="commit-message">${renderMarkdown(commit.messageBody ?? commit.message ?? "")}</div>` : ""
            }</div>`;
          }
        )
        .join("")
    : '<div class="empty-state small">변경 내역이 없습니다.</div>';
}

function toggleHistoryMessage(sha) {
  if (!sha) return;
  state.expandedHistorySha = state.expandedHistorySha === sha ? "" : sha;
  renderHistory();
}

function compareCommitChronology(left, right) {
  const dateOrder = (left.date ?? "").localeCompare(right.date ?? "");
  if (dateOrder !== 0) return dateOrder;
  return (left.sha ?? "").localeCompare(right.sha ?? "");
}

function selectedCompareCommits() {
  return [...state.selectedCommits].sort(compareCommitChronology);
}

function commitDateLabel(commit) {
  return commit.date ? commit.date.slice(0, 10) : "날짜 없음";
}

function revisionSummary(commit) {
  return commit.message?.trim() || "개정 이력";
}

function compareStatusLabel() {
  const selected = selectedCompareCommits();
  if (selected.length === 2) {
    return `이전 버전 ${commitDateLabel(selected[0])} ↔ 비교할 버전 ${commitDateLabel(selected[1])}`;
  }
  return selected.length === 1 ? "비교할 개정 이력을 1개 더 선택하세요." : "비교할 개정 이력을 2개 선택하세요.";
}

function renderTimelineCommit(item, total, roleBySha, selectedShas, cardPlacementBySha) {
  const { commit, index } = item;
  const selected = selectedShas.has(commit.sha);
  const role = roleBySha.get(commit.sha) ?? "";
  const roleClass = role === "이전 버전" ? "previous" : role === "비교할 버전" ? "target" : role ? "single" : "";
  const cardPlacementClass = cardPlacementBySha.get(commit.sha) ? ` ${cardPlacementBySha.get(commit.sha)}` : "";
  const date = commitDateLabel(commit);
  const summary = revisionSummary(commit);
  const title = `${date} · ${summary}`;
  return `<li class="timeline-item${role ? " has-card" : ""}"><button type="button" class="timeline-commit pick-commit${
    selected ? " selected" : ""
  }${roleClass ? ` ${roleClass}` : ""}" data-sha="${escapeHtml(commit.sha)}" aria-pressed="${selected}" aria-label="${escapeHtml(
    `${index + 1}/${total} ${title}`
  )}" title="${escapeHtml(title)}"><span class="timeline-date">${escapeHtml(date)}</span><span class="timeline-dot"></span>${
    role
      ? `<span class="timeline-card${cardPlacementClass}"><span>${escapeHtml(role)}</span><strong>${escapeHtml(date)}</strong><em>${escapeHtml(summary)}</em></span>`
      : ""
  }</button></li>`;
}

function timelineCardPlacements(visualItems, roleBySha) {
  const selectedItems = visualItems
    .map((item, position) => (roleBySha.has(item.commit.sha) ? { sha: item.commit.sha, position } : null))
    .filter(Boolean);
  const placements = new Map();
  if (selectedItems.length === 2 && selectedItems[1].position - selectedItems[0].position === 1) {
    const firstAtStart = selectedItems[0].position === 0;
    const secondAtEnd = selectedItems[1].position === visualItems.length - 1;
    placements.set(selectedItems[0].sha, firstAtStart && !secondAtEnd ? "card-anchor" : "card-left");
    placements.set(selectedItems[1].sha, secondAtEnd && !firstAtStart ? "card-anchor" : "card-right");
    if (firstAtStart && !secondAtEnd) placements.set(selectedItems[1].sha, "card-right-edge");
    if (secondAtEnd && !firstAtStart) placements.set(selectedItems[0].sha, "card-left-edge");
  }
  return placements;
}

function balancedTimelineRows(items) {
  const rowCount = Math.max(1, Math.ceil(items.length / timelineMaxItemsPerRow));
  const baseSize = Math.floor(items.length / rowCount);
  const extraRows = items.length % rowCount;
  const rows = [];
  let start = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const size = baseSize + (rowIndex < extraRows ? 1 : 0);
    rows.push(items.slice(start, start + size));
    start += size;
  }
  return rows;
}

function renderTimelineTrack(commits) {
  const selected = selectedCompareCommits();
  const selectedShas = new Set(state.selectedCommits.map((commit) => commit.sha));
  const roleBySha = new Map();
  if (selected.length === 1) {
    roleBySha.set(selected[0].sha, "선택한 버전");
  } else if (selected.length === 2) {
    roleBySha.set(selected[0].sha, "이전 버전");
    roleBySha.set(selected[1].sha, "비교할 버전");
  }
  const items = commits.map((commit, index) => ({ commit, index }));
  const rowGroups = balancedTimelineRows(items);
  const rows = rowGroups.map((chunk, rowIndex) => {
    const reverse = rowIndex % 2 === 1;
    const visualItems = reverse ? [...chunk].reverse() : chunk;
    const cardPlacementBySha = timelineCardPlacements(visualItems, roleBySha);
    return `<ol class="timeline-track-row${reverse ? " reverse" : ""}${rowIndex < rowGroups.length - 1 ? " has-next" : ""}" style="--timeline-count:${
        chunk.length
      }">${visualItems.map((item) => renderTimelineCommit(item, items.length, roleBySha, selectedShas, cardPlacementBySha)).join("")}</ol>`;
  });
  return `<div class="timeline-track" aria-label="개정 이력 타임라인">${rows.join("")}</div>`;
}

function renderHistoryTimeline(commits) {
  if (!commits.length) {
    $("historyTimeline").innerHTML = "";
    return;
  }
  const chronological = [...commits].sort(compareCommitChronology);
  $("historyTimeline").innerHTML = renderTimelineTrack(chronological);
}

function selectCommit(sha) {
  const commit = state.history.find((item) => item.sha === sha);
  if (!commit) return;
  state.selectedCommits = [...state.selectedCommits.filter((item) => item.sha !== sha), commit].slice(-2);
  $("compareStatus").textContent = compareStatusLabel();
  renderHistory();
  if (state.selectedCommits.length === 2) {
    runCompare();
  } else {
    $("compareView").innerHTML = '<div class="empty-state small">비교할 개정 이력을 2개 선택하세요.</div>';
  }
}

function persistComparePreset() {
  if (!state.document || state.selectedCommits.length !== 2) return;
  const [base, target] = selectedCompareCommits();
  localStorage.setItem(
    `legalize.viewer.plugins.compare.${documentId(state.document.repo, state.document.path)}`,
    JSON.stringify({
      base: base.sha,
      target: target.sha,
      mode: $("compareMode").value,
      onlyChanged: $("onlyChanged").checked
    })
  );
}

async function runCompare() {
  if (!state.document || state.selectedCommits.length !== 2) {
    $("compareView").innerHTML = '<div class="empty-state small">비교할 개정 이력을 2개 선택하세요.</div>';
    return;
  }
  const [base, target] = selectedCompareCommits();
  if (base.sha === target.sha) {
    $("compareView").innerHTML = '<div class="state-line error">같은 개정 이력입니다. 서로 다른 개정 이력 2개를 선택하세요.</div>';
    return;
  }
  $("compareView").innerHTML = '<div class="state-line">두 버전의 원문을 불러오는 중</div>';
  try {
    const [baseBody, targetBody] = await Promise.all([
      fetchMarkdownAtRef(state.document.path, base.sha),
      fetchMarkdownAtRef(state.document.path, target.sha)
    ]);
    const rows = buildDiffRows(splitFrontmatter(baseBody).body, splitFrontmatter(targetBody).body);
    $("compareView").innerHTML = renderDiff(rows, {
      mode: $("compareMode").value,
      onlyChanged: $("onlyChanged").checked
    });
    persistComparePreset();
  } catch (error) {
    $("compareView").innerHTML = renderErrorLine(error.message);
  }
}

function updateFavoriteButton() {
  if (!state.document) return;
  const id = documentId(state.document.repo, state.document.path);
  const isFavorite = state.favoriteIds.includes(id);
  const favoriteButton = $("favoriteButton");
  const label = isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가";
  favoriteButton.classList.toggle("is-favorite", isFavorite);
  favoriteButton.setAttribute("aria-pressed", String(isFavorite));
  favoriteButton.setAttribute("aria-label", label);
  favoriteButton.title = label;
  favoriteButton.dataset.tooltip = label;
}

function toggleFavorite() {
  if (!state.document) return;
  const id = documentId(state.document.repo, state.document.path);
  state.favoriteIds = state.favoriteIds.includes(id)
    ? state.favoriteIds.filter((item) => item !== id)
    : [...state.favoriteIds, id];
  saveFavorites();
  updateFavoriteButton();
  renderFavorites();
}

function favoriteTitle(repo, path) {
  const id = documentId(repo, path);
  if (state.document && documentId(state.document.repo, state.document.path) === id) return state.document.title || path;
  return state.recentDocs.find((item) => item.id === id)?.title || containingDirectoryName(path);
}

function renderFavorites() {
  $("favoritesList").innerHTML = state.favoriteIds.length
    ? state.favoriteIds
        .map((id) => {
          const [repo, ...pathParts] = id.split(":");
          const path = pathParts.join(":");
          const label = repos.find((item) => item.name === repo)?.label ?? repo;
          const title = favoriteTitle(repo, path);
          return `<button type="button" class="mini-row" data-repo="${escapeHtml(repo)}" data-path="${escapeHtml(
            path
          )}"><strong>${escapeHtml(title)}</strong><em>${escapeHtml(label)} · ${escapeHtml(path)}</em></button>`;
        })
        .join("")
    : '<div class="muted">없음</div>';
  $("favoritesList").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const repo = repos.find((item) => item.name === button.dataset.repo);
      if (repo) {
        state.repo = repo;
        $("repoSelect").value = repo.name;
        applySourceStatus();
      }
      openDocument(button.dataset.path ?? "");
    });
  });
}

function rememberRecentDocument() {
  if (!state.document) return;
  const id = documentId(state.document.repo, state.document.path);
  state.recentDocs = [
    {
      id,
      repo: state.document.repo,
      path: state.document.path,
      title: state.document.title,
      openedAt: new Date().toISOString()
    },
    ...state.recentDocs.filter((item) => documentId(item.repo, item.path) !== id)
  ].slice(0, 12);
  saveRecentDocs();
  renderRecentDocs();
}

function renderRecentDocs() {
  $("recentDocsList").innerHTML = state.recentDocs.length
    ? state.recentDocs
        .map((item) => {
          const repo = repos.find((repoItem) => repoItem.name === item.repo);
          const label = repo?.label ?? item.repo;
          return `<button type="button" class="mini-row" data-repo="${escapeHtml(item.repo)}" data-path="${escapeHtml(
            item.path
          )}"><strong>${escapeHtml(item.title || item.path)}</strong><em>${escapeHtml(label)} · ${escapeHtml(
            item.path
          )}</em></button>`;
        })
        .join("")
    : '<div class="muted">없음</div>';
  $("recentDocsList").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const repo = repos.find((item) => item.name === button.dataset.repo);
      if (repo) {
        state.repo = repo;
        $("repoSelect").value = repo.name;
        applySourceStatus();
      }
      openDocument(button.dataset.path ?? "");
    });
  });
}

function activateTab(tab) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`${tab}Tab`).classList.remove("hidden");
  if (tab === "history" && state.document && !state.history.length) {
    loadHistory();
  }
}

function activatePanelTab(group, targetId) {
  document.querySelectorAll(`[data-panel-tab-group="${group}"]`).forEach((button) => {
    const active = button.dataset.panelTabTarget === targetId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(`.panel-tab-panel[id^="${group}"]`).forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== targetId);
  });
}

function setPanelCollapsed(panel, collapsed) {
  const panelId = panel === "left" ? "leftPanel" : "rightPanel";
  const layoutClass = panel === "left" ? "left-collapsed" : "right-collapsed";
  const railButtonId = panel === "left" ? "toggleLeftPanelRail" : "toggleRightPanelRail";
  const openLabel = panel === "left" ? "좌측 패널 열기" : "우측 패널 열기";
  const closeLabel = panel === "left" ? "좌측 패널 닫기" : "우측 패널 닫기";
  let iconId = collapsed ? "icon-chevron-left" : "icon-chevron-right";
  if (panel === "left") {
    iconId = collapsed ? "icon-chevron-right" : "icon-chevron-left";
  }
  $(panelId).classList.toggle("collapsed", collapsed);
  $("layout").classList.toggle(layoutClass, collapsed);
  $(railButtonId).setAttribute("aria-expanded", String(!collapsed));
  $(railButtonId).setAttribute("aria-label", collapsed ? openLabel : closeLabel);
  $(railButtonId).querySelector("use")?.setAttribute("href", `#${iconId}`);
}

function togglePanel(panel) {
  const panelId = panel === "left" ? "leftPanel" : "rightPanel";
  setPanelCollapsed(panel, !$(panelId).classList.contains("collapsed"));
}

function setPanelWidth(panel, width, persist = true) {
  state.panelWidths[panel] = clampPanelWidth(width);
  applyPanelWidths();
  if (persist) savePanelWidths();
}

function bindPanelResizeRail(rail) {
  const panel = rail.dataset.resizePanel;
  if (!panel) return;
  rail.addEventListener("wheel", (event) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    setPanelWidth(panel, state.panelWidths[panel] + direction * 24);
  });
  rail.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    event.preventDefault();
    if ($(panel === "left" ? "leftPanel" : "rightPanel").classList.contains("collapsed")) {
      setPanelCollapsed(panel, false);
    }
    const startX = event.clientX;
    const startWidth = state.panelWidths[panel];
    rail.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-panels");
    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      setPanelWidth(panel, panel === "left" ? startWidth + delta : startWidth - delta, false);
    };
    const onUp = () => {
      savePanelWidths();
      document.body.classList.remove("resizing-panels");
      rail.removeEventListener("pointermove", onMove);
      rail.removeEventListener("pointerup", onUp);
      rail.removeEventListener("pointercancel", onUp);
    };
    rail.addEventListener("pointermove", onMove);
    rail.addEventListener("pointerup", onUp);
    rail.addEventListener("pointercancel", onUp);
  });
}

function syncCompareModeButtons() {
  const mode = $("compareMode").value;
  document.querySelectorAll("[data-compare-mode]").forEach((button) => {
    const active = button.dataset.compareMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function bindSettingsDialogDismiss() {
  const dialog = $("settingsDialog");
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.close();
  });
}

function bindEvents() {
  $("repoSelect").addEventListener("change", () => {
    const repo = repos.find((item) => item.name === $("repoSelect").value) ?? repos[0];
    selectRepository(repo, { openReadme: true }).catch((error) => setStatus(error.message, true));
  });
  $("searchInput").addEventListener("input", () => {
    if (state.settings.sourceMode === "local-folder") {
      renderLocalFiles();
      return;
    }
    renderTree();
    if (searchQuery().length >= 2) {
      ensureMetadataForCurrentRepo();
    }
  });
  $("clearSearchButton").addEventListener("click", () => {
    $("searchInput").value = "";
    renderSearchPanel();
    state.settings.sourceMode === "local-folder" ? renderLocalFiles() : renderTree();
    $("searchInput").focus();
  });
  $("themeToggle").addEventListener("click", () => {
    saveTheme(nextTheme(state.settings?.theme)).catch((error) => setStatus(error.message, true));
  });
  $("settingsButton").addEventListener("click", () => {
    applySettingsToForm();
    activatePanelTab("settings", "settingsViewTab");
    $("settingsDialog").showModal();
  });
  $("sourceMode").addEventListener("change", applySettingsVisibility);
  $("themeSetting").addEventListener("change", updateSettingsPreview);
  [
    ["fontSizeSetting", "fontSizeValue"],
    ["leftPanelFontSizeSetting", "leftPanelFontSizeValue"],
    ["rightPanelFontSizeSetting", "rightPanelFontSizeValue"]
  ].forEach(([inputId, outputId, fallback]) => {
    $(inputId).addEventListener("input", () => {
      $(outputId).textContent = `${normalizeFontSize($(inputId).value, fallback)}px`;
      updateSettingsPreview();
    });
  });
  $("saveSettingsButton").addEventListener("click", saveSettingsFromForm);
  $("clearTokenButton").addEventListener("click", async () => {
    state.token = "";
    $("githubToken").value = "";
    await clearToken();
  });
  $("settingsPickFolderButton").addEventListener("click", () =>
    pickLocalFolder().catch((error) => setStatus(error.message, true))
  );
  $("openTokenSettingsButton").addEventListener("click", openTokenSettings);
  $("closeAttachmentPreview").addEventListener("click", clearAttachmentPreview);
  $("downloadAttachmentPreview").addEventListener("click", () => {
    if (state.attachmentPreviewFile) downloadAttachment(state.attachmentPreviewFile);
  });
  bindSettingsDialogDismiss();
  $("attachmentsList").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("[data-attachment-action]");
    if (!(button instanceof HTMLButtonElement)) return;
    const file = attachmentFileFromButton(button);
    if (button.dataset.attachmentAction === "preview") {
      previewAttachment(file, button);
    }
  });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".source-view-wrap")) {
      setSourceViewMenuOpen(false);
    }
    if (target?.closest("[data-rate-limit-help]")) {
      event.preventDefault();
      showRateLimitHelp();
    }
  });
  $("compareMode").addEventListener("change", () => {
    syncCompareModeButtons();
    runCompare();
  });
  document.querySelectorAll("[data-compare-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      $("compareMode").value = button.dataset.compareMode;
      syncCompareModeButtons();
      runCompare();
    });
  });
  $("onlyChanged").addEventListener("change", runCompare);
  $("favoriteButton").addEventListener("click", toggleFavorite);
  $("sourceViewButton").addEventListener("click", (event) => {
    event.stopPropagation();
    setSourceViewMenuOpen($("sourceViewMenu").hidden);
  });
  $("sourceViewMenu").addEventListener("click", () => setSourceViewMenuOpen(false));
  $("homeButton").addEventListener("click", () => {
    $("documentView").classList.add("hidden");
    $("emptyState").classList.remove("hidden");
    setSourceViewMenuOpen(false);
  });
  $("toggleLeftPanelRail").addEventListener("click", () => togglePanel("left"));
  $("toggleRightPanelRail").addEventListener("click", () => togglePanel("right"));
  document.querySelectorAll(".panel-tab").forEach((button) => {
    button.addEventListener("click", () => {
      activatePanelTab(button.dataset.panelTabGroup, button.dataset.panelTabTarget);
    });
  });
  document.querySelectorAll("[data-resize-panel]").forEach(bindPanelResizeRail);
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  document.querySelectorAll(".quick-repo").forEach((button) => {
    button.addEventListener("click", async () => {
      const repo = repos.find((item) => item.name === button.dataset.repo);
      if (!repo) return;
      activatePanelTab("left", "leftNavigationTab");
      setPanelCollapsed("left", false);
      try {
        await selectRepository(repo, { query: "" });
        document.querySelector('[data-panel-tab-group="left"][data-panel-tab-target="leftNavigationTab"]')?.focus({ preventScroll: true });
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === "Escape") {
      setSourceViewMenuOpen(false);
    }
    if (!editing && event.key === "/") {
      event.preventDefault();
      $("searchInput").focus();
    }
  });
}

async function init() {
  state.settings = await loadSettings();
  state.token = await loadToken();
  state.repo = repos[0];
  populateRepos();
  applyTheme();
  applyFontSize();
  applyPanelWidths();
  applySettingsToForm();
  applySourceStatus();
  applyRuntimeBadge();
  setPanelCollapsed("left", false);
  setPanelCollapsed("right", false);
  bindEvents();
  syncCompareModeButtons();
  globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (normalizeTheme(state.settings?.theme) === "system") applyTheme();
  });
  await loadTree(repoStartPath());
}

init().catch((error) => {
  setStatus(error.message, true);
});
