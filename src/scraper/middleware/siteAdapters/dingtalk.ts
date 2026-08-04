import type { Page } from "playwright";
import { logger } from "../../../utils/logger";
import type {
  MonacoGlobal,
  MonacoModel,
  SiteAdapter,
  SiteAdapterDomScript,
} from "./types";

/** Result of materializing monaco code blocks into static `pre/code`. */
interface MaterializeResult {
  /** Number of blocks successfully replaced. */
  fixed: number;
  /** Number of blocks left untouched (non-monaco or skipped). */
  skipped: number;
  /** True when model/block counts diverged and the whole pass was aborted. */
  mismatch: boolean;
}

/**
 * Browser-side pure function: materializes virtual-scrolled monaco code blocks
 * into static `pre > code` elements holding the full source.
 *
 * Designed to be serialized via `page.evaluate(fn)` — uses only `window` /
 * `document` globals and never closes over Node-side variables.
 *
 * Verified against open.dingtalk.com:
 * - `monaco.editor.getModels()` maps 1:1, same order, to DOM `.doc-code-block`
 *   (RSA page 1:1, third-party signature page 3:3).
 * - `model.uri` is reused across SPA routes (`inmemory://model/1`), so it must
 *   NOT be used for cross-page matching — only the current page's array index.
 * - `model.getValue()` returns the full code; `getLanguageId()` returns the
 *   language id used for the `language-*` class.
 *
 * Safety: if `getModels().length !== .doc-code-block.length`, the pass aborts
 * (mismatch) and leaves the DOM untouched rather than risking index drift.
 */
export function materializeMonacoCodeBlocks(): MaterializeResult {
  const editor = (window as unknown as { monaco?: MonacoGlobal }).monaco?.editor;
  if (!editor?.getModels) {
    return { fixed: 0, skipped: 0, mismatch: false };
  }

  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".doc-code-block"));
  const models = editor.getModels();

  if (models.length !== blocks.length) {
    return { fixed: 0, skipped: blocks.length, mismatch: true };
  }

  let fixed = 0;
  blocks.forEach((block, index) => {
    // Skip non-monaco blocks (plain pre/code) — leave them as-is.
    if (!block.querySelector(".monaco-editor")) {
      return;
    }
    const model: MonacoModel = models[index];
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    const lang = model.getLanguageId();
    if (lang) {
      codeEl.className = `language-${lang}`;
    }
    codeEl.textContent = model.getValue();
    pre.appendChild(codeEl);
    block.replaceWith(pre);
    fixed++;
  });

  return { fixed, skipped: blocks.length - fixed, mismatch: false };
}

const monacoCodeBlockFixer: SiteAdapterDomScript = {
  id: "dingtalk-monaco-code-fix",
  description: "Materialize virtual-scrolled monaco code blocks into pre/code",
  async run(page: Page): Promise<void> {
    const result = await page.evaluate(materializeMonacoCodeBlocks);
    if (result.mismatch) {
      logger.debug(
        `dingtalk adapter: monaco model/block count mismatch, skipped ${result.skipped} block(s)`,
      );
    }
  },
};

/**
 * DingTalk Open Platform documentation adapter.
 *
 * The site (open.dingtalk.com) renders code blocks with monaco-editor, which
 * virtualizes lines so only the viewport is in the DOM — scraping captures a
 * fraction of the real code. This adapter scrolls the inner content container
 * to trigger lazy rendering, then replaces each `.doc-code-block` with the
 * model's full source via `monaco.editor.getModels()`.
 *
 * Nav/noise chrome is stripped via excludeSelectors through the downstream
 * sanitizer. Selectors are stable semantic classes (verified across the SPA):
 * top tab nav, bottom recommendations + prev/next pager, and the fixed
 * floating widgets (智能解释/文档反馈/开发助手, the "鼠标选中内容" guidance
 * tooltip, and the first-visit introjs tour).
 */
export const dingtalkAdapter: SiteAdapter = {
  id: "dingtalk",
  description:
    "DingTalk Open Platform docs (open.dingtalk.com SPA, monaco virtual-scrolled code blocks)",
  hosts: ["open.dingtalk.com", "developers.dingtalk.com"],
  excludeSelectors: [
    '[class*="treeMenu"]',
    ".opdf-common-header",
    ".doc-breadcrumb",
    '[class*="breadcrumb"]',
    ".doc-right-wrapper",
    // Top tab nav (文档中心｜应用开发/服务端API/客户端JSAPI/事件订阅/钉钉CLI).
    '[class*="new-header-submenu"]',
    // Bottom "遇到其他问题？问问AI钉钉开发助手" + related-question recommendations.
    ".doc-recommend-section",
    // Previous/next doc pager (上一篇 / 下一篇).
    ".menu-step-wrapper",
    // Floating widget rail (智能解释 / 文档反馈).
    ".styles-float-new",
    // "开发助手" floating button.
    ".ai-assistant-button-wrapper",
    // Doc-feedback floating-action-button shell.
    ".article-doc-feedback-fab-wrapper",
    // "鼠标选中内容，AI智能解释" first-visit guidance tooltip.
    ".intro-guide-wrapper",
    // First-visit tour overlays (introjs + dingtalk variant, e.g. "跳过钉钉开发助手...").
    '[class*="introjs"]',
  ],
  scrollContainerSelector: ".article-main-new",
  domFixScripts: [monacoCodeBlockFixer],
};
