import { articleSections, escapeHtml } from "./markdown.js";

function tokenize(text) {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export function wordDiff(base, target) {
  const a = tokenize(base);
  const b = tokenize(target);
  if (a.length * b.length > 2_000_000) {
    return [
      ...(base ? [{ type: "remove", text: base }] : []),
      ...(target ? [{ type: "add", text: target }] : [])
    ];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last?.type === type) {
      last.text += text;
    } else {
      out.push({ type, text });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("remove", a[i]);
      i += 1;
    } else {
      push("add", b[j]);
      j += 1;
    }
  }
  while (i < a.length) push("remove", a[i++]);
  while (j < b.length) push("add", b[j++]);
  return out;
}

function segmentHtml(segments, side = "both") {
  return segments
    .map((segment) => {
      const text = escapeHtml(segment.text);
      if (segment.type === "same") return text;
      if (segment.type === "add") return side === "base" ? "" : `<ins>${text}</ins>`;
      return side === "target" ? "" : `<del>${text}</del>`;
    })
    .join("");
}

export function buildDiffRows(baseMarkdown, targetMarkdown) {
  const baseSections = articleSections(baseMarkdown);
  const targetSections = articleSections(targetMarkdown);
  if (!baseSections.length && !targetSections.length) {
    return [
      {
        key: "document",
        title: "본문",
        baseText: baseMarkdown.trim(),
        targetText: targetMarkdown.trim(),
        changed: baseMarkdown.trim() !== targetMarkdown.trim(),
        unit: "document"
      }
    ];
  }
  const baseMap = new Map(baseSections.map((section) => [section.key, section]));
  const targetMap = new Map(targetSections.map((section) => [section.key, section]));
  const keys = [...new Set([...targetSections.map((section) => section.key), ...baseSections.map((section) => section.key)])];
  return keys.map((key) => {
    const base = baseMap.get(key);
    const target = targetMap.get(key);
    return {
      key,
      title: target?.title ?? base?.title ?? key,
      baseText: base?.text ?? "",
      targetText: target?.text ?? "",
      changed: (base?.text ?? "") !== (target?.text ?? ""),
      unit: "article"
    };
  });
}

export function renderDiff(rows, { mode = "split", onlyChanged = true } = {}) {
  const visible = onlyChanged ? rows.filter((row) => row.changed) : rows;
  if (!visible.length) {
    return '<div class="empty-state small">이 두 버전 사이에 바뀐 항목이 없습니다.</div>';
  }
  return visible
    .map((row) => {
      const segments = wordDiff(row.baseText, row.targetText);
      if (mode === "unified") {
        return `<section class="diff-row unified"><h3>${escapeHtml(row.title)}</h3><p>${segmentHtml(segments)}</p></section>`;
      }
      return `<section class="diff-row split"><div><h3>${escapeHtml(row.title)}</h3><p>${segmentHtml(
        segments,
        "base"
      )}</p></div><div><h3>${escapeHtml(row.title)}</h3><p>${segmentHtml(segments, "target")}</p></div></section>`;
    })
    .join("");
}

