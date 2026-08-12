const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const MarkdownPreviewView = require("../lib/markdown-preview-view");
const { TextEditor } = require("lumine");
const TextMateLanguageMode = new TextEditor().getBuffer().getLanguageMode().constructor;

describe("Markdown Preview", function () {
  let preview = null;

  beforeEach(async () => {
    const fixturesPath = path.join(__dirname, "fixtures");
    const tempPath = temp.mkdirSync("lumine");
    fs.copySync(fixturesPath, tempPath);
    lumine.project.setPaths([tempPath]);

    jasmine.unspy(TextMateLanguageMode.prototype, "tokenizeInBackground");

    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));

    await lumine.packages.activatePackage("markdown-preview");

    await lumine.packages.activatePackage("language-gfm");

    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
  });

  const expectPreviewInSplitPane = async () => {
    await conditionPromise(() => lumine.workspace.getCenter().getPanes().length === 2);
    await conditionPromise(
      () => (preview = lumine.workspace.getCenter().getPanes()[1].getActiveItem()),
      "markdown preview to be created",
    );
    await conditionPromise(
      () => !preview.element.classList.contains("loading"),
      "preview to finish loading",
    );

    expect(preview).toBeInstanceOf(MarkdownPreviewView);
    expect(preview.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
  };

  describe("when a preview has not been created for the file", function () {
    it("displays a markdown preview in a split pane", async () => {
      await lumine.workspace.open("subdir/file.markdown");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      const [editorPane] = lumine.workspace.getCenter().getPanes();
      expect(editorPane.getItems()).toHaveLength(1);
      expect(editorPane.isActive()).toBe(true);
    });

    describe("when the editor's path does not exist", function () {
      it("splits the current pane to the right with a markdown preview for the file", async () => {
        await lumine.workspace.open("new.markdown");
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        );
        await expectPreviewInSplitPane();
      });
    });

    describe("when the editor does not have a path", function () {
      it("splits the current pane to the right with a markdown preview for the file", async () => {
        await lumine.workspace.open("");
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        );
        await expectPreviewInSplitPane();
      });
    });

    describe("when the path contains a space", function () {
      it("renders the preview", async () => {
        await lumine.workspace.open("subdir/file with space.md");
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        );
        await expectPreviewInSplitPane();
      });
    });

    describe("when the path contains accented characters", function () {
      it("renders the preview", async () => {
        await lumine.workspace.open("subdir/áccéntéd.md");
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        );
        await expectPreviewInSplitPane();
      });
    });
  });

  describe("when a preview has been created for the file", function () {
    beforeEach(async () => {
      await lumine.workspace.open("subdir/file.markdown");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();
    });

    it("closes the existing preview when toggle is triggered a second time on the editor", async () => {
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );

      const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
      expect(editorPane.isActive()).toBe(true);
      expect(previewPane.getActiveItem()).toBeUndefined();
    });

    it("closes the existing preview when toggle is triggered on it and it has focus", async () => {
      const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
      previewPane.activate();

      lumine.commands.dispatch(editorPane.getActiveItem().getElement(), "markdown-preview:toggle");
      expect(previewPane.getActiveItem()).toBeUndefined();
    });

    describe("when the editor is modified", function () {
      it("re-renders the preview", async () => {
        spyOn(preview, "showLoading");

        const markdownEditor = lumine.workspace.getActiveTextEditor();
        markdownEditor.setText("Hey!");

        await conditionPromise(() => preview.element.textContent.includes("Hey!"));

        expect(preview.showLoading).not.toHaveBeenCalled();
      });

      it("invokes ::onDidChangeMarkdown listeners", async () => {
        let listener;
        const markdownEditor = lumine.workspace.getActiveTextEditor();
        preview.onDidChangeMarkdown((listener = jasmine.createSpy("didChangeMarkdownListener")));

        markdownEditor.setText("Hey!");

        await conditionPromise(
          () => listener.calls.count() > 0,
          "::onDidChangeMarkdown handler to be called",
        );
      });

      describe("when the preview is in the active pane but is not the active item", function () {
        it("re-renders the preview but does not make it active", async () => {
          const markdownEditor = lumine.workspace.getActiveTextEditor();
          const previewPane = lumine.workspace.getCenter().getPanes()[1];
          previewPane.activate();

          await lumine.workspace.open();

          markdownEditor.setText("Hey!");

          await conditionPromise(() => preview.element.textContent.includes("Hey!"));

          expect(previewPane.isActive()).toBe(true);
          expect(previewPane.getActiveItem()).not.toBe(preview);
        });
      });

      describe("when the preview is not the active item and not in the active pane", function () {
        it("re-renders the preview and makes it active", async () => {
          const markdownEditor = lumine.workspace.getActiveTextEditor();
          const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
          previewPane.splitRight({ copyActiveItem: true });
          previewPane.activate();

          await lumine.workspace.open();

          editorPane.activate();
          markdownEditor.setText("Hey!");

          await conditionPromise(() => preview.element.textContent.includes("Hey!"));

          expect(editorPane.isActive()).toBe(true);
          expect(previewPane.getActiveItem()).toBe(preview);
        });
      });

      describe("when the liveUpdate config is set to false", function () {
        it("only re-renders the markdown when the editor is saved, not when the contents are modified", async () => {
          lumine.config.set("markdown-preview.liveUpdate", false);

          const didStopChangingHandler = jasmine.createSpy("didStopChangingHandler");
          lumine.workspace
            .getActiveTextEditor()
            .getBuffer()
            .onDidStopChanging(didStopChangingHandler);
          lumine.workspace.getActiveTextEditor().setText("ch ch changes");

          await conditionPromise(() => didStopChangingHandler.calls.count() > 0);

          expect(preview.element.textContent).not.toMatch("ch ch changes");
          lumine.workspace.getActiveTextEditor().save();

          await conditionPromise(() => preview.element.textContent.includes("ch ch changes"));
        });
      });
    });

    describe("when the original preview is split", function () {
      it("renders another preview in the new split pane", async () => {
        lumine.workspace.getCenter().getPanes()[1].splitRight({ copyActiveItem: true });

        expect(lumine.workspace.getCenter().getPanes()).toHaveLength(3);

        await conditionPromise(
          () => (preview = lumine.workspace.getCenter().getPanes()[2].getActiveItem()),
          "split markdown preview to be created",
        );

        expect(preview).toBeInstanceOf(MarkdownPreviewView);
        expect(preview.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
      });
    });

    describe("when the editor is destroyed", function () {
      beforeEach(() => lumine.workspace.getCenter().getPanes()[0].destroyActiveItem());

      it("falls back to using the file path", async () => {
        lumine.workspace.getCenter().getPanes()[1].activate();
        expect(preview.file.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
      });

      it("continues to update the preview if the file is changed on #win32 and #darwin", async () => {
        let listener;
        const titleChangedCallback = jasmine.createSpy("titleChangedCallback");

        // The fallback file watcher arms asynchronously; wait for it before
        // mutating the file so the first change is observed.
        await preview.file.getStartPromise();

        expect(preview.getTitle()).toBe("file.markdown Preview");
        preview.onDidChangeTitle(titleChangedCallback);
        fs.renameSync(preview.getPath(), path.join(path.dirname(preview.getPath()), "file2.md"));

        await conditionPromise(() => preview.getTitle() === "file2.md Preview", "title to update");

        expect(titleChangedCallback).toHaveBeenCalled();

        spyOn(preview, "showLoading");

        // The watch was re-pointed at the renamed file; wait for the new
        // watcher to arm before writing to it.
        await preview.file.getStartPromise();

        fs.writeFileSync(preview.getPath(), "Hey!");

        await conditionPromise(
          () => preview.element.textContent.includes("Hey!"),
          "contents to update",
        );

        expect(preview.showLoading).not.toHaveBeenCalled();

        preview.onDidChangeMarkdown((listener = jasmine.createSpy("didChangeMarkdownListener")));

        fs.writeFileSync(preview.getPath(), "Hey!");

        await conditionPromise(
          () => listener.calls.count() > 0,
          "::onDidChangeMarkdown handler to be called",
        );
      });

      it("allows a new split pane of the preview to be created", async () => {
        lumine.workspace.getCenter().getPanes()[1].splitRight({ copyActiveItem: true });

        expect(lumine.workspace.getCenter().getPanes()).toHaveLength(3);

        await conditionPromise(
          () => (preview = lumine.workspace.getCenter().getPanes()[2].getActiveItem()),
          "split markdown preview to be created",
        );

        expect(preview).toBeInstanceOf(MarkdownPreviewView);
        expect(preview.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
      });
    });
  });

  describe("when the markdown preview view is requested by file URI", function () {
    it("opens a preview editor and watches the file for changes", async () => {
      await lumine.workspace.open(
        `markdown-preview://${lumine.project.getDirectories()[0].resolve("subdir/file.markdown")}`,
      );

      preview = lumine.workspace.getActivePaneItem();
      expect(preview).toBeInstanceOf(MarkdownPreviewView);

      spyOn(preview, "renderMarkdownText");
      preview.file.emitter.emit("did-change");

      await conditionPromise(
        () => preview.renderMarkdownText.calls.count() > 0,
        "markdown to be re-rendered after file changed",
      );
    });
  });

  describe("when the editor's grammar it not enabled for preview", function () {
    it("does not open the markdown preview", async () => {
      lumine.config.set("markdown-preview.grammars", []);

      await lumine.workspace.open("subdir/file.markdown");

      spyOn(lumine.workspace, "open").and.callThrough();
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      expect(lumine.workspace.open).not.toHaveBeenCalled();
    });
  });

  describe("when the editor's path changes on #win32 and #darwin", function () {
    it("updates the preview's title", async () => {
      const titleChangedCallback = jasmine.createSpy("titleChangedCallback");

      await lumine.workspace.open("subdir/file.markdown");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );

      await expectPreviewInSplitPane();

      // The preview follows the editor, whose buffer follows the renamed file
      // on disk. Wait for the buffer's file watch to arm before renaming.
      await lumine.workspace.getActiveTextEditor().getBuffer().getFileWatchStartPromise();

      expect(preview.getTitle()).toBe("file.markdown Preview");
      preview.onDidChangeTitle(titleChangedCallback);
      fs.renameSync(
        lumine.workspace.getActiveTextEditor().getPath(),
        path.join(path.dirname(lumine.workspace.getActiveTextEditor().getPath()), "file2.md"),
      );

      await conditionPromise(() => preview.getTitle() === "file2.md Preview");

      expect(titleChangedCallback).toHaveBeenCalled();
    });
  });

  describe("when the URI opened does not have a markdown-preview protocol", function () {
    it("does not throw an error trying to decode the URI (regression)", async () => {
      await lumine.workspace.open("%");

      expect(lumine.workspace.getActiveTextEditor()).toBeTruthy();
    });
  });

  describe("markdown-preview:toggle", function () {
    beforeEach(async () => {
      await lumine.workspace.open("code-block.md");
    });

    // The command is registered once, on the workspace, so that Packages >
    // Markdown Preview works when focus is anywhere. The grammar list decides
    // what the command does, not whether it can be dispatched.
    it("exists whatever the active editor's grammar is", async () => {
      lumine.config.set("markdown-preview.grammars", ["source.weird-md"]);
      const commands = lumine.commands
        .findCommands({ target: lumine.workspace.getElement() })
        .map((command) => command.name);
      expect(commands).toContain("markdown-preview:toggle");
    });

    it("previews an editor whose grammar is in `markdown-preview.grammars`", async () => {
      lumine.config.set("markdown-preview.grammars", ["source.gfm"]);
      lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");

      await conditionPromise(() => lumine.workspace.getCenter().getPanes()[1]?.getActiveItem());
      expect(
        lumine.workspace.getCenter().getPanes()[1].getActiveItem() instanceof MarkdownPreviewView,
      ).toBe(true);
    });

    it("says why it declined when the grammar is not in the list", async () => {
      lumine.config.set("markdown-preview.grammars", ["source.weird-md"]);
      const warnings = [];
      lumine.notifications.onDidAddNotification((notification) => warnings.push(notification));

      lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");

      expect(warnings.length).toBe(1);
      expect(warnings[0].getType()).toBe("warning");
    });
  });

  describe("markdown-preview:preview-file", function () {
    // The real row builder, so this covers the actual DOM contract rather than
    // a stand-in that could drift from it.
    const treeViewPath = lumine.packages.resolvePackagePath("tree-view");
    const TreeEntry = require(path.join(treeViewPath, "lib", "tree-entry"));
    const TreeRowView = require(path.join(treeViewPath, "lib", "tree-row-view"));
    const rowViews = [];

    afterEach(async () => {
      for (const view of rowViews) view.destroy();
      rowViews.length = 0;
    });

    function treeViewRow(name, filePath = path.join(lumine.project.getPaths()[0], name)) {
      const container = document.createElement("div");
      container.classList.add("tree-view");

      const treeView = { selectedEntries: new Set() };
      const entry = new TreeEntry(treeView, {
        item: {
          name,
          path: filePath,
          status: null,
          isPathEqual: (other) => other === filePath,
        },
        kind: "file",
      });
      const view = new TreeRowView(treeView, "file");
      rowViews.push(view);
      container.appendChild(view.bind(entry));

      return { row: view.element, nameSpan: view.name };
    }

    function contextMenuLabels(element) {
      return lumine.contextMenu.templateForElement(element).map((item) => item.label);
    }

    it("offers the command anywhere on the row, not just on the file name", async () => {
      const { row, nameSpan } = treeViewRow("file.md");

      // The bug this guards: the item used to be registered on the span, so it
      // was absent unless the pointer happened to be over the text itself.
      expect(contextMenuLabels(row)).toContain("Markdown Preview");
      expect(contextMenuLabels(nameSpan)).toContain("Markdown Preview");
    });

    it("offers the command for every previewable extension and no others", async () => {
      for (const name of ["a.markdown", "a.md", "a.mdown", "a.mkd", "a.mkdown", "a.ron", "a.txt"]) {
        expect(contextMenuLabels(treeViewRow(name).row)).toContain("Markdown Preview");
      }
      for (const name of ["a.js", "a.mdx", "md"]) {
        expect(contextMenuLabels(treeViewRow(name).row)).not.toContain("Markdown Preview");
      }
    });

    it("previews the row's file when dispatched from the name span inside it", async () => {
      const filePath = path.join(lumine.project.getPaths()[0], "subdir", "simple.md");
      const { nameSpan } = treeViewRow("simple.md", filePath);

      // Dispatching from the span is what a real right-click on the text does;
      // the handler has to read the row that matched, not the click target.
      lumine.commands.dispatch(nameSpan, "markdown-preview:preview-file");

      await conditionPromise(
        () => lumine.workspace.getActivePaneItem() instanceof MarkdownPreviewView,
      );

      expect(lumine.workspace.getActivePaneItem().getPath()).toBe(filePath);
    });
  });

  describe("when markdown-preview:copy-html is triggered", function () {
    it("copies the HTML to the clipboard", async () => {
      await lumine.workspace.open("subdir/simple.md");

      await lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:copy-html",
      );

      // Windows' clipboard normalizes line endings to CRLF on the round-trip.
      expect(lumine.clipboard.read().replace(/\r\n/g, "\n")).toBe(`\
<p><em>italic</em></p>
<p><strong>bold</strong></p>
<p>encoding \u2192 issue</p>\
`);

      lumine.workspace.getActiveTextEditor().setSelectedBufferRange([
        [0, 0],
        [1, 0],
      ]);

      await lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:copy-html",
      );

      expect(lumine.clipboard.read()).toBe(`\
<p><em>italic</em></p>\
`);
    });

    describe("code block tokenization", function () {
      beforeEach(async () => {
        await lumine.packages.activatePackage("language-ruby");

        await lumine.packages.activatePackage("markdown-preview");

        await lumine.workspace.open("subdir/file.markdown");

        await lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:copy-html",
        );

        preview = document.createElement("div");
        preview.innerHTML = lumine.clipboard.read();
      });

      describe("when the code block's fence name has a matching grammar", function () {
        it("tokenizes the code block with the grammar", async () => {
          expect(preview.querySelector("pre span.entity.name.function.ruby")).toBeDefined();
        });
      });

      describe("when the code block's fence name doesn't have a matching grammar", function () {
        it("does not tokenize the code block", async () => {
          expect(
            preview.querySelectorAll("pre.lang-kombucha .line .syntax--null-grammar").length,
          ).toBe(2);
        });
      });

      describe("when the code block contains empty lines", function () {
        it("doesn't remove the empty lines", async () => {
          expect(preview.querySelector("pre.lang-python").children.length).toBe(6);
          expect(preview.querySelector("pre.lang-python div:nth-child(2)").textContent.trim()).toBe(
            "",
          );
          expect(preview.querySelector("pre.lang-python div:nth-child(4)").textContent.trim()).toBe(
            "",
          );
          expect(preview.querySelector("pre.lang-python div:nth-child(5)").textContent.trim()).toBe(
            "",
          );
        });
      });
    });
  });

  describe("sanitization", function () {
    it("removes script tags and attributes that commonly contain inline scripts", async () => {
      await lumine.workspace.open("subdir/evil.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.innerHTML).toBe(`\
<p>hello</p>


<img>
world\
`);
    });

    it("remove any <!doctype> tag on markdown files", async () => {
      await lumine.workspace.open("subdir/doctype-tag.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.innerHTML).toBe(`\
<p>content
</p>\
`);
    });
  });

  describe("when the markdown contains an <html> tag", function () {
    it("does not throw an exception", async () => {
      await lumine.workspace.open("subdir/html-tag.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.innerHTML).toBe("content");
    });
  });

  describe("when the markdown contains a <pre> tag", function () {
    it("does not throw an exception", async () => {
      await lumine.workspace.open("subdir/pre-tag.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.querySelector("lumine-text-editor")).toBeDefined();
    });
  });

  describe("when there is an image with a relative path and no directory", function () {
    it("does not alter the image src", async () => {
      for (let projectPath of lumine.project.getPaths()) {
        lumine.project.removePath(projectPath);
      }

      const filePath = path.join(temp.mkdirSync("lumine"), "bar.md");
      fs.writeFileSync(filePath, "![rel path](/foo.png)");

      await lumine.workspace.open(filePath);

      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.innerHTML).toBe(`\
<p><img src="/foo.png" alt="rel path"></p>\
`);
    });
  });

  describe("GitHub style markdown preview", function () {
    beforeEach(() => lumine.config.set("markdown-preview.useGitHubStyle", false));

    it("renders markdown using the default style when GitHub styling is disabled", async () => {
      await lumine.workspace.open("subdir/simple.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.getAttribute("data-use-github-style")).toBeNull();
    });

    it("renders markdown using the GitHub styling when enabled", async () => {
      lumine.config.set("markdown-preview.useGitHubStyle", true);

      await lumine.workspace.open("subdir/simple.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.getAttribute("data-use-github-style")).toBe("auto");
    });

    it("updates the rendering style immediately when the configuration is changed", async () => {
      await lumine.workspace.open("subdir/simple.md");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();

      expect(preview.element.getAttribute("data-use-github-style")).toBeNull();

      lumine.config.set("markdown-preview.useGitHubStyle", true);
      expect(preview.element.getAttribute("data-use-github-style")).not.toBeNull();

      lumine.config.set("markdown-preview.useGitHubStyle", false);
      expect(preview.element.getAttribute("data-use-github-style")).toBeNull();
    });
  });

  describe("when markdown-preview:save-as-html is triggered", function () {
    beforeEach(async () => {
      await lumine.workspace.open("subdir/simple.markdown");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();
    });

    it("saves the HTML when it is triggered and the editor has focus", async () => {
      const [editorPane] = lumine.workspace.getCenter().getPanes();
      editorPane.activate();

      const outputPath = temp.path({ suffix: ".html" });
      expect(fs.existsSync(outputPath)).toBe(false);

      spyOn(preview, "getSaveDialogOptions").and.returnValue({
        defaultPath: outputPath,
      });
      spyOn(lumine.applicationDelegate, "showSaveDialog").and.callFake((options) =>
        Promise.resolve({ canceled: false, filePath: options.defaultPath }),
      );
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:save-as-html",
      );

      await conditionPromise(() => fs.existsSync(outputPath));

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it("saves the HTML when it is triggered and the preview pane has focus", async () => {
      const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
      previewPane.activate();

      const outputPath = temp.path({ suffix: ".html" });
      expect(fs.existsSync(outputPath)).toBe(false);

      spyOn(preview, "getSaveDialogOptions").and.returnValue({
        defaultPath: outputPath,
      });
      spyOn(lumine.applicationDelegate, "showSaveDialog").and.callFake((options) =>
        Promise.resolve({ canceled: false, filePath: options.defaultPath }),
      );
      lumine.commands.dispatch(
        editorPane.getActiveItem().getElement(),
        "markdown-preview:save-as-html",
      );

      await conditionPromise(() => fs.existsSync(outputPath));

      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });

  describe("when markdown-preview:export-to-pdf is triggered", function () {
    beforeEach(async () => {
      await lumine.workspace.open("subdir/simple.markdown");
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );
      await expectPreviewInSplitPane();
    });

    it("prints the standalone document the HTML export would have written", async () => {
      const [editorPane] = lumine.workspace.getCenter().getPanes();
      editorPane.activate();

      const outputPath = temp.path({ suffix: ".pdf" });
      spyOn(preview, "getPDFSaveDialogOptions").and.returnValue({ defaultPath: outputPath });
      spyOn(lumine.window, "showSaveDialog").and.callFake((options) =>
        Promise.resolve({ canceled: false, filePath: options.defaultPath }),
      );
      const printToPDF = spyOn(lumine.application, "printToPDF").and.returnValue(
        Promise.resolve({ outcome: "success", result: outputPath }),
      );

      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:export-to-pdf",
      );

      await conditionPromise(() => printToPDF.calls.count() > 0);

      const [html, filePath] = printToPDF.calls.argsFor(0);
      expect(filePath).toBe(outputPath);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("class='markdown-preview'");
      // The preview's own stylesheet rides along, which is the whole point of
      // printing this document rather than the window it is displayed in.
      expect(html).toContain("<style>");
    });

    it("writes nothing when the save dialog is dismissed", async () => {
      const [, previewPane] = lumine.workspace.getCenter().getPanes();
      previewPane.activate();

      spyOn(lumine.window, "showSaveDialog").and.returnValue(
        Promise.resolve({ canceled: true, filePath: undefined }),
      );
      spyOn(lumine.application, "printToPDF");

      await lumine.packages.getActivePackage("markdown-preview").mainModule.exportToPDF();

      expect(lumine.application.printToPDF).not.toHaveBeenCalled();
    });

    it("reports a failure from the main process instead of failing silently", async () => {
      const [, previewPane] = lumine.workspace.getCenter().getPanes();
      previewPane.activate();

      spyOn(lumine.window, "showSaveDialog").and.returnValue(
        Promise.resolve({ canceled: false, filePath: temp.path({ suffix: ".pdf" }) }),
      );
      spyOn(lumine.application, "printToPDF").and.returnValue(
        Promise.resolve({ outcome: "failure", error: { message: "no printer here" } }),
      );
      spyOn(lumine.notifications, "addError");

      await lumine.packages.getActivePackage("markdown-preview").mainModule.exportToPDF();

      expect(lumine.notifications.addError).toHaveBeenCalled();
      expect(lumine.notifications.addError.calls.argsFor(0)[1].detail).toBe("no printer here");
    });

    it("declines with a warning when no preview is open", async () => {
      lumine.workspace.getCenter().getPanes()[1].destroyItems();
      await lumine.workspace.open("subdir/file.txt");
      spyOn(lumine.notifications, "addWarning");
      spyOn(lumine.application, "printToPDF");

      await lumine.packages.getActivePackage("markdown-preview").mainModule.exportToPDF();

      expect(lumine.notifications.addWarning).toHaveBeenCalled();
      expect(lumine.application.printToPDF).not.toHaveBeenCalled();
    });
  });
});
