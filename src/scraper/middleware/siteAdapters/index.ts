import { dingtalkAdapter } from "./dingtalk";
import type { SiteAdapter } from "./types";

/**
 * Built-in site adapters, ordered most-specific first. New platforms
 * (e.g. Feishu, Yuque) append here. Rules ship in code (not config) so they
 * propagate on release — mirrors `subresourceBlocklist.ts`.
 */
const SITE_ADAPTERS: ReadonlyArray<SiteAdapter> = Object.freeze([dingtalkAdapter]);

// Validate hosts at module load — catches typos before any page renders.
for (const adapter of SITE_ADAPTERS) {
  for (const host of adapter.hosts) {
    if (!host || host.includes("/") || host.includes(":")) {
      throw new Error(
        `Invalid site adapter host: "${host}" in adapter "${adapter.id}" (must be a bare hostname)`,
      );
    }
  }
}

/**
 * Returns true when `requestHost` equals `matcherHost` or ends with
 * `.<matcherHost>` (label boundary), so `evil-open.dingtalk.com` does not match
 * `open.dingtalk.com`. Mirrors `subresourceBlocklist.hostMatches`.
 */
function hostMatches(requestHost: string, matcherHost: string): boolean {
  if (requestHost === matcherHost) return true;
  return requestHost.endsWith(`.${matcherHost}`);
}

/**
 * Finds the built-in adapter for a URL's hostname, or null when no adapter
 * applies. Invalid URLs return null rather than throwing.
 */
export function getSiteAdapter(url: string): SiteAdapter | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  for (const adapter of SITE_ADAPTERS) {
    if (adapter.hosts.some((h) => hostMatches(host, h))) {
      return adapter;
    }
  }
  return null;
}

export type {
  MonacoEditor,
  MonacoGlobal,
  MonacoModel,
  SiteAdapter,
  SiteAdapterDomScript,
} from "./types";
