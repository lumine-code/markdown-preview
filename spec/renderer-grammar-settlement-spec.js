const { TextEditor } = require("lumine");
const MarkdownPreviewView = require("../lib/markdown-preview-view");
const renderer = require("../lib/renderer");

describe("Markdown renderer grammar settlement", () => {
  const codeLines = ["const first = 1;", "const second = 2;", "const third = 3;"];
  const codeSource = codeLines.join("\n");
  const markdown = ["```js", ...codeLines, "```"].join("\n");

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
  });

  function codeBlockLineCount(html) {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element.querySelectorAll("pre.editor-colors .line").length;
  }

  function codeBlockSource(html) {
    const element = document.createElement("div");
    element.innerHTML = html;
    return element.querySelector("pre.editor-colors").textContent.trimEnd();
  }

  it("serializes a code block after the real grammar settles", async () => {
    const html = await renderer.toHTML(markdown);

    expect(codeBlockLineCount(html)).toBe(3);
  });

  it("waits for a delayed grammar before serializing a code block", async () => {
    let codeEditor;
    let releaseGrammar;
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      codeEditor = this;
      grammarSignal = signal;
      return new Promise((resolve) => {
        releaseGrammar = () => resolve(true);
      });
    });

    let renderFinished = false;
    const renderPromise = renderer.toHTML(markdown).then((html) => {
      renderFinished = true;
      return html;
    });
    await conditionPromise(() => Boolean(releaseGrammar));
    await Promise.resolve();

    expect(renderFinished).toBe(false);
    expect(grammarSignal?.aborted).toBe(false);

    releaseGrammar();
    const html = await renderPromise;

    expect(codeBlockLineCount(html)).toBe(3);
    expect(codeEditor.isDestroyed()).toBe(true);
  });

  it("waits for a delayed grammar before completing a live preview render", async () => {
    let codeEditor;
    let releaseGrammar;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      codeEditor = this;
      return new Promise((resolve) => {
        releaseGrammar = () => resolve(true);
      });
    });
    const cache = new renderer.EditorCache();
    const [fragment, finishRender] = await renderer.toDOMFragment(
      markdown,
      undefined,
      undefined,
      cache,
    );
    const host = document.createElement("div");
    host.appendChild(fragment);
    document.body.appendChild(host);

    try {
      let renderFinished = false;
      const renderPromise = finishRender(host).then(() => (renderFinished = true));
      await conditionPromise(() => Boolean(releaseGrammar));
      await Promise.resolve();

      expect(renderFinished).toBe(false);

      releaseGrammar();
      await renderPromise;

      expect(renderFinished).toBe(true);
      expect(host.querySelectorAll("lumine-text-editor").length).toBe(1);
      expect(codeEditor.isDestroyed()).toBe(false);
    } finally {
      cache.destroy();
      host.remove();
    }
  });

  it("destroys a live render's owned cache while grammar settlement is pending", async () => {
    let codeEditor;
    let finishGrammarWait;
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      codeEditor = this;
      grammarSignal = signal;
      return new Promise((resolve) => {
        finishGrammarWait = resolve;
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    const cache = new renderer.EditorCache();
    const controller = new AbortController();
    const [fragment, finishRender] = await renderer.toDOMFragment(
      markdown,
      undefined,
      undefined,
      cache,
      { signal: controller.signal },
    );
    const host = document.createElement("div");
    host.appendChild(fragment);
    document.body.appendChild(host);

    try {
      const renderPromise = finishRender(host);
      await conditionPromise(() => Boolean(codeEditor));
      expect(cache.editorsByPre.size).toBe(1);

      controller.abort();
      cache.destroy();
      await renderPromise;

      expect(grammarSignal.aborted).toBe(true);
      expect(codeEditor.isDestroyed()).toBe(true);
      expect(cache.editorsByPre.size).toBe(0);

      finishGrammarWait(true);
      await Promise.resolve();
      expect(cache.editorsByPre.size).toBe(0);
    } finally {
      cache.destroy();
      host.remove();
    }
  });

  it("destroys the view-owned cache and ignores a stale live-render completion", async () => {
    let codeEditor;
    let finishGrammarWait;
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      codeEditor = this;
      grammarSignal = signal;
      return new Promise((resolve) => {
        finishGrammarWait = resolve;
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    const filePath = lumine.project.getDirectories()[0].resolve("subdir/code-block.md");
    const view = new MarkdownPreviewView({ filePath });
    const changed = jasmine.createSpy("changed");
    view.onDidChangeMarkdown(changed);
    document.body.appendChild(view.element);

    await conditionPromise(() => Boolean(codeEditor));
    const ownedCache = view.editorCache;
    expect(ownedCache.editorsByPre.size).toBe(1);

    view.destroy();

    expect(grammarSignal.aborted).toBe(true);
    expect(codeEditor.isDestroyed()).toBe(true);
    expect(ownedCache.editorsByPre.size).toBe(0);

    finishGrammarWait(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(view.element.isConnected).toBe(false);
  });

  it("does not publish a stale render whose source resolves after a newer render", async () => {
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    const view = new MarkdownPreviewView({
      filePath: lumine.project.getDirectories()[0].resolve("subdir/code-block.md"),
    });
    view.loaded = true;
    document.body.appendChild(view.element);
    const changed = jasmine.createSpy("changed");
    view.onDidChangeMarkdown(changed);

    let releaseOldSource;
    spyOn(view, "getMarkdownSource").and.returnValues(
      new Promise((resolve) => {
        releaseOldSource = resolve;
      }),
      Promise.resolve("## New render"),
    );

    try {
      const oldRender = view.renderMarkdown();
      const newRender = view.renderMarkdown();
      await newRender;

      const htmlAfterNewRender = view.element.innerHTML;
      expect(view.element.querySelector("h2").textContent).toBe("New render");
      expect(changed).toHaveBeenCalledTimes(1);

      releaseOldSource("## Old render");
      await oldRender;

      expect(view.element.innerHTML).toBe(htmlAfterNewRender);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(view.editorCache.editorsByPre.size).toBe(0);
    } finally {
      view.destroy();
    }
  });

  it("does not publish an error from a stale source request", async () => {
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    const view = new MarkdownPreviewView({
      filePath: lumine.project.getDirectories()[0].resolve("subdir/code-block.md"),
    });
    view.loaded = true;
    document.body.appendChild(view.element);
    const showError = spyOn(view, "showError").and.callThrough();

    let rejectOldSource;
    spyOn(view, "getMarkdownSource").and.returnValues(
      new Promise((_resolve, reject) => {
        rejectOldSource = reject;
      }),
      Promise.resolve("## New render"),
    );

    try {
      const oldRender = view.renderMarkdown();
      await view.renderMarkdown();
      const htmlAfterNewRender = view.element.innerHTML;

      rejectOldSource(new Error("stale read failed"));
      await oldRender;

      expect(showError).not.toHaveBeenCalled();
      expect(view.element.innerHTML).toBe(htmlAfterNewRender);
      expect(view.element.querySelector("h2").textContent).toBe("New render");
    } finally {
      view.destroy();
    }
  });

  it("keeps a newer live render authoritative when an older grammar wait finishes late", async () => {
    let releaseOldGrammar;
    let oldGrammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      if (this.getText().includes("oldValue")) {
        oldGrammarSignal = signal;
        return new Promise((resolve) => {
          releaseOldGrammar = resolve;
        });
      }
      return Promise.resolve(true);
    });
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    const view = new MarkdownPreviewView({
      filePath: lumine.project.getDirectories()[0].resolve("subdir/code-block.md"),
    });
    view.loaded = true;
    let scrollTop = 0;
    Object.defineProperty(view.element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set(value) {
        scrollTop = value;
      },
    });
    document.body.appendChild(view.element);
    const changed = jasmine.createSpy("changed");
    view.onDidChangeMarkdown(changed);
    const oldSource = "## Old render\n\n```js\nconst oldValue = 1;\n```";
    const newSource = [
      "## New render",
      "",
      "```js",
      "const newValue = 2;",
      "```",
      "",
      ...Array.from({ length: 20 }, (_, index) => `- row ${index}`),
    ].join("\n");
    spyOn(view, "getMarkdownSource").and.returnValues(
      Promise.resolve(oldSource),
      Promise.resolve(newSource),
    );

    try {
      const oldRender = view.renderMarkdown();
      await conditionPromise(() => Boolean(releaseOldGrammar));
      view.element.scrollTop = 24;

      const newRender = view.renderMarkdown();
      await newRender;

      const htmlAfterNewRender = view.element.innerHTML;
      const scrollAfterNewRender = view.element.scrollTop;
      const cacheEntriesAfterNewRender = [...view.editorCache.editorsByPre.entries()];
      expect(oldGrammarSignal.aborted).toBe(true);
      expect(view.element.querySelector("h2").textContent).toBe("New render");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(cacheEntriesAfterNewRender.length).toBe(1);
      expect(cacheEntriesAfterNewRender[0][1].isDestroyed()).toBe(false);

      releaseOldGrammar(true);
      await oldRender;

      expect(view.element.innerHTML).toBe(htmlAfterNewRender);
      expect(view.element.scrollTop).toBe(scrollAfterNewRender);
      expect(changed).toHaveBeenCalledTimes(1);
      expect([...view.editorCache.editorsByPre.entries()]).toEqual(cacheEntriesAfterNewRender);
      expect(cacheEntriesAfterNewRender[0][1].isDestroyed()).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("aborts an in-flight export when its view is destroyed", async () => {
    let codeEditor;
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      if (this.getText() !== codeSource || codeEditor) return Promise.resolve(true);
      codeEditor = this;
      grammarSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    const view = new MarkdownPreviewView({
      filePath: lumine.project.getDirectories()[0].resolve("subdir/code-block.md"),
    });
    spyOn(view, "getMarkdownSource").and.resolveTo(markdown);

    const exportPromise = view.getHTML();
    await conditionPromise(() => Boolean(grammarSignal));
    view.destroy();
    const html = await exportPromise;

    expect(grammarSignal.aborted).toBe(true);
    expect(codeBlockLineCount(html)).toBe(3);
    expect(codeEditor.isDestroyed()).toBe(true);
  });

  it("does not restore stale scroll after an event handler starts another render", async () => {
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    const view = new MarkdownPreviewView({
      filePath: lumine.project.getDirectories()[0].resolve("subdir/code-block.md"),
    });
    view.loaded = true;
    let scrollTop = 0;
    Object.defineProperty(view.element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set(value) {
        scrollTop = value;
      },
    });
    document.body.appendChild(view.element);
    const longList = Array.from({ length: 20 }, (_, index) => `- row ${index}`).join("\n");
    spyOn(view, "getMarkdownSource").and.returnValues(
      Promise.resolve(`## First render\n\n${longList}`),
      Promise.resolve(`## Event render\n\n${longList}`),
    );
    let eventRender;
    let changeCount = 0;
    view.onDidChangeMarkdown(() => {
      changeCount++;
      if (changeCount === 1) {
        view.element.scrollTop = 24;
        eventRender = view.renderMarkdown();
      }
    });

    try {
      await view.renderMarkdown();
      await eventRender;

      expect(changeCount).toBe(2);
      expect(view.element.querySelector("h2").textContent).toBe("Event render");
      expect(view.element.scrollTop).toBe(24);
    } finally {
      view.destroy();
    }
  });

  it("does not let an older cache session destroy an editor claimed by a newer one", () => {
    const cache = new renderer.EditorCache();
    const pre = document.createElement("pre");
    const editorElement = document.createElement("lumine-text-editor");
    const editor = {
      destroy: jasmine.createSpy("destroy"),
      getElement: () => editorElement,
    };
    const seedSession = cache.beginRender();
    cache.addEditor(pre, editor, seedSession);
    cache.endRender(seedSession);
    const oldSession = cache.beginRender();
    const newSession = cache.beginRender();

    expect(cache.getEditor(pre, newSession)).toBe(editor);
    cache.endRender(newSession);

    expect(cache.editorsByPre.get(pre)).toBe(editor);
    expect(editor.destroy).not.toHaveBeenCalled();

    cache.endRender(oldSession);
    expect(cache.editorsByPre.get(pre)).toBe(editor);
    expect(editor.destroy).not.toHaveBeenCalled();

    cache.destroy();
    expect(editor.destroy).toHaveBeenCalledTimes(1);
  });

  it("lets the next cache session clean up after an abandoned render", () => {
    const cache = new renderer.EditorCache();
    const pre = document.createElement("pre");
    const editor = {
      destroy: jasmine.createSpy("destroy"),
      getElement: () => document.createElement("lumine-text-editor"),
    };
    const seedSession = cache.beginRender();
    cache.addEditor(pre, editor, seedSession);
    cache.endRender(seedSession);
    cache.beginRender();
    const currentSession = cache.beginRender();

    cache.endRender(currentSession);
    expect(cache.editorsByPre.has(pre)).toBe(false);
    expect(editor.destroy).toHaveBeenCalledTimes(1);
  });

  it("lets a newer cache session discard an editor still claimed by an older one", () => {
    const cache = new renderer.EditorCache();
    const pre = document.createElement("pre");
    const editor = {
      destroy: jasmine.createSpy("destroy"),
      getElement: () => document.createElement("lumine-text-editor"),
    };
    const seedSession = cache.beginRender();
    cache.addEditor(pre, editor, seedSession);
    cache.endRender(seedSession);
    const oldSession = cache.beginRender();
    expect(cache.getEditor(pre, oldSession)).toBe(editor);
    const newSession = cache.beginRender();

    cache.endRender(newSession);
    expect(cache.editorsByPre.has(pre)).toBe(false);
    expect(editor.destroy).toHaveBeenCalledTimes(1);

    cache.endRender(oldSession);
    expect(editor.destroy).toHaveBeenCalledTimes(1);
  });

  it("finishes once when the grammar changes during the wait", async () => {
    let codeEditor;
    let finishGrammarWait;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      codeEditor = this;
      return new Promise((resolve) => {
        finishGrammarWait = resolve;
      });
    });

    const renderPromise = renderer.toHTML(markdown);
    await conditionPromise(() => Boolean(finishGrammarWait));
    expect(codeEditor.getGrammar().scopeName).toBe("source.js");

    expect(lumine.grammars.assignLanguageMode(codeEditor, "text.plain.null-grammar")).toBe(true);
    finishGrammarWait(false);
    const html = await renderPromise;

    expect(codeBlockLineCount(html)).toBe(3);
    expect(codeEditor.isDestroyed()).toBe(true);
  });

  it("falls back to the current rendering when grammar settlement reports a parse failure", async () => {
    const waitForGrammar = spyOn(TextEditor.prototype, "whenGrammarSettled").and.resolveTo(false);

    const html = await renderer.toHTML(markdown);

    expect(waitForGrammar).toHaveBeenCalledTimes(1);
    const [{ signal }] = waitForGrammar.calls.argsFor(0);
    expect(typeof signal?.addEventListener).toBe("function");
    expect(signal.aborted).toBe(false);
    expect(codeBlockLineCount(html)).toBe(3);
  });

  it("falls back to the current rendering when grammar settlement rejects", async () => {
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.rejectWith(
      new Error("parser load failed"),
    );

    const html = await renderer.toHTML(markdown);

    expect(codeBlockLineCount(html)).toBe(3);
  });

  it("preserves source code when the component update promise rejects", async () => {
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      spyOn(this.component, "getNextUpdatePromise").and.rejectWith(
        new Error("component update failed"),
      );
      return Promise.resolve(true);
    });

    const html = await renderer.toHTML(markdown);

    expect(codeBlockLineCount(html)).toBe(0);
    expect(codeBlockSource(html)).toBe(codeSource);
  });

  it("preserves nonempty source when the component has no rendered lines", async () => {
    let codeEditor;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      codeEditor = this;
      const editorElement = this.getElement();
      const querySelectorAll = editorElement.querySelectorAll.bind(editorElement);
      spyOn(editorElement, "querySelectorAll").and.callFake((selector) => {
        if (selector === ".line:not(.dummy)") return [];
        return querySelectorAll(selector);
      });
      return Promise.resolve(true);
    });

    const html = await renderer.toHTML(markdown);

    expect(codeBlockLineCount(html)).toBe(0);
    expect(codeBlockSource(html)).toBe(codeSource);
    expect(codeEditor.isDestroyed()).toBe(true);
  });

  it("preserves source and cleans up when copying rendered lines fails", async () => {
    let codeEditor;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function () {
      codeEditor = this;
      const editorElement = this.getElement();
      const querySelectorAll = editorElement.querySelectorAll.bind(editorElement);
      spyOn(editorElement, "querySelectorAll").and.callFake((selector) => {
        if (selector === ".line:not(.dummy)") return [{ firstChild: null }];
        return querySelectorAll(selector);
      });
      return Promise.resolve(true);
    });

    const html = await renderer.toHTML(markdown);

    expect(codeBlockLineCount(html)).toBe(0);
    expect(codeBlockSource(html)).toBe(codeSource);
    expect(codeEditor.isDestroyed()).toBe(true);
  });

  it("settles once when the caller aborts grammar waiting", async () => {
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      grammarSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    const controller = new AbortController();

    const renderPromise = renderer.toHTML(markdown, undefined, undefined, {
      signal: controller.signal,
    });
    await conditionPromise(() => Boolean(grammarSignal));
    controller.abort();
    const html = await renderPromise;

    expect(grammarSignal.aborted).toBe(true);
    expect(codeBlockLineCount(html)).toBe(3);
  });

  it("aborts and settles conversion when its temporary editor is destroyed", async () => {
    let codeEditor;
    let grammarSignal;
    spyOn(TextEditor.prototype, "whenGrammarSettled").and.callFake(function ({ signal } = {}) {
      codeEditor = this;
      grammarSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });

    const renderPromise = renderer.toHTML(markdown);
    await conditionPromise(() => Boolean(codeEditor));
    codeEditor.destroy();
    const html = await renderPromise;

    expect(grammarSignal.aborted).toBe(true);
    expect(codeBlockLineCount(html)).toBe(0);
    expect(codeBlockSource(html)).toBe(codeSource);
  });
});
