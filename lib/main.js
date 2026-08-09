const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable } = require("atom");

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

    this.style = new CSSStyleSheet();
    document.adoptedStyleSheets.push(this.style);

    // One registration on the workspace rather than one per configured grammar,
    // rebuilt whenever the list changes. Packages > Markdown Preview is always
    // visible and the application menu dispatches at whatever holds focus, so
    // the grammar scope only made the three items dead outside a markdown
    // editor — and the two config toggles have no editor to be scoped to at
    // all. toggle, copyHTML and saveAsHTML each re-read the grammar list
    // themselves, which is what makes the subscription dance redundant.
    this.disposables.add(
      atom.commands.add("atom-workspace", {
        "markdown-preview:toggle": () => this.toggle(),
        "markdown-preview:copy-html": {
          displayName: "Markdown Preview: Copy HTML",
          didDispatch: () => this.copyHTML(),
        },
        "markdown-preview:save-as-html": {
          displayName: "Markdown Preview: Save as HTML",
          didDispatch: () => this.saveAsHTML(),
        },
        "markdown-preview:toggle-break-on-single-newline": () => {
          const keyPath = "markdown-preview.breakOnSingleNewline";
          atom.config.set(keyPath, !atom.config.get(keyPath));
        },
        "markdown-preview:toggle-github-style": () => {
          const keyPath = "markdown-preview.useGitHubStyle";
          atom.config.set(keyPath, !atom.config.get(keyPath));
        },
      }),
    );

    this.disposables.add(
      atom.config.observe("editor.fontFamily", (fontFamily) => {
        // Keep the user's `fontFamily` setting in sync with preview styles.
        // `pre` blocks will use this font automatically, but `code` elements
        // need a specific style rule.
        //
        // Since this applies to all content, we should declare this only once,
        // instead of once per preview view.
        this.style.replaceSync(`
          .markdown-preview code {
            font-family: ${fontFamily} !important;
          }
        `);
      }),
    );

    // Stays on the tree-view row: it previews the file that was right-clicked,
    // read from the dispatch target, not the active editor. One comma-joined
    // selector rather than seven registrations of the same handler.
    this.disposables.add(
      atom.commands.add(
        PREVIEWABLE_EXTENSIONS.map(
          (extension) => `.tree-view .file[data-name$=".${extension}"]`,
        ).join(", "),
        "markdown-preview:preview-file",
        this.previewFile.bind(this),
      ),
    );

    this.disposables.add(
      atom.workspace.addOpener((uriToOpen) => {
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
    if (isMarkdownPreviewView(atom.workspace.getActivePaneItem())) {
      atom.workspace.destroyActivePaneItem();
      return;
    }

    const editor = atom.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }

    const grammars = atom.config.get("markdown-preview.grammars") || [];
    if (!grammars.includes(editor.getGrammar().scopeName)) {
      // Reachable from an always-visible menu, so it has to say why it declined
      // rather than look broken.
      atom.notifications.addWarning("Markdown Preview: not a previewable file", {
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
    const previewPane = atom.workspace.paneForURI(uri);
    if (previewPane != null) {
      previewPane.destroyItem(previewPane.itemForURI(uri));
      return true;
    } else {
      return false;
    }
  },

  addPreviewForEditor(editor) {
    const uri = this.uriForEditor(editor);
    const previousActivePane = atom.workspace.getActivePane();
    const options = { searchAllPanes: true };
    if (atom.config.get("markdown-preview.openPreviewInSplitPane")) {
      options.split = "right";
    }

    return atom.workspace.open(uri, options).then(function (markdownPreviewView) {
      if (isMarkdownPreviewView(markdownPreviewView)) {
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

    for (const editor of atom.workspace.getTextEditors()) {
      if (editor.getPath() === filePath) {
        return this.addPreviewForEditor(editor);
      }
    }

    atom.workspace.open(`markdown-preview://${encodeURI(filePath)}`, {
      searchAllPanes: true,
    });
  },

  async copyHTML() {
    const editor = atom.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }

    if (renderer == null) {
      renderer = require("./renderer");
    }
    const text = editor.getSelectedText() || editor.getText();
    const html = await renderer.toHTML(text, editor.getPath(), editor.getGrammar(), editor.id);

    atom.clipboard.write(html);
  },

  saveAsHTML() {
    const activePaneItem = atom.workspace.getActivePaneItem();
    if (isMarkdownPreviewView(activePaneItem)) {
      return atom.workspace.getActivePane().saveItemAs(activePaneItem);
    }

    const editor = atom.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }

    const grammars = atom.config.get("markdown-preview.grammars") || [];
    if (!grammars.includes(editor.getGrammar().scopeName)) {
      return;
    }

    const uri = this.uriForEditor(editor);
    const markdownPreviewPane = atom.workspace.paneForURI(uri);
    const markdownPreviewPaneItem =
      markdownPreviewPane != null ? markdownPreviewPane.itemForURI(uri) : undefined;

    if (isMarkdownPreviewView(markdownPreviewPaneItem)) {
      return markdownPreviewPane.saveItemAs(markdownPreviewPaneItem);
    }
  },
};
