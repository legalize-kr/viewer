import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractAttachments, renderAttachmentList } from "../extension/src/markdown.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const samplePath = resolve(
  workspaceRoot,
  "ordinance-kr",
  "경상북도",
  "청송군",
  "조례",
  "청송군 자율방재단 운영 등에 관한 조례",
  "본문.md"
);
const markdown = await readFile(samplePath, "utf8");
const attachments = extractAttachments(markdown);
const html = renderAttachmentList(attachments);

assert(attachments.length >= 6, "expected real ordinance HWP attachments");
assert(attachments.every((item) => item.files.some((file) => file.extension === "hwp")), "real ordinance attachments must include HWP files");
assert(attachments.some((item) => item.label.includes("가입신청서")), "expected decoded attachment title");
assert(html.includes("#icon-file-hwp"), "real ordinance HWP icon missing");
assert(html.includes('data-attachment-action="preview"'), "real ordinance preview action missing");
assert(!html.includes('data-attachment-action="download"'), "real ordinance downloads must be handled from the preview panel");

console.log(`HWP smoke passed: ${attachments.length} attachments from ${samplePath}`);
