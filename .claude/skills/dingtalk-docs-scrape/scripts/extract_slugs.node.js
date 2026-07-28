#!/usr/bin/env node
/**
 * DingTalk open-platform doc explorer for docs-mcp-server scrape form.
 *
 * Fetches the site's nav-tree JSON, finds the doc section matching a topic
 * keyword, harvests every page slug in that section, and prints a ready-to-paste
 * includePatterns regex plus the recommended scrape-form values.
 *
 * Usage:
 *   node extract_slugs.node.js <topic> [repo]
 *
 *   topic  Chinese or English fragment of the section title/slug
 *          e.g. "宜搭", "考勤", "通讯录", "OA审批", "yida", "attendance"
 *   repo   docs repository slug (default: development)
 *          URL becomes /zh-CN/dingtalk/<repo>/meta.json
 *
 * Output: single JSON object on stdout (everything else on stderr).
 * Reads cleanly so Claude can parse it and present the form to the user.
 */
const [, , topicArg, repoArg] = process.argv;
const repo = repoArg || "development";

if (!topicArg) {
  console.error("Usage: node extract_slugs.node.js <topic> [repo]");
  console.error('Example: node extract_slugs.node.js 宜搭');
  process.exit(1);
}

const META_URL = `https://icms-document.oss-cn-beijing.aliyuncs.com/zh-CN/dingtalk/${repo}/meta.json`;
const PAGE_BASE = `https://open.dingtalk.com/document/${repo}/`;
const PATH_PREFIX = `/document/${repo}/`;

/** Escape regex metacharacters in a slug. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

(async () => {
  let res;
  try {
    res = await fetch(META_URL);
  } catch (e) {
    console.error(`Network error fetching ${META_URL}: ${e}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`Fetch failed: HTTP ${res.status} for ${META_URL}`);
    process.exit(2);
  }
  const j = await res.json();
  const topics = j.topics || [];

  const kw = topicArg.trim().toLowerCase();

  // Walk the tree, collect every node whose title or slug contains the keyword.
  // Keep the ancestor path so we can show the user where the match lives.
  /** @type {{node:any, path:string[]}[]} */
  const candidates = [];
  const stack = [];
  function walk(n) {
    const here = stack.concat([n.title || n.slug]);
    const hay = `${n.title || ""} ${n.slug || ""}`.toLowerCase();
    if (hay.includes(kw)) candidates.push({ node: n, path: here });
    stack.push(n.title || n.slug);
    for (const c of n.children || []) walk(c);
    stack.pop();
  }
  for (const t of topics) walk(t);

  if (candidates.length === 0) {
    // Print available top-level sections so the user can pick a real topic.
    const tops = topics.map((t) => t.title || t.slug).filter(Boolean);
    console.error(`No node matched "${topicArg}".`);
    console.error("Top-level sections in this repo:");
    for (const title of tops) console.error("  - " + title);
    process.exit(3);
  }

  // A topic may match several sibling sections with the same title living under
  // different parents (DingTalk splits e.g. 宜搭 into two subtrees). Union ALL
  // exact-title matches so nothing is missed.
  const exacts = candidates.filter(
    (c) => (c.node.title || "").toLowerCase() === kw,
  );
  const dirs = candidates.filter((c) => (c.node.children || []).length > 0);

  /** @type {any[]} */
  let chosenNodes;
  /** @type {string[]} */
  let matchedPaths;
  let chosenTitle;
  if (exacts.length) {
    chosenNodes = exacts.map((c) => c.node);
    matchedPaths = exacts.map((c) => c.path.join(" > "));
    chosenTitle = exacts[0].node.title;
  } else {
    // Fragment match: pick the shallowest directory containing the keyword
    // (the broadest section), else the first candidate.
    const pick =
      dirs.slice().sort((a, b) => a.path.length - b.path.length)[0] ||
      candidates[0];
    chosenNodes = [pick.node];
    matchedPaths = [pick.path.join(" > ")];
    chosenTitle = pick.node.title;
  }

  // Harvest every slug across all chosen subtrees (leaves + section landing pages).
  /** @type {Set<string>} */
  const slugSet = new Set();
  function gather(n) {
    if (n.slug) slugSet.add(n.slug);
    for (const c of n.children || []) gather(c);
  }
  for (const n of chosenNodes) gather(n);
  const slugs = [...slugSet];

  // First leaf slug = a good start URL (real content, not a section landing page).
  function firstLeaf(n) {
    if (n.slug && !(n.children && n.children.length)) return n.slug;
    for (const c of n.children || []) {
      const f = firstLeaf(c);
      if (f) return f;
    }
    return null;
  }
  const startSlug =
    chosenNodes.map(firstLeaf).find(Boolean) || slugs[0];

  const inner = `^${PATH_PREFIX}(${slugs.map(esc).join("|")})(/.*)?$`;
  const isSection = chosenNodes.some(
    (n) => n.children && n.children.length,
  );

  const out = {
    repo,
    topic: topicArg,
    matchedTitle: chosenTitle,
    matchedPaths,
    matchedPathCount: matchedPaths.length,
    pageType: isSection ? "directory (whole section)" : "leaf (single page)",
    slugCount: slugs.length,
    slugs,
    startUrl: PAGE_BASE + startSlug,
    includePatterns: "/" + inner + "/",
    excludePatterns: "/#$/",
    recommended: {
      url: PAGE_BASE + startSlug,
      library: "dingtalk-" + (chosenNodes[0].slug || topicArg),
      version: "",
      scrapeMode: "Playwright",
      scope: "domain",
      maxDepth: 2,
      maxPages: Math.max(20, Math.round(slugs.length * 1.3)),
      preserveHashes: false,
      followRedirects: true,
      ignoreErrors: true,
      headers: {},
    },
    alternativeCandidates: candidates
      .slice(0, 10)
      .map((c) => c.path.join(" > ")),
  };

  console.log(JSON.stringify(out, null, 2));
})();
