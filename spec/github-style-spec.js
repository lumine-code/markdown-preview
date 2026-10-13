const fs = require("node:fs");
const path = require("node:path");

describe("GitHub Markdown presentation", () => {
  let preview;
  let frames;
  let themeStyles;
  let MarkdownPreviewView;
  const fixturePath = path.join(__dirname, "fixtures/github-style.md");

  beforeEach(async () => {
    jasmine.useRealClock();
    preview = null;
    frames = [];
    await lumine.packages.activatePackage("markdown-preview");
    await lumine.packages.activatePackage("language-javascript");
    MarkdownPreviewView = require("../lib/markdown-preview-view");
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    lumine.config.set("markdown-preview.useGitHubStyle", true);
    lumine.config.set("editor.fontFamily", "Courier New");
    lumine.config.set("editor.fontSize", 28);
    // OneTheme applies these generic rules to the whole application document.
    themeStyles = lumine.styles.addStyleSheet(
      "p { line-height: 1.6; } code { font-weight: normal; }",
    );
  });

  afterEach(() => {
    for (const frame of frames) frame.remove();
    preview?.destroy();
    themeStyles?.dispose();
  });

  async function createPreview(mode) {
    lumine.config.set("markdown-preview.gitHubStyleMode", mode);
    preview = new MarkdownPreviewView({ filePath: fixturePath });
    jasmine.attachToDOM(preview.element);
    await preview.renderMarkdown();
    return preview.element;
  }

  async function loadFrame(html) {
    const frame = document.createElement("iframe");
    frames.push(frame);
    frame.style.cssText = "width:900px;height:600px;position:fixed;left:-10000px;";
    await new Promise((resolve) => {
      frame.onload = resolve;
      frame.srcdoc = html;
      document.body.appendChild(frame);
    });
    return frame.contentDocument;
  }

  async function createGitHubReference(mode) {
    const referenceCSS = (scheme) =>
      fs.readFileSync(
        path.join(__dirname, `fixtures/github-markdown-reference-${scheme}.css`),
        "utf8",
      );
    const css =
      mode === "auto"
        ? `@media (prefers-color-scheme: light) { ${referenceCSS("light")} }\n@media (prefers-color-scheme: dark) { ${referenceCSS("dark")} }`
        : referenceCSS(mode);
    const html = await preview.getHTML();
    const reference = await loadFrame(
      `<!doctype html><html><head><style>${css}</style></head><body><article class="markdown-body">${html}</article></body></html>`,
    );
    return reference.querySelector(".markdown-body");
  }

  function compareStyles(actual, expected, properties, context) {
    expect(actual).withContext(`${context}: live element`).not.toBeNull();
    expect(expected).withContext(`${context}: reference element`).not.toBeNull();
    if (!actual || !expected) return;
    const actualStyle = actual.ownerDocument.defaultView.getComputedStyle(actual);
    const expectedStyle = expected.ownerDocument.defaultView.getComputedStyle(expected);
    for (const property of properties) {
      expect(actualStyle.getPropertyValue(property))
        .withContext(`${context}: ${property}`)
        .toBe(expectedStyle.getPropertyValue(property));
    }
  }

  function compareMarkdownElements(actual, expected, context) {
    const typography = ["font-family", "font-size", "font-weight", "line-height", "color"];
    const spacing = ["margin-top", "margin-bottom", "padding-top", "padding-bottom"];
    compareStyles(actual, expected, [...typography, "background-color"], `${context}: document`);
    for (const selector of ["h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "dt", "dd"]) {
      compareStyles(
        actual.querySelector(selector),
        expected.querySelector(selector),
        [...typography, ...spacing],
        `${context}: ${selector}`,
      );
    }
    for (const selector of ["ul", "ul ul", "ol", "ol ol", ".task-list-item"]) {
      compareStyles(
        actual.querySelector(selector),
        expected.querySelector(selector),
        ["font-size", "line-height", ...spacing, "padding-left", "list-style-type"],
        `${context}: ${selector}`,
      );
    }
    for (const selector of ["table", "th", "td", "blockquote", "hr"]) {
      compareStyles(
        actual.querySelector(selector),
        expected.querySelector(selector),
        [
          "border-top-width",
          "border-top-style",
          "border-top-color",
          "border-left-width",
          "border-left-style",
          "border-left-color",
          "background-color",
        ],
        `${context}: ${selector}`,
      );
    }
    compareStyles(
      actual.querySelector("p code"),
      expected.querySelector("p code"),
      [
        ...typography,
        "background-color",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
        "border-top-width",
      ],
      `${context}: inline code`,
    );
    for (const selector of ["h2 code", "strong code"]) {
      compareStyles(
        actual.querySelector(selector),
        expected.querySelector(selector),
        ["font-size", "font-weight"],
        `${context}: ${selector}`,
      );
    }
    compareStyles(
      actual.querySelector("a"),
      expected.querySelector("a"),
      ["color", "text-decoration-line", "text-underline-offset"],
      `${context}: link`,
    );
    compareStyles(
      actual.querySelector("picture img"),
      expected.querySelector("picture img"),
      ["vertical-align", "display", "max-width", "box-sizing"],
      `${context}: picture image`,
    );
    compareStyles(
      actual.querySelector('.task-list-item input[type="checkbox"]'),
      expected.querySelector('.task-list-item input[type="checkbox"]'),
      [
        "position",
        "float",
        "margin-top",
        "margin-right",
        "margin-bottom",
        "margin-left",
        "vertical-align",
      ],
      `${context}: task checkbox`,
    );
  }

  it("uses GitHub styling by default without a user configuration value", () => {
    lumine.config.unset("markdown-preview.useGitHubStyle");
    expect(lumine.config.get("markdown-preview.useGitHubStyle")).toBe(true);
  });

  it("preserves the custom editor font when exporting the optional theme-based style", async () => {
    lumine.config.set("markdown-preview.useGitHubStyle", false);
    const element = await createPreview("auto");
    const code = element.querySelector("p code");
    expect(getComputedStyle(code).fontFamily).toContain("Courier New");
    const exported = await loadFrame(await preview.buildStandaloneDocument());
    compareStyles(
      code,
      exported.querySelector("p code"),
      ["font-family"],
      "theme-based inline code export",
    );
  });

  for (const mode of ["light", "dark", "auto"]) {
    it(`matches GitHub typography, colours and spacing in ${mode} mode`, async () => {
      const element = await createPreview(mode);
      const reference = await createGitHubReference(mode);
      compareMarkdownElements(element, reference, mode);
      compareStyles(
        element.querySelector("lumine-text-editor"),
        reference.querySelector("pre"),
        [
          "font-family",
          "font-size",
          "line-height",
          "background-color",
          "padding-top",
          "padding-right",
          "padding-bottom",
          "padding-left",
          "margin-top",
          "margin-bottom",
          "border-top-width",
          "border-radius",
        ],
        `${mode}: highlighted code block`,
      );
    });

    it(`retains GitHub presentation in standalone ${mode} HTML`, async () => {
      const element = await createPreview(mode);
      const exported = await loadFrame(await preview.buildStandaloneDocument());
      expect(exported.body.getAttribute("data-use-github-style")).toBe(mode);
      compareMarkdownElements(element, exported.body, `${mode} export`);
      compareStyles(
        element.querySelector("lumine-text-editor"),
        exported.querySelector("pre.editor-colors"),
        [
          "font-family",
          "font-size",
          "line-height",
          "background-color",
          "padding-top",
          "padding-right",
          "padding-bottom",
          "padding-left",
          "margin-top",
          "margin-bottom",
          "border-top-width",
          "border-radius",
        ],
        `${mode} export: highlighted code block`,
      );
    });
  }

  for (const mode of ["light", "dark"]) {
    it(`matches the GitHub ${mode} code palette in the preview and standalone HTML`, async () => {
      const element = await createPreview(mode);
      element.style.height = "500px";
      const codeBlock = element.querySelector("lumine-text-editor");
      codeBlock.scrollIntoView({ block: "center" });
      codeBlock.getModel().component.updateSync();
      const reference = await createGitHubReference(mode);
      const palette = reference.ownerDocument.createElement("div");
      palette.innerHTML =
        '<span class="pl-c">Comment</span><span class="pl-k">Keyword</span><span class="pl-c1">Constant</span><span class="pl-s">String</span><span class="pl-en">Function</span>';
      reference.appendChild(palette);
      const exported = await loadFrame(await preview.buildStandaloneDocument());
      for (const [scope, githubClass] of [
        [".syntax--comment", ".pl-c"],
        [".syntax--storage, .syntax--keyword", ".pl-k"],
        [".syntax--constant.syntax--numeric", ".pl-c1"],
        [".syntax--string", ".pl-s"],
        [".syntax--entity.syntax--name.syntax--function", ".pl-en"],
      ]) {
        const expected = palette.querySelector(githubClass);
        compareStyles(
          codeBlock.querySelector(scope),
          expected,
          ["color"],
          `${mode} code palette: ${scope}`,
        );
        compareStyles(
          exported.querySelector("pre.editor-colors").querySelector(scope),
          expected,
          ["color"],
          `${mode} exported code palette: ${scope}`,
        );
      }
    });
  }
});
