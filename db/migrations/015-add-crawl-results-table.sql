-- Migration: Add crawl_results table for crawlOnly persistence
-- crawlOnly 模式原本只发 page-scraped SSE、不落库，SSE 断连即丢页。
-- 本表持久化 crawlOnly 的原始抓取结果（按 version_id+url 唯一），
-- 供 AIHelms 入库前经 REST 回补，实现页级中断恢复。
-- 与 pages/documents 分离：documents 是分块+向量化索引，crawl_results 是原文缓存。

-- @migration-step create crawl_results table
CREATE TABLE IF NOT EXISTS crawl_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  job_id TEXT,
  url TEXT NOT NULL,
  title TEXT,
  text_content TEXT,
  content_type TEXT,
  depth INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(version_id, url)
);

-- @migration-step create crawl_results indexes
CREATE INDEX IF NOT EXISTS idx_crawl_results_version_id ON crawl_results(version_id);
CREATE INDEX IF NOT EXISTS idx_crawl_results_url ON crawl_results(url);

-- @migration-step create updated_at trigger
CREATE TRIGGER IF NOT EXISTS crawl_results_updated_at_trigger AFTER UPDATE ON crawl_results BEGIN
  UPDATE crawl_results SET updated_at = CURRENT_TIMESTAMP WHERE id = new.id;
END;
