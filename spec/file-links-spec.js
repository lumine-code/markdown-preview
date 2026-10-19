const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/fs-temp").track();

describe("Markdown preview file links", () => {
  let preview;
  let directory;
  let container;
  let delegatedClick;
  let resolveFileLink;

  beforeEach(async () => {
    jasmine.useRealClock();
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    await lumine.packages.activatePackage("markdown-preview");
    const MarkdownPreviewView = require("../lib/markdown-preview-view");
    resolveFileLink = require("../lib/file-link");
    directory = temp.mkdirSync("markdown-links-");
    const sourcePath = path.join(directory, "source.md");
    fs.writeFileSync(sourcePath, "# Source");
    preview = new MarkdownPreviewView({ filePath: sourcePath });
    container = document.createElement("div");
    container.appendChild(preview.element);
    jasmine.attachToDOM(container);
    // Observe delegation without letting real links reach the editor shell or navigate.
    delegatedClick = jasmine.createSpy("delegated click");
    container.addEventListener("click", (event) => {
      delegatedClick(event);
      event.preventDefault();
      event.stopPropagation();
    });
    await preview.renderMarkdown();
    spyOn(preview, "openLinkedFile").and.callThrough();
    spyOn(lumine.workspace, "open").and.resolveTo();
    spyOn(lumine.notifications, "addWarning");
    lumine.config.set("markdown-preview.allowUnsafeProtocols", false);
  });

  afterEach(() => preview.destroy());

  async function render(markdown) {
    spyOn(preview, "getMarkdownSource").and.resolveTo(markdown);
    await preview.renderMarkdown();
  }

  async function click(selector = "a") {
    const target = preview.element.querySelector(selector);
    expect(target).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    const operation = preview.openLinkedFile.calls.mostRecent()?.returnValue;
    await operation?.catch(() => {});
    return event;
  }

  for (const useOriginalParser of [true, false]) {
    describe(useOriginalParser ? "with the original parser" : "with the built-in parser", () => {
      beforeEach(() => {
        lumine.config.set("markdown-preview.useOriginalParser", useOriginalParser);
      });

      it("opens an inline link from a nested label relative to its source document", async () => {
        const targetPath = path.join(directory, "target.md");
        fs.writeFileSync(targetPath, "# Target");
        // The active source editor is deliberately unrelated to the preview's file.
        const editor = lumine.workspace.buildTextEditor();
        const activeEditor = spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(editor);
        try {
          await render("[**Target**](target.md)");
          const event = await click("a strong");

          expect(lumine.workspace.open).toHaveBeenCalledOnceWith(targetPath);
          expect(activeEditor).not.toHaveBeenCalled();
          expect(event.defaultPrevented).toBeTrue();
          expect(delegatedClick).not.toHaveBeenCalled();
        } finally {
          editor.destroy();
        }
      });

      it("decodes a reference destination and removes URL suffixes from the filename", async () => {
        const targetPath = path.join(directory, "space # %.md");
        fs.writeFileSync(targetPath, "# Target");
        await render("[Target][file]\n\n[file]: space%20%23%20%25.md?raw=true#heading");

        await click();

        expect(lumine.workspace.open).toHaveBeenCalledOnceWith(targetPath);
      });

      it("opens an absolute filesystem path retained by the renderer", async () => {
        const targetPath = path.join(directory, "absolute.md");
        fs.writeFileSync(targetPath, "# Target");
        lumine.config.set("markdown-preview.allowUnsafeProtocols", true);
        await render(`[Target](${targetPath.replace(/\\/g, "/")})`);

        await click();

        expect(lumine.workspace.open).toHaveBeenCalledOnceWith(targetPath);
      });

      it("opens a Markdown file URL when unsafe protocols are enabled", async () => {
        const targetPath = path.join(directory, "file space.md");
        fs.writeFileSync(targetPath, "# Target");
        lumine.config.set("markdown-preview.allowUnsafeProtocols", true);
        await render(`[Target](${pathToFileURL(targetPath).href}?raw=true#heading)`);

        await click();

        expect(lumine.workspace.open).toHaveBeenCalledOnceWith(targetPath);
      });

      it("keeps file URLs removed when unsafe protocols are disabled", async () => {
        const targetPath = path.join(directory, "target.md");
        fs.writeFileSync(targetPath, "# Target");
        await render(`<a href="${pathToFileURL(targetPath).href}">Target</a>`);

        expect(preview.element.querySelector("a").hasAttribute("href")).toBeFalse();
        await click();

        expect(lumine.workspace.open).not.toHaveBeenCalled();
      });
    });
  }

  it("warns for a missing file without asking the workspace to create it", async () => {
    await render("[Missing](missing.md)");

    await click();

    expect(lumine.workspace.open).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning.calls.count()).toBe(1);
    const [message, options] = lumine.notifications.addWarning.calls.mostRecent().args;
    expect(message).toBe("Unable to open Markdown link");
    expect(options.detail).toMatch(/ENOENT/);
    expect(options.dismissable).toBeTrue();
  });

  it("does not open directories as linked files", async () => {
    await render("[Directory](.)");

    await click();

    expect(lumine.workspace.open).not.toHaveBeenCalled();
    expect(lumine.notifications.addWarning.calls.count()).toBe(1);
    const [message, options] = lumine.notifications.addWarning.calls.mostRecent().args;
    expect(message).toBe("Unable to open Markdown link");
    expect(options.detail).toMatch(/not a file/);
  });

  it("reports an asynchronous workspace failure", async () => {
    fs.writeFileSync(path.join(directory, "target.md"), "# Target");
    lumine.workspace.open.and.rejectWith(new Error("Opening failed"));
    await render("[Target](target.md)");

    await click();

    expect(lumine.notifications.addWarning.calls.count()).toBe(1);
    const [message, options] = lumine.notifications.addWarning.calls.mostRecent().args;
    expect(message).toBe("Unable to open Markdown link");
    expect(options.detail).toBe("Opening failed");
    expect(options.dismissable).toBeTrue();
  });

  it("declines relative links in a preview without a source path", async () => {
    fs.writeFileSync(path.join(directory, "target.md"), "# Target");
    spyOn(preview, "getPath").and.returnValue(undefined);
    await render("[Target](target.md)");

    await click();

    expect(lumine.workspace.open).not.toHaveBeenCalled();
    expect(delegatedClick).toHaveBeenCalled();
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("declines malformed encodings and NUL characters before attempting to open a file", () => {
    for (const destination of [
      "target%ZZ.md",
      "target%00.md",
      "target\0.md",
      "file:///tmp/target%ZZ.md",
      "file:///tmp/target%00.md",
    ]) {
      expect(resolveFileLink(destination, preview.getPath())).toBeNull();
    }
  });

  it("accepts a file URL regardless of protocol casing", () => {
    const targetPath = path.join(directory, "target.md");
    expect(resolveFileLink(pathToFileURL(targetPath).href.replace(/^file/, "FILE"))).toBe(
      targetPath,
    );
  });

  if (process.platform !== "win32") {
    it("declines Windows paths on a different operating system", () => {
      for (const destination of ["C:/Docs/target.md", "\\\\server\\share\\target.md"]) {
        expect(resolveFileLink(destination, preview.getPath())).toBeNull();
      }
    });
  }

  it("leaves external, application and unsupported protocol links to their existing handlers", async () => {
    lumine.config.set("markdown-preview.allowUnsafeProtocols", true);
    const links = [
      "http://example.com/",
      "https://example.com/",
      "mailto:example@example.com",
      "lumine://settings",
      "ftp://example.com/file",
      "//example.com/file",
    ];
    await render(
      links.map((href, index) => `<a id="link-${index}" href="${href}">Link</a>`).join(" "),
    );

    for (let index = 0; index < links.length; index++) await click(`#link-${index}`);

    expect(preview.openLinkedFile).not.toHaveBeenCalled();
    expect(lumine.workspace.open).not.toHaveBeenCalled();
    expect(delegatedClick).toHaveBeenCalledTimes(links.length);
  });
});
