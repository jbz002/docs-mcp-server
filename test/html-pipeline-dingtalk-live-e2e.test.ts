/**
 * Live E2E for DingTalk docs — validates the site adapter (monaco code-block
 * materialization + nav-noise removal) against the real SPA.
 *
 * Excluded from the default test run (matches the live-e2e glob). Run with:
 *   npm run test:live -- html-pipeline-dingtalk-live-e2e
 *
 * Requires network. Uses Playwright mode (full JS) with a generous timeout.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { AutoDetectFetcher } from "../src/scraper/fetcher/AutoDetectFetcher";
import { ScrapeMode } from "../src/scraper/types";
import { FetchUrlTool } from "../src/tools/FetchUrlTool";
import { loadConfig } from "../src/utils/config";

describe("DingTalk docs site adapter (live)", () => {
  let fetchUrlTool: FetchUrlTool;

  beforeAll(() => {
    const appConfig = loadConfig();
    const fetcher = new AutoDetectFetcher(appConfig.scraper);
    fetchUrlTool = new FetchUrlTool(fetcher, appConfig);
  });

  it("materializes the full RSA signing code block on open.dingtalk.com", async () => {
    const url =
      "https://open.dingtalk.com/document/development/rsa-private-key-to-sign-parameters-1";
    const result = await fetchUrlTool.execute({
      url,
      scrapeMode: ScrapeMode.Playwright,
      followRedirects: true,
    });

    expect(typeof result).toBe("string");
    // Full Java source (127 lines) — markers absent from the 21-line DOM viewport.
    expect(result).toContain("SHA256withRSA");
    expect(result).toContain("PKCS8EncodedKeySpec");
    // Left tree nav noise should be stripped.
    expect(result).not.toContain("考勤");
    expect(result).not.toContain("签到");
  }, 60000);

  it("materializes all three code blocks on the third-party signature page", async () => {
    const url =
      "https://open.dingtalk.com/document/development/the-signature-calculation-method-of-the-third-party-access-interface";
    const result = await fetchUrlTool.execute({
      url,
      scrapeMode: ScrapeMode.Playwright,
      followRedirects: true,
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("HmacSHA256");
    expect(result).toContain("URLEncoder");
    expect(result).not.toContain("考勤");
  }, 60000);
});
