describe("Markdown previews with no source grammar", () => {
  let editor, preview, renderer;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    await lumine.packages.activatePackage("language-gfm");
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("markdown-preview");
    editor = await lumine.workspace.open("none-preview.md");
    editor.setText("# Before\n\n```js\nconst value = 1;\n```\n");
    const MarkdownPreviewView = require("../lib/markdown-preview-view");
    renderer = require("../lib/renderer");
    preview = new MarkdownPreviewView({ editorId: editor.id });
    jasmine.attachToDOM(preview.element);
    await preview.renderMarkdown();
  });

  afterEach(() => {
    preview.destroy();
    editor.destroy();
  });

  it("releases rendered code editors, skips source processing and resumes with the latest source", async () => {
    expect(preview.element.querySelector("h1").textContent).toBe("Before");
    expect(preview.editorCache.editorsByPre.size).toBeGreaterThan(0);
    const read = spyOn(preview, "getMarkdownSource").and.callThrough();
    const render = spyOn(renderer, "toDOMFragment").and.callThrough();
    const exportHTML = spyOn(renderer, "toHTML").and.callThrough();

    lumine.grammars.assignGrammar(editor, lumine.grammars.nullGrammar);
    expect(preview.element.textContent).toContain("Preview paused.");
    expect(preview.editorCache.editorsByPre.size).toBe(0);
    editor.setText("# After\n");
    editor.buffer.emitDidStopChangingEvent();
    await preview.renderMarkdown();
    expect(await preview.getHTML()).toBeUndefined();
    expect(await preview.buildStandaloneDocument()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(exportHTML).not.toHaveBeenCalled();

    lumine.grammars.autoAssignLanguageMode(editor.buffer);
    await preview.currentRender.promise;
    expect(preview.element.querySelector("h1").textContent).toBe("After");
    expect(read).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });

  it("cancels an in-flight render when None is selected", async () => {
    const requests = [];
    spyOn(renderer, "toDOMFragment").and.callFake((_text, _path, _grammar, _cache, options) => {
      return new Promise((resolve) => {
        requests.push({
          signal: options.signal,
          finish() {
            const fragment = document.createDocumentFragment();
            const heading = document.createElement("h1");
            heading.textContent = "Obsolete render";
            fragment.appendChild(heading);
            resolve([fragment, () => Promise.resolve()]);
          },
        });
      });
    });
    const pending = [preview.renderMarkdown()];
    await conditionPromise(() => requests.length > 0);
    pending.push(preview.renderMarkdown());
    await conditionPromise(() => requests.length > 1);
    lumine.grammars.assignGrammar(editor, lumine.grammars.nullGrammar);
    for (const request of requests) {
      expect(request.signal.aborted).toBe(true);
      request.finish();
    }
    await Promise.all(pending);
    expect(preview.element.textContent).toContain("Preview paused.");
    expect(preview.element.textContent).not.toContain("Obsolete render");
  });

  it("cancels in-flight HTML processing when the source grammar changes", async () => {
    let signal;
    spyOn(renderer, "toHTML").and.callFake((_text, _path, _grammar, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("Obsolete HTML"), { once: true });
      });
    });
    const pending = preview.getHTML();
    await conditionPromise(() => Boolean(signal));
    lumine.grammars.assignGrammar(editor, lumine.grammars.nullGrammar);
    expect(signal.aborted).toBe(true);
    expect(await pending).toBeUndefined();
  });

  it("disables source preview and HTML-copy commands even if None is in the configured scope list", () => {
    lumine.config.set("markdown-preview.grammars", [lumine.grammars.nullGrammar.scopeName]);
    lumine.grammars.assignGrammar(editor, lumine.grammars.nullGrammar);
    expect(lumine.commands.canDispatch(editor.element, "markdown-preview:toggle")).toBe(false);
    expect(lumine.commands.canDispatch(editor.element, "markdown-preview:copy-html")).toBe(false);
  });
});
