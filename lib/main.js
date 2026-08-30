const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable, Disposable } = require("lumine");

let MarkdownPreviewView = null;
let renderer = null;

const isMarkdownPreviewView = function (object) {
  if (MarkdownPreviewView == null) {
    MarkdownPreviewView = require("./markdown-preview-view");
  }
  return object instanceof MarkdownPreviewView;
};

// The file types the tree view offers a preview for. The editor commands read
// `markdown-preview.grammars` instead; a tree row carries no grammar.
const PREVIEWABLE_EXTENSIONS = ["markdown", "md", "mdown", "mkd", "mkdown", "ron", "txt"];

module.exports = {
  activate() {
    this.disposables = new CompositeDisposable();

    // One registration on the workspace rather than one per configured grammar,
    // rebuilt whenever the list changes. Packages > Markdown Preview is always
    // visible and the application menu dispatches at whatever holds focus, so
    // the grammar scope only made the three items dead outside a markdown
    // editor — and the two config toggles have no editor to be scoped to at
    // all. toggle, copyHTML and saveAsHTML each re-read the grammar list
    // themselves, which is what makes the subscription dance redundant.
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "markdown-preview:toggle": () => this.toggle(),
        "markdown-preview:copy-html": {
          description: "Copy the rendered HTML of this file to the clipboard.",
          didDispatch: () => this.copyHTML(),
        },
        "markdown-preview:save-as-html": {
          description: "Write the rendered HTML to a file beside this one.",
          didDispatch: () => this.saveAsHTML(),
        },
        "markdown-preview:export-to-pdf": {
          description: "Write the preview to a PDF beside this file.",
          didDispatch: () => this.exportToPDF(),
        },
        "markdown-preview:toggle-break-on-single-newline": {
          description: "Render one newline as a line break rather than as a space.",
          didDispatch: () => {
            const keyPath = "markdown-preview.breakOnSingleNewline";
            lumine.config.set(keyPath, !lumine.config.get(keyPath));
          },
        },
        "markdown-preview:toggle-github-style": {
          description: "Style the preview the way GitHub styles a rendered file.",
          didDispatch: () => {
            const keyPath = "markdown-preview.useGitHubStyle";
            lumine.config.set(keyPath, !lumine.config.get(keyPath));
          },
        },
      }),
    );

    this.disposables.add(
      lumine.config.observe("editor.fontFamily", (fontFamily) => {
        // Keep the user's `fontFamily` setting in sync with preview styles.
        // `pre` blocks will use this font automatically, but `code` elements
        // need a specific style rule.
        //
        // Since this applies to all content, we should declare this only once,
        // instead of once per preview view.
        this.fontStyleDisposable?.dispose();
        this.fontStyleDisposable = lumine.styles.addStyleSheet(
          `
          .markdown-preview code {
            font-family: ${fontFamily} !important;
          }
        `,
          { sourcePath: "markdown-preview-font-family" },
        );
      }),
      new Disposable(() => this.fontStyleDisposable?.dispose()),
    );

    // Stays on the tree-view row: it previews the file that was right-clicked,
    // read from the dispatch target, not the active editor. One comma-joined
    // selector rather than seven registrations of the same handler.
    this.disposables.add(
      lumine.commands.add(
        PREVIEWABLE_EXTENSIONS.map(
          (extension) => `.tree-view .file[data-name$=".${extension}"]`,
        ).join(", "),
        "markdown-preview:preview-file",
        {
          description: "Open the preview for the file selected in the tree.",
          didDispatch: this.previewFile.bind(this),
        },
      ),
    );

    this.disposables.add(
      lumine.workspace.addOpener((uriToOpen) => {
        let [protocol, path] = uriToOpen.split("://");
        if (protocol !== "markdown-preview") {
          return;
        }

        try {
          path = decodeURI(path);
        } catch {
          return;
        }

        if (path.startsWith("editor/")) {
          return this.createMarkdownPreviewView({ editorId: path.substring(7) });
        } else {
          return this.createMarkdownPreviewView({ filePath: path });
        }
      }),
    );
  },

  deactivate() {
    this.disposables.dispose();
  },

  createMarkdownPreviewView(state) {
    if (state.editorId || fs.isFileSync(state.filePath)) {
      if (MarkdownPreviewView == null) {
        MarkdownPreviewView = require("./markdown-preview-view");
      }
      return new MarkdownPreviewView(state);
    }
  },

  toggle() {
    if (isMarkdownPreviewView(lumine.workspace.getActivePaneItem())) {
      lumine.workspace.destroyActivePaneItem();
      return;
    }

    const editor = lumine.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }

    const grammars = lumine.config.get("markdown-preview.grammars") || [];
    if (!grammars.includes(editor.getGrammar().scopeName)) {
      // Reachable from an always-visible menu, so it has to say why it declined
      // rather than look broken.
      lumine.notifications.addWarning("Markdown Preview: not a previewable file", {
        detail: `No preview is configured for ${editor.getGrammar().name}.`,
      });
      return;
    }

    if (!this.removePreviewForEditor(editor)) {
      return this.addPreviewForEditor(editor);
    }
  },

  uriForEditor(editor) {
    return `markdown-preview://editor/${editor.id}`;
  },

  removePreviewForEditor(editor) {
    const uri = this.uriForEditor(editor);
    const previewPane = lumine.workspace.paneForURI(uri);
    if (previewPane != null) {
      previewPane.destroyItem(previewPane.itemForURI(uri));
      return true;
    } else {
      return false;
    }
  },

  addPreviewForEditor(editor) {
    const uri = this.uriForEditor(editor);
    const previousActivePane = lumine.workspace.getActivePane();
    const restorePreviousPane = lumine.workspace
      .getCenter()
      .getTiledPanes()
      .includes(previousActivePane);
    const options = { searchAllPanes: true };
    if (lumine.config.get("markdown-preview.openPreviewInSplitPane")) {
      options.split = "right";
    }

    return lumine.workspace.open(uri, options).then(function (markdownPreviewView) {
      if (isMarkdownPreviewView(markdownPreviewView) && restorePreviousPane) {
        previousActivePane.activate();
      }
    });
  },

  // `currentTarget`, not `target`: the command matches the tree-view row, but
  // the click that dispatched it may have landed on the name span inside it.
  previewFile({ currentTarget }) {
    const filePath = currentTarget.dataset.path;
    if (!filePath) {
      return;
    }

    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.getPath() === filePath) {
        return this.addPreviewForEditor(editor);
      }
    }

    lumine.workspace.open(`markdown-preview://${encodeURI(filePath)}`, {
      searchAllPanes: true,
    });
  },

  async copyHTML() {
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }

    if (renderer == null) {
      renderer = require("./renderer");
    }
    const text = editor.getSelectedText() || editor.getText();
    const html = await renderer.toHTML(text, editor.getPath(), editor.getGrammar(), editor.id);

    lumine.clipboard.write(html);
  },

  saveAsHTML() {
    const { pane, view } = this.activePreview();
    if (view == null) return;

    return pane.saveItemAs(view);
  },

  async exportToPDF() {
    const { view } = this.activePreview();
    if (view == null) {
      // The application menu dispatches this wherever focus happens to be, and
      // an item that was enabled and did nothing needs to say why.
      lumine.notifications.addWarning("Open a Markdown Preview to export it to PDF");
      return;
    }

    const { filePath } = await lumine.workspace.showSaveDialogForPaneItem(
      view,
      view.getPDFSaveDialogOptions(),
    );
    if (!filePath) return;

    return view.exportToPDF(filePath);
  },

  // The preview to act on: the one in front if it is a preview, otherwise the
  // one belonging to the markdown editor in front. Returns empty members when
  // neither is on screen, which every caller treats as "nothing to do".
  activePreview() {
    const activePaneItem = lumine.workspace.getActivePaneItem();
    if (isMarkdownPreviewView(activePaneItem)) {
      return { pane: lumine.workspace.getActivePane(), view: activePaneItem };
    }

    const editor = lumine.workspace.getActiveTextEditor();
    if (editor == null) {
      return {};
    }

    const grammars = lumine.config.get("markdown-preview.grammars") || [];
    if (!grammars.includes(editor.getGrammar().scopeName)) {
      return {};
    }

    const uri = this.uriForEditor(editor);
    const markdownPreviewPane = lumine.workspace.paneForURI(uri);
    const markdownPreviewPaneItem =
      markdownPreviewPane != null ? markdownPreviewPane.itemForURI(uri) : undefined;

    if (isMarkdownPreviewView(markdownPreviewPaneItem)) {
      return { pane: markdownPreviewPane, view: markdownPreviewPaneItem };
    }

    return {};
  },
};
