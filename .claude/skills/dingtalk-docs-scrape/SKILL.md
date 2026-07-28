---
name: dingtalk-docs-scrape
description: Produce docs-mcp-server scrape-form values for crawling DingTalk open-platform documentation (open.dingtalk.com / developers.dingtalk.com). Use this whenever the user wants to index, crawl, or scrape DingTalk docs into docs-mcp-server, asks how to fill the scrape form for DingTalk docs, or names a DingTalk doc topic to ingest — e.g. 宜搭/考勤/通讯录/OA审批/日程/签到/日志/审批, "钉钉开放平台文档", or any open.dingtalk.com URL. The skill explores the site's navigation-tree JSON, harvests every page slug in the requested section, and returns a ready-to-paste includePatterns regex plus the full form prescription. Trigger it even when the user only vaguely mentions wanting DingTalk API docs searchable.
---

# DingTalk docs → docs-mcp-server scrape form

Turn a user's requested DingTalk doc topic (宜搭, 考勤, 通讯录, …) into the exact
field values for a docs-mcp-server scrape job, with a URL filter tight enough to
index only that section.

## TL;DR — two scripts, pick by scope

| Goal | Script | How |
|---|---|---|
| **Whole top-level section** (服务端 API 1145p, 客户端 API 307p, …) | `scripts/batch_scrape.node.js` | Fans out one job per sub-section, seeds every slug via `initialQueue`, submits via REST. **This is the reliable path** — do NOT try to crawl a big section as one discovery-based job. |
| **One section's form values** (web UI, or inspection) | `scripts/extract_slugs.node.js` | Prints the form prescription for a single matched section. |

Both scripts read the authoritative nav JSON, never the rendered sidebar.

## Why this skill exists (the site quirks it codifies)

The DingTalk open-platform docs look like a normal docs site but behave in ways
that break a naive crawl. These were learned the hard way — respect them:

1. **It's a JavaScript SPA, and Playwright must actually render it.** A plain
   HTTP fetch (or a render that bails early) gets a shell HTML whose textContent
   is raw JS / "加载中..." with no article body and no sidebar links. Two things
   must be true or you get 1-page junk crawls:
   - `scrapeMode` must be the **lowercase enum value `"playwright"`**. The REST
     API and MCP tool do **not** normalize case — `"Playwright"` silently fails
     the `=== ScrapeMode.Playwright` check, Playwright is skipped, and you get
     the raw shell. (The web UI happens to normalize, which is why the old form
     values looked like they worked there.)
   - The default `pageTimeoutMs` (5000ms) is too short — the SPA needs longer to
     fetch `meta.json` and render. Set env `DOCS_MCP_SCRAPER_PAGE_TIMEOUT_MS=15000`
     on the worker (`.env` + recreate; it's a server config, not a per-job option).

2. **The real table of contents is a JSON file, not the HTML sidebar.** The
   authoritative nav tree lives at
   `https://icms-document.oss-cn-beijing.aliyuncs.com/zh-CN/dingtalk/development/meta.json`
   (~1 MB). It lists every page and its slug. The HTML sidebar is lazy-loaded and
   inconsistent, so **never try to harvest page URLs from the rendered sidebar** —
   read the JSON. Both scripts do this.

3. **Crawler discovery is unreliable for this site — seed the URL list instead.**
   docs-mcp-server discovers pages from rendered DOM links and has no sitemap
   support (the site serves an SPA shell for `sitemap.xml`/`robots.txt`). Because
   the sidebar races Playwright's wait, a discovery-based crawl (start URL +
   `scope` + `maxDepth`) frequently finds only the seed page. **Fix: pass every
   section slug as `options.initialQueue`** (`{url, depth:1}` items). Queued items
   enter the crawl unfiltered, so each is fetched+rendered individually with no
   discovery dependency. This is what `batch_scrape.node.js` does.

4. **A topic can map to several subtrees.** DingTalk duplicates some sections
   under different parents (e.g. 宜搭 appears under both "服务端 API" and
   "历史文档"). `extract_slugs` unions all same-titled subtrees so pages aren't
   missed.

5. **Page URLs have no shared path prefix per section.** Every page is
   `https://open.dingtalk.com/document/development/<slug>` where `<slug>` is an
   arbitrary English string. So a single `includePatterns` regex enumerating the
   slugs is the only precise way to scope a section (still useful as a safety
   filter even when seeding).

6. **`developers.dingtalk.com` 302-redirects to `open.dingtalk.com`.** Same
   content, two hostnames, links to both appear in the DOM. Final indexed URLs
   normalize to `open.dingtalk.com`. Keep `scope: domain` (registrable domain
   `dingtalk.com` covers both) as a safety net; with `initialQueue` seeding it
   matters less but doesn't hurt.

7. **Sidebar anchors emit empty-hash hrefs (`href="...slug#"`).** The crawler
   treats `slug` and `slug#` as two different URLs and indexes both — same
   content twice. On a real run this was **35% of all chunks**. Kill it with
   `excludePatterns: /#$/`.

8. **REST API field gotchas** (the web UI is more forgiving; REST/MCP is strict):
   - `version`: **omit the field entirely** for the default version. Sending
     `version: ""` is rejected (`optionalTrimmed` requires ≥1 char). Omitting →
     null → stored as version "".
   - `clean`: a normal scrape job **wipes the whole library+version first**
     (`PipelineWorker.removeAllDocuments` when `clean !== false`). For a
     multi-job fan-out into one library, every job after the first must pass
     `clean: false` to APPEND. Same-URL pages upsert, so overlaps don't duplicate.
   - `maxConcurrency`: leave at default **3**. The worker container is 2G-limited;
     concurrency 6 drove memory to 98% (OOM risk, 37 chromium procs).

## How to use it

### Path A — whole top-level section (recommended for anything > ~20 pages)

```bash
# Prereq: worker must have DOCS_MCP_SCRAPER_PAGE_TIMEOUT_MS=15000 set.
node <skill-dir>/scripts/batch_scrape.node.js <library> "<topic>" [repo] [--submit] [--only=<substring>] [--base URL]
```

- `<library>` — target docs-mcp-server library (shared by all sub-jobs; appended
  with `clean: false`).
- `<topic>` — a **top-level** section title whose immediate children become the
  sub-jobs (e.g. `服务端 API`, `客户端 API`). The script crawls each child
  sub-section separately, seeding that child's slugs via `initialQueue`.
- `repo` — optional, default `development`.
- `--submit` — POST each job sequentially and poll to completion. Without it,
  dry-run: prints per-sub-section page counts + full JSON specs.
- `--only=<substring>` — run a single matching sub-section (use to test one
  before committing to the whole section).
- `--base` — REST base, default `http://localhost:8080`.

Example (服务端 API, 28 sub-sections, 1145 pages):

```bash
# 1. Dry-run — sanity-check the page counts
node <skill-dir>/scripts/batch_scrape.node.js dingtalk-server-api "服务端 API"
# 2. Test one sub-section end-to-end
node <skill-dir>/scripts/batch_scrape.node.js dingtalk-server-api "服务端 API" --only="通讯录管理" --submit
# 3. Full run (sequential; ~3h at default concurrency 3)
node <skill-dir>/scripts/batch_scrape.node.js dingtalk-server-api "服务端 API" --submit
```

### Path B — single section form values (web UI or one-off)

```bash
node <skill-dir>/scripts/extract_slugs.node.js "<topic>" [repo]
```

- `<topic>` — a fragment of the section's Chinese or English title/slug
  (`宜搭`, `考勤`, `通讯录`, `OA审批`, `yida`, `attendance`).

The script prints one JSON object. Read `matchedPaths`, `slugCount`,
`startUrl`, `includePatterns`, and `recommended`. Then fill the form:

| Field | Value | Why |
|---|---|---|
| **url** | `recommended.url` (first real leaf page) | Entry point; a leaf guarantees real content |
| **library** | `recommended.library` (or any name) | The docs-mcp-server library to index into |
| **version** | _(omit the field)_ | REST rejects `""`; omit → default version |
| **scrapeMode** | `playwright` | SPA — **lowercase enum value**, case is not normalized |
| **scope** | `domain` | Covers both `open.` and `developers.` hosts |
| **includePatterns** | `includePatterns` (one regex, already `/…/` wrapped) | Anchored to the section's slugs |
| **excludePatterns** | `/#$/` | Drops empty-hash href variants (`slug#`) |
| **maxDepth** | `1` | Seeds carry the URL list; no discovery needed |
| **maxPages** | `recommended.maxPages` (~slugCount × 1.3) | Must be ≥ seed count |
| **initialQueue** | `[{url: <section slug URLs>, depth: 1}, …]` | **Bypasses unreliable DOM discovery** — the reliable method |
| **clean** | `true` first job / `false` to append | Default wipes the library; `false` appends |
| **preserveHashes** | off (default) | Strip `#title-…` TOC anchors |
| **followRedirects** | on (default) | Follow `developers.` → `open.` redirect |
| **ignoreErrors** | on | A single page failure shouldn't abort the batch |
| **headers** | _(none)_ | Pages are public |

### Single page instead of a section

If the script reports `pageType: leaf (single page)`, the user named one API.
Crawl just it: keep `url` and `library`, set `scope: hostname`, `maxDepth: 0`,
leave `includePatterns` and `initialQueue` blank.

## After the crawl — verify (recommended)

Two failure modes to check: `#`-href duplicates, and "加载中..." junk from
premature extraction. Once the job finishes, the docs-mcp-server UI shows
"Pages" and "Chunks". A healthy run has `pages ≈ slugCount` and `chunks / pages ≈ 2–5`.

For a definitive check against the SQLite store (project runs in Docker,
`documents.db` lives on the worker container under `/data`):

```bash
docker exec docs-mcp-worker node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/documents.db', {readonly: true});
const lib = db.prepare('SELECT id FROM libraries WHERE name=?').get('<library>');
const vid = db.prepare('SELECT id FROM versions WHERE library_id=?').get(lib.id);
const pages = db.prepare('SELECT url FROM pages WHERE version_id=?').all(vid.id);
const hashDup = pages.filter(r => r.url.endsWith('#')).length;
const docs = db.prepare('SELECT length(d.content) l, d.content c FROM documents d JOIN pages p ON d.page_id=p.id WHERE p.version_id=?').all(vid.id);
const junk = docs.filter(d => d.c.includes('加载中')).length;
const lens = docs.map(d=>d.l).sort((a,b)=>a-b);
console.log({totalPages: pages.length, hashDup, junkDocs: junk, medianDocLen: lens[lens.length>>1]});
db.close();
"
```

Healthy: `totalPages ≈ slugCount`, `hashDup = 0`, `junkDocs = 0`, `medianDocLen`
in the thousands. `junkDocs > 0` means `pageTimeoutMs` is too low (re-render race).
`hashDup > 0` means the `#` exclude pattern wasn't applied — clean and re-crawl
(note: `deletePage` does not clear the `documents_vec` vector table, so prefer a
clean re-crawl over SQL surgery).

Reference result (服务端 API, with the fixes above): 1145/1145 pages, 0 hashDup,
0 junk, median ~1793 chars/doc.

## When the topic doesn't match

If the script exits with "No node matched", it prints the repo's top-level
sections. Offer those to the user and re-run with the right term. Common
top-level sections in the `development` repo: 服务端 API (1145p), 历史文档 (1265p,
mostly legacy — often skippable), 客户端 API (307p), 事件订阅 (256p), 常见问题 (9p).
