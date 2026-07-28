#!/usr/bin/env node
/**
 * Batch-scrape a DingTalk doc section by fanning out ONE job per immediate
 * sub-section, all appending to a single docs-mcp-server library.
 *
 * WHY FAN-OUT (not one whole-section job):
 *  - docs-mcp-server discovers pages from rendered DOM links only (no sitemap
 *    support; site serves SPA shell for sitemap.xml/robots.txt).
 *  - DingTalk sidebar is lazy-loaded/inconsistent, so a single whole-section
 *    job misses pages. Each sub-section's local sidebar renders fully
 *    (proven on 宜搭 = 120 pages), so per-sub-section jobs are complete.
 *  - A normal scrape job wipes the whole library+version first (PipelineWorker
 *    removeAllDocuments when clean !== false). So multi-job fan-out MUST pass
 *    clean:false to APPEND. Same-URL pages upsert, no double-insert.
 *
 * Usage:
 *   node batch_scrape.node.js <library> <topic> [repo] [--submit] [--base URL]
 *
 *   library  target docs-mcp-server library (shared by all sub-jobs)
 *   topic    top-level section title; its immediate children become sub-jobs
 *            e.g. "服务端 API", "客户端 API"
 *   repo     docs repo slug (default development)
 *   --submit POST each job sequentially and wait for completion (default dry-run)
 *   --base   REST base URL (default http://localhost:8080)
 *
 * Output: progress on stderr; dry-run prints per-sub-section summary + full
 * JSON specs on stdout.
 */
const [, , libArg, topicArg, ...rest] = process.argv;
const SUBMIT = rest.includes("--submit");
const ONLY = (rest.find((a) => a.startsWith("--only=")) || "").slice(7);
const baseArg = rest.find((a) => a.startsWith("--base="));
const BASE = (
  baseArg ? baseArg.slice(7) : process.env.DOCS_MCP_BASE || "http://localhost:8080"
).replace(/\/$/, "");
const repo = rest.find((a) => !a.startsWith("-")) || "development";

if (!libArg || !topicArg) {
  console.error(
    "Usage: node batch_scrape.node.js <library> <topic> [repo] [--submit] [--base URL]",
  );
  console.error('Example: node batch_scrape.node.js dingtalk-server-api "服务端 API"');
  process.exit(1);
}

const META_URL = `https://icms-document.oss-cn-beijing.aliyuncs.com/zh-CN/dingtalk/${repo}/meta.json`;
const PAGE_BASE = `https://open.dingtalk.com/document/${repo}/`;
const PATH_PREFIX = `/document/${repo}/`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ["completed", "failed", "cancelled"];

function gather(n, set) {
  if (n.slug) set.add(n.slug);
  for (const c of n.children || []) gather(c, set);
}
function firstLeaf(n) {
  if (n.slug && !(n.children && n.children.length)) return n.slug;
  for (const c of n.children || []) {
    const f = firstLeaf(c);
    if (f) return f;
  }
  return null;
}

(async () => {
  let res;
  try {
    res = await fetch(META_URL);
  } catch (e) {
    console.error(`Network error fetching meta.json: ${e}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`meta.json HTTP ${res.status}`);
    process.exit(2);
  }
  const j = await res.json();
  const topics = j.topics || [];
  const kw = topicArg.trim();
  const topic =
    topics.find((t) => (t.title || "") === kw) ||
    topics.find((t) => (t.title || "").includes(kw));
  if (!topic) {
    console.error(
      `No topic matched "${kw}". Top-level: ${topics.map((t) => t.title).join(", ")}`,
    );
    process.exit(3);
  }

  const subs = (topic.children || []).filter((c) => {
    const s = new Set();
    gather(c, s);
    return s.size > 0;
  });

  const specs = subs.map((c) => {
    const slugSet = new Set();
    gather(c, slugSet);
    const slugs = [...slugSet];
    const start = firstLeaf(c) || slugs[0];
    const inner = `^${PATH_PREFIX}(${slugs.map(esc).join("|")})(/.*)?$`;
    // Seed every slug directly — bypass flaky DOM discovery (DingTalk SPA sidebar
    // races Playwright's wait, yielding 1 page). initialQueue items enter the
    // queue unfiltered; with depth 1 + maxDepth 1 no further discovery happens,
    // so exactly these URLs get rendered+indexed (≈yida's per-page 94% success).
    const initialQueue = slugs.map((s) => ({ url: PAGE_BASE + s, depth: 1 }));
    return {
      label: c.title || c.slug,
      slugCount: slugs.length,
      body: {
        library: libArg,
        // version OMITTED: REST schema `optionalTrimmed` rejects "" (min 1 char).
        // Omitting → null → stored as version "" (matches existing lib convention).
        options: {
          url: PAGE_BASE + start,
          scrapeMode: "playwright", // lowercase — enum value, REST does NOT normalize case
          scope: "domain",
          includePatterns: "/" + inner + "/",
          excludePatterns: "/#$/",
          maxDepth: 1,
          maxPages: Math.max(20, Math.round(slugs.length * 1.3)),
          // maxConcurrency omitted → default 3. Worker is 2G-limited; concurrency 6
          // hit 98% mem (OOM risk). 3 stays ~650M (proven safe, same as yida).
          initialQueue,
          clean: false, // APPEND — do not wipe prior sub-sections
          ignoreErrors: true,
          followRedirects: true,
          preserveHashes: false,
        },
      },
    };
  });

  const filtered = ONLY
    ? specs.filter((s) => s.label.includes(ONLY))
    : specs;
  const specsRun = filtered;
  const total = specsRun.reduce((a, s) => a + s.slugCount, 0);
  console.error(
    `Topic: ${topic.title} | sub-sections: ${specs.length} | expected pages: ${total}`,
  );
  console.error(
    `Library: ${libArg} | mode: ${SUBMIT ? "SUBMIT (sequential)" : "DRY-RUN"} | base: ${BASE}`,
  );

  if (!SUBMIT) {
    for (const s of specsRun) {
      console.error(
        `${String(s.slugCount).padStart(4)}  ${s.label}  ->  ${s.body.options.url}`,
      );
    }
    console.log(JSON.stringify(specsRun.map((s) => s.body), null, 2));
    return;
  }

  // Sequential: enqueue, poll to terminal, then next. Sidesteps any same-library
  // active-job guard and the serial single-worker anyway.
  let done = 0;
  const summary = [];
  for (const s of specsRun) {
    process.stderr.write(
      `[${++done}/${specsRun.length}] ${s.label} (${s.slugCount}p) ... `,
    );
    let r;
    try {
      r = await fetch(`${BASE}/api/jobs/scrape`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s.body),
      });
    } catch (e) {
      console.error(`enqueue error: ${e}`);
      continue;
    }
    if (!r.ok) {
      console.error(`enqueue HTTP ${r.status}: ${await r.text()}`);
      continue;
    }
    const { jobId } = await r.json();
    let status = "queued";
    let job = {};
    while (!TERMINAL.includes(status)) {
      await sleep(3000);
      const jr = await fetch(`${BASE}/api/jobs/${jobId}`);
      if (!jr.ok) {
        console.error(`poll HTTP ${jr.status}`);
        break;
      }
      job = await jr.json();
      status = String(job.status || "").toLowerCase();
    }
    const counts = JSON.stringify(
      Object.fromEntries(
        Object.entries(job).filter(([k]) => /page|chunk|url|error/i.test(k)),
      ),
    );
    console.error(`${status} | ${counts}`);
    summary.push({ label: s.label, expected: s.slugCount, status, job });
  }

  console.error(`\n=== DONE. Verify total pages approach ${total} ===`);
  console.error("Per-section results:");
  for (const m of summary) {
    const got = m.job.totalPages ?? m.job.pages ?? m.job.processedPages ?? "?";
    console.error(`  ${String(m.expected).padStart(4)}exp ${String(got).padStart(4)}got  ${m.status.padEnd(9)} ${m.label}`);
  }
})();
