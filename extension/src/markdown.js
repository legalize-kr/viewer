const attachmentPattern = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const rawUrlPattern = /https?:\/\/[^\s'"<>]+/g;
const attachmentExtensions = new Set(["hwp", "hwpx", "pdf", "png", "jpg", "jpeg", "gif", "webp"]);
const articlePattern = /^(#{1,6}\s*)?(제\s*\d+\s*조(?:의\s*\d+)?)(?=$|\s|\()(?:\s*\(([^)]*)\))?/;

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function splitFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: {}, body: markdown };
  }
  const raw = markdown.slice(4, end).trim();
  const body = markdown.slice(end + 4).replace(/^\n/, "");
  const frontmatter = {};
  for (const line of raw.split("\n")) {
    if (/^\s/.test(line) || line.startsWith("-")) continue;
    const index = line.indexOf(":");
    if (index > 0) {
      frontmatter[line.slice(0, index).trim()] = cleanYamlScalar(line.slice(index + 1));
    }
  }
  return { frontmatter, body };
}

export function slugify(text, index) {
  return `${text.replace(/\s+/g, "-").replace(/[^\p{Letter}\p{Number}_-]/gu, "") || "section"}-${index}`;
}

export function extractToc(markdown, { skipFirstHeading = false } = {}) {
  const toc = [];
  let skippedHeading = false;
  markdown.split("\n").forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      if (skipFirstHeading && !skippedHeading) {
        skippedHeading = true;
        return;
      }
      toc.push({ level: heading[1].length, title: heading[2].replace(/[#*_`]/g, "").trim(), anchor: slugify(heading[2], index) });
      skippedHeading = true;
    }
  });
  return toc;
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1");
  return html;
}

function markdownItFactory() {
  return typeof globalThis.markdownit === "function" ? globalThis.markdownit : null;
}

function markdownWithoutFirstHeading(markdown) {
  let removed = false;
  return markdown
    .split("\n")
    .filter((line) => {
      if (!removed && /^(#{1,6})\s+(.+?)\s*#*$/.test(line)) {
        removed = true;
        return false;
      }
      return true;
    })
    .join("\n");
}

function renderWithMarkdownIt(markdown, { skipFirstHeading = false } = {}) {
  const createMarkdownIt = markdownItFactory();
  if (!createMarkdownIt) return "";
  const toc = extractToc(markdown, { skipFirstHeading });
  const parser = createMarkdownIt({
    html: false,
    linkify: true,
    typographer: false
  });
  let headingIndex = 0;
  parser.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
    const item = toc[headingIndex++];
    if (item?.anchor) tokens[index].attrSet("id", item.anchor);
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noreferrer");
    return renderer.renderToken(tokens, index, options);
  };
  return parser.render(skipFirstHeading ? markdownWithoutFirstHeading(markdown) : markdown);
}

function renderBasicMarkdown(markdown, { skipFirstHeading = false } = {}) {
  const lines = markdown.split("\n");
  const toc = extractToc(markdown, { skipFirstHeading });
  let tocIndex = 0;
  let skippedHeading = false;
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  lines.forEach((line) => {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      closeList();
      if (skipFirstHeading && !skippedHeading) {
        skippedHeading = true;
        return;
      }
      const item = toc[tocIndex++];
      skippedHeading = true;
      html.push(`<h${heading[1].length} id="${item?.anchor ?? ""}">${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      return;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`);
      return;
    }
    if (!line.trim()) {
      closeList();
      return;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  });
  closeList();
  return html.join("\n");
}

export function renderMarkdown(markdown, options = {}) {
  return renderWithMarkdownIt(markdown, options) || renderBasicMarkdown(markdown, options);
}

function cleanYamlScalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function decodeAttachmentFilename(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function attachmentLabelFromHref(href, fallback = "첨부파일") {
  try {
    const url = new URL(href, "https://example.invalid/");
    const filename = url.searchParams.get("flNm") || url.searchParams.get("filename") || url.searchParams.get("fileName");
    if (filename) return cleanAttachmentLabel(decodeAttachmentFilename(filename));
    return cleanAttachmentLabel(decodeAttachmentFilename(url.pathname.split("/").pop() || fallback));
  } catch {
    return fallback;
  }
}

function cleanAttachmentLabel(value) {
  return value
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extensionFromFilename(value) {
  const extension = value.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return attachmentExtensions.has(extension) ? extension : "";
}

function attachmentExtensionFromHref(href, fallbackExtension = "") {
  const fallback = fallbackExtension.toLowerCase();
  const clean = href.split(/[?#]/)[0];
  const pathExtension = extensionFromFilename(clean);
  if (pathExtension) return pathExtension;
  try {
    const url = new URL(href, "https://example.invalid/");
    const filename = url.searchParams.get("flNm") || url.searchParams.get("filename") || url.searchParams.get("fileName") || "";
    const filenameExtension = extensionFromFilename(decodeAttachmentFilename(filename));
    if (filenameExtension) return filenameExtension;
  } catch {
    // Ignore invalid URLs and fall back to the explicit metadata extension.
  }
  return attachmentExtensions.has(fallback) ? fallback : "";
}

function normalizeAttachmentUrl(href, baseUrl) {
  try {
    return /^https?:\/\//i.test(href) ? href : new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

export function extractAttachments(markdown, baseUrl = "") {
  const out = new Map();
  const seenUrls = new Set();
  const addAttachment = (label, href, fallbackExtension = "", groupKey = "") => {
    const extension = attachmentExtensionFromHref(href, fallbackExtension);
    if (!extension) return;
    const url = normalizeAttachmentUrl(href, baseUrl);
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    const normalizedLabel = cleanAttachmentLabel(label || attachmentLabelFromHref(href));
    const key = groupKey || `${normalizedLabel}:${url}`;
    const group = out.get(key) ?? { label: normalizedLabel, files: [] };
    if (!group.files.some((item) => item.url === url)) {
      group.files.push({ label: normalizedLabel, url, extension });
    }
    if (!out.has(key)) {
      out.set(key, group);
    }
  };

  for (const match of markdown.matchAll(attachmentPattern)) {
    const label = match[1].trim();
    const href = match[2].trim();
    addAttachment(label, href, "", `markdown:${href}`);
  }

  let pendingTitle = "";
  let pendingExtension = "";
  let frontmatterItemIndex = -1;
  for (const line of markdown.split("\n")) {
    if (/^\s*-\s+/.test(line)) {
      pendingTitle = "";
      pendingExtension = "";
      frontmatterItemIndex += 1;
    }
    const title = /^\s*(?:-\s*)?제목:\s*(.+)$/.exec(line);
    if (title) {
      pendingTitle = cleanAttachmentLabel(cleanYamlScalar(title[1]));
      continue;
    }
    const fileType = /^\s*(?:-\s*)?파일형식:\s*(.+)$/.exec(line);
    if (fileType) {
      pendingExtension = cleanYamlScalar(fileType[1]);
      continue;
    }
    const fileLink = /^\s*(?:-\s*)?(파일링크|PDF링크):\s*(.+)$/.exec(line);
    if (fileLink) {
      const href = cleanYamlScalar(fileLink[2]);
      const fallbackExtension = pendingExtension || (fileLink[1] === "PDF링크" ? "pdf" : "hwp");
      const label = pendingTitle || attachmentLabelFromHref(href);
      addAttachment(label, href, fallbackExtension, `frontmatter:${frontmatterItemIndex}:${label}`);
      if (pendingExtension) pendingExtension = "";
      continue;
    }
  }

  for (const match of markdown.matchAll(rawUrlPattern)) {
    const href = match[0].trim();
    addAttachment(attachmentLabelFromHref(href), href, "", `raw:${href}`);
  }
  return [...out.values()].map((item) => ({
    ...item,
    extension: item.files[0]?.extension ?? "",
    url: item.files[0]?.url ?? ""
  }));
}

export function renderAttachmentList(attachments) {
  if (!attachments.length) {
    return '<div class="empty-state small">인식된 첨부 링크가 없습니다.</div>';
  }
  return attachments
    .map((item) => {
      const files = item.files?.length ? item.files : [item];
      const buttons = files
        .map((file) => {
          const extension = file.extension.toLowerCase();
          const type = extension === "pdf" ? "pdf" : "hwp";
          const label = extension.toUpperCase();
          return `<button class="attachment-format-button ${type}" type="button" data-attachment-action="preview" data-url="${escapeHtml(
            file.url
          )}" data-extension="${escapeHtml(extension)}" data-label="${escapeHtml(item.label)}" title="${escapeHtml(
            `바로보기 ${label}`
          )}"><svg aria-hidden="true" focusable="false"><use href="#icon-file-${type}"></use></svg><span>${escapeHtml(
            label
          )}</span></button>`;
        })
        .join("");
      const actionGroup = `<div class="attachment-action-group"><span class="attachment-action-label">바로보기</span><span class="attachment-format-buttons">${buttons}</span></div>`;
      return `<div class="attachment"><div class="attachment-row"><strong class="attachment-title">${escapeHtml(
        item.label
      )}</strong><div class="attachment-action-groups">${actionGroup}</div></div></div>`;
    })
    .join("");
}

function normalizeRelativePath(currentPath, href) {
  const clean = href.split(/[?#]/)[0];
  const base = currentPath.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      base.pop();
    } else {
      base.push(part);
    }
  }
  return base.join("/");
}

export function extractReferences(markdown, baseUrl = "", currentPath = "") {
  const out = new Map();
  for (const match of markdown.matchAll(attachmentPattern)) {
    const label = match[1].trim();
    const href = match[2].trim();
    const clean = href.split(/[?#]/)[0];
    if (attachmentExtensionFromHref(href)) continue;
    if (/^(mailto|tel):/i.test(href)) continue;

    let url = href;
    try {
      url = /^https?:\/\//i.test(href) || href.startsWith("#") ? href : new URL(href, baseUrl).toString();
    } catch {
      url = href;
    }

    const targetPath = !/^https?:\/\//i.test(href) && clean.toLowerCase().endsWith(".md")
      ? normalizeRelativePath(currentPath, href)
      : "";
    const kind = targetPath ? "viewer" : href.startsWith("#") ? "anchor" : /^https?:\/\//i.test(href) ? "external" : "relative";
    out.set(`${kind}:${url}:${targetPath}`, { label, href, url, targetPath, kind });
  }
  return [...out.values()];
}

export function articleSections(markdown) {
  const lines = markdown.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    const match = articlePattern.exec(line.trim());
    if (match) {
      starts.push({ index, articleNo: match[2].replace(/\s+/g, ""), heading: match[3]?.trim() ?? "" });
    }
  });
  return starts.map((start, offset) => {
    const end = starts[offset + 1]?.index ?? lines.length;
    const textLines = lines.slice(start.index, end);
    const firstLine = textLines[0]?.trimStart() ?? "";
    const firstLineBody = firstLine.replace(articlePattern, "").trim();
    return {
      key: start.articleNo,
      title: `${start.articleNo}${start.heading ? ` (${start.heading})` : ""}`,
      text: [firstLineBody, ...textLines.slice(1)].join("\n").trim()
    };
  });
}
