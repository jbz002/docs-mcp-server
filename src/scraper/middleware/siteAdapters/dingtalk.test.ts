// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { dingtalkAdapter, materializeMonacoCodeBlocks } from "./dingtalk";
import type { MonacoEditor, MonacoGlobal, MonacoModel } from "./types";

interface MonacoWindow extends Window {
  monaco?: MonacoGlobal;
}

const setMonaco = (models: MonacoModel[]): void => {
  const editor: MonacoEditor = { getModels: () => models };
  (window as unknown as MonacoWindow).monaco = { editor };
};

const clearMonaco = (): void => {
  delete (window as unknown as MonacoWindow).monaco;
};

const makeModel = (code: string, languageId: string): MonacoModel => ({
  getValue: () => code,
  getLanguageId: () => languageId,
});

/** Builds a `.doc-code-block`; when `monaco` is true it contains a `.monaco-editor` child. */
const makeBlock = (monaco: boolean): HTMLElement => {
  const el = document.createElement("div");
  el.className = "doc-code-block";
  if (monaco) {
    const m = document.createElement("div");
    m.className = "monaco-editor";
    el.appendChild(m);
  }
  return el;
};

describe("dingtalkAdapter", () => {
  it("targets dingtalk hosts with nav-noise selectors and a scroll container", () => {
    expect(dingtalkAdapter.id).toBe("dingtalk");
    expect(dingtalkAdapter.hosts).toContain("open.dingtalk.com");
    expect(dingtalkAdapter.excludeSelectors).toContain('[class*="treeMenu"]');
    expect(dingtalkAdapter.excludeSelectors).toContain(".doc-right-wrapper");
    expect(dingtalkAdapter.scrollContainerSelector).toBe(".article-main-new");
    expect(dingtalkAdapter.domFixScripts?.[0]?.id).toBe("dingtalk-monaco-code-fix");
  });
});

describe("materializeMonacoCodeBlocks", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    clearMonaco();
  });

  it("replaces monaco blocks with pre/code holding the full model source", () => {
    document.body.append(makeBlock(true), makeBlock(true));
    const plain = document.createElement("pre");
    plain.textContent = "plain";
    document.body.append(plain);
    setMonaco([makeModel("code1", "java"), makeModel("code2\nmore", "javascript")]);

    const result = materializeMonacoCodeBlocks();

    expect(result).toEqual({ fixed: 2, skipped: 0, mismatch: false });
    const codes = document.querySelectorAll("pre > code");
    expect(codes).toHaveLength(2);
    expect(codes[0].textContent).toBe("code1");
    expect(codes[0].className).toBe("language-java");
    expect(codes[1].textContent).toBe("code2\nmore");
    expect(codes[1].className).toBe("language-javascript");
    // Original plain pre is untouched.
    const pres = document.querySelectorAll("pre");
    expect(pres.length).toBe(3);
    expect([...pres].some((p) => p.textContent === "plain")).toBe(true);
  });

  it("is a no-op when window.monaco is absent", () => {
    document.body.append(makeBlock(true));
    const result = materializeMonacoCodeBlocks();
    expect(result).toEqual({ fixed: 0, skipped: 0, mismatch: false });
    expect(document.querySelectorAll(".doc-code-block")).toHaveLength(1);
  });

  it("aborts (mismatch) and leaves DOM untouched when counts diverge", () => {
    document.body.append(makeBlock(true), makeBlock(true));
    setMonaco([makeModel("only-one", "java")]);

    const result = materializeMonacoCodeBlocks();

    expect(result).toEqual({ fixed: 0, skipped: 2, mismatch: true });
    expect(document.querySelectorAll(".doc-code-block")).toHaveLength(2);
    expect(document.querySelectorAll("pre > code")).toHaveLength(0);
  });

  it("skips non-monaco doc-code-blocks without a model", () => {
    document.body.append(makeBlock(true), makeBlock(false));
    setMonaco([makeModel("real", "java"), makeModel("unused", "java")]);

    const result = materializeMonacoCodeBlocks();

    expect(result).toEqual({ fixed: 1, skipped: 1, mismatch: false });
    expect(document.querySelectorAll("pre > code")).toHaveLength(1);
    expect(document.querySelectorAll(".doc-code-block")).toHaveLength(1);
  });

  it("omits the language class when getLanguageId returns empty", () => {
    document.body.append(makeBlock(true));
    setMonaco([makeModel("noflang", "")]);

    materializeMonacoCodeBlocks();

    const code = document.querySelector("pre > code");
    expect(code?.textContent).toBe("noflang");
    expect(code?.className).toBe("");
  });
});
