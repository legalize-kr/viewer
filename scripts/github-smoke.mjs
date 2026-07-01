import { fetchGithubMarkdown, listGithubTree } from "../extension/src/github.js";

const owner = "legalize-kr";
const ref = "main";
const token = process.env.GITHUB_TOKEN?.trim() ?? "";

const specs = [
  {
    repo: "legalize-kr",
    label: "법령",
    path: "kr/물품목록정보의관리및이용에관한법률/법률.md"
  },
  {
    repo: "precedent-kr",
    label: "판례",
    path: "선거·특별/하급심/대전고등법원_2022-05-25_2022누50008.md"
  },
  {
    repo: "admrule-kr",
    label: "행정규칙",
    path: "문화체육관광부/국립현대미술관/예규/정부미술품 운영에 관한 세부시행 규정/본문.md"
  },
  {
    repo: "ordinance-kr",
    label: "자치법규",
    path: "세종특별자치시/_본청/조례/세종특별자치시 가족돌봄 청소년ㆍ청년 지원 조례/본문.md"
  }
];

const encoder = new TextEncoder();
const results = [];

for (const spec of specs) {
  const dir = spec.path.split("/").slice(0, -1).join("/");
  const tree = await listGithubTree({ owner, repo: spec.repo, path: dir, ref, token });
  const markdown = await fetchGithubMarkdown({ owner, repo: spec.repo, path: spec.path, ref, token });
  const bytes = encoder.encode(markdown).length;
  const containsFile = tree.some((item) => item.path === spec.path);
  if (!containsFile) {
    throw new Error(`${spec.repo}: GitHub tree did not include ${spec.path}`);
  }
  if (bytes <= 0) {
    throw new Error(`${spec.repo}: raw markdown is empty`);
  }
  results.push({
    repo: spec.repo,
    label: spec.label,
    treeCount: tree.length,
    path: spec.path,
    markdownBytes: bytes,
    starts: markdown.slice(0, 40).replace(/\n/g, "\\n")
  });
}

console.log(JSON.stringify(results, null, 2));
