const fs = require("@lumine-code/fs-plus");
const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");

let MarkdownPreviewView = null;
let renderer = null;

const isMarkdownPreviewView = function (object) {
  if (MarkdownPreviewView == null) {
    MarkdownPreviewView = require("./markdown-preview-view");
  }
  return object instanceof MarkdownPreviewView;
};

// File choices use extensions; the editor commands use configured grammars.
const PREVIEWABLE_EXTENSIONS = ["markdown", "md", "mdown", "mkd", "mkdown", "ron", "txt"];

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "markdown-preview",
      tips: [
        "You can open a live preview of the Markdown file you are editing with {{ 'markdown-preview:toggle' | keystroke }}",
      ],
    };
  },

  activate() {
    this.disposables = new CompositeDisposable();

    this.stylesByWindow = new Map();
    this.styleText = "";
    this.disposables.add(
      lumine.workspace.observeWindows((window) => {
        const document = window.getDocument();
        const style = new document.defaultView.CSSStyleSheet();
        style.replaceSync(this.styleText);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
        this.stylesByWindow.set(window, style);
        if (window.isMain()) this.style = style;
        const lease = new CompositeDisposable(
          new Disposable(() => {
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
              (sheet) => sheet !== style,
            );
            this.stylesByWindow.delete(window);
            if (this.style === style) this.style = null;
          }),
        );
        lease.add(
          window.onWillDestroy(() => {
            lease.dispose();
            this.disposables.remove(lease);
          }),
        );
        this.disposables.add(lease);
      }),
    );

    // One registration on the workspace rather than one per configured grammar,
    // rebuilt whenever the list changes. Packages > Markdown Preview is always
    // visible and the application menu dispatches at whatever holds focus, so
    // the grammar scope only made the three items dead outside a markdown
    // editor — and the two config toggles have no editor to be scoped to at
    // all. toggle, copyHTML and saveAsHTML each re-read the grammar list
    // themselves, which is what makes the subscription dance redundant.
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "markdown-preview:toggle": (event) => this.toggle(event),
        "markdown-preview:copy-html": {
          description: "Copy the rendered HTML of this file to the clipboard.",
          didDispatch: (event) => this.copyHTML(event),
        },
        "markdown-preview:save-as-html": {
          description: "Write the rendered HTML to a file beside this one.",
          didDispatch: (event) => this.saveAsHTML(event),
        },
        "markdown-preview:export-to-pdf": {
          description: "Write the preview to a PDF beside this file.",
          didDispatch: (event) => this.exportToPDF(event),
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
        // Theme-based previews follow the editor font. GitHub previews keep
        // GitHub's monospace stack, independently of the editor settings.
        this.styleText = `
          .markdown-preview:not([data-use-github-style]) code {
            font-family: ${fontFamily} !important;
          }
        `;
        for (const style of this.stylesByWindow.values()) style.replaceSync(this.styleText);
      }),
    );

    this.disposables.add(
      lumine.workspace.addFileOpener({
        id: "markdown-preview",
        label: "Markdown Preview",
        canOpen: (uri) =>
          typeof uri === "string" &&
          PREVIEWABLE_EXTENSIONS.includes(path.extname(uri).slice(1).toLowerCase()),
        isDefaultEligible: () => false,
        open: (filePath) => {
          const editor = lumine.workspace
            .getTextEditors()
            .find((item) => item.getPath() === filePath);
          return this.createMarkdownPreviewView(editor ? { editorId: editor.id } : { filePath });
        },
        handlesItem: isMarkdownPreviewView,
      }),
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
    if (MarkdownPreviewView != null) {
      for (const item of lumine.workspace.getPaneItems()) {
        if (!(item instanceof MarkdownPreviewView)) continue;
        const pane = lumine.workspace.paneForItem(item);
        if (pane) pane.destroyItem(item);
        else item.destroy();
      }
    }
    this.disposables.dispose();
  },

  createMarkdownPreviewView(state) {
    if (state.editorId != null || fs.isFileSync(state.filePath)) {
      if (MarkdownPreviewView == null) {
        MarkdownPreviewView = require("./markdown-preview-view");
      }
      return new MarkdownPreviewView(state);
    }
  },

  commandContext(event) {
    return (
      event?.context ?? {
        pane: lumine.workspace.getActivePane(),
        item: lumine.workspace.getActivePaneItem(),
        editor: lumine.workspace.getActiveTextEditor(),
      }
    );
  },

  toggle(event) {
    const context = this.commandContext(event);
    if (isMarkdownPreviewView(context.item)) {
      context.pane.destroyItem(context.item);
      return;
    }

    const editor = context.editor;
    if (editor == null) {
      if (context.item) {
        lumine.notifications.addWarning(
          "Activate a Markdown source file before opening its preview.",
        );
      }
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
      return this.addPreviewForEditor(editor, context.pane);
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

  addPreviewForEditor(editor, pane = lumine.workspace.paneForItem(editor)) {
    const uri = this.uriForEditor(editor);
    const previousActivePane = pane ?? lumine.workspace.getActivePane();
    const options = { searchAllPanes: true, pane: previousActivePane };
    if (lumine.config.get("markdown-preview.openPreviewInSplitPane")) {
      options.split = "right";
    }

    return lumine.workspace.open(uri, options).then(function (markdownPreviewView) {
      if (isMarkdownPreviewView(markdownPreviewView)) {
        previousActivePane.activate();
      }
    });
  },

  async copyHTML(event) {
    const editor = this.commandContext(event).editor;
    if (editor == null) {
      return;
    }

    if (renderer == null) {
      renderer = require("./renderer");
    }
    const text = editor.getSelectedText() || editor.getText();
    const html = await renderer.toHTML(text, editor.getPath(), editor.getGrammar());

    lumine.clipboard.write(html);
  },

  saveAsHTML(event) {
    const { pane, view } = this.activePreview(event);
    if (view == null) return;

    return pane.saveItemAs(view);
  },

  async exportToPDF(event) {
    const { view } = this.activePreview(event);
    if (view == null) {
      // The application menu dispatches this wherever focus happens to be, and
      // an item that was enabled and did nothing needs to say why.
      lumine.notifications.addWarning("Open a Markdown Preview to export it to PDF");
      return;
    }

    const window =
      lumine.workspace.getWindowForElement(view.element) ?? lumine.workspace.getMainWindow();
    const { filePath } = await window.showSaveDialog(view.getPDFSaveDialogOptions());
    if (!filePath) return;

    return view.exportToPDF(filePath);
  },

  // The preview to act on: the one in front if it is a preview, otherwise the
  // one belonging to the markdown editor in front. Returns empty members when
  // neither is on screen, which every caller treats as "nothing to do".
  activePreview(event) {
    const context = this.commandContext(event);
    const activePaneItem = context.item;
    if (isMarkdownPreviewView(activePaneItem)) {
      return { pane: context.pane, view: activePaneItem };
    }

    const editor = context.editor;
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
