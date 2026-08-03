import { describe, expect, it } from "vitest";
import { dingtalkAdapter } from "./dingtalk";
import { getSiteAdapter } from "./index";

describe("getSiteAdapter", () => {
  it("matches open.dingtalk.com", () => {
    expect(getSiteAdapter("https://open.dingtalk.com/document/development/x")?.id).toBe(
      "dingtalk",
    );
  });

  it("matches developers.dingtalk.com", () => {
    expect(getSiteAdapter("https://developers.dingtalk.com/foo")?.id).toBe("dingtalk");
  });

  it("matches a subdomain of a matched host", () => {
    expect(getSiteAdapter("https://doc.open.dingtalk.com/")?.id).toBe("dingtalk");
  });

  it("returns null for an unrelated host", () => {
    expect(getSiteAdapter("https://example.com/")).toBeNull();
  });

  it("returns null for an invalid URL without throwing", () => {
    expect(getSiteAdapter("not-a-url")).toBeNull();
  });

  it("does not match an attacker look-alike (label boundary)", () => {
    expect(getSiteAdapter("https://open.dingtalk.com.attacker.com/")).toBeNull();
  });

  it("returns the registered adapter object, not a copy", () => {
    expect(getSiteAdapter("https://open.dingtalk.com/")).toBe(dingtalkAdapter);
  });
});
