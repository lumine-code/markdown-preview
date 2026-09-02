const { TextEditor } = require("lumine");
const path = require("path");
const createDOMPurify = require("dompurify");
const emoji = require("emoji-images");
const fs = require("@lumine-code/fs-plus");
let marked = null; // Defer until used
let githubSlugger = null;
let innertext = null;
let renderer = null;
let grayMatter = null;

const { scopeForFenceName } = require("./extension-helper");
const resourcePath = lumine.application.getResourcePath();
const packagePath = path.dirname(__dirname);

const emojiFolder = path.join(path.dirname(require.resolve("emoji-images")), "pngs");

// Creating `TextEditor` instances is costly, so we'll try to re-use instances
// when a preview changes.
class EditorCache {
  constructor() {
    this.editorsByPre = new Map();
    this.nextRenderSessionId = 0;
    this.lastClaimedSessionByEditor = new WeakMap();
  }

  destroy() {
    let editors = Array.from(this.editorsByPre.values());
    for (let editor of editors) {
      editor.destroy();
    }
    this.editorsByPre.clear();
  }

  // Called when we start a render. Every `TextEditor` is assumed to be stale,
  // but any editor that is successfully looked up from the cache during this
  // render is saved from culling.
  beginRender() {
    const editorsByPre = new Map(this.editorsByPre);
    return {
      id: ++this.nextRenderSessionId,
      editorsByPre,
      unusedEditors: new Set(editorsByPre.values()),
    };
  }

  // Cache an editor by the PRE element that it's standing in for.
  addEditor(pre, editor, session) {
    this.editorsByPre.set(pre, editor);
    this.recordClaim(editor, session);
  }

  getEditor(pre, session) {
    let editor = this.editorsByPre.get(pre);
    if (editor) {
      // Cache hit! This editor will be reused, so we should prevent it from
      // getting culled.
      session.unusedEditors.delete(editor);
      this.recordClaim(editor, session);
    }
    return editor;
  }

  recordClaim(editor, session) {
    const lastClaimedSession = this.lastClaimedSessionByEditor.get(editor) ?? 0;
    if (session.id > lastClaimedSession) {
      this.lastClaimedSessionByEditor.set(editor, session.id);
    }
  }

  endRender(session) {
    // Any editor that didn't get claimed during the render is orphaned and
    // should be disposed of. An older overlapping render must not dispose of
    // an editor that a newer render has claimed in the meantime.
    for (const [pre, editor] of session.editorsByPre) {
      if (!session.unusedEditors.has(editor)) continue;
      if (this.editorsByPre.get(pre) !== editor) continue;
      if ((this.lastClaimedSessionByEditor.get(editor) ?? 0) > session.id) continue;

      let element = editor.getElement();
      if (element.parentNode) {
        element.remove();
      }
      // Recheck the identity immediately before deletion. Rendering callbacks
      // are normally synchronous here, but the cache contract should not let
      // a replaced mapping be removed by its predecessor.
      if (this.editorsByPre.get(pre) !== editor) continue;
      this.editorsByPre.delete(pre);
      editor.destroy();
    }

    session.unusedEditors.clear();
  }
}

exports.EditorCache = EditorCache;

function chooseRender(text, filePath) {
  if (lumine.config.get("markdown-preview.useOriginalParser")) {
    // Legacy rendering with `marked`.
    return render(text, filePath);
  } else {
    // Built-in rendering with `markdown-it`.
    let html = lumine.tools.markdown.render(text, {
      renderMode: "fragment",
      filePath: filePath,
      breaks: lumine.config.get("markdown-preview.breakOnSingleNewline"),
      useDefaultEmoji: true,
      useGitHubHeadings: true,
      sanitizeAllowUnknownProtocols: lumine.config.get("markdown-preview.allowUnsafeProtocols"),
    });
    return lumine.tools.markdown.convertToDOM(html);
  }
}

exports.toDOMFragment = async function (text, filePath, grammar, cache, { signal } = {}) {
  text ??= "";
  let defaultLanguage = getDefaultLanguageForGrammar(grammar);

  // We cache editor instances in this code path because it's the one used by
  // the preview pane, so we expect it to be updated quite frequently.
  const cacheSession = cache.beginRender();

  const domFragment = chooseRender(text, filePath);
  annotatePreElements(domFragment, defaultLanguage);

  return [
    domFragment,
    async (element) => {
      if (signal?.aborted) return;
      try {
        await highlightCodeBlocks(element, grammar, cache, cacheSession, (editorElement) =>
          makeLumineEditorNonInteractive(editorElement, { signal }),
        );
      } finally {
        // The session's claim epoch prevents an older aborted render from
        // culling editors used by a newer one. Still finish the old session so
        // repeated cancellations cannot retain every detached predecessor.
        cache.endRender(cacheSession);
      }
    },
  ];
};

exports.toHTML = async function (text, filePath, grammar, { signal } = {}) {
  text ??= "";

  // We don't cache editor instances in this code path because it's the one
  // used by the “Copy HTML” command, so this is likely to be a one-off for
  // which caches won't help.

  const domFragment = chooseRender(text, filePath);
  const div = document.createElement("div");
  annotatePreElements(domFragment, getDefaultLanguageForGrammar(grammar));

  // Mark each PRE element with a `data-serialized` attribute.
  //
  // This helps distinguish between a PRE in the preview pane (which we want to
  // hide, since the read-only editor is shown in its place) and a PRE in the
  // generated HTML (which we want to show, since there is no substitute
  // element).
  for (let pre of domFragment.querySelectorAll("pre")) {
    pre.dataset.serialized = true;
  }

  div.appendChild(domFragment);
  document.body.appendChild(div);

  await highlightCodeBlocks(div, grammar, null, null, (editorElement, preElement) =>
    convertLumineEditorToStandardElement(editorElement, preElement, { signal }),
  );

  const result = div.innerHTML;
  div.remove();

  return result;
};

// Render with the package's own `marked` library.
function render(text, filePath) {
  if (marked == null || grayMatter == null) {
    marked = require("marked");
    // ESM-only since v2, so require() hands back the namespace rather than
    // the class itself.
    const GithubSlugger = require("github-slugger").default;
    innertext = require("innertext");
    grayMatter = require("gray-matter");

    renderer = new marked.Renderer();
    githubSlugger = new GithubSlugger();
    // As of `marked` v15+, renderer methods receive a single token object
    // (rather than positional strings) and the inner HTML is no longer
    // pre-rendered for us. Reuse the default `listitem` rendering — which
    // handles task checkboxes and loose/tight items — and just add the
    // `task-list-item` class that our stylesheet expects.
    const baseListitem = marked.Renderer.prototype.listitem;
    renderer.listitem = function (item) {
      const html = baseListitem.call(this, item);
      return item.task ? html.replace(/^<li>/, '<li class="task-list-item">') : html;
    };
    // Generate GitHub-compatible, DOMPurify-safe heading ids so in-page
    // fragment links (tables of contents) resolve to the right heading.
    renderer.heading = function (token) {
      const html = this.parser.parseInline(token.tokens);
      const id = `user-content-${githubSlugger.slug(innertext(html))}`;
      return `<h${token.depth} id="${id}">${html}</h${token.depth}>\n`;
    };
  }

  // Reset per render so repeated headings get stable, deduplicated ids.
  githubSlugger.reset();
  marked.setOptions({
    breaks: lumine.config.get("markdown-preview.breakOnSingleNewline"),
    renderer,
  });

  const { content: __content, data: vars } = grayMatter(text);

  let html = marked.parse(renderYamlTable(vars) + __content);

  // emoji-images is too aggressive, so replace images in monospace tags with
  // the actual emoji text. A template's content is inert — nothing loads or
  // executes while we rewrite it, and DOMPurify sanitizes the result below.
  const emojiTemplate = document.createElement("template");
  emojiTemplate.innerHTML = emoji(html, emojiFolder, 20);
  for (const img of emojiTemplate.content.querySelectorAll("pre img, code img")) {
    img.replaceWith(img.getAttribute("title") ?? "");
  }

  html = emojiTemplate.innerHTML;

  html = createDOMPurify().sanitize(html, {
    ALLOW_UNKNOWN_PROTOCOLS: lumine.config.get("markdown-preview.allowUnsafeProtocols"),
  });

  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const fragment = template.content.cloneNode(true);

  resolveImagePaths(fragment, filePath);

  return fragment;
}

function renderYamlTable(variables) {
  const entries = Object.entries(variables);

  if (!entries.length) {
    return "";
  }

  const markdownRows = [
    entries.map((entry) => entry[0]),
    entries.map((_) => "--"),
    entries.map((entry) => {
      if (typeof entry[1] === "object" && !Array.isArray(entry[1])) {
        // Remove all newlines, or they ruin formatting of parent table
        return marked.parse(renderYamlTable(entry[1])).replace(/\n/g, "");
      } else {
        return entry[1];
      }
    }),
  ];

  return markdownRows.map((row) => "| " + row.join(" | ") + " |").join("\n") + "\n";
}

function resolveImagePaths(element, filePath) {
  const [rootDirectory] = lumine.project.relativizePath(filePath);

  const result = [];
  for (const img of element.querySelectorAll("img")) {
    // We use the raw attribute instead of the .src property because the value
    // of the property seems to be transformed in some cases.
    let src;

    if ((src = img.getAttribute("src"))) {
      if (src.match(/^(https?|lumine):\/\//)) {
        continue;
      }
      if (src.startsWith(process.resourcesPath)) {
        continue;
      }
      if (src.startsWith(resourcePath)) {
        continue;
      }
      if (src.startsWith(packagePath)) {
        continue;
      }

      if (src[0] === "/") {
        if (!fs.isFileSync(src)) {
          if (rootDirectory) {
            result.push((img.src = path.join(rootDirectory, src.substring(1))));
          } else {
            result.push(undefined);
          }
        } else {
          result.push(undefined);
        }
      } else {
        result.push((img.src = path.resolve(path.dirname(filePath), src)));
      }
    } else {
      result.push(undefined);
    }
  }

  return result;
}

function getDefaultLanguageForGrammar(grammar) {
  return grammar?.scopeName === "source.litcoffee" ? "coffee" : "text";
}

function annotatePreElements(fragment, defaultLanguage) {
  for (let preElement of fragment.querySelectorAll("pre")) {
    const codeBlock = preElement.firstElementChild ?? preElement;
    const className = codeBlock.getAttribute("class");
    const fenceName = className?.replace(/^language-/, "") ?? defaultLanguage;
    preElement.classList.add("editor-colors", `lang-${fenceName}`);
  }
}

function reassignEditorToLanguage(editor, languageScope) {
  // When we successfully reassign the language on an editor, its
  // `data-grammar` attribute updates on its own.
  let result = lumine.grammars.assignLanguageMode(editor, languageScope);
  if (result) return true;

  // When we fail to assign the language on an editor — maybe its package is
  // deactivated — it won't reset itself to the default grammar, so we have to
  // do it ourselves.
  result = lumine.grammars.assignLanguageMode(editor, `text.plain.null-grammar`);
  if (!result) return false;
}

// After render, create an `lumine-text-editor` for each `pre` element so that we
// enjoy syntax highlighting.
function highlightCodeBlocks(element, grammar, cache, cacheSession, editorCallback) {
  let defaultLanguage = getDefaultLanguageForGrammar(grammar);

  const promises = [];

  for (const preElement of element.querySelectorAll("pre")) {
    const codeBlock = preElement.firstElementChild ?? preElement;
    const className = codeBlock.getAttribute("class");
    const fenceName = className?.replace(/^language-/, "") ?? defaultLanguage;
    let editorText = codeBlock.textContent.replace(/\r?\n$/, "");

    // If this PRE element was present in the last render, then we should
    // already have a cached text editor available for use.
    let editor = cache?.getEditor(preElement, cacheSession) ?? null;
    let editorElement;
    if (!editor) {
      editor = new TextEditor({ keyboardInputEnabled: false });
      editorElement = editor.getElement();
      editor.setReadOnly(true);
      cache?.addEditor(preElement, editor, cacheSession);
    } else {
      editorElement = editor.getElement();
    }

    // If the PRE changed its content, we need to change the content of its
    // `TextEditor`.
    if (editor.getText() !== editorText) {
      editor.setReadOnly(false);
      editor.setText(editorText);
      editor.setReadOnly(true);
    }

    // If the PRE changed its language, we need to change the language of its
    // `TextEditor`. The same scope is not enough to skip this: the grammar
    // behind the scope may have been removed or re-added since the last
    // render — its package deactivated and reactivated — and a cached editor
    // would keep highlighting with the dead grammar.
    let scopeDescriptor = editor.getRootScopeDescriptor()[0];
    let languageScope = scopeForFenceName(fenceName);
    const sameScope = languageScope === scopeDescriptor || `.${languageScope}` === scopeDescriptor;
    const registryGrammar = lumine.grammars.grammarForId(languageScope) ?? null;
    const editorGrammar = editor.getGrammar();
    if (!sameScope || registryGrammar !== editorGrammar) {
      reassignEditorToLanguage(editor, languageScope);
    }

    // If the editor is brand new, we'll have to insert it; otherwise it should
    // already be in the right place.
    if (!editorElement.parentNode) {
      preElement.parentNode.insertBefore(editorElement, preElement);
      editor.setVisible(true);
    }

    promises.push(editorCallback(editorElement, preElement));
  }
  return Promise.all(promises);
}

async function makeLumineEditorNonInteractive(editorElement, { signal } = {}) {
  editorElement.setAttributeNode(document.createAttribute("gutter-hidden"));
  editorElement.removeAttribute("tabindex");

  // Remove line decorations from code blocks.
  const editor = editorElement.getModel();
  for (const cursorLineDecoration of editor.cursorLineDecorations) {
    cursorLineDecoration.destroy();
  }

  await waitForEditorGrammar(editor, { signal });
}

function convertLumineEditorToStandardElement(editorElement, preElement, { signal } = {}) {
  return new Promise(function (resolve) {
    const editor = editorElement.getModel();
    let timeout;
    let finished = false;
    let destroySubscription;
    const finish = (copyLines) => {
      // Grammar settlement, component update, timeout, and editor destruction
      // can all race. Exactly one path owns the conversion and cleanup.
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      destroySubscription?.dispose();

      try {
        if (copyLines && !editor.isDestroyed()) {
          const lines = editorElement.querySelectorAll(".line:not(.dummy)");
          // No rendered lines for nonempty source means the component did not
          // actually finish. Preserve the Markdown renderer's code element.
          if (lines.length > 0 || preElement.textContent.length === 0) {
            const replacement = document.createDocumentFragment();
            for (const line of lines) {
              const line2 = document.createElement("div");
              line2.className = "line";
              line2.innerHTML = line.firstChild.innerHTML;
              replacement.appendChild(line2);
            }
            // Build the replacement off-DOM first. A failed or cancelled
            // component update must leave the original code element intact.
            preElement.replaceChildren(replacement);
          }
        }
      } catch {
        // Keep the original code element when extracting rendered lines fails.
      }

      editorElement.remove();
      try {
        if (!editor.isDestroyed()) editor.destroy();
      } catch {
        // Rendering has already fallen back to the original code element.
      }
      resolve();
    };
    const done = () => {
      if (finished) return;
      if (editor.isDestroyed()) {
        finish(false);
        return;
      }

      let updatePromise;
      try {
        updatePromise = editor.component.getNextUpdatePromise();
      } catch {
        finish(false);
        return;
      }
      updatePromise.then(
        () => finish(true),
        () => finish(false),
      );

      // Guard against the next component update not happening promptly — or
      // not happening at all. This isn't the right fix, but as a workaround
      // it'll do.
      timeout = setTimeout(() => {
        // If we haven't had an update yet, force one.
        if (finished) return;
        try {
          editor.component.updateSync();
          finish(true);
        } catch {
          finish(false);
        }
      }, 500);
    };

    destroySubscription = editor.onDidDestroy(() => finish(false));
    waitForEditorGrammar(editor, { signal }).then(done);
  });
}

async function waitForEditorGrammar(editor, { signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const destroySubscription = editor.onDidDestroy(abort);
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener?.("abort", abort, { once: true });
  }
  try {
    return await editor.whenGrammarSettled({ signal: controller.signal });
  } catch {
    // A preview is still useful without highlighted code blocks. Loading and
    // parser failures must not strand an export or a live render.
    return false;
  } finally {
    destroySubscription.dispose();
    signal?.removeEventListener?.("abort", abort);
  }
}
