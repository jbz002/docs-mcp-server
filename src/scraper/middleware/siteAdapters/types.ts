import type { Page } from "playwright";

/**
 * Minimal monaco-editor model interface (browser-side). Only the methods the
 * DingTalk adapter relies on; everything else stays behind `unknown`.
 */
export interface MonacoModel {
  /** Returns the full source text of the model (ignores virtual-scroll viewport). */
  getValue(): string;
  /** Returns the monaco language id, e.g. "java" / "javascript". */
  getLanguageId(): string;
}

/** Minimal monaco editor namespace surface used by adapters. */
export interface MonacoEditor {
  /** Returns all models in creation order (stable within a page). */
  getModels(): MonacoModel[];
}

/** Shape of the global `window.monaco` the adapter reads defensively. */
export interface MonacoGlobal {
  readonly editor?: MonacoEditor;
}

/**
 * A browser-side DOM fixup script. Runs after the page settled and after the
 * scroll container has been scrolled; each script is independently fault-tolerant.
 */
export interface SiteAdapterDomScript {
  /** Stable id for logs and test dispatch. */
  readonly id: string;
  /** One-line purpose. */
  readonly description: string;
  /** Executes the fixup against the live Playwright page. May throw; caller wraps. */
  readonly run: (page: Page) => Promise<void>;
}

/**
 * Platform-specific cleaning rules for a documentation site that the generic
 * pipeline cannot handle alone (e.g. SPA code editors with virtual scrolling).
 * Matched by hostname; applied inside `HtmlPlaywrightMiddleware` before the
 * rendered DOM is serialized.
 */
export interface SiteAdapter {
  /** Stable id, e.g. "dingtalk". */
  readonly id: string;
  /** One-line description of the platform and the problem it solves. */
  readonly description: string;
  /**
   * Hostnames this adapter handles. A request matches when its hostname equals
   * an entry or ends with `.<entry>` (label boundary), mirroring
   * `subresourceBlocklist.hostMatches`.
   */
  readonly hosts: ReadonlyArray<string>;
  /**
   * Noise selectors appended to `context.options.excludeSelectors` for the
   * downstream `HtmlSanitizerMiddleware` (cheerio) to remove. Reuses the
   * existing selector-removal path instead of re-implementing it.
   */
  readonly excludeSelectors?: ReadonlyArray<string>;
  /**
   * Selector of an internal scroll container (when the page does not scroll
   * the window). Scrolled top-to-bottom then back to top before fixup scripts
   * run, to trigger lazy rendering (monaco code blocks, images, sections).
   */
  readonly scrollContainerSelector?: string;
  /** Browser-side DOM fixup scripts, executed in order. */
  readonly domFixScripts?: ReadonlyArray<SiteAdapterDomScript>;
}
