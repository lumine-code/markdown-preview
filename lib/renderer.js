const path = require("path");
const { pathToFileURL } = require("node:url");
const createDOMPurify = require("dompurify");
const emoji = require("emoji-images");
const fs = require("@lumine-code/fs-plus");
const parserLoader = require("./parser-loader");
let marked = null; // Defer until used
let githubSlugger = null;
let renderer = null;
let grayMatter = null;
let domPurify = null;

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

async function chooseRender(text, filePath, { signal } = {}) {
  signal?.throwIfAborted();
  let fragment;
  if (lumine.config.get("markdown-preview.useOriginalParser")) {
    // Legacy rendering with `marked`.
    const libraries = await parserLoader.loadParser();
    signal?.throwIfAborted();
    fragment = render(text, libraries);
  } else {
    // Built-in rendering with `markdown-it`.
    let html = lumine.tools.markdown.render(text, {
      renderMode: "fragment",
      filePath: filePath,
      breaks: lumine.config.get("markdown-preview.breakOnSingleNewline"),
      useDefaultEmoji: true,
      useGitHubHeadings: true,
      // Localize images after sanitization, in the same pass as raw HTML and
      // responsive image sources. An authored relative path is safe even when
      // authored file:// URLs are disabled.
      transformImageLinks: false,
      sanitize: false,
    });
    fragment = sanitizeHTML(html);
  }

  resolveImagePaths(fragment, filePath);
  normalizeTaskLists(fragment);
  resolvePictureMedia(fragment);
  return fragment;
}

exports.toDOMFragment = async function (text, filePath, grammar, cache, { signal } = {}) {
  signal?.throwIfAborted();
  text ??= "";
  let defaultLanguage = getDefaultLanguageForGrammar(grammar);
  const domFragment = await chooseRender(text, filePath, { signal });
  signal?.throwIfAborted();

  // We cache editor instances in this code path because it's the one used by
  // the preview pane, so we expect it to be updated quite frequently.
  const cacheSession = cache.beginRender();

  annotatePreElements(domFragment, defaultLanguage);

  return [
    domFragment,
    async (element) => {
      try {
        if (signal?.aborted) return;
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
  signal?.throwIfAborted();
  text ??= "";

  // We don't cache editor instances in this code path because it's the one
  // used by the “Copy HTML” command, so this is likely to be a one-off for
  // which caches won't help.

  const domFragment = await chooseRender(text, filePath, { signal });
  signal?.throwIfAborted();
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

  try {
    await highlightCodeBlocks(div, grammar, null, null, (editorElement, preElement) =>
      convertLumineEditorToStandardElement(editorElement, preElement, { signal }),
    );
    return div.innerHTML;
  } finally {
    div.remove();
  }
};

// Render with the package's own `marked` library.
function render(text, libraries) {
  if (marked == null || grayMatter == null) {
    ({ marked, grayMatter } = libraries);
    const { GithubSlugger } = libraries;

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
      // GitHub slugs the text nodes, without adding spaces around inline tags
      // or treating an image's alt text as heading text.
      const template = document.createElement("template");
      template.innerHTML = html;
      const id = `user-content-${githubSlugger.slug(template.content.textContent)}`;
      return `<h${token.depth} id="${id}">${html}</h${token.depth}>\n`;
    };
  }

  // Reset per render so repeated headings get stable, deduplicated ids.
  githubSlugger.reset();

  // Supplying options disables gray-matter's unbounded source cache. A live
  // preview otherwise retains every complete revision, including its buffer.
  const { content: __content, data: vars } = grayMatter(text, {});

  let html = marked.parse(renderYamlTable(vars) + __content, {
    breaks: lumine.config.get("markdown-preview.breakOnSingleNewline"),
    renderer,
  });

  // emoji-images is too aggressive, so replace images in monospace tags with
  // the actual emoji text. A template's content is inert — nothing loads or
  // executes while we rewrite it, and DOMPurify sanitizes the result below.
  const emojiTemplate = document.createElement("template");
  emojiTemplate.innerHTML = emoji(html, emojiFolder, 20);
  for (const img of emojiTemplate.content.querySelectorAll("pre img, code img")) {
    img.replaceWith(img.getAttribute("title") ?? "");
  }

  html = emojiTemplate.innerHTML;

  return sanitizeHTML(html);
}

function sanitizeHTML(html) {
  if (domPurify == null) {
    domPurify = createDOMPurify();
    domPurify.addHook("uponSanitizeAttribute", (node, attribute) => {
      if (attribute.attrName !== "srcset" || !/^(IMG|SOURCE)$/.test(node.nodeName)) return;
      // A srcset is a list of URLs, and data URLs contain commas. Validate
      // every candidate as an image URL before retaining the list attribute.
      const candidates = parseSrcset(attribute.attrValue).filter(({ url }) =>
        domPurify.isValidAttribute("img", "src", url),
      );
      attribute.attrValue = serializeSrcset(candidates);
      attribute.keepAttr = candidates.length > 0;
      attribute.forceKeepAttr = candidates.length > 0;
      if (candidates.length > 0) node.setAttribute("srcset", attribute.attrValue);
    });
  }
  let fragment;
  try {
    fragment = domPurify.sanitize(html, {
      ALLOW_UNKNOWN_PROTOCOLS: lumine.config.get("markdown-preview.allowUnsafeProtocols"),
      // DOMPurify deliberately handles customized built-ins differently for
      // node output. Keep string output for documents with an `is` attribute.
      RETURN_DOM_FRAGMENT: !/\sis=/i.test(html),
    });
  } finally {
    // The private reusable sanitizer must not retain removed nodes from the
    // previous document through its diagnostic array.
    domPurify.removed = [];
  }

  if (typeof fragment === "string" || needsHtmlReparse(fragment)) {
    // HTML parsing consumes an initial newline in PRE, TEXTAREA and LISTING.
    // Preserve the final parse for the uncommon documents that depend on it,
    // including when sanitization exposed a newline by removing a child.
    const template = document.createElement("template");
    if (typeof fragment === "string") {
      template.innerHTML = fragment.trim();
    } else {
      template.content.appendChild(fragment);
      template.innerHTML = template.innerHTML.trim();
    }
    fragment = template.content.cloneNode(true);
  } else {
    // HTML serialization escapes NBSP as &nbsp;, so retain it while trimming
    // the fragment's boundaries as the former serialized HTML trim did.
    trimFragmentBoundary(fragment, "firstChild", /^[^\S\u00a0]+/u);
    trimFragmentBoundary(fragment, "lastChild", /[^\S\u00a0]+$/u);
  }

  return fragment;
}

function needsHtmlReparse(fragment) {
  for (const element of fragment.querySelectorAll("pre, textarea, listing, template")) {
    if (element.content) {
      if (needsHtmlReparse(element.content)) return true;
    } else if (element.firstChild?.nodeType === Node.TEXT_NODE) {
      if (element.firstChild.data.startsWith("\n")) return true;
    }
  }
  return false;
}

function trimFragmentBoundary(fragment, boundary, whitespace) {
  while (fragment[boundary]?.nodeType === Node.TEXT_NODE) {
    const node = fragment[boundary];
    node.data = node.data.replace(whitespace, "");
    if (node.data) break;
    node.remove();
  }
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
      if (entry[1] !== null && typeof entry[1] === "object" && !Array.isArray(entry[1])) {
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
  for (const img of element.querySelectorAll("img")) {
    const source = img.getAttribute("src");
    if (source) img.setAttribute("src", resolveImageSource(source, filePath, rootDirectory));
  }

  for (const surface of element.querySelectorAll("picture source[srcset], img[srcset]")) {
    const candidates = parseSrcset(surface.getAttribute("srcset"));
    for (const candidate of candidates) {
      candidate.url = resolveImageSource(candidate.url, filePath, rootDirectory, true);
    }
    surface.setAttribute("srcset", serializeSrcset(candidates));
  }
}

function resolveImageSource(source, filePath, rootDirectory, asURL = false) {
  // The preview document has an editor protocol. GitHub resolves network-path
  // references against HTTPS, so make that scheme explicit here as well.
  if (source.startsWith("//")) source = `https:${source}`;
  const githubBlobPath = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/)blob\//;
  if (githubBlobPath.test(source)) {
    return source.replace(githubBlobPath, "$1raw/");
  }
  if (/^[a-z]:[\\/]/i.test(source) || source.startsWith("\\\\")) {
    return asURL ? pathToFileURL(source, { windows: true }).href : path.win32.normalize(source);
  }
  // Absolute URLs (including file/data/custom protocols) have already passed
  // sanitization. Never turn them into local paths.
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) return source;
  if (!filePath) return source;

  const suffixIndex = source.search(/[?#]/);
  const suffix = suffixIndex < 0 ? "" : source.slice(suffixIndex);
  let pathname = suffixIndex < 0 ? source : source.slice(0, suffixIndex);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Preserve a literal percent sign in an authored filesystem path.
  }

  let resolved;
  if (path.isAbsolute(pathname)) {
    if (
      pathname.startsWith(process.resourcesPath) ||
      pathname.startsWith(resourcePath) ||
      pathname.startsWith(packagePath) ||
      fs.isFileSync(pathname)
    ) {
      resolved = pathname;
    } else if (pathname.startsWith("/") && rootDirectory) {
      resolved = path.join(rootDirectory, pathname.substring(1));
    } else {
      return source;
    }
  } else {
    resolved = path.resolve(path.dirname(filePath), pathname);
  }

  return asURL || suffix ? pathToFileURL(resolved).href + suffix : resolved;
}

function parseSrcset(value) {
  const candidates = [];
  let position = 0;
  // Follow the HTML candidate boundaries: commas inside a URL belong to the
  // URL; a trailing comma or a comma after its descriptors ends a candidate.
  while (position < value.length) {
    while (/[\t\n\f\r ,]/.test(value[position] ?? "") && position < value.length) position++;
    const start = position;
    while (position < value.length && !/[\t\n\f\r ]/.test(value[position])) position++;
    let url = value.slice(start, position);
    if (!url) break;

    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const descriptorStart = position;
      let parentheses = 0;
      while (position < value.length) {
        const character = value[position];
        if (character === "," && parentheses === 0) break;
        if (character === "(") parentheses++;
        if (character === ")") parentheses = Math.max(0, parentheses - 1);
        position++;
      }
      descriptors = value.slice(descriptorStart, position).trim();
      if (value[position] === ",") position++;
    }
    if (url) candidates.push({ url, descriptors });
  }
  return candidates;
}

function serializeSrcset(candidates) {
  return candidates
    .map(({ url, descriptors }) => url + (descriptors ? ` ${descriptors}` : ""))
    .join(", ");
}

function normalizeTaskLists(fragment) {
  for (const item of fragment.querySelectorAll("li.task-list-item")) {
    const checkbox = item.querySelector(
      ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
    );
    if (!checkbox) continue;
    checkbox.classList.add("task-list-item-checkbox");
    checkbox.disabled = true;
    // The core parser puts the item text in a label and generates document-wide
    // cbx_N ids. GitHub's read-only tasks have neither linked labels nor ids.
    if (/^cbx_\d+$/.test(checkbox.id)) {
      const label = [...checkbox.parentElement.children].find(
        (child) => child.tagName === "LABEL" && child.htmlFor === checkbox.id,
      );
      if (label) label.replaceWith(...label.childNodes);
      checkbox.removeAttribute("id");
    }
    const list = item.parentElement;
    if (list?.matches("ul, ol")) {
      list.classList.remove("task-list");
      list.classList.add("contains-task-list");
    }
  }
}

function resolvePictureMedia(fragment) {
  if (!lumine.config.get("markdown-preview.useGitHubStyle")) return;
  const mode = lumine.config.get("markdown-preview.gitHubStyleMode");
  if (mode !== "light" && mode !== "dark") return;
  for (const source of fragment.querySelectorAll("picture source[media]")) {
    source.setAttribute(
      "media",
      source
        .getAttribute("media")
        .replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_clause, scheme) =>
          scheme.toLowerCase() === mode ? "(width >= 0px)" : "(width < 0px)",
        ),
    );
  }
}

function getDefaultLanguageForGrammar(grammar) {
  return grammar?.scopeName === "source.litcoffee" ? "coffee" : "text";
}

function annotatePreElements(fragment, defaultLanguage) {
  for (let preElement of fragment.querySelectorAll("pre")) {
    const codeBlock = preElement.firstElementChild ?? preElement;
    const fenceName = fenceNameForCodeBlock(codeBlock, defaultLanguage);
    preElement.classList.add("editor-colors", `lang-${fenceName}`);
  }
}

function fenceNameForCodeBlock(codeBlock, defaultLanguage) {
  const names = (codeBlock.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  const language = names.find((name) => name.startsWith("language-"));
  return language ? language.slice("language-".length) : (names[0] ?? defaultLanguage);
}

function reassignEditorToLanguage(editor, languageScope) {
  // When we successfully reassign the language on an editor, its
  // `data-grammar` attribute updates on its own.
  let result = lumine.grammars.assignLanguageMode(editor, languageScope);
  if (result) return true;

  // When we fail to assign the language on an editor — maybe its package is
  // deactivated — it won't reset itself to the default grammar, so we have to
  // do it ourselves.
  result = lumine.grammars.assignLanguageMode(editor, "text.plain");
  if (result) return true;

  return lumine.grammars.assignLanguageMode(editor, null);
}

// After render, create an `lumine-text-editor` for each `pre` element so that we
// enjoy syntax highlighting.
function highlightCodeBlocks(element, grammar, cache, cacheSession, editorCallback) {
  let defaultLanguage = getDefaultLanguageForGrammar(grammar);

  const promises = [];

  for (const preElement of element.querySelectorAll("pre")) {
    const codeBlock = preElement.firstElementChild ?? preElement;
    const fenceName = fenceNameForCodeBlock(codeBlock, defaultLanguage);
    let editorText = codeBlock.textContent.replace(/\r?\n$/, "");

    // If this PRE element was present in the last render, then we should
    // already have a cached text editor available for use.
    let editor = cache?.getEditor(preElement, cacheSession) ?? null;
    let editorElement;
    if (!editor) {
      editor = lumine.workspace.buildTextEditor({
        keyboardInputEnabled: false,
        softWrapped: false,
        showInvisibles: false,
      });
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
              // The screen renderer expands a tab to spaces. Keep the authored
              // character in exported HTML and let CSS provide its tab stop.
              for (const tab of line2.querySelectorAll(".hard-tab")) tab.textContent = "\t";
              replacement.appendChild(line2);
            }
            // Build the replacement off-DOM first. A failed or cancelled
            // component update must leave the original code element intact.
            preElement.style.tabSize = String(editor.getTabLength());
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
    const settled = await editor.whenGrammarSettled({ signal: controller.signal });
    if (!controller.signal.aborted && !editor.isDestroyed()) {
      // The editor factory reapplies scoped settings when a grammar changes.
      // Set the preview's presentation after that work, including cached code
      // editors whose GitHub style was toggled since the preceding render.
      const tabLength = lumine.config.get("markdown-preview.useGitHubStyle")
        ? 8
        : lumine.config.get("editor.tabLength", { scope: editor.getRootScopeDescriptor() });
      void editor.update({ softWrapped: false, showInvisibles: false, tabLength }).catch(() => {
        // The render/export callback owns its update completion and fallback.
      });
    }
    return settled;
  } catch {
    // A preview is still useful without highlighted code blocks. Loading and
    // parser failures must not strand an export or a live render.
    return false;
  } finally {
    destroySubscription.dispose();
    signal?.removeEventListener?.("abort", abort);
  }
}
