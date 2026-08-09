const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const MarkdownPreviewView = require("../lib/markdown-preview-view");
const { TextEditor } = require("lumine");
const TextMateLanguageMode = new TextEditor().getBuffer().getLanguageMode().constructor;

describe("Markdown Preview", function () {
  let preview = null;

  beforeEach(function () {
    const fixturesPath = path.join(__dirname, "fixtures");
    const tempPath = temp.mkdirSync("lumine");
    fs.copySync(fixturesPath, tempPath);
    lumine.project.setPaths([tempPath]);

    jasmine.unspy(TextMateLanguageMode.prototype, "tokenizeInBackground");

    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));

    waitsForPromise(() => lumine.packages.activatePackage("markdown-preview"));

    waitsForPromise(() => lumine.packages.activatePackage("language-gfm"));

    runs(() => spyOn(lumine.packages, "hasActivatedInitialPackages").andReturn(true));
  });

  const expectPreviewInSplitPane = function () {
    waitsFor(() => lumine.workspace.getCenter().getPanes().length === 2);

    waitsFor(
      "markdown preview to be created",
      () => (preview = lumine.workspace.getCenter().getPanes()[1].getActiveItem()),
    );

    waitsFor("preview to finish loading", () => {
      return !preview.element.classList.contains("loading");
    });

    runs(() => {
      expect(preview).toBeInstanceOf(MarkdownPreviewView);
      expect(preview.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
    });
  };

  describe("when a preview has not been created for the file", function () {
    it("displays a markdown preview in a split pane", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/file.markdown"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() => {
        const [editorPane] = lumine.workspace.getCenter().getPanes();
        expect(editorPane.getItems()).toHaveLength(1);
        expect(editorPane.isActive()).toBe(true);
      });
    });

    describe("when the editor's path does not exist", function () {
      it("splits the current pane to the right with a markdown preview for the file", function () {
        waitsForPromise(() => lumine.workspace.open("new.markdown"));
        runs(() =>
          lumine.commands.dispatch(
            lumine.workspace.getActiveTextEditor().getElement(),
            "markdown-preview:toggle",
          ),
        );
        expectPreviewInSplitPane();
      });
    });

    describe("when the editor does not have a path", function () {
      it("splits the current pane to the right with a markdown preview for the file", function () {
        waitsForPromise(() => lumine.workspace.open(""));
        runs(() =>
          lumine.commands.dispatch(
            lumine.workspace.getActiveTextEditor().getElement(),
            "markdown-preview:toggle",
          ),
        );
        expectPreviewInSplitPane();
      });
    });

    describe("when the path contains a space", function () {
      it("renders the preview", function () {
        waitsForPromise(() => lumine.workspace.open("subdir/file with space.md"));
        runs(() =>
          lumine.commands.dispatch(
            lumine.workspace.getActiveTextEditor().getElement(),
            "markdown-preview:toggle",
          ),
        );
        expectPreviewInSplitPane();
      });
    });

    describe("when the path contains accented characters", function () {
      it("renders the preview", function () {
        waitsForPromise(() => lumine.workspace.open("subdir/áccéntéd.md"));
        runs(() =>
          lumine.commands.dispatch(
            lumine.workspace.getActiveTextEditor().getElement(),
            "markdown-preview:toggle",
          ),
        );
        expectPreviewInSplitPane();
      });
    });
  });

  describe("when a preview has been created for the file", function () {
    beforeEach(function () {
      waitsForPromise(() => lumine.workspace.open("subdir/file.markdown"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();
    });

    it("closes the existing preview when toggle is triggered a second time on the editor", function () {
      lumine.commands.dispatch(
        lumine.workspace.getActiveTextEditor().getElement(),
        "markdown-preview:toggle",
      );

      const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
      expect(editorPane.isActive()).toBe(true);
      expect(previewPane.getActiveItem()).toBeUndefined();
    });

    it("closes the existing preview when toggle is triggered on it and it has focus", function () {
      const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
      previewPane.activate();

      lumine.commands.dispatch(editorPane.getActiveItem().getElement(), "markdown-preview:toggle");
      expect(previewPane.getActiveItem()).toBeUndefined();
    });

    describe("when the editor is modified", function () {
      it("re-renders the preview", function () {
        spyOn(preview, "showLoading");

        const markdownEditor = lumine.workspace.getActiveTextEditor();
        markdownEditor.setText("Hey!");

        waitsFor(() => preview.element.textContent.includes("Hey!"));

        runs(() => expect(preview.showLoading).not.toHaveBeenCalled());
      });

      it("invokes ::onDidChangeMarkdown listeners", function () {
        let listener;
        const markdownEditor = lumine.workspace.getActiveTextEditor();
        preview.onDidChangeMarkdown((listener = jasmine.createSpy("didChangeMarkdownListener")));

        runs(() => markdownEditor.setText("Hey!"));

        waitsFor("::onDidChangeMarkdown handler to be called", () => listener.callCount > 0);
      });

      describe("when the preview is in the active pane but is not the active item", function () {
        it("re-renders the preview but does not make it active", function () {
          const markdownEditor = lumine.workspace.getActiveTextEditor();
          const previewPane = lumine.workspace.getCenter().getPanes()[1];
          previewPane.activate();

          waitsForPromise(() => lumine.workspace.open());

          runs(() => markdownEditor.setText("Hey!"));

          waitsFor(() => preview.element.textContent.includes("Hey!"));

          runs(() => {
            expect(previewPane.isActive()).toBe(true);
            expect(previewPane.getActiveItem()).not.toBe(preview);
          });
        });
      });

      describe("when the preview is not the active item and not in the active pane", function () {
        it("re-renders the preview and makes it active", function () {
          const markdownEditor = lumine.workspace.getActiveTextEditor();
          const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
          previewPane.splitRight({ copyActiveItem: true });
          previewPane.activate();

          waitsForPromise(() => lumine.workspace.open());

          runs(() => {
            editorPane.activate();
            markdownEditor.setText("Hey!");
          });

          waitsFor(() => preview.element.textContent.includes("Hey!"));

          runs(() => {
            expect(editorPane.isActive()).toBe(true);
            expect(previewPane.getActiveItem()).toBe(preview);
          });
        });
      });

      describe("when the liveUpdate config is set to false", function () {
        it("only re-renders the markdown when the editor is saved, not when the contents are modified", function () {
          lumine.config.set("markdown-preview.liveUpdate", false);

          const didStopChangingHandler = jasmine.createSpy("didStopChangingHandler");
          lumine.workspace
            .getActiveTextEditor()
            .getBuffer()
            .onDidStopChanging(didStopChangingHandler);
          lumine.workspace.getActiveTextEditor().setText("ch ch changes");

          waitsFor(() => didStopChangingHandler.callCount > 0);

          runs(() => {
            expect(preview.element.textContent).not.toMatch("ch ch changes");
            lumine.workspace.getActiveTextEditor().save();
          });

          waitsFor(() => preview.element.textContent.includes("ch ch changes"));
        });
      });
    });

    describe("when the original preview is split", function () {
      it("renders another preview in the new split pane", function () {
        lumine.workspace.getCenter().getPanes()[1].splitRight({ copyActiveItem: true });

        expect(lumine.workspace.getCenter().getPanes()).toHaveLength(3);

        waitsFor(
          "split markdown preview to be created",
          () => (preview = lumine.workspace.getCenter().getPanes()[2].getActiveItem()),
        );

        runs(() => {
          expect(preview).toBeInstanceOf(MarkdownPreviewView);
          expect(preview.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
        });
      });
    });

    describe("when the editor is destroyed", function () {
      beforeEach(() => lumine.workspace.getCenter().getPanes()[0].destroyActiveItem());

      it("falls back to using the file path", function () {
        lumine.workspace.getCenter().getPanes()[1].activate();
        expect(preview.file.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
      });

      it("continues to update the preview if the file is changed on #win32 and #darwin", function () {
        let listener;
        const titleChangedCallback = jasmine.createSpy("titleChangedCallback");

        // The fallback file watcher arms asynchronously; wait for it before
        // mutating the file so the first change is observed.
        waitsForPromise("watcher to arm", () => preview.file.getStartPromise());

        runs(() => {
          expect(preview.getTitle()).toBe("file.markdown Preview");
          preview.onDidChangeTitle(titleChangedCallback);
          fs.renameSync(preview.getPath(), path.join(path.dirname(preview.getPath()), "file2.md"));
        });

        waitsFor("title to update", () => preview.getTitle() === "file2.md Preview");

        runs(() => expect(titleChangedCallback).toHaveBeenCalled());

        spyOn(preview, "showLoading");

        // The watch was re-pointed at the renamed file; wait for the new
        // watcher to arm before writing to it.
        waitsForPromise("re-pointed watcher to arm", () => preview.file.getStartPromise());

        runs(() => fs.writeFileSync(preview.getPath(), "Hey!"));

        waitsFor("contents to update", () => preview.element.textContent.includes("Hey!"));

        runs(() => expect(preview.showLoading).not.toHaveBeenCalled());

        preview.onDidChangeMarkdown((listener = jasmine.createSpy("didChangeMarkdownListener")));

        runs(() => fs.writeFileSync(preview.getPath(), "Hey!"));

        waitsFor("::onDidChangeMarkdown handler to be called", () => listener.callCount > 0);
      });

      it("allows a new split pane of the preview to be created", function () {
        lumine.workspace.getCenter().getPanes()[1].splitRight({ copyActiveItem: true });

        expect(lumine.workspace.getCenter().getPanes()).toHaveLength(3);

        waitsFor(
          "split markdown preview to be created",
          () => (preview = lumine.workspace.getCenter().getPanes()[2].getActiveItem()),
        );

        runs(() => {
          expect(preview).toBeInstanceOf(MarkdownPreviewView);
          expect(preview.getPath()).toBe(lumine.workspace.getActivePaneItem().getPath());
        });
      });
    });
  });

  describe("when the markdown preview view is requested by file URI", function () {
    it("opens a preview editor and watches the file for changes", function () {
      waitsForPromise("lumine.workspace.open promise to be resolved", () =>
        lumine.workspace.open(
          `markdown-preview://${lumine.project.getDirectories()[0].resolve("subdir/file.markdown")}`,
        ),
      );

      runs(() => {
        preview = lumine.workspace.getActivePaneItem();
        expect(preview).toBeInstanceOf(MarkdownPreviewView);

        spyOn(preview, "renderMarkdownText");
        preview.file.emitter.emit("did-change");
      });

      waitsFor(
        "markdown to be re-rendered after file changed",
        () => preview.renderMarkdownText.callCount > 0,
      );
    });
  });

  describe("when the editor's grammar it not enabled for preview", function () {
    it("does not open the markdown preview", function () {
      lumine.config.set("markdown-preview.grammars", []);

      waitsForPromise(() => lumine.workspace.open("subdir/file.markdown"));

      runs(() => {
        spyOn(lumine.workspace, "open").andCallThrough();
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        );
        expect(lumine.workspace.open).not.toHaveBeenCalled();
      });
    });
  });

  describe("when the editor's path changes on #win32 and #darwin", function () {
    it("updates the preview's title", function () {
      const titleChangedCallback = jasmine.createSpy("titleChangedCallback");

      waitsForPromise(() => lumine.workspace.open("subdir/file.markdown"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );

      expectPreviewInSplitPane();

      // The preview follows the editor, whose buffer follows the renamed file
      // on disk. Wait for the buffer's file watch to arm before renaming.
      waitsForPromise("buffer watch to arm", () =>
        lumine.workspace.getActiveTextEditor().getBuffer().getFileWatchStartPromise(),
      );

      runs(() => {
        expect(preview.getTitle()).toBe("file.markdown Preview");
        preview.onDidChangeTitle(titleChangedCallback);
        fs.renameSync(
          lumine.workspace.getActiveTextEditor().getPath(),
          path.join(path.dirname(lumine.workspace.getActiveTextEditor().getPath()), "file2.md"),
        );
      });

      waitsFor(() => preview.getTitle() === "file2.md Preview");

      runs(() => expect(titleChangedCallback).toHaveBeenCalled());
    });
  });

  describe("when the URI opened does not have a markdown-preview protocol", function () {
    it("does not throw an error trying to decode the URI (regression)", function () {
      waitsForPromise(() => lumine.workspace.open("%"));

      runs(() => expect(lumine.workspace.getActiveTextEditor()).toBeTruthy());
    });
  });

  describe("markdown-preview:toggle", function () {
    beforeEach(() => waitsForPromise(() => lumine.workspace.open("code-block.md")));

    // The command is registered once, on the workspace, so that Packages >
    // Markdown Preview works when focus is anywhere. The grammar list decides
    // what the command does, not whether it can be dispatched.
    it("exists whatever the active editor's grammar is", function () {
      lumine.config.set("markdown-preview.grammars", ["source.weird-md"]);
      const commands = lumine.commands
        .findCommands({ target: lumine.workspace.getElement() })
        .map((command) => command.name);
      expect(commands).toContain("markdown-preview:toggle");
    });

    it("previews an editor whose grammar is in `markdown-preview.grammars`", function () {
      lumine.config.set("markdown-preview.grammars", ["source.gfm"]);
      lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");

      waitsFor(() => lumine.workspace.getCenter().getPanes()[1]?.getActiveItem());
      runs(() =>
        expect(
          lumine.workspace.getCenter().getPanes()[1].getActiveItem() instanceof MarkdownPreviewView,
        ).toBe(true),
      );
    });

    it("says why it declined when the grammar is not in the list", function () {
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

    afterEach(function () {
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

    it("offers the command anywhere on the row, not just on the file name", function () {
      const { row, nameSpan } = treeViewRow("file.md");

      // The bug this guards: the item used to be registered on the span, so it
      // was absent unless the pointer happened to be over the text itself.
      expect(contextMenuLabels(row)).toContain("Markdown Preview");
      expect(contextMenuLabels(nameSpan)).toContain("Markdown Preview");
    });

    it("offers the command for every previewable extension and no others", function () {
      for (const name of ["a.markdown", "a.md", "a.mdown", "a.mkd", "a.mkdown", "a.ron", "a.txt"]) {
        expect(contextMenuLabels(treeViewRow(name).row)).toContain("Markdown Preview");
      }
      for (const name of ["a.js", "a.mdx", "md"]) {
        expect(contextMenuLabels(treeViewRow(name).row)).not.toContain("Markdown Preview");
      }
    });

    it("previews the row's file when dispatched from the name span inside it", function () {
      const filePath = path.join(lumine.project.getPaths()[0], "subdir", "simple.md");
      const { nameSpan } = treeViewRow("simple.md", filePath);

      // Dispatching from the span is what a real right-click on the text does;
      // the handler has to read the row that matched, not the click target.
      lumine.commands.dispatch(nameSpan, "markdown-preview:preview-file");

      waitsFor(() => lumine.workspace.getActivePaneItem() instanceof MarkdownPreviewView);

      runs(() => expect(lumine.workspace.getActivePaneItem().getPath()).toBe(filePath));
    });
  });

  describe("when markdown-preview:copy-html is triggered", function () {
    it("copies the HTML to the clipboard", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/simple.md"));

      waitsForPromise(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:copy-html",
        ),
      );

      runs(() => {
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
      });

      waitsForPromise(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:copy-html",
        ),
      );

      runs(() =>
        expect(lumine.clipboard.read()).toBe(`\
<p><em>italic</em></p>\
`),
      );
    });

    describe("code block tokenization", function () {
      beforeEach(function () {
        waitsForPromise(() => lumine.packages.activatePackage("language-ruby"));

        waitsForPromise(() => lumine.packages.activatePackage("markdown-preview"));

        waitsForPromise(() => lumine.workspace.open("subdir/file.markdown"));

        waitsForPromise(() =>
          lumine.commands.dispatch(
            lumine.workspace.getActiveTextEditor().getElement(),
            "markdown-preview:copy-html",
          ),
        );

        runs(() => {
          preview = document.createElement("div");
          preview.innerHTML = lumine.clipboard.read();
        });
      });

      describe("when the code block's fence name has a matching grammar", function () {
        it("tokenizes the code block with the grammar", function () {
          expect(preview.querySelector("pre span.entity.name.function.ruby")).toBeDefined();
        });
      });

      describe("when the code block's fence name doesn't have a matching grammar", function () {
        it("does not tokenize the code block", function () {
          expect(
            preview.querySelectorAll("pre.lang-kombucha .line .syntax--null-grammar").length,
          ).toBe(2);
        });
      });

      describe("when the code block contains empty lines", function () {
        it("doesn't remove the empty lines", function () {
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
    it("removes script tags and attributes that commonly contain inline scripts", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/evil.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() =>
        expect(preview.element.innerHTML).toBe(`\
<p>hello</p>


<img>
world\
`),
      );
    });

    it("remove any <!doctype> tag on markdown files", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/doctype-tag.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() =>
        expect(preview.element.innerHTML).toBe(`\
<p>content
</p>\
`),
      );
    });
  });

  describe("when the markdown contains an <html> tag", function () {
    it("does not throw an exception", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/html-tag.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() => expect(preview.element.innerHTML).toBe("content"));
    });
  });

  describe("when the markdown contains a <pre> tag", function () {
    it("does not throw an exception", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/pre-tag.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() => expect(preview.element.querySelector("lumine-text-editor")).toBeDefined());
    });
  });

  describe("when there is an image with a relative path and no directory", function () {
    it("does not alter the image src", function () {
      for (let projectPath of lumine.project.getPaths()) {
        lumine.project.removePath(projectPath);
      }

      const filePath = path.join(temp.mkdirSync("lumine"), "bar.md");
      fs.writeFileSync(filePath, "![rel path](/foo.png)");

      waitsForPromise(() => lumine.workspace.open(filePath));

      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() =>
        expect(preview.element.innerHTML).toBe(`\
<p><img src="/foo.png" alt="rel path"></p>\
`),
      );
    });
  });

  describe("GitHub style markdown preview", function () {
    beforeEach(() => lumine.config.set("markdown-preview.useGitHubStyle", false));

    it("renders markdown using the default style when GitHub styling is disabled", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/simple.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() => expect(preview.element.getAttribute("data-use-github-style")).toBeNull());
    });

    it("renders markdown using the GitHub styling when enabled", function () {
      lumine.config.set("markdown-preview.useGitHubStyle", true);

      waitsForPromise(() => lumine.workspace.open("subdir/simple.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() => expect(preview.element.getAttribute("data-use-github-style")).toBe("auto"));
    });

    it("updates the rendering style immediately when the configuration is changed", function () {
      waitsForPromise(() => lumine.workspace.open("subdir/simple.md"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();

      runs(() => {
        expect(preview.element.getAttribute("data-use-github-style")).toBeNull();

        lumine.config.set("markdown-preview.useGitHubStyle", true);
        expect(preview.element.getAttribute("data-use-github-style")).not.toBeNull();

        lumine.config.set("markdown-preview.useGitHubStyle", false);
        expect(preview.element.getAttribute("data-use-github-style")).toBeNull();
      });
    });
  });

  describe("when markdown-preview:save-as-html is triggered", function () {
    beforeEach(function () {
      waitsForPromise(() => lumine.workspace.open("subdir/simple.markdown"));
      runs(() =>
        lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:toggle",
        ),
      );
      expectPreviewInSplitPane();
    });

    it("saves the HTML when it is triggered and the editor has focus", function () {
      const [editorPane] = lumine.workspace.getCenter().getPanes();
      editorPane.activate();

      const outputPath = temp.path({ suffix: ".html" });
      expect(fs.existsSync(outputPath)).toBe(false);

      runs(() => {
        spyOn(preview, "getSaveDialogOptions").andReturn({
          defaultPath: outputPath,
        });
        spyOn(lumine.applicationDelegate, "showSaveDialog").andCallFake((options) =>
          Promise.resolve({ canceled: false, filePath: options.defaultPath }),
        );
        return lumine.commands.dispatch(
          lumine.workspace.getActiveTextEditor().getElement(),
          "markdown-preview:save-as-html",
        );
      });

      waitsFor(() => fs.existsSync(outputPath));

      runs(() => expect(fs.existsSync(outputPath)).toBe(true));
    });

    it("saves the HTML when it is triggered and the preview pane has focus", function () {
      const [editorPane, previewPane] = lumine.workspace.getCenter().getPanes();
      previewPane.activate();

      const outputPath = temp.path({ suffix: ".html" });
      expect(fs.existsSync(outputPath)).toBe(false);

      runs(() => {
        spyOn(preview, "getSaveDialogOptions").andReturn({
          defaultPath: outputPath,
        });
        spyOn(lumine.applicationDelegate, "showSaveDialog").andCallFake((options) =>
          Promise.resolve({ canceled: false, filePath: options.defaultPath }),
        );
        return lumine.commands.dispatch(
          editorPane.getActiveItem().getElement(),
          "markdown-preview:save-as-html",
        );
      });

      waitsFor(() => fs.existsSync(outputPath));

      runs(() => expect(fs.existsSync(outputPath)).toBe(true));
    });
  });
});
