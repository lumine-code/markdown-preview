const path = require("path");
const morphdom = require("morphdom");

const { Emitter, Disposable, CompositeDisposable, watchFile } = require("lumine");
const _ = require("@lumine-code/underscore-plus");
const fs = require("@lumine-code/fs-plus");

const renderer = require("./renderer");

module.exports = class MarkdownPreviewView {
  static deserialize(params) {
    return new MarkdownPreviewView(params);
  }

  constructor({ editorId, filePath }) {
    this.editorId = editorId;
    this.filePath = filePath;
    this.element = globalThis.document.createElement("div");
    this.element.classList.add("markdown-preview");
    this.element.tabIndex = -1;

    this.emitter = new Emitter();
    this.loaded = false;
    this.disposables = new CompositeDisposable();
    this.selectionDocument = null;
    this.renderPromise = null;
    this.registerScrollCommands();
    this.registerAnchorScrolling();
    if (this.editorId != null) {
      this.resolveEditor(this.editorId);
    } else if (lumine.packages.hasActivatedInitialPackages()) {
      this.subscribeToFilePath(this.filePath);
    } else {
      this.disposables.add(
        lumine.packages.onDidActivateInitialPackages(() => {
          this.subscribeToFilePath(this.filePath);
        }),
      );
    }
    this.editorCache = new renderer.EditorCache(editorId);
    this.bindSelectionListener();
    this.disposables.add(new Disposable(() => this.unbindSelectionListener()));
  }

  get document() {
    return this.element.ownerDocument;
  }

  get domWindow() {
    return this.document.defaultView;
  }

  async beginWindowSurfaceTransition(context) {
    context.signal?.throwIfAborted?.();
    if (this.renderPromise) await this.renderPromise;
    const state = {
      id: context.id,
      scrollTop: this.element.scrollTop,
      selection: this.captureSelection(),
      wasFocused: this.element.contains(this.document.activeElement),
    };
    this.unbindSelectionListener();
    const finish = async () => {
      this.editorCache.adoptDocument(this.document);
      this.bindSelectionListener();
      await this.renderMarkdown();
      this.element.scrollTop = state.scrollTop;
      this.restoreSelection(state.selection);
      if (state.wasFocused) this.element.focus();
    };
    return { commit: finish, rollback: finish };
  }

  captureSelection() {
    const selection = this.domWindow.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!this.element.contains(range.commonAncestorContainer)) return null;
    return {
      start: nodePath(this.element, range.startContainer),
      startOffset: range.startOffset,
      end: nodePath(this.element, range.endContainer),
      endOffset: range.endOffset,
    };
  }

  restoreSelection(state) {
    if (!state) return;
    const start = nodeAtPath(this.element, state.start);
    const end = nodeAtPath(this.element, state.end);
    if (!start || !end) return;
    const range = this.document.createRange();
    try {
      range.setStart(start, Math.min(state.startOffset, nodeLength(start)));
      range.setEnd(end, Math.min(state.endOffset, nodeLength(end)));
    } catch {
      return;
    }
    const selection = this.domWindow.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  serialize() {
    return {
      deserializer: "MarkdownPreviewView",
      filePath: this.getPath() != null ? this.getPath() : this.filePath,
      editorId: this.editorId,
    };
  }

  copy() {
    return new MarkdownPreviewView({
      editorId: this.editorId,
      filePath: this.getPath() != null ? this.getPath() : this.filePath,
    });
  }

  destroy() {
    this.unbindSelectionListener();
    this.disposables.dispose();
    this.element.remove();
    this.editorCache.destroy();
  }

  registerScrollCommands() {
    this.disposables.add(
      lumine.commands.add(this.element, {
        "core:move-up": () => {
          this.element.scrollTop -= this.document.body.offsetHeight / 20;
        },
        "core:move-down": () => {
          this.element.scrollTop += this.document.body.offsetHeight / 20;
        },
        "core:page-up": () => {
          this.element.scrollTop -= this.element.offsetHeight;
        },
        "core:page-down": () => {
          this.element.scrollTop += this.element.offsetHeight;
        },
        "core:move-to-top": () => {
          this.element.scrollTop = 0;
        },
        "core:move-to-bottom": () => {
          this.element.scrollTop = this.element.scrollHeight;
        },
      }),
    );
  }

  // Lumine's global link handler prevents native fragment navigation.
  registerAnchorScrolling() {
    const handleClick = (event) => this.scrollToAnchor(event);
    this.element.addEventListener("click", handleClick);
    this.disposables.add(
      new Disposable(() => this.element.removeEventListener("click", handleClick)),
    );
  }

  scrollToAnchor(event) {
    const anchor = event.target.closest('a[href^="#"]');
    if (anchor == null) return;

    let id = anchor.getAttribute("href").slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Fall back to the raw fragment.
    }
    if (!id) return;

    // Prefer generated heading ids over colliding raw ids.
    const prefixedId = `user-content-${id}`;
    const target =
      this.element.querySelector(`[id="${this.domWindow.CSS.escape(prefixedId)}"]`) ??
      this.element.querySelector(`[id="${this.domWindow.CSS.escape(id)}"]`);
    if (target == null) return;

    event.preventDefault();
    target.scrollIntoView();
  }

  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  onDidChangeMarkdown(callback) {
    return this.emitter.on("did-change-markdown", callback);
  }

  subscribeToFilePath(filePath) {
    this.filePath = filePath;
    this.file = watchFile(filePath);
    this.emitter.emit("did-change-title");
    this.disposables.add(this.file);
    this.disposables.add(
      this.file.onDidRename((newPath) => {
        // `watchFile` follows the rename internally; keep our path in sync so
        // the title and URI reflect the new location.
        if (newPath) this.filePath = newPath;
        this.emitter.emit("did-change-title");
      }),
    );
    this.handleEvents();
    return this.renderMarkdown();
  }

  resolveEditor(editorId) {
    const resolve = () => {
      this.editor = this.editorForId(editorId);

      if (this.editor != null) {
        this.emitter.emit("did-change-title");
        this.disposables.add(
          this.editor.onDidDestroy(() => this.subscribeToFilePath(this.getPath())),
        );
        this.handleEvents();
        this.renderMarkdown();
      } else {
        this.subscribeToFilePath(this.filePath);
      }
    };

    if (lumine.packages.hasActivatedInitialPackages()) {
      resolve();
    } else {
      this.disposables.add(lumine.packages.onDidActivateInitialPackages(resolve));
    }
  }

  editorForId(editorId) {
    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.id != null && editor.id.toString() === editorId.toString()) {
        return editor;
      }
    }
    return null;
  }

  handleEvents() {
    const lazyRenderMarkdown = _.debounce(() => this.renderMarkdown(), 250);
    this.disposables.add(lumine.grammars.onDidAddGrammar(() => lazyRenderMarkdown()));
    this.disposables.add(lumine.grammars.onDidUpdateGrammar(() => lazyRenderMarkdown()));
    this.disposables.add(lumine.grammars.onDidRemoveGrammar(() => lazyRenderMarkdown()));

    lumine.commands.add(this.element, {
      "core:copy": (event) => {
        event.stopPropagation();
        return this.copyToClipboard();
      },
      "markdown-preview:select-all": {
        description: "Select the whole preview rather than the file behind it.",
        didDispatch: () => {
          this.selectAll();
        },
      },
      "markdown-preview:zoom-in": {
        description: "Make the preview a tenth larger.",
        didDispatch: () => {
          const zoomLevel = parseFloat(this.domWindow.getComputedStyle(this.element).zoom);
          this.element.style.zoom = zoomLevel + 0.1;
        },
      },
      "markdown-preview:zoom-out": {
        description: "Make the preview a tenth smaller.",
        didDispatch: () => {
          const zoomLevel = parseFloat(this.domWindow.getComputedStyle(this.element).zoom);
          this.element.style.zoom = zoomLevel - 0.1;
        },
      },
      "markdown-preview:reset-zoom": {
        description: "Put the preview back to its unzoomed size.",
        didDispatch: () => {
          this.element.style.zoom = 1;
        },
      },
      "markdown-preview:toggle-break-on-single-newline"() {
        const keyPath = "markdown-preview.breakOnSingleNewline";
        lumine.config.set(keyPath, !lumine.config.get(keyPath));
      },
      "markdown-preview:toggle-github-style"() {
        const keyPath = "markdown-preview.useGitHubStyle";
        lumine.config.set(keyPath, !lumine.config.get(keyPath));
      },
    });

    const changeHandler = () => {
      this.renderMarkdown();

      const pane = lumine.workspace.paneForItem(this);
      if (pane != null && pane !== lumine.workspace.getActivePane()) {
        pane.activateItem(this);
      }
    };

    if (this.file) {
      this.disposables.add(this.file.onDidChange(changeHandler));
    } else if (this.editor) {
      this.disposables.add(
        this.editor.getBuffer().onDidStopChanging(function () {
          if (lumine.config.get("markdown-preview.liveUpdate")) {
            changeHandler();
          }
        }),
      );
      this.disposables.add(
        this.editor.onDidChangePath(() => this.emitter.emit("did-change-title")),
      );
      this.disposables.add(
        this.editor.getBuffer().onDidSave(function () {
          if (!lumine.config.get("markdown-preview.liveUpdate")) {
            changeHandler();
          }
        }),
      );
      this.disposables.add(
        this.editor.getBuffer().onDidReload(function () {
          if (!lumine.config.get("markdown-preview.liveUpdate")) {
            changeHandler();
          }
        }),
      );
    }

    this.disposables.add(
      lumine.config.onDidChange("markdown-preview.breakOnSingleNewline", changeHandler),
    );

    this.disposables.add(
      lumine.config.observe("markdown-preview.gitHubStyleMode", (gitHubStyleMode) => {
        this.gitHubStyleMode = gitHubStyleMode;
        if (this.useGitHubStyle) {
          this.element.setAttribute("data-use-github-style", gitHubStyleMode);
        }
      }),
    );

    this.disposables.add(
      lumine.config.observe("markdown-preview.useGitHubStyle", (useGitHubStyle) => {
        this.useGitHubStyle = useGitHubStyle;
        if (useGitHubStyle) {
          this.element.setAttribute("data-use-github-style", this.gitHubStyleMode);
        } else {
          this.element.removeAttribute("data-use-github-style");
        }
      }),
    );
  }

  bindSelectionListener() {
    this.unbindSelectionListener();
    const document = this.document;
    const onSelectionChange = () => {
      const selection = document.defaultView.getSelection();
      const selectedNode = selection.baseNode;
      if (
        selectedNode === null ||
        this.element === selectedNode ||
        this.element.contains(selectedNode)
      ) {
        if (selection.isCollapsed) {
          this.element.classList.remove("has-selection");
        } else {
          this.element.classList.add("has-selection");
        }
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    this.selectionDocument = document;
    this.selectionChangeListener = onSelectionChange;
  }

  unbindSelectionListener() {
    this.selectionDocument?.removeEventListener("selectionchange", this.selectionChangeListener);
    this.selectionDocument = null;
    this.selectionChangeListener = null;
  }

  renderMarkdown() {
    if (!this.loaded) {
      this.showLoading();
    }
    const promise = this.getMarkdownSource()
      .then((source) => {
        if (source != null) {
          if (this.loaded) {
            return this.renderMarkdownText(source);
          } else {
            // If we haven't loaded yet, defer before we render the Markdown
            // for the first time. This allows the pane to appear and to
            // display the loading indicator. Otherwise the first render
            // happens before the pane is even visible.
            //
            // This doesn't slow anything down; it just shifts the work around
            // so that the pane appears earlier in the cycle.
            return new Promise((resolve) => {
              setTimeout(() => {
                resolve(this.renderMarkdownText(source));
              }, 0);
            });
          }
        }
      })
      .catch((reason) => this.showError({ message: reason }));
    this.renderPromise = promise;
    return promise.finally(() => {
      if (this.renderPromise === promise) this.renderPromise = null;
    });
  }

  getMarkdownSource() {
    if (this.file && this.filePath) {
      return require("fs")
        .promises.readFile(this.filePath, "utf8")
        .then((source) => Promise.resolve(source))
        .catch((reason) => {
          if (reason && reason.code === "ENOENT") {
            return Promise.reject(new Error(`${path.basename(this.filePath)} could not be found`));
          }
          return Promise.reject(reason);
        });
    } else if (this.editor != null) {
      return Promise.resolve(this.editor.getText());
    } else {
      return Promise.reject(new Error("No editor found"));
    }
  }

  async getHTML() {
    const source = await this.getMarkdownSource();

    if (source == null) {
      return;
    }

    return renderer.toHTML(source, this.getPath(), this.getGrammar(), this.editorId, this.document);
  }

  async renderMarkdownText(text) {
    const { scrollTop } = this.element;
    try {
      const [domFragment, done] = await renderer.toDOMFragment(
        text,
        this.getPath(),
        this.getGrammar(),
        this.editorId,
        this.document,
        this.editorCache,
      );

      this.loading = false;
      this.loaded = true;

      // Clone the existing container
      let newElement = this.element.cloneNode(false);
      newElement.appendChild(domFragment);

      morphdom(this.element, newElement, {
        onBeforeNodeDiscarded(node) {
          // Don't discard `lumine-text-editor` elements despite the fact that
          // they don't exist in the new content.
          if (node.nodeName === "LUMINE-TEXT-EDITOR") {
            return false;
          }
        },
      });

      await done(this.element);
      this.element.classList.remove("loading");

      this.emitter.emit("did-change-markdown");
      this.element.scrollTop = scrollTop;
    } catch (error) {
      this.showError(error);
    }
  }

  getTitle() {
    if (this.file != null && this.getPath() != null) {
      return `${path.basename(this.getPath())} Preview`;
    } else if (this.editor != null) {
      return `${this.editor.getTitle()} Preview`;
    } else {
      return "Markdown Preview";
    }
  }

  getIconName() {
    return "markdown";
  }

  getURI() {
    if (this.file != null) {
      return `markdown-preview://${this.getPath()}`;
    } else {
      return `markdown-preview://editor/${this.editorId}`;
    }
  }

  getPath() {
    if (this.file != null) {
      return this.filePath;
    } else if (this.editor != null) {
      return this.editor.getPath();
    }
  }

  getGrammar() {
    return this.editor != null ? this.editor.getGrammar() : undefined;
  }

  getDocumentStyleSheets() {
    // This function exists so we can stub it
    return this.document.styleSheets;
  }

  getTextEditorStyles() {
    const document = this.document;
    const textEditorStyles = document.createElement("lumine-styles");
    textEditorStyles.initialize(lumine.styles);
    textEditorStyles.setAttribute("context", "lumine-text-editor");
    document.body.appendChild(textEditorStyles);

    // Extract style elements content
    return Array.prototype.slice
      .apply(textEditorStyles.childNodes)
      .map((styleElement) => styleElement.innerText);
  }

  // The preview's rules are written against the active theme's custom
  // properties, but those are declared on `:root` by the theme's own
  // stylesheets — which `getMarkdownPreviewCSS` does not collect, because their
  // selectors say nothing about `.markdown-preview`. In a document of its own
  // every one of them is undefined, so each declaration that reads one is
  // invalid at computed-value time: table borders vanish and every themed color
  // falls back to the browser default.
  //
  // So resolve the ones the stylesheet actually references, against this
  // preview, and ship their values alongside it.
  resolveThemeVariables(css) {
    const names = new Set();
    for (const [, name] of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
      names.add(name);
    }

    const computed = this.domWindow.getComputedStyle(this.element);
    const declarations = [];
    for (const name of [...names].sort()) {
      const value = computed.getPropertyValue(name).trim();
      if (value) declarations.push(`  ${name}: ${value};`);
    }

    return declarations.length > 0 ? `:root {\n${declarations.join("\n")}\n}\n` : "";
  }

  getMarkdownPreviewCSS() {
    const markdownPreviewRules = [];
    const ruleRegExp = /\.markdown-preview/;
    const cssUrlRegExp = /url\(lumine:\/\/markdown-preview\/assets\/(.*)\)/;

    for (const stylesheet of this.getDocumentStyleSheets()) {
      if (stylesheet.rules != null) {
        for (const rule of stylesheet.rules) {
          // We only need `.markdown-review` css
          if (rule.selectorText && rule.selectorText.match(ruleRegExp)) {
            markdownPreviewRules.push(rule.cssText);
          }
        }
      }
    }

    return markdownPreviewRules
      .concat(this.getTextEditorStyles())
      .join("\n")
      .replace(/lumine-text-editor/g, "pre.editor-colors")
      .replace(/:host/g, ".host") // Remove shadow-dom :host selector causing problem on FF
      .replace(cssUrlRegExp, function (_match, assetsName, _offset, _string) {
        // base64 encode assets
        const assetPath = path.join(__dirname, "../assets", assetsName);
        const originalData = fs.readFileSync(assetPath, "binary");
        const base64Data = Buffer.from(originalData, "binary").toString("base64");
        return `url('data:image/jpeg;base64,${base64Data}')`;
      });
  }

  showError(result) {
    this.element.textContent = "";
    this.element.classList.remove("loading");
    const h2 = this.document.createElement("h2");
    h2.textContent = "Previewing Markdown Failed";
    this.element.appendChild(h2);
    if (result) {
      const h3 = this.document.createElement("h3");
      h3.textContent = result.message;
      this.element.appendChild(h3);
    }
  }

  showLoading() {
    this.loading = true;
    this.element.classList.add("loading");
  }

  selectAll() {
    if (this.loading) {
      return;
    }

    const selection = this.domWindow.getSelection();
    selection.removeAllRanges();
    const range = this.document.createRange();
    range.selectNodeContents(this.element);
    selection.addRange(range);
  }

  async copyToClipboard() {
    if (this.loading) {
      return;
    }

    const selection = this.domWindow.getSelection();
    const selectedText = selection.toString();
    const selectedNode = selection.baseNode;

    // Use default copy event handler if there is selected text inside this view
    if (
      selectedText &&
      selectedNode != null &&
      (this.element === selectedNode || this.element.contains(selectedNode))
    ) {
      lumine.clipboard.write(selectedText);
    } else {
      try {
        const html = await this.getHTML();

        lumine.clipboard.write(html);
      } catch (error) {
        lumine.notifications.addError("Copying Markdown as HTML failed", {
          dismissable: true,
          detail: error.message,
        });
      }
    }
  }

  getSaveDialogOptions() {
    let defaultPath = this.getPath();
    if (defaultPath) {
      defaultPath += ".html";
    } else {
      let projectPath;
      defaultPath = "untitled.md.html";
      if ((projectPath = lumine.project.getPaths()[0])) {
        defaultPath = path.join(projectPath, defaultPath);
      }
    }

    return { defaultPath };
  }

  getPDFSaveDialogOptions() {
    const sourcePath = this.getPath();
    let defaultPath = "untitled.pdf";

    if (sourcePath) {
      // The PDF replaces the markdown extension rather than following it, the
      // way the HTML export does: `notes.md.pdf` reads as an accident.
      const { dir, name } = path.parse(sourcePath);
      defaultPath = path.join(dir, `${name}.pdf`);
    } else {
      const projectPath = lumine.project.getPaths()[0];
      if (projectPath) defaultPath = path.join(projectPath, defaultPath);
    }

    return { defaultPath, filters: [{ name: "PDF", extensions: ["pdf"] }] };
  }

  // The rendered preview as a document that stands on its own: the preview's
  // stylesheet is inlined and the renderer has already turned every asset into
  // a data URI, so nothing here resolves against this window. Both the HTML and
  // the PDF export are built from it, which is what keeps the two in step.
  //
  // Returns `null` when the preview has not finished loading, having said so.
  async buildStandaloneDocument() {
    if (this.loading) {
      lumine.notifications.addWarning(
        "Please wait until the Markdown Preview has finished loading before saving",
      );
      return null;
    }

    const filePath = this.getPath();
    let title = "Markdown to HTML";
    if (filePath) {
      title = path.parse(filePath).name;
    }

    const htmlBody = await this.getHTML();
    const css = this.getMarkdownPreviewCSS();

    // Mirror the live preview's attribute rather than always writing the mode:
    // the base stylesheet hangs off `.markdown-preview:not([data-use-github-style])`,
    // so spelling the attribute out when GitHub style is off — which is what
    // `gitHubStyleMode` reports as "auto" — matched that `:not()` against a
    // present attribute and dropped every base rule from the document.
    const gitHubStyle = this.element.getAttribute("data-use-github-style");
    const gitHubStyleAttribute =
      gitHubStyle == null ? "" : ` data-use-github-style="${gitHubStyle}"`;

    return (
      `\
<!DOCTYPE html>
<html>
  <head>
      <meta charset="utf-8" />
      <title>${title}</title>
      <style>${this.resolveThemeVariables(css)}${css}</style>
  </head>
  <body class='markdown-preview'${gitHubStyleAttribute}>${htmlBody}</body>
</html>` + "\n"
    ); // Ensure trailing newline
  }

  async saveAs(htmlFilePath) {
    const html = await this.buildStandaloneDocument();
    if (html == null) return;

    fs.writeFileSync(htmlFilePath, html);
    return lumine.workspace.open(htmlFilePath);
  }

  // Printing happens in the main process, in a window of its own — printing
  // this one would capture the tree view and the tabs along with the preview.
  async exportToPDF(pdfFilePath) {
    const html = await this.buildStandaloneDocument();
    if (html == null) return;

    const { outcome, error } = await lumine.application.printToPDF(html, pdfFilePath, {
      printBackground: true,
      preferCSSPageSize: true,
    });

    if (outcome !== "success") {
      lumine.notifications.addError("Could not export the Markdown Preview to PDF", {
        detail: error?.message,
        dismissable: true,
      });
      return;
    }

    return pdfFilePath;
  }
};

function nodePath(root, node) {
  const path = [];
  while (node && node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return node === root ? path : null;
}

function nodeAtPath(root, path) {
  if (!path) return null;
  let node = root;
  for (const index of path) node = node?.childNodes[index];
  return node || null;
}

function nodeLength(node) {
  return node.nodeType === 3 ? node.data.length : node.childNodes.length;
}
