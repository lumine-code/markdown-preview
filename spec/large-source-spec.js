const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Markdown source and presentation budgets", () => {
  let editor, preview, renderer;
  beforeEach(async () => {
    jasmine.useRealClock();
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    await lumine.packages.activatePackage("language-gfm");
    await lumine.packages.activatePackage("markdown-preview");
    renderer = require("../lib/renderer");
    editor = await lumine.workspace.open("source-budget.md");
    editor.setText("# Before");
    const View = require("../lib/markdown-preview-view");
    preview = new View({ editorId: editor.id });
    await preview.renderMarkdown();
  });
  afterEach(() => {
    preview?.destroy();
    editor?.destroy();
  });

  it("rejects oversized editor input before reading and resumes after shrinking", async () => {
    const length = spyOn(editor.getBuffer(), "getLength").and.returnValue(537602502);
    const read = spyOn(editor, "getText").and.throwError("Whole-source read");
    await preview.renderMarkdown();
    expect(read).not.toHaveBeenCalled();
    expect(preview.element.textContent).toContain("2 Mi UTF-16");
    expect(preview.editorCache.editorsByPre.size).toBe(0);
    expect(preview.loading).toBe(false);
    length.and.callThrough();
    read.and.callThrough();
    editor.setText("# After");
    await preview.renderMarkdown();
    expect(preview.element.querySelector("h1").textContent).toBe("After");
  });

  it("keeps complete large code blocks as plain PRE content without constructing a code editor", async () => {
    const text = "x".repeat(70000);
    const cache = new renderer.EditorCache();
    const [fragment, done] = await renderer.toDOMFragment(
      "```text\n" + text + "\n```",
      null,
      editor.getGrammar(),
      cache,
    );
    const container = document.createElement("div");
    container.appendChild(fragment);
    try {
      await done(container);
      expect(container.querySelector("pre").textContent.trimEnd()).toBe(text);
      expect(cache.editorsByPre.size).toBe(0);
      expect(container.querySelector("lumine-text-editor")).toBeNull();
    } finally {
      cache.destroy();
    }
  });

  it("bounds direct render calls before invoking a parser", async () => {
    const parse = spyOn(lumine.tools.markdown, "render").and.throwError("Parser called");
    await expectAsync(renderer.toHTML("x".repeat(2 * 1024 * 1024 + 1))).toBeRejectedWithError(
      /2 Mi UTF-16/,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("reads file sources incrementally with decode and cancellation budgets", async () => {
    const budget = require("../lib/source-budget");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-source-budget-"));
    const file = path.join(directory, "source.md");
    try {
      const text = "x".repeat(65535) + "😀\r\n# Heading";
      fs.writeFileSync(file, text);
      expect(await budget.readFile(file)).toBe(text);
      fs.writeFileSync(file, "x".repeat(budget.MAX_SOURCE_UNITS + 1));
      await expectAsync(budget.readFile(file)).toBeRejectedWithError(/2 Mi UTF-16/);
      const controller = new AbortController();
      controller.abort();
      await expectAsync(budget.readFile(file, { signal: controller.signal })).toBeRejected();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
