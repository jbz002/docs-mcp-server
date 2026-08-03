#!/usr/bin/env node
// One-off: generate an anchored includePatterns regex for the DingTalk
// "服务端 API" section and sanity-test it. Slugs are a-z0-9- only (no regex
// metachars), so no per-slug escaping is needed.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const here = import.meta.dirname;
const out = execSync(`node "${here}/extract_slugs.node.js" "服务端 API"`, {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
const slugs = JSON.parse(out).slugs;
const alt = slugs.join("|");
// Anchored: both hosts (open|developers), tolerate ?/# suffix.
// Wrapped in /.../ so docs-mcp treats it as a regex pattern.
const re = `^https?://(?:open|developers)\\.dingtalk\\.com/document/(?:development|orgapp)/(?:${alt})(?:[?#]|$)`;
const wrapped = `/${re}/`;

const dest = `${here}/../server-api-include-patterns.txt`;
writeFileSync(dest, wrapped, "utf8");

const test = new RegExp(re);
const checks = {
  "open server": test.test("https://open.dingtalk.com/document/development/server"),
  "developers leaf":
    test.test("https://developers.dingtalk.com/document/development/user-information-creation"),
  "reject foreign slug":
    test.test("https://open.dingtalk.com/document/orgapp/some-other-slug"),
  "reject prefix trap":
    test.test("https://open.dingtalk.com/document/development/server-evil-extra"),
};
console.log("slugs:", slugs.length, "regex chars:", wrapped.length);
console.log("written:", dest);
console.log("checks:", checks);
