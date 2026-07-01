import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { buildDiffRows, renderDiff, wordDiff } from "../extension/src/diff.js";
import {
  articleSections,
  extractAttachments,
  extractReferences,
  extractToc,
  renderAttachmentList,
  renderMarkdown,
  splitFrontmatter
} from "../extension/src/markdown.js";
import { filterMetadataDocuments, loadMetadataManifest, loadMetadataShard } from "../extension/src/metadata.js";
import {
  fetchGithubHistory,
  fetchGithubMarkdown,
  fetchLocalBridgeHistory,
  githubBlobUrl,
  githubHeaders,
  githubTokenForRequest,
  listGithubTree,
  localBridgeCommitsUrl,
  rawUrl,
  repos
} from "../extension/src/github.js";
import {
  clearToken,
  defaultSettings,
  loadSettings,
  loadToken,
  normalizeFontSize,
  normalizeTheme,
  saveSettings,
  saveToken
} from "../extension/src/storage.js";

const root = resolve(import.meta.dirname, "..");
const extension = resolve(root, "extension");
const nativeHost = resolve(root, "native-host");

globalThis.markdownit = MarkdownIt;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = JSON.parse(await readFile(resolve(extension, "manifest.json"), "utf8"));
const buildExtensionJs = await readFile(resolve(root, "scripts", "build-extension.mjs"), "utf8");
const serviceWorkerJs = await readFile(resolve(extension, "service-worker.js"), "utf8");
const attachmentCorsRules = JSON.parse(await readFile(resolve(extension, "rules/law-attachments-cors.json"), "utf8"));
assert(manifest.manifest_version === 3, "manifest must be MV3");
assert(manifest.name === "Legalize-KR Viewer", "manifest name must use the released project name");
assert(manifest.version === "0.1.0", "manifest version must reset for the new repository");
assert(manifest.key, "manifest key is required for stable development extension ID");
const keyBytes = Buffer.from(manifest.key, "base64");
const digest = createHash("sha256").update(keyBytes).digest().subarray(0, 16);
const alphabet = "abcdefghijklmnop";
const extensionId = [...digest].map((byte) => alphabet[byte >> 4] + alphabet[byte & 15]).join("");
assert(extensionId === "hceodioeamflhfelpepcimgjpbgoooaf", "stable extension ID mismatch");
assert(buildExtensionJs.includes("delete webStoreManifest.key"), "Chrome Web Store build must omit manifest key");
assert(manifest.permissions.includes("storage"), "manifest must include storage permission");
assert(
  manifest.permissions.includes("declarativeNetRequestWithHostAccess"),
  "manifest must include a host-scoped DNR permission for attachment CORS fallback"
);
assert(
  manifest.declarative_net_request?.rule_resources?.some((item) => item.path === "rules/law-attachments-cors.json" && item.enabled),
  "manifest must register the law attachment CORS fallback ruleset"
);
assert(attachmentCorsRules.length === 1, "attachment CORS ruleset must stay narrowly scoped");
assert(attachmentCorsRules[0].condition.urlFilter === "||law.go.kr/*flDownload.do", "attachment CORS rule must target law.go.kr downloads only");
assert(
  attachmentCorsRules[0].condition.resourceTypes.includes("xmlhttprequest"),
  "attachment CORS rule must apply to fetch/XMLHttpRequest requests"
);
assert(
  attachmentCorsRules[0].action.responseHeaders.some(
    (header) => header.header === "Access-Control-Allow-Origin" && header.operation === "set" && header.value === "*"
  ),
  "attachment CORS rule must add Access-Control-Allow-Origin"
);
assert(manifest.host_permissions.includes("https://api.github.com/*"), "manifest must include GitHub API host");
assert(manifest.host_permissions.includes("http://127.0.0.1/*"), "manifest must include local bridge host");
assert(manifest.host_permissions.includes("https://www.law.go.kr/*"), "manifest must allow law.go.kr attachment fetches");
assert(
  manifest.content_security_policy?.extension_pages?.includes("wasm-unsafe-eval"),
  "manifest CSP must allow bundled rhwp WASM execution"
);
assert(manifest.background.service_worker === "service-worker.js", "service worker path mismatch");
assert(serviceWorkerJs.includes("fetch-attachment"), "service worker must handle attachment fetch messages");
assert(serviceWorkerJs.includes("chrome.action?.onClicked"), "service worker action handler must not crash when action API is unavailable");
assert(serviceWorkerJs.includes("__legalize_attachment__"), "service worker must expose an attachment fetch proxy path");
assert(serviceWorkerJs.includes('self.addEventListener("fetch"'), "service worker must handle attachment proxy fetch events");
assert(serviceWorkerJs.includes("x-content-disposition"), "service worker proxy must forward attachment filenames");
assert(serviceWorkerJs.includes("arrayBufferToBase64"), "service worker must serialize attachment bytes for extension messages");
assert(serviceWorkerJs.includes('credentials: "omit"'), "service worker attachment fetches must not send credentials");
assert(manifest.icons?.["128"] === "icons/icon-128.png", "manifest must expose extension icons");
assert(manifest.action.default_icon?.["32"] === "icons/icon-32.png", "action icon must use packaged icon");
assert(repos.length === 4, "must support four repositories");
assert(repos[0].name === "legalize-kr" && repos[0].startPath === "kr", "law repository must start at kr/");

const viewerHtml = await readFile(resolve(extension, "viewer.html"), "utf8");
const optionsHtml = await readFile(resolve(extension, "options.html"), "utf8");
const stylesCss = await readFile(resolve(extension, "src", "styles.css"), "utf8");
assert(!/<script(?![^>]+src=)[^>]*>/i.test(viewerHtml), "viewer.html must not contain inline script");
assert(!/https:\/\/fonts\./.test(viewerHtml), "viewer.html must not load remote fonts");
assert(!/<script[^>]+src="https:\/\/[^"]*markdown/i.test(viewerHtml), "viewer.html must not load a remote markdown parser");
assert(viewerHtml.includes('src="vendor/markdown-it.js"'), "viewer.html must load the local markdown-it parser");
assert(viewerHtml.includes('src="src/app.js"'), "viewer.html must load app module");
assert(viewerHtml.includes('rel="icon" href="icons/icon-32.png"'), "viewer.html must use packaged favicon");
assert(viewerHtml.includes('id="runtimeBadge"'), "viewer.html must expose runtime badge");
assert(viewerHtml.includes('id="themeToggle"'), "viewer.html must expose theme toggle control");
assert(viewerHtml.includes('id="settingsButton"'), "viewer.html must expose settings control");
assert(
  viewerHtml.indexOf('id="runtimeBadge"') < viewerHtml.indexOf('id="themeToggle"') &&
    viewerHtml.indexOf('id="themeToggle"') < viewerHtml.indexOf('id="settingsButton"'),
  "topbar icons must be ordered version, theme, settings"
);
assert(!viewerHtml.includes('data-theme-choice='), "viewer.html must use one cycling theme toggle instead of three text buttons");
assert(!viewerHtml.includes(">Light<") && !viewerHtml.includes(">Dark<") && !viewerHtml.includes(">System<"), "theme toggle must be icon-only");
assert(viewerHtml.includes('id="icon-theme-system"'), "viewer.html must define a system theme SVG icon");
assert(viewerHtml.includes('id="icon-settings"'), "viewer.html must define a settings SVG icon");
assert(viewerHtml.includes("M12.2 2h-.4"), "settings icon must render as a cog");
assert(viewerHtml.includes('class="topbar-icon"'), "topbar action icons must use the shared SVG icon size");
assert(!viewerHtml.includes(">◐<") && !viewerHtml.includes(">⚙<"), "topbar icons must not depend on font-rendered emoji");
assert(viewerHtml.includes('class="icon-sprite"'), "viewer.html must include a local SVG icon sprite");
assert(viewerHtml.includes('class="tab-icon'), "viewer.html must render tabs with SVG icons");
assert(viewerHtml.includes('class="rail-icon"'), "viewer.html must render panel rail arrows with SVG icons");
assert(viewerHtml.includes('id="icon-file-hwp"'), "viewer.html must define an HWP attachment icon");
assert(viewerHtml.includes('id="icon-file-pdf"'), "viewer.html must define a PDF attachment icon");
assert(viewerHtml.includes('class="button icon-button favorite-toggle"'), "favorite action must be an icon button");
assert(viewerHtml.includes('aria-pressed="false"'), "favorite action must expose pressed state");
assert(viewerHtml.includes('class="favorite-icon"'), "favorite action must render a star icon");
assert(viewerHtml.includes('data-tooltip="즐겨찾기 추가"'), "favorite action must expose a hover tooltip");
assert(viewerHtml.includes('id="icon-document"'), "viewer.html must define a document source icon");
assert(viewerHtml.includes('id="sourceViewButton"'), "document header must expose an original-source button");
assert(viewerHtml.includes('data-tooltip="원문 보기"'), "original-source button must expose a hover tooltip");
assert(viewerHtml.includes('id="sourceViewMenu"'), "document header must expose an original-source menu");
assert(viewerHtml.includes("GitHub에서 Markdown 보기"), "original-source menu must link to the GitHub markdown view");
assert(viewerHtml.includes("국가법령정보센터 보기"), "original-source menu must link to the law.go.kr source view");
assert(!viewerHtml.includes('id="githubLink"'), "document header must not expose the old GitHub text link");
assert(viewerHtml.includes('class="field panel-repo-field"'), "viewer.html must place repository select in left panel navigation");
assert(viewerHtml.includes('id="repoSelect"'), "viewer.html must expose repository select");
assert(!viewerHtml.includes('id="breadcrumb"'), "left navigation must not render a redundant root path breadcrumb");
assert(!viewerHtml.includes('id="pickFolderButton"'), "viewer.html must not expose left panel local folder button");
assert(viewerHtml.includes('id="themeSetting"'), "viewer.html must expose settings theme control");
assert(viewerHtml.includes('id="fontSizeSetting"'), "viewer.html must expose content font size setting");
assert(viewerHtml.includes('id="leftPanelFontSizeSetting"'), "viewer.html must expose left panel font size setting");
assert(viewerHtml.includes('id="rightPanelFontSizeSetting"'), "viewer.html must expose right panel font size setting");
assert(viewerHtml.includes('id="fontSizeSetting" type="range" min="14" max="22" step="1"'), "content font size must be user-adjustable around 16px");
assert(viewerHtml.includes('id="settingsViewTab"'), "viewer.html must expose settings view tab panel");
assert(viewerHtml.includes('id="settingsSourceTab"'), "viewer.html must expose settings source tab panel");
assert(viewerHtml.includes('id="settingsLicenseTab"'), "viewer.html must expose settings license tab panel");
assert(viewerHtml.includes('data-panel-tab-group="settings"'), "viewer.html must expose settings dialog tabs");
assert(viewerHtml.includes(">라이선스<"), "settings dialog must expose a license tab label");
const settingsDialogHtml = viewerHtml.slice(viewerHtml.indexOf('id="settingsDialog"'), viewerHtml.indexOf('id="rateLimitHelpDialog"'));
assert(settingsDialogHtml.includes('class="ghost-button dialog-close-button"'), "settings dialog close control must use the icon close button style");
assert(settingsDialogHtml.includes('aria-label="설정 닫기"'), "settings dialog icon close button must keep an accessible label");
assert(!settingsDialogHtml.includes(">닫기<"), "settings dialog close button must not render text");
assert(settingsDialogHtml.includes("rhwp") && settingsDialogHtml.includes("vendor/rhwp/LICENSE"), "settings license tab must list rhwp");
assert(settingsDialogHtml.includes("PDF.js") && settingsDialogHtml.includes("vendor/pdfjs/LICENSE"), "settings license tab must list PDF.js");
assert(settingsDialogHtml.includes("markdown-it") && settingsDialogHtml.includes("vendor/markdown-it.LICENSE"), "settings license tab must list markdown-it");
assert(settingsDialogHtml.includes("https://github.com/edwardkim/rhwp"), "rhwp license item must link to GitHub");
assert(settingsDialogHtml.includes("https://github.com/mozilla/pdf.js"), "PDF.js license item must link to GitHub");
assert(settingsDialogHtml.includes("https://github.com/markdown-it/markdown-it"), "markdown-it license item must link to GitHub");
assert(settingsDialogHtml.includes("Apache-2.0") && settingsDialogHtml.includes("MIT"), "settings license tab must show license names");
assert(viewerHtml.includes('class="settings-section font-size-section"'), "viewer.html must group font size settings");
assert(viewerHtml.includes('class="font-size-row"'), "viewer.html must render each font size control on one row");
assert(viewerHtml.includes('id="settingsPreview"'), "viewer.html must expose settings view preview");
assert(!viewerHtml.includes('id="githubOwner"'), "viewer.html must hide fixed GitHub owner setting");
assert(!viewerHtml.includes('id="githubRef"'), "viewer.html must hide fixed GitHub ref setting");
assert(!viewerHtml.includes('id="tokenStorage"'), "viewer.html must hide token storage setting");
assert(viewerHtml.includes('id="githubTokenField"'), "viewer.html must wrap token field for source-specific visibility");
assert(viewerHtml.includes('class="token-input-row"'), "viewer.html must place token input and delete button in one row");
assert(
  viewerHtml.indexOf('id="githubToken"') < viewerHtml.indexOf('id="clearTokenButton"') &&
    viewerHtml.indexOf('id="clearTokenButton"') < viewerHtml.indexOf('id="localBridgeUrlField"'),
  "token delete button must sit next to the GitHub token input"
);
assert(
  viewerHtml.indexOf('id="sourceMode"') < viewerHtml.indexOf('id="githubTokenField"') &&
    viewerHtml.indexOf('id="sourceMode"') < viewerHtml.indexOf('id="localBridgeUrlField"') &&
    viewerHtml.indexOf('id="sourceMode"') < viewerHtml.indexOf('id="localFolderField"'),
  "source-specific settings must sit directly below source mode"
);
assert(viewerHtml.includes('id="localBridgeUrlField"'), "viewer.html must wrap local bridge URL field");
assert(viewerHtml.includes('id="localFolderField"'), "viewer.html must expose local folder source field");
assert(viewerHtml.includes('id="settingsPickFolderButton"'), "viewer.html must expose local folder browse button");
assert(viewerHtml.includes('id="rateLimitHelpDialog"'), "viewer.html must expose rate limit help dialog");
assert(viewerHtml.includes('assets/github-token-guide.svg'), "rate limit help dialog must include local guide image");
assert(viewerHtml.includes('id="openTokenSettingsButton"'), "rate limit help dialog must link back to token settings");
assert(viewerHtml.includes('class="field-help"'), "viewer.html must explain the GitHub token setting");
assert(viewerHtml.includes("GitHub 접근 토큰"), "viewer.html must use reader-facing GitHub token wording");
assert(!viewerHtml.includes("GitHub API rate limit"), "viewer.html must not expose API rate limit wording");
assert(!viewerHtml.includes("GitHub token"), "viewer.html must not expose lowercase token wording");
assert(viewerHtml.includes("Fine-grained personal access token"), "GitHub token help must mention token creation");
assert(viewerHtml.includes("Contents: Read-only"), "GitHub token help must recommend read-only contents permission");
assert(
  viewerHtml.includes("docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"),
  "GitHub token help must link to the official GitHub documentation"
);
assert(viewerHtml.includes('id="searchPanel"'), "viewer.html must expose search status panel");
assert(viewerHtml.includes('id="clearSearchButton"'), "viewer.html must expose search clear control");
assert(viewerHtml.includes('id="toggleLeftPanelRail"'), "viewer.html must expose left panel rail toggle");
assert(viewerHtml.includes('id="toggleRightPanelRail"'), "viewer.html must expose right panel rail toggle");
assert(viewerHtml.includes('id="leftFavoritesTab"'), "viewer.html must expose left favorites tab panel");
assert(viewerHtml.includes('id="recentDocsList"'), "viewer.html must expose recent docs list");
assert(viewerHtml.includes('id="historyTimeline"'), "viewer.html must expose history timeline");
assert(!viewerHtml.includes('id="loadHistoryButton"'), "history tab must load automatically without a manual load button");
assert(!viewerHtml.includes('id="historyOrder"'), "history tab must not expose a manual sort selector");
assert(!viewerHtml.includes('id="dateCommitInput"'), "history tab must not expose date-based selection input");
assert(!viewerHtml.includes('id="dateCommitButton"'), "history tab must not expose date-based selection button");
assert(!viewerHtml.includes("비교할 commit"), "history tab must not expose developer commit wording");
assert(viewerHtml.includes("비교할 개정 이력을 2개 선택하세요"), "history tab must use reader-facing revision wording");
assert(viewerHtml.includes("바뀐 조문만 보기"), "history compare controls must expose changed-articles-only mode");
assert(viewerHtml.includes('data-compare-mode="split"'), "history compare controls must expose split mode button");
assert(viewerHtml.includes('data-compare-mode="unified"'), "history compare controls must expose unified mode button");
assert(viewerHtml.includes(">변경 내역<"), "viewer.html must label history tabs as 변경 내역");
assert(viewerHtml.includes(">관련 링크<"), "viewer.html must label reference tabs as 관련 링크");
assert(!viewerHtml.includes(">이력<"), "viewer.html must not expose the old 이력 tab label");
assert(!viewerHtml.includes(">참조<"), "viewer.html must not expose the old 참조 tab label");
assert(!viewerHtml.includes('data-tab="compare"'), "compare must be integrated into the history tab instead of a separate top-level tab");
assert(!viewerHtml.includes('id="compareTab"'), "viewer.html must not expose a separate compare tab panel");
assert(
  viewerHtml.indexOf('id="historyTab"') < viewerHtml.indexOf('id="compareView"') &&
    viewerHtml.indexOf('id="compareView"') < viewerHtml.indexOf('id="historyList"') &&
    viewerHtml.indexOf('id="historyList"') < viewerHtml.indexOf('id="attachmentsTab"'),
  "history tab must contain the compare controls and result view"
);
assert(!viewerHtml.includes('id="rightHistoryTab"'), "right panel must not expose a history tab panel");
assert(!viewerHtml.includes('id="sideHistoryList"'), "right panel must not render a side history list");
assert(!viewerHtml.includes('id="sideHistoryTimeline"'), "right panel must not render a side history timeline");
assert(!viewerHtml.includes('id="sideLoadHistoryButton"'), "right history panel must not require a manual history load button");
assert(viewerHtml.includes('id="attachmentPreview"'), "viewer.html must expose an integrated attachment preview panel");
assert(viewerHtml.includes('id="attachmentPreviewBody"'), "viewer.html must expose attachment preview body");
assert(viewerHtml.includes('id="downloadAttachmentPreview"'), "viewer.html must expose preview-scoped attachment downloads");
assert(viewerHtml.includes('id="referenceGraph"'), "viewer.html must expose reference graph");
assert(viewerHtml.includes('class="quick-repo"'), "viewer.html must expose quick repository actions");
assert(viewerHtml.includes("좌측에서 저장소를 선택해주세요"), "empty state must direct readers to the left repository selector");
assert(!viewerHtml.includes("GitHub 원격, 로컬 Git 연결, 로컬 폴더 중 하나를 원문 소스로 사용할 수 있습니다."), "empty state must not repeat source-mode explanation");
assert(!viewerHtml.includes("data-query="), "quick repository buttons must not start a search query");
assert(!stylesCss.includes(".layout.right-collapsed .markdown-body"), "document body width must not depend on a right-panel-only override");
assert(stylesCss.includes(".markdown-body") && stylesCss.includes("width: 100%") && stylesCss.includes("max-width: none"), "document body must always fill the available workspace width");
assert(stylesCss.includes(".document-view") && stylesCss.includes("min-width: 0"), "document view must be allowed to shrink and grow with panel changes");
assert(stylesCss.includes("var(--left-panel-width"), "styles must use persisted left panel width");
assert(stylesCss.includes(".panel-rail"), "styles must define thin panel rails");
assert(stylesCss.includes(".panel-repo-field"), "styles must define left panel repository selector spacing");
assert(stylesCss.includes(".tab-icon"), "styles must define tab SVG icons");
assert(stylesCss.includes(".topbar-icon"), "styles must define shared topbar SVG icon sizing");
assert(!stylesCss.includes(".tab-icon-star"), "tab SVG icons must not use per-icon size overrides");
assert(stylesCss.includes("--tab-bg: #172033"), "dark theme tabs must define an inactive tab background");
assert(stylesCss.includes("--tab-active-bg: var(--panel)"), "dark theme selected tabs must match the panel background");
assert(stylesCss.includes("--tab-active-bg: #ffffff"), "light theme selected tabs must use a white active background");
assert(stylesCss.includes(".panel-tab.active,\n.tab.active"), "document tabs and panel tabs must share active styling");
assert(stylesCss.includes("background: var(--tab-bg)"), "document tabs and panel tabs must share inactive tab background styling");
assert(!stylesCss.includes(".mini-row:hover,\n.tab.active"), "document tabs must not use a separate active background override");
assert(
  stylesCss.includes(".right-panel .panel-tabs") && stylesCss.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"),
  "right panel single TOC tab must stay at half width"
);
assert(stylesCss.includes(".rail-icon"), "styles must define centered rail SVG icons");
assert(stylesCss.includes(".favorite-toggle.is-favorite .favorite-icon"), "favorite state must render a filled star");
assert(stylesCss.includes("[data-tooltip]::after"), "styles must define balloon tooltips");
assert(stylesCss.includes(".source-view-button"), "styles must define the original-source icon button");
assert(stylesCss.includes(".source-view-menu"), "styles must define the original-source menu");
assert(stylesCss.includes(".source-status:empty"), "styles must hide empty topbar status");
assert(stylesCss.includes("[hidden]"), "styles must preserve hidden attribute behavior over component display rules");
assert(stylesCss.includes(".rate-limit-help-button"), "styles must define rate limit help button");
assert(stylesCss.includes(".token-guide-image"), "styles must define token guide image");
assert(stylesCss.includes(".token-input-row"), "styles must define token input row layout");
assert(stylesCss.includes(".attachment-format-button"), "styles must define attachment file type action buttons");
assert(stylesCss.includes(".attachment-action-group"), "styles must group attachment preview actions by file type");
assert(stylesCss.includes(".attachment-preview-actions"), "styles must place preview download and close actions together");
assert(stylesCss.includes(".attachment .attachment-preview"), "styles must place preview panels below each attachment row");
assert(stylesCss.includes(".attachment-preview-body"), "styles must define integrated attachment preview body");
assert(stylesCss.includes(".pdf-page-canvas"), "styles must define PDF.js canvas pages");
assert(stylesCss.includes(".hwp-page-svg"), "styles must define rhwp SVG pages");
assert(stylesCss.includes("--content-font-size"), "styles must define content font size token");
assert(stylesCss.includes("--left-panel-font-size"), "styles must define left panel font size token");
assert(stylesCss.includes("--right-panel-font-size"), "styles must define right panel font size token");
assert(stylesCss.includes("--content-small-font-size"), "styles must derive small content text from content font size");
assert(stylesCss.includes(".document-view"), "styles must scope the document view to the content font size");
assert(stylesCss.includes("font-size: 1.625em"), "document title must scale from the content font size");
assert(stylesCss.includes(".markdown-body h1") && stylesCss.includes("font-size: 2em"), "markdown h1 must scale from content font size");
assert(stylesCss.includes(".markdown-body h6") && stylesCss.includes("font-size: 0.875em"), "markdown h6 must scale from content font size");
assert(stylesCss.includes("--panel-small-font-size"), "panel labels must derive from panel font sizes");
assert(stylesCss.includes(".font-size-row"), "styles must define one-line font size rows");
assert(stylesCss.includes(".settings-preview"), "styles must define settings preview");
assert(stylesCss.includes(".settings-tab-panel") && stylesCss.includes("min-height: 336px"), "source settings tab must reserve view-tab height for token help");
assert(stylesCss.includes(".license-list"), "styles must define license list layout");
assert(stylesCss.includes(".license-item"), "styles must define license item layout");
assert(stylesCss.includes(".license-links"), "styles must define license link grouping");
assert(stylesCss.includes(".dialog-close-button"), "styles must define the settings dialog icon close button");
assert(stylesCss.includes(".dialog-actions") && stylesCss.includes("justify-content: flex-end"), "settings dialog actions must be right-aligned");
assert(stylesCss.includes("#saveSettingsButton") && stylesCss.includes("color: #ffffff"), "settings save button text must stay white");
assert(stylesCss.includes(".browse-row"), "styles must define local folder browse row");
assert(stylesCss.includes(".tree-section-toggle"), "styles must define large tree section toggles");
assert(stylesCss.includes(".tree-row.current"), "styles must highlight the current tree row");
assert(stylesCss.includes(".field-help-popover"), "styles must define token help popover");
assert(!/\.actions,\s*\.dialog-actions,\s*\.history-toolbar,\s*\.compare-toolbar,\s*\.tab-panel\s*\{\s*min-height:\s*240px/.test(stylesCss), "document header actions must not inherit tab panel height");
assert(stylesCss.includes(".history-compare-layout"), "styles must place history and compare in one tab layout");
assert(stylesCss.includes(".commit-row.selected"), "styles must show selected history commits");
assert(stylesCss.includes(".commit-message"), "styles must define expanded history commit messages");
assert(stylesCss.includes("grid-template-columns: auto 96px minmax(0, 1fr) 112px auto"), "history rows must omit the bot author column");
assert(stylesCss.includes(".timeline-track-row.has-next::after"), "styles must connect wrapped timeline rows");
assert(stylesCss.includes("--timeline-line-top"), "timeline layout must use a shared line position");
assert(!stylesCss.includes(".timeline-commit.previous .timeline-card"), "previous timeline selection card must not be placed above the line");
assert(stylesCss.includes(".timeline-commit.target .timeline-card"), "target timeline selection card must have its own placement");
assert(!stylesCss.includes(".timeline-card.card-lower"), "adjacent timeline selection cards must not be stacked vertically");
assert(!stylesCss.includes(".timeline-track-row.has-stacked-card"), "timeline rows must not grow only to stack adjacent cards");
assert(stylesCss.includes(".timeline-card.card-left"), "adjacent timeline selection cards must support left placement");
assert(stylesCss.includes(".timeline-card.card-right"), "adjacent timeline selection cards must support right placement");
assert(stylesCss.includes(".timeline-card::before") && stylesCss.includes(".timeline-card::after"), "timeline cards must render a speech-bubble pointer");
assert(stylesCss.includes("repeat(var(--timeline-count), minmax(74px, 1fr))"), "main timeline must cap each row at fixed commit slots");
assert(stylesCss.includes(".segmented-control"), "styles must render split/unified controls as a segmented control");
assert(stylesCss.includes(".diff-row.unified del") && stylesCss.includes("text-decoration: line-through"), "unified removed diff text must use strikethrough");
assert(stylesCss.includes(':root[data-theme="light"]'), "styles must define light theme tokens");
assert(stylesCss.includes(".search-panel"), "styles must define search panel");
assert(stylesCss.includes(".quick-start"), "styles must define quick start controls");
assert(optionsHtml.includes("읽기 전용"), "options page must explain read-only policy");
assert(optionsHtml.includes("요청 한도"), "options page must explain GitHub request limit handling");
assert(!optionsHtml.includes("Rate limit"), "options page must not expose rate limit wording");
assert(!optionsHtml.includes("commit, push"), "options page must not expose developer git operation wording");
assert(optionsHtml.includes("개인정보"), "options page must explain privacy policy");
assert(optionsHtml.includes('id="optionsTheme"'), "options page must expose theme setting");
assert(!optionsHtml.includes('id="optionsTokenStorage"'), "options page must hide token storage setting");
assert(optionsHtml.includes('rel="icon" href="icons/icon-32.png"'), "options page must use packaged favicon");

const srcFiles = await readdir(resolve(extension, "src"));
assert(srcFiles.includes("app.js"), "app.js missing");
assert(srcFiles.includes("storage.js"), "storage.js missing");
assert(srcFiles.includes("metadata.js"), "metadata lazy loader missing");
const metadataFiles = await readdir(resolve(extension, "metadata"));
assert(!metadataFiles.includes("manifest.json"), "metadata directory must not include a nested manifest.json");
assert(metadataFiles.includes("index.json"), "metadata index missing");
assert(metadataFiles.includes("legalize-kr.json"), "legalize metadata shard missing");
assert(metadataFiles.includes("precedent-kr.json"), "precedent metadata shard missing");
assert(metadataFiles.includes("admrule-kr.json"), "admrule metadata shard missing");
assert(metadataFiles.includes("ordinance-kr.json"), "ordinance metadata shard missing");
const iconFiles = await readdir(resolve(extension, "icons"));
assert(iconFiles.includes("icon.svg"), "source icon svg missing");
assert(iconFiles.includes("icon-16.png"), "16px icon missing");
assert(iconFiles.includes("icon-32.png"), "32px icon missing");
assert(iconFiles.includes("icon-48.png"), "48px icon missing");
assert(iconFiles.includes("icon-128.png"), "128px icon missing");
const assetFiles = await readdir(resolve(extension, "assets"));
assert(assetFiles.includes("github-token-guide.svg"), "GitHub token guide image missing");
const tokenGuideSvg = await readFile(resolve(extension, "assets", "github-token-guide.svg"), "utf8");
assert(tokenGuideSvg.includes("GitHub 접근 토큰"), "GitHub token guide image must explain token flow in reader-facing wording");
assert(!tokenGuideSvg.includes("GitHub API"), "GitHub token guide image must not expose API wording");
const vendorFiles = await readdir(resolve(extension, "vendor"));
assert(vendorFiles.includes("markdown-it.js"), "local markdown parser bundle missing");
assert(vendorFiles.includes("markdown-it.LICENSE"), "local markdown parser license missing");
const rhwpFiles = await readdir(resolve(extension, "vendor", "rhwp"));
assert(rhwpFiles.includes("rhwp.js"), "bundled rhwp JS missing");
assert(rhwpFiles.includes("rhwp_bg.wasm"), "bundled rhwp WASM missing");
assert(rhwpFiles.includes("LICENSE"), "bundled rhwp license missing");
const pdfjsFiles = await readdir(resolve(extension, "vendor", "pdfjs"));
assert(pdfjsFiles.includes("pdf.mjs"), "bundled PDF.js module missing");
assert(pdfjsFiles.includes("pdf.worker.mjs"), "bundled PDF.js worker missing");
assert(pdfjsFiles.includes("LICENSE"), "bundled PDF.js license missing");
const nativeHostFiles = await readdir(nativeHost);
assert(nativeHostFiles.includes("host.py"), "native messaging host prototype missing");
assert(
  nativeHostFiles.includes("kr.legalize.viewer_bridge.json.template"),
  "native messaging host manifest template missing"
);
const nativeManifestTemplate = await readFile(resolve(nativeHost, "kr.legalize.viewer_bridge.json.template"), "utf8");
assert(
  nativeManifestTemplate.includes("chrome-extension://hceodioeamflhfelpepcimgjpbgoooaf/"),
  "native host manifest template must allow the stable extension ID"
);
const python = spawnSync("python3", [resolve(nativeHost, "host.py"), "--self-test"], { encoding: "utf8" });
const pythonFallback =
  python.status === 0 ? python : spawnSync("python", [resolve(nativeHost, "host.py"), "--self-test"], { encoding: "utf8" });
assert(pythonFallback.status === 0, `native host self-test failed: ${pythonFallback.stderr || pythonFallback.stdout}`);
const appJs = await readFile(resolve(extension, "src", "app.js"), "utf8");
assert(appJs.includes("chrome?.runtime"), "app.js must read extension runtime metadata defensively");
assert(appJs.includes("applyTheme"), "app.js must apply persisted theme");
assert(appJs.includes("nextTheme"), "app.js must cycle the topbar theme toggle");
assert(appJs.includes("themeIcons"), "app.js must render the topbar theme toggle as an icon");
assert(appJs.includes('activatePanelTab("left", "leftNavigationTab")'), "quick repository buttons must switch back to the explore panel");
assert(appJs.includes('selectRepository(repo, { query: "" })'), "quick repository buttons must clear stale search filters");
assert(appJs.includes('setPanelCollapsed("left", false)'), "quick repository buttons must reopen the left explore panel");
assert(appJs.includes('focus({ preventScroll: true })'), "quick repository buttons must keep focus on the explore tab");
assert(appJs.includes("aria-pressed"), "app.js must update favorite pressed state");
assert(appJs.includes("favoriteButton.dataset.tooltip = label"), "app.js must update favorite tooltip text");
assert(appJs.includes("frontmatterSourceUrl"), "app.js must derive original law source URLs from frontmatter");
assert(appJs.includes('frontmatter["출처"]'), "app.js must use only the frontmatter source field for law source URLs");
assert(appJs.includes("law\\.go\\.kr"), "app.js must only use law.go.kr URLs for the law source menu item");
assert(appJs.includes("normalizedDate"), "app.js must normalize document-provided dates");
assert(appJs.includes('state.document?.repo !== "precedent-kr"'), "precedent-specific date fallback must not affect other repositories");
assert(appJs.includes('state.document.frontmatter?.["선고일자"]'), "1970-01-01 precedent history dates must fall back to the judgment date");
assert(appJs.includes("updateSourceViewLinks"), "app.js must update the original-source menu links");
assert(appJs.includes("sourceLawLink"), "app.js must conditionally render the law.go.kr source link");
assert(!appJs.includes('$("githubLink")'), "app.js must not update the removed GitHub text link");
assert(appJs.includes("favoriteTitle"), "favorites must derive a display title like recent documents");
assert(appJs.includes("const label = repos.find((item) => item.name === repo)?.label ?? repo"), "favorites must render repository labels");
assert(appJs.includes("<strong>${escapeHtml(title)}</strong><em>${escapeHtml(label)} · ${escapeHtml(path)}</em>"), "favorites must use the same two-line shape as recent documents");
assert(!appJs.includes(">${escapeHtml(id)}</button>"), "favorites must not render raw repository IDs");
assert(appJs.includes("applyFontSize"), "app.js must apply persisted content font size");
assert(appJs.includes("updateSettingsPreview"), "app.js must update settings preview from view controls");
assert(appJs.includes("renderErrorLine"), "app.js must render structured error messages");
assert(appJs.includes("data-rate-limit-help"), "rate limit errors must expose a help action");
assert(appJs.includes("rateLimitHelpDialog"), "rate limit help action must open a layer dialog");
assert(appJs.includes("isEmptyFrontmatterValue"), "frontmatter rendering must skip empty values");
assert(appJs.includes('text === "[]"'), "empty frontmatter arrays must not be rendered");
assert(appJs.includes('text === "{}"'), "empty frontmatter objects must not be rendered");
assert(appJs.includes("bindSettingsDialogDismiss"), "settings dialog must bind explicit dismiss behavior");
assert(appJs.includes("event.target === dialog"), "settings dialog backdrop clicks must close the dialog");
assert(appJs.includes('dialog.addEventListener("cancel"'), "settings dialog ESC cancel must close the dialog");
assert(appJs.includes("renderSearchPanel"), "app.js must render search status");
assert(appJs.includes("setPanelCollapsed"), "app.js must support independent panel collapse");
assert(appJs.includes("bindPanelResizeRail"), "app.js must support rail resizing");
assert(appJs.includes("resetDocumentPanels"), "app.js must clear document-specific panels when switching documents");
assert(!appJs.includes("renderBreadcrumb"), "left navigation must not maintain a redundant breadcrumb renderer");
assert(appJs.includes("navigationEntries"), "app.js must filter hidden entries from navigation");
assert(appJs.includes('entry.name === ".gitignore"'), "left navigation must hide .gitignore");
assert(appJs.includes("selectRepository"), "repository selection must use a shared selection helper");
assert(appJs.includes('openDocument("README.md")'), "repository selection must open README immediately");
assert(appJs.includes("openDirectoryEntry"), "app.js must inspect directories before navigating");
assert(appJs.includes("openSingleChildEntry"), "directory selection must auto-open a single child entry");
assert(appJs.includes("treeEntryIsCurrent"), "tree rendering must mark the current document path");
assert(appJs.includes('aria-current="location"'), "current tree rows must expose aria-current");
assert(appJs.includes("state.expandedTreePaths.add(parentPath)"), "single-child auto-open must keep the parent directory visible");
assert(appJs.includes('state.settings.sourceMode === "local-folder" ? renderLocalFiles() : renderTree()'), "opening a document must refresh the left tree current marker");
assert(appJs.includes("entries.length === 1"), "directory selection must detect single-item folders");
assert(!appJs.includes("shouldInlineDirectory"), "directory expansion must not be limited to document leaf directories");
assert(!appJs.includes("await loadTree(path);"), "directory clicks must expand inline instead of navigating into the folder");
assert(!appJs.includes("state.repo.kind"), "directory handling must not be restricted to one repository kind");
assert(appJs.includes("markdownDocumentTitle"), "app.js must derive document titles from markdown headings first");
assert(appJs.includes('["행정규칙명", "자치법규명", "사건명", "제목", "title"]'), "frontmatter title fallback order must cover non-law repositories");
assert(
  appJs.includes("return markdownDocumentTitle(body) || frontmatterDocumentTitle(frontmatter) || containingDirectoryName(path)"),
  "document title fallback order must be markdown title, frontmatter title, then containing directory"
);
assert(appJs.includes("parts.at(-2)"), "document title must fall back to the containing directory name");
assert(!appJs.includes('frontmatter["제목"] || frontmatter.title ||'), "frontmatter title must not override markdown document title");
assert(appJs.includes("treeSectionThreshold"), "app.js must section large tree listings");
assert(appJs.includes("initialSectionLabel"), "app.js must group large tree listings by initial consonant");
assert(!appJs.includes("shouldRenderMetadataFullList"), "left navigation must not render a separate metadata full-list section");
assert(!appJs.includes("metadataDocumentTreeEntries"), "metadata documents must not be duplicated into the normal tree");
assert(!appJs.includes("전체 목록"), "left navigation must not show an unexplained full-list section");
assert(appJs.includes('renderTreeEntries(files, { scope: "local-folder"'), "local folder lists must reuse sectioned tree rendering");
assert(appJs.includes("repoStartPath"), "app.js must use repository start paths");
assert(appJs.includes("currentDocumentPath"), "settings changes must reload the current document from the selected source");
assert(appJs.includes("ensureMetadataForCurrentRepo"), "app.js must lazy load metadata shards from search input");
assert(appJs.includes("renderMetadataEntry"), "app.js must render metadata search results");
assert(appJs.includes("rememberRecentDocument"), "app.js must remember recently opened documents");
assert(appJs.includes("renderHistoryTimeline"), "app.js must render history timeline");
assert(!appJs.includes("loadHistoryButton"), "history loading must not depend on a removed load button");
assert(!appJs.includes("historyOrder"), "history rendering must not depend on a removed sort selector");
assert(!appJs.includes("dateCommit"), "history selection must not depend on removed date controls");
assert(appJs.includes("normalizeHistoryCommits"), "history commits must be normalized before rendering");
assert(appJs.includes("messageBody"), "history rows must keep full commit messages for expansion");
assert(appJs.includes("toggleHistoryMessage"), "history rows must toggle expanded commit messages");
assert(appJs.includes("commitDateLabel(commit)"), "history rows must render dates without time");
assert(!appJs.includes("commit.author ??"), "history rows must not expose bot authors");
assert(appJs.includes("timelineMaxItemsPerRow = 10"), "history timeline must cap each row at 10 revisions");
assert(appJs.includes("balancedTimelineRows"), "history timeline must distribute long histories evenly across rows");
assert(appJs.includes("timelineCardPlacements"), "history timeline must place adjacent selection cards side by side");
assert(appJs.includes("compareCommitChronology"), "history compare must normalize selected commits chronologically");
assert(appJs.includes("이전 버전"), "history timeline must label the previous comparison version");
assert(appJs.includes("비교할 버전"), "history timeline must label the target comparison version");
assert(!appJs.includes("비교할 commit"), "history compare status must not use developer commit wording");
assert(!appJs.includes("같은 commit"), "history compare errors must not use developer commit wording");
assert(appJs.includes("syncCompareModeButtons"), "app.js must keep split/unified segmented controls in sync");
assert(!appJs.includes("sideLoadHistoryButton"), "app.js must not bind a removed right history load button");
assert(!appJs.includes("sideHistoryList"), "app.js must not render removed right-panel history rows");
assert(!appJs.includes("sideHistoryTimeline"), "app.js must not render removed right-panel history timeline");
assert(!appJs.includes('tab === "compare"'), "app.js must not depend on a separate compare tab");
assert(!appJs.includes('rightHistoryTab'), "app.js must not depend on the removed right-panel history tab");
assert(!appJs.includes("File System Access 가능"), "app.js must not render the normal topbar source status");
assert(!appJs.includes("GitHub 원문은"), "settings must not render the fixed GitHub source note");
assert(appJs.includes("변경 내역을 불러오는 중"), "app.js must use the updated history loading label");
assert(appJs.includes("현재 ${escapeHtml(documentTypeLabel())} 문서에 첨부 파일이 없습니다."), "attachment empty state must name the current document type");
assert(appJs.includes("현재 ${escapeHtml(documentTypeLabel())} 문서에 포함된 링크가 없습니다."), "reference empty state must name the current document type");
assert(appJs.includes("renderReferences"), "app.js must render outgoing references");
assert(appJs.includes("loadPdfjs"), "app.js must load the integrated PDF.js viewer");
assert(appJs.includes("loadRhwp"), "app.js must load the integrated rhwp viewer");
assert(appJs.includes("renderPageSvg"), "app.js must render HWP/HWPX pages through rhwp");
assert(appJs.includes("getDocument"), "app.js must render PDFs through PDF.js");
assert(appJs.includes("data-attachment-action"), "app.js must bind attachment preview and download actions");
assert(appJs.includes("attachmentPreviewFile"), "app.js must remember the currently previewed attachment");
assert(appJs.includes("downloadAttachmentPreview"), "app.js must bind the preview header download action");
assert(appJs.includes('state.attachmentPreviewFile = null'), "app.js must clear the preview download target when preview closes");
assert(appJs.includes('$("downloadAttachmentPreview").disabled = true'), "app.js must disable preview downloads with no selected attachment");
assert(appJs.includes('$("downloadAttachmentPreview").disabled = false'), "app.js must enable preview downloads for the selected attachment");
assert(appJs.includes("fetchAttachmentThroughRuntime"), "app.js must fetch attachments through the extension service worker");
assert(appJs.includes('type: "fetch-attachment"'), "app.js must use the service worker attachment fetch message");
assert(appJs.includes("base64ToArrayBuffer"), "app.js must decode service worker attachment bytes");
assert(appJs.includes("fetchAttachmentDirect"), "app.js must support direct attachment fetches for DNR-enabled downloads");
assert(appJs.includes("fetchAttachmentThroughProxy"), "app.js must keep the service worker fetch proxy as a fallback for attachments");
assert(appJs.includes('fetch(file.url, { credentials: "omit" })'), "direct attachment fallback fetches must omit credentials");
assert(
  appJs.indexOf("return await fetchAttachmentDirect(file)") < appJs.indexOf("const proxyResult = await fetchAttachmentThroughProxy(file)"),
  "attachment fetches must try the direct DNR-enabled path before service worker fallbacks"
);
assert(appJs.includes("resetAttachmentPreviewHost"), "app.js must preserve the preview panel when attachments rerender");
assert(appJs.includes("placeAttachmentPreview"), "app.js must move preview panels below the clicked attachment");
assert(appJs.includes("previewAttachment(file, button)"), "attachment previews must receive the clicked button as placement target");
assert(appJs.includes("sendRuntimeMessageOnce"), "app.js must wrap runtime messages so lastError can be handled");
assert(appJs.includes("isMissingRuntimeReceiverError"), "app.js must detect missing service worker receivers");
assert(appJs.includes("첨부 파일 프록시가 연결되지 않았습니다"), "runtime receiver failures must show an actionable attachment proxy error");
assert(appJs.includes("openTocTarget"), "TOC clicks must switch to the body tab before scrolling");
assert(appJs.includes('data-anchor="${escapeHtml(item.anchor)}"'), "TOC links must carry a stable anchor target");
assert(appJs.includes("skipTitleHeading"), "app.js must avoid rendering the document title twice");
assert(appJs.includes("renderMarkdown(body, { skipFirstHeading: skipTitleHeading })"), "document body must skip duplicate title heading");
assert(appJs.includes("renderToc(body, { skipFirstHeading: skipTitleHeading })"), "TOC must skip duplicate title heading with the body");
assert(!appJs.includes("<em>${escapeHtml(entry.path)}</em>"), "tree rows must not visibly repeat full paths");
assert(!appJs.includes("<em>${escapeHtml(item.path)}</em>"), "metadata rows must not visibly repeat full paths");

const markdown = "---\n제목: 형법\n법령ID: '001692'\n---\n# 형법\n\n##### 제1조 (목적)\n본문\n\n[별표](files/별표.hwpx)";
const parsed = splitFrontmatter(markdown);
assert(parsed.frontmatter["제목"] === "형법", "frontmatter title parse failed");
assert(extractToc(parsed.body).some((item) => item.title.includes("제1조")), "TOC must include article heading");
const nestedTitleMarkdown =
  "---\n제목: 건축법 시행령\n첨부파일:\n- 별표번호: '0015'\n  제목: 과태료의 부과기준(제121조 관련)\n---\n# 건축법 시행령\n\n## 제1장 총칙";
const nestedTitleParsed = splitFrontmatter(nestedTitleMarkdown);
assert(nestedTitleParsed.frontmatter["제목"] === "건축법 시행령", "nested frontmatter titles must not overwrite document title");
assert(!renderMarkdown(nestedTitleParsed.body, { skipFirstHeading: true }).includes("<h1"), "document title heading must render only in the document header");
assert(
  extractToc(nestedTitleParsed.body, { skipFirstHeading: true }).every((item) => item.title !== "건축법 시행령"),
  "document title heading must not remain in the side TOC when skipped from the body"
);
const paragraphOnlyArticle = "제16조제3항에 따라 구조된 사람을 인도한다.";
assert(extractToc(paragraphOnlyArticle).length === 0, "TOC must be generated from markdown headings only");
assert(!renderMarkdown(paragraphOnlyArticle).includes("<h5"), "plain article references must not be promoted to headings");
assert(renderMarkdown("1\\. 구조된 사람").includes("1. 구조된 사람"), "markdown parser must render escaped ordered-list markers without a backslash");
assert(renderMarkdown("1. 첫째\n2. 둘째").includes("<ol>"), "markdown parser must render ordered lists");
const commitMessageMarkdown =
  "법률: 박물관및미술관진흥법 (제정)\n\n법령 전문: [https://www.law.go.kr/법령/박물관및미술관진흥법](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EB%B0%95%EB%AC%BC%EA%B4%80%EB%B0%8F%EB%AF%B8%EC%88%A0%EA%B4%80%EC%A7%84%ED%9D%A5%EB%B2%95)\n제개정문: [https://www.law.go.kr/법령/제개정문/박물관및미술관진흥법/(04410,19911130)](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%A0%9C%EA%B0%9C%EC%A0%95%EB%AC%B8/%EB%B0%95%EB%AC%BC%EA%B4%80%EB%B0%8F%EB%AF%B8%EC%88%A0%EA%B4%80%EC%A7%84%ED%9D%A5%EB%B2%95/(04410,19911130\\))";
assert(renderMarkdown(commitMessageMarkdown).includes("<a href="), "commit message markdown links must render as links");
const attachmentBase = "https://raw.githubusercontent.com/legalize-kr/legalize-kr/main/kr/형법/법률.md";
const hwpAttachments = extractAttachments(markdown, attachmentBase);
assert(hwpAttachments[0].extension === "hwpx", "attachment detection failed");
const hwpAttachmentHtml = renderAttachmentList(hwpAttachments);
assert(hwpAttachmentHtml.includes('data-attachment-action="preview"'), "HWP/HWPX attachments must support integrated preview");
assert(!hwpAttachmentHtml.includes('data-attachment-action="download"'), "attachment rows must not duplicate preview-scoped downloads");
assert(hwpAttachmentHtml.includes("#icon-file-hwp"), "HWP/HWPX attachments must render an HWP icon");
assert(hwpAttachmentHtml.includes("%EB%B3%84%ED%91%9C.hwpx"), "HWP/HWPX fallback must keep attachment URL");
const frontmatterAttachmentMarkdown = `---
첨부파일:
  - 제목: '[별지 제1호서식] 청송군 자율방재단 가입신청서'
    파일형식: 'hwp'
    파일링크: 'http://www.law.go.kr/flDownload.do?gubun=ELIS&flSeq=152050071&flNm=%5B%EB%B3%84%EC%A7%80+%EC%A0%9C1%ED%98%B8%EC%84%9C%EC%8B%9D%5D+%EC%B2%AD%EC%86%A1%EA%B5%B0+%EC%9E%90%EC%9C%A8%EB%B0%A9%EC%9E%AC%EB%8B%A8+%EA%B0%80%EC%9E%85%EC%8B%A0%EC%B2%AD%EC%84%9C'
  - 제목: '[별지 제6호서식] 보상청구서.hwp'
    파일형식: 'hwp'
    파일링크: 'http://www.law.go.kr/flDownload.do?gubun=ELIS&flSeq=152050081&flNm=%5B%EB%B3%84%EC%A7%80+%EC%A0%9C6%ED%98%B8%EC%84%9C%EC%8B%9D%5D+%EB%B3%B4%EC%83%81%EC%B2%AD%EA%B5%AC%EC%84%9C.hwp'
---`;
const frontmatterAttachments = extractAttachments(frontmatterAttachmentMarkdown);
assert(frontmatterAttachments.length === 2, "frontmatter file links must be detected as attachments");
assert(frontmatterAttachments.every((item) => item.extension === "hwp"), "frontmatter file links must use explicit file type");
assert(frontmatterAttachments[0].label.includes("가입신청서"), "frontmatter attachment title must be used as label");
assert(
  renderAttachmentList(frontmatterAttachments).includes('data-attachment-action="preview"'),
  "frontmatter HWP preview action missing"
);
const lawFrontmatterAttachmentMarkdown = `---
첨부파일:
- 별표번호: '0002'
  별표구분: 별표
  제목: 건축허가신청에 필요한 설계도서(제6조제1항 관련)
  파일링크: https://www.law.go.kr/LSW/flDownload.do?flSeq=161989843
  PDF링크: https://www.law.go.kr/LSW/flDownload.do?flSeq=161989845
---`;
const lawFrontmatterAttachments = extractAttachments(lawFrontmatterAttachmentMarkdown);
assert(lawFrontmatterAttachments.length === 1, "law.go.kr frontmatter file and PDF links must be grouped as one attachment");
assert(lawFrontmatterAttachments[0].files.some((item) => item.extension === "hwp"), "law.go.kr file links must fall back to HWP attachments");
assert(lawFrontmatterAttachments[0].files.some((item) => item.extension === "pdf"), "law.go.kr PDF links must be detected as PDF attachments");
assert(
  lawFrontmatterAttachments.every((item) => item.label.includes("건축허가신청")),
  "law.go.kr frontmatter attachment title must be used as label"
);
const lawFrontmatterAttachmentHtml = renderAttachmentList(lawFrontmatterAttachments);
assert(lawFrontmatterAttachmentHtml.includes("#icon-file-hwp"), "grouped law.go.kr attachment must render an HWP icon");
assert(lawFrontmatterAttachmentHtml.includes("#icon-file-pdf"), "grouped law.go.kr attachment must render a PDF icon");
assert(lawFrontmatterAttachmentHtml.includes('class="attachment-row"'), "grouped law.go.kr attachment must render as one attachment row");
assert(lawFrontmatterAttachmentHtml.includes("attachment-action-label\">바로보기"), "grouped law.go.kr attachment must show preview action group");
assert(!lawFrontmatterAttachmentHtml.includes("attachment-action-label\">다운로드"), "grouped law.go.kr attachment downloads must be scoped to the preview panel");
assert(!lawFrontmatterAttachmentHtml.includes('class="attachment-file"'), "grouped law.go.kr attachment must not split HWP and PDF into separate rows");
assert(
  renderAttachmentList([{ label: "도면", files: [{ label: "도면", url: "https://example.com/drawing.pdf", extension: "pdf" }] }]).includes(
    'data-attachment-action="preview"'
  ),
  "PDF attachment preview action missing"
);
assert(renderAttachmentList([]).includes("인식된 첨부 링크가 없습니다"), "empty attachment state missing");
const references = extractReferences(
  `${markdown}\n[민법](../민법/법률.md)\n[외부](https://example.com/ref)`,
  attachmentBase,
  "kr/형법/법률.md"
);
assert(references.some((item) => item.targetPath === "kr/민법/법률.md"), "relative markdown reference parse failed");
assert(references.some((item) => item.kind === "external"), "external reference parse failed");
assert(!references.some((item) => item.label === "별표"), "attachments must not be duplicated as references");
const hwpQueryReferences = extractReferences(
  "[별지](http://www.law.go.kr/flDownload.do?gubun=ELIS&flNm=%5B%EB%B3%84%EC%A7%80%5D+%EB%B3%B4%EC%83%81%EC%B2%AD%EA%B5%AC%EC%84%9C.hwp)",
  attachmentBase,
  "kr/형법/법률.md"
);
assert(hwpQueryReferences.length === 0, "query filename attachments must not be duplicated as references");

const diff = wordDiff("제1조 목적", "제1조 취지");
assert(diff.some((item) => item.type === "remove"), "diff remove segment missing");
assert(diff.some((item) => item.type === "add"), "diff add segment missing");
assert(buildDiffRows("##### 제1조 (목적)\n구문", "##### 제1조 (목적)\n새 구문")[0].unit === "article", "article diff missing");
assert(buildDiffRows("판례 본문 A", "판례 본문 B")[0].unit === "document", "document diff fallback missing");
const headingArticle = articleSections("###### 제4조 (결정의 고지와 통지) **①** 본문");
assert(headingArticle[0].title === "제4조 (결정의 고지와 통지)", "article heading title parse failed");
assert(headingArticle[0].text === "**①** 본문", "article heading line must not remain in diff text");
const plainArticle = articleSections("제3조 (다른 규칙의 개정) 가정보호심판규칙 제15조를 삭제한다.");
assert(plainArticle[0].text === "가정보호심판규칙 제15조를 삭제한다.", "plain article title must not remain in diff text");
assert(articleSections("제29조제1항제4호를 제5호로 한다.").length === 0, "article references must not be split as articles");
const articleDiffRows = buildDiffRows("##### 제1조 (목적)\n이전 구문\n\n##### 제2조 (정의)\n같음", "##### 제1조 (목적)\n새 구문\n\n##### 제2조 (정의)\n같음");
assert(renderDiff(articleDiffRows, { mode: "split", onlyChanged: true }).includes('class="diff-row split"'), "split diff render missing");
assert(renderDiff(articleDiffRows, { mode: "unified", onlyChanged: true }).includes('class="diff-row unified"'), "unified diff render missing");
assert(renderDiff(articleDiffRows, { mode: "unified", onlyChanged: true }).includes("<del>"), "unified diff must mark removed text with del");
assert(!renderDiff(articleDiffRows, { mode: "split", onlyChanged: true }).includes("제2조"), "changed-only diff must hide unchanged articles");
assert(renderDiff(articleDiffRows, { mode: "split", onlyChanged: false }).includes("제2조"), "full diff must include unchanged articles");

assert(
  rawUrl({ owner: "legalize-kr", repo: "legalize-kr", ref: "main", path: "kr/형법/법률.md" }).includes(
    "raw.githubusercontent.com"
  ),
  "raw URL build failed"
);
assert(
  githubBlobUrl({ owner: "legalize-kr", repo: "legalize-kr", ref: "main", path: "kr/형법/법률.md" }).includes(
    "/blob/main/"
  ),
  "GitHub blob URL build failed"
);
assert(
  localBridgeCommitsUrl({ bridgeUrl: "http://127.0.0.1:8765", repo: "legalize-kr", path: "kr/형법/법률.md" }).includes(
    "/api/commits"
  ),
  "local bridge commits URL build failed"
);
const tokenHeaders = githubHeaders("sample-token", "application/vnd.github.raw");
assert(tokenHeaders.Accept === "application/vnd.github.raw", "GitHub Accept header override failed");
assert(tokenHeaders.Authorization === ["Bearer", "sample-token"].join(" "), "GitHub token header build failed");
assert(!("Authorization" in githubHeaders("", "application/vnd.github.raw")), "empty GitHub token must not set auth header");
assert(githubTokenForRequest("sample-token") === "sample-token", "ASCII GitHub token normalization failed");
assert(githubTokenForRequest("한글-token") === "", "non-ASCII GitHub token must not be sent as a request header");
assert(!("Authorization" in githubHeaders("한글-token", "application/vnd.github.raw")), "invalid GitHub token must not set auth header");

function memoryKeyValueStorage() {
  const data = {};
  return {
    data,
    getItem(key) {
      return data[key] ?? null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    }
  };
}

globalThis.sessionStorage = memoryKeyValueStorage();
let metadataFetchCount = 0;
globalThis.chrome = {
  runtime: {
    getURL(path) {
      return `chrome-extension://hceodioeamflhfelpepcimgjpbgoooaf/${path}`;
    }
  }
};
globalThis.fetch = async (url) => {
  metadataFetchCount += 1;
  const target = String(url);
  if (target.endsWith("/metadata/index.json")) {
    return new Response(
      JSON.stringify({
        generatedAt: "2026-06-30T00:00:00Z",
        sourceRef: "main",
        shards: { "legalize-kr": { path: "metadata/legalize-kr.json", count: 1 } }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (target.endsWith("/metadata/legalize-kr.json")) {
    return new Response(
      JSON.stringify({
        documents: [
          {
            title: "형법",
            path: "kr/형법/법률.md",
            kind: "법률"
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response("not found", { status: 404 });
};
const metadataManifest = await loadMetadataManifest();
assert(metadataManifest.sourceRef === "main", "metadata manifest load failed");
const metadataShard = await loadMetadataShard("legalize-kr");
assert(metadataShard.documents[0]?.path === "kr/형법/법률.md", "metadata shard load failed");
assert(filterMetadataDocuments(metadataShard.documents, "형법")[0]?.title === "형법", "metadata filter failed");
await loadMetadataShard("legalize-kr");
assert(metadataFetchCount === 2, "metadata shard should be cached after lazy load");

let githubFetchCount = 0;
globalThis.fetch = async (url) => {
  githubFetchCount += 1;
  const target = String(url);
  if (target.includes("/commits")) {
    return new Response(
      JSON.stringify([
        {
          sha: "feedface123456",
          html_url: "https://github.com/legalize-kr/legalize-kr/commit/feedface123456",
          commit: {
            message: "GitHub history\n\n법령 전문: [https://www.law.go.kr/법령/형법](https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%ED%98%95%EB%B2%95)",
            author: { name: "legalize-kr-bot", date: "2026-01-03T00:00:00Z" }
          }
        }
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (target.includes("/contents/")) {
    return new Response(
      JSON.stringify([
        {
          type: "file",
          name: "법률.md",
          path: "kr/형법/법률.md",
          sha: "blob123",
          size: 12,
          html_url: "https://github.com/legalize-kr/legalize-kr/blob/main/kr/형법/법률.md",
          download_url: "https://raw.githubusercontent.com/legalize-kr/legalize-kr/main/kr/형법/법률.md"
        }
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response("# cached markdown", { status: 200, headers: { "content-type": "text/markdown" } });
};

await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법", ref: "main", token: "" });
await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법", ref: "main", token: "" });
assert(githubFetchCount === 1, "tokenless GitHub tree requests should use session cache");
githubFetchCount = 0;
await fetchGithubMarkdown({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법/법률.md", ref: "main", token: "" });
await fetchGithubMarkdown({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법/법률.md", ref: "main", token: "" });
assert(githubFetchCount === 1, "tokenless GitHub markdown requests should use session cache");
githubFetchCount = 0;
const githubHistory = await fetchGithubHistory({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법/법률.md", token: "" });
await fetchGithubHistory({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법/법률.md", token: "" });
assert(githubFetchCount === 1, "tokenless GitHub history requests should use session cache");
assert(githubHistory[0]?.message === "GitHub history", "GitHub history rows must keep a short message title");
assert(githubHistory[0]?.messageBody?.includes("법령 전문"), "GitHub history rows must preserve the full commit message");
githubFetchCount = 0;
await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법", ref: "main", token: "sample-token" });
await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법", ref: "main", token: "sample-token" });
assert(githubFetchCount === 2, "authenticated GitHub requests must bypass session cache");
globalThis.sessionStorage = memoryKeyValueStorage();
githubFetchCount = 0;
await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법", ref: "main", token: "한글-token" });
await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr/형법", ref: "main", token: "한글-token" });
assert(githubFetchCount === 1, "invalid GitHub tokens must be treated as unauthenticated cacheable requests");

globalThis.sessionStorage = memoryKeyValueStorage();
let largeTreeFallbackCount = 0;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/contents/kr?")) {
    return new Response(
      JSON.stringify({
        type: "dir",
        name: "kr",
        path: "kr",
        entries: Array.from({ length: 1000 }, (_, index) => ({
          type: "dir",
          name: `법령${index}`,
          path: `kr/법령${index}`,
          sha: `dir${index}`
        }))
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (target.includes("/contents/?")) {
    return new Response(
      JSON.stringify({
        entries: [
          {
            type: "dir",
            name: "kr",
            path: "kr",
            sha: "large-tree-sha"
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (target.includes("/git/trees/large-tree-sha")) {
    largeTreeFallbackCount += 1;
    return new Response(
      JSON.stringify({
        tree: Array.from({ length: 1001 }, (_, index) => ({
          type: "tree",
          path: `법령${index}`,
          sha: `tree${index}`
        })),
        truncated: false
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response("not found", { status: 404 });
};
const largeTreeEntries = await listGithubTree({ owner: "legalize-kr", repo: "legalize-kr", path: "kr", ref: "main", token: "" });
assert(largeTreeFallbackCount === 1, "large GitHub contents responses must fall back to Git Trees API");
assert(largeTreeEntries.length === 1001, "Git Trees fallback must return the full direct child list");
assert(largeTreeEntries[1000]?.path === "kr/법령1000", "Git Trees fallback must keep full repository paths");

globalThis.fetch = async () =>
  new Response(
    JSON.stringify([
      {
        sha: "abcdef123456",
        shortSha: "abcdef1",
        date: "2026-01-02T03:04:05Z",
        message: "법령 개정",
        author: "bot",
        htmlUrl: "http://127.0.0.1:8765/api/commit?repo=legalize-kr&sha=abcdef123456",
        rawUrl: "http://127.0.0.1:8765/api/raw?repo=legalize-kr&path=kr/형법/법률.md&ref=abcdef123456"
      }
    ]),
    { status: 200, headers: { "content-type": "application/json" } }
  );
const localHistory = await fetchLocalBridgeHistory({
  bridgeUrl: "http://127.0.0.1:8765",
  repo: "legalize-kr",
  path: "kr/형법/법률.md"
});
assert(localHistory[0]?.sha === "abcdef123456", "local bridge history response parse failed");

function memoryStorageArea() {
  const data = {};
  return {
    data,
    get(key, callback) {
      callback({ [key]: data[key] });
    },
    set(items, callback) {
      Object.assign(data, items);
      callback();
    },
    remove(key, callback) {
      delete data[key];
      callback();
    }
  };
}

const localArea = memoryStorageArea();
const sessionArea = memoryStorageArea();
globalThis.chrome = {
  runtime: { lastError: undefined },
  storage: {
    local: localArea,
    session: sessionArea
  }
};
globalThis.localStorage = memoryKeyValueStorage();

assert(normalizeTheme("light") === "light", "light theme normalization failed");
assert(normalizeTheme("dark") === "dark", "dark theme normalization failed");
assert(normalizeTheme("unexpected") === "system", "unknown theme must fallback to system");
assert(defaultSettings.fontSize === 16, "content font size default must be 16px");
assert(defaultSettings.leftPanelFontSize === 16, "left panel font size default must be 16px");
assert(defaultSettings.rightPanelFontSize === 16, "right panel font size default must be 16px");
assert(normalizeFontSize(undefined) === 16, "missing font size must default to 16px");
assert(normalizeFontSize("14") === 14, "minimum font size normalization failed");
assert(normalizeFontSize("22") === 22, "maximum font size normalization failed");
assert(normalizeFontSize("99") === 22, "font size normalization must clamp large values");
assert(normalizeFontSize("bad") === 16, "invalid font size normalization must use default");
assert(normalizeFontSize("bad", 14) === 14, "invalid panel font size normalization must use panel default");
await saveSettings({
  githubOwner: "custom-owner",
  githubRef: "feature-ref",
  githubToken: "must-not-be-saved",
  tokenStorage: "session",
  theme: "light",
  fontSize: 18,
  leftPanelFontSize: 15,
  rightPanelFontSize: 17,
  localFolderName: "local-laws"
});
const loadedSettings = await loadSettings();
assert(!JSON.stringify(localArea.data).includes("must-not-be-saved"), "settings must not persist githubToken");
assert(loadedSettings.githubOwner === "legalize-kr", "GitHub owner must be fixed");
assert(loadedSettings.githubRef === "main", "GitHub ref must be fixed");
assert(loadedSettings.tokenStorage === "local", "token storage compatibility value must stay local");
assert(loadedSettings.theme === "light", "settings must persist theme");
assert(loadedSettings.fontSize === 18, "settings must persist content font size");
assert(loadedSettings.leftPanelFontSize === 15, "settings must persist left panel font size");
assert(loadedSettings.rightPanelFontSize === 17, "settings must persist right panel font size");
assert(loadedSettings.localFolderName === "local-laws", "settings must persist selected local folder label");

const githubTokenKey = "legalize.viewer.plugins.githubToken";
await saveToken("persistent-secret");
assert((await loadToken()) === "persistent-secret", "GitHub token must load from localStorage");
assert(JSON.stringify(globalThis.localStorage.data).includes("persistent-secret"), "GitHub token must persist in localStorage");
assert(!JSON.stringify(localArea.data).includes("persistent-secret"), "GitHub token must not persist in chrome.storage.local");
assert(!JSON.stringify(sessionArea.data).includes("persistent-secret"), "GitHub token must not persist in chrome.storage.session");
globalThis.localStorage.removeItem(githubTokenKey);
localArea.data[githubTokenKey] = "legacy-local-secret";
assert((await loadToken()) === "legacy-local-secret", "legacy local chrome token must remain readable");
await saveToken("persistent-secret");
assert(!JSON.stringify(localArea.data).includes("legacy-local-secret"), "saving localStorage token must clear legacy local token");
sessionArea.data[githubTokenKey] = "legacy-session-secret";
await clearToken();
assert((await loadToken()) === "", "clearToken must remove localStorage token");
assert(!JSON.stringify(sessionArea.data).includes("legacy-session-secret"), "clearToken must remove legacy session token");

const originalChrome = globalThis.chrome;
const originalSelf = globalThis.self;
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
let serviceWorkerFetchHandler = null;
let serviceWorkerMessageHandler = null;
globalThis.chrome = {
  action: { onClicked: { addListener() {} } },
  tabs: { create() {} },
  runtime: {
    getURL(path) {
      return `chrome-extension://hceodioeamflhfelpepcimgjpbgoooaf/${path}`;
    },
    onMessage: {
      addListener(handler) {
        serviceWorkerMessageHandler = handler;
      }
    }
  }
};
globalThis.self = {
  addEventListener(type, handler) {
    if (type === "fetch") serviceWorkerFetchHandler = handler;
  }
};
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { origin: "chrome-extension://hceodioeamflhfelpepcimgjpbgoooaf" }
});
globalThis.fetch = async () =>
  new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=test.pdf"
    }
  });
await import(`../extension/service-worker.js?test=${Date.now()}`);
assert(serviceWorkerMessageHandler, "service worker must register a runtime message handler");
assert(serviceWorkerFetchHandler, "service worker must register a fetch proxy handler");
let proxyResponsePromise = null;
serviceWorkerFetchHandler({
  request: {
    url:
      "chrome-extension://hceodioeamflhfelpepcimgjpbgoooaf/__legalize_attachment__?url=" +
      encodeURIComponent("https://www.law.go.kr/LSW/flDownload.do?flSeq=1")
  },
  respondWith(promise) {
    proxyResponsePromise = promise;
  }
});
const proxyResponse = await proxyResponsePromise;
assert(proxyResponse.ok, "service worker proxy response must be successful");
assert(proxyResponse.headers.get("content-type") === "application/pdf", "service worker proxy must preserve content type");
assert(proxyResponse.headers.get("x-content-disposition")?.includes("test.pdf"), "service worker proxy must expose filename metadata");
assert((await proxyResponse.arrayBuffer()).byteLength === 4, "service worker proxy must return attachment bytes");
globalThis.chrome = originalChrome;
globalThis.self = originalSelf;
globalThis.fetch = originalFetch;
if (originalLocation) {
  Object.defineProperty(globalThis, "location", originalLocation);
} else {
  delete globalThis.location;
}

console.log("legalize-kr-viewer tests passed");
