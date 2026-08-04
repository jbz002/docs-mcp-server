-- @migration-step add links column to crawl_results
-- Stores the extracted link URLs (JSON array, ScrapeResult.links) for each
-- crawled page so an interrupted crawlOnly job can reconstruct the uncrawled
-- frontier on resume (see BaseScraperStrategy resumeFromQueue).
-- Nullable: rows written before this migration and pages with no links stay NULL.
ALTER TABLE crawl_results ADD COLUMN links TEXT;
