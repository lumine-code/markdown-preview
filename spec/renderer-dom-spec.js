const path = require("node:path");
const { pathToFileURL } = require("node:url");

describe("Markdown renderer sanitized DOM", () => {
  let renderer;

  beforeEach(async () => {
    await lumine.packages.activatePackage("markdown-preview");
    // Package teardown replaces these modules between specs.
    renderer = require("../lib/renderer");
    lumine.config.set("markdown-preview.useOriginalParser", true);
    lumine.config.set("markdown-preview.allowUnsafeProtocols", false);
  });

  async function render(markdown, filePath) {
    const cache = new renderer.EditorCache();
    try {
      const [fragment] = await renderer.toDOMFragment(markdown, filePath, undefined, cache);
      const element = document.createElement("div");
      element.appendChild(fragment);
      return element;
    } finally {
      cache.destroy();
    }
  }

  it("removes scripts, event handlers and executable links from raw HTML", async () => {
    const element = await render(
      [
        '<div onclick="alert(1)">',
        "<script>alert(1)</script>",
        '<img onload="alert(1)" onerror="alert(1)">',
        '<a href="javascript:alert(1)">Unsafe link</a>',
        '<svg><a xlink:href="javascript:alert(1)"><text>SVG link</text></a></svg>',
        '<template><img onerror="alert(1)"><script>alert(1)</script></template>',
        "</div>",
      ].join("\n"),
    );

    expect(element.querySelector("script")).toBeNull();
    expect(element.querySelector("[onclick], [onload], [onerror]")).toBeNull();
    expect(element.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(element.querySelector("svg a").getAttribute("xlink:href")).toBeNull();
    const template = element.querySelector("template");
    if (template) {
      expect(template.content.querySelector("script, [onerror]")).toBeNull();
    }
  });

  it("applies protocol changes on every render while still rejecting JavaScript", async () => {
    const markdown =
      '<a href="custom-preview://document">Custom link</a> <a href="javascript:alert(1)">Script link</a>';
    for (const allowUnsafeProtocols of [false, true, false, true]) {
      lumine.config.set("markdown-preview.allowUnsafeProtocols", allowUnsafeProtocols);
      const element = await render(markdown);
      const [customLink, scriptLink] = element.querySelectorAll("a");

      expect(customLink.getAttribute("href")).toBe(
        allowUnsafeProtocols ? "custom-preview://document" : null,
      );
      expect(scriptLink.getAttribute("href")).toBeNull();
    }
  });

  it("trims whitespace exposed by removed scripts and comments", async () => {
    const element = await render(
      "<script>discard</script> \t\u2003\ufeff<!-- discarded --><div>Kept</div><!-- discarded -->\t\u2003<script>discard</script>",
    );

    expect(element.firstChild.nodeName).toBe("DIV");
    expect(element.lastChild.nodeName).toBe("DIV");
    expect(element.innerHTML).toBe("<div>Kept</div>");
  });

  it("preserves nonbreaking spaces at the fragment boundaries", async () => {
    const element = await render("<script>discard</script>&nbsp;<div>Kept</div>&nbsp;");

    expect(element.firstChild.textContent).toBe("\u00a0");
    expect(element.lastChild.textContent).toBe("\u00a0");
    expect(element.innerHTML).toBe("&nbsp;<div>Kept</div>&nbsp;");
  });

  it("retains customized built-in content while neutralizing its registration", async () => {
    const element = await render(
      '<div><button is="untrusted-button">Button text</button><template><button is="untrusted-button">Template text</button></template></div>',
    );

    const button = element.querySelector("button");
    expect(button.textContent).toBe("Button text");
    expect(button.getAttribute("is")).toBe("");
    const templateButton = element.querySelector("template").content.querySelector("button");
    expect(templateButton.textContent).toBe("Template text");
    expect(templateButton.getAttribute("is")).toBe("");
  });

  it("preserves raw multiline surfaces and newlines exposed by removed HTML", async () => {
    const newlines = "\n".repeat(5);
    const element = await render(
      [
        "<div>",
        `<pre>${newlines}Pre text</pre>`,
        `<textarea>${newlines}Textarea text</textarea>`,
        `<template><pre>${newlines}Template text</pre></template>`,
        '<pre class="exposed"><script>discard</script>\nExposed text</pre>',
        "</div>",
      ].join("\n"),
    );

    expect(element.querySelector("pre").textContent).toBe("Pre text");
    expect(element.querySelector("textarea").textContent).toBe("\n\nTextarea text");
    expect(element.querySelector("template").content.querySelector("pre").textContent).toBe(
      "\nTemplate text",
    );
    expect(element.querySelector("pre.exposed").textContent).toBe("Exposed text");
  });

  it("renders emoji images in prose and retains literal emoji names in code", async () => {
    const element = await render(":smile:\n\n`:smile:`\n\n```text\n:smile:\n```");

    expect(element.querySelectorAll("p img.emoji").length).toBe(1);
    expect(element.querySelector("p code").textContent).toBe(":smile:");
    expect(element.querySelector("pre code").textContent).toBe(":smile:\n");
    expect(element.querySelector("pre img, code img")).toBeNull();
  });

  it("retains front matter tables and stable duplicate heading ids", async () => {
    const markdown = [
      "---",
      "title: Preview",
      "enabled: true",
      "---",
      "## Repeat",
      "",
      "## Repeat",
      "",
      "## Caf&eacute;",
    ].join("\n");

    for (let iteration = 0; iteration < 2; iteration++) {
      const element = await render(markdown);
      expect([...element.querySelectorAll("thead th")].map((node) => node.textContent)).toEqual([
        "title",
        "enabled",
      ]);
      expect([...element.querySelectorAll("tbody td")].map((node) => node.textContent)).toEqual([
        "Preview",
        "true",
      ]);
      expect([...element.querySelectorAll("h2")].map((node) => node.id)).toEqual([
        "user-content-repeat",
        "user-content-repeat-1",
        "user-content-café",
      ]);
    }
  });

  it("slugs inline heading text without inserting whitespace around HTML", async () => {
    const element = await render(
      [
        "## Hello<span>world</span>",
        "",
        "## A<br>B",
        "",
        "## Image ![Alt name](https://example.com/image.png)",
        "",
        "## <code>one</code><code>two</code>",
      ].join("\n"),
    );
    expect([...element.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-helloworld",
      "user-content-ab",
      "user-content-image-",
      "user-content-onetwo",
    ]);
  });

  it("keeps fenced code unwrapped and hides invisibles while style toggles reuse its editor", async () => {
    jasmine.useRealClock();
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    lumine.config.set("editor.tabLength", 2);
    lumine.config.set("editor.showInvisibles", true);
    lumine.config.set("editor.softWrap", true);
    lumine.config.set("editor.invisibles", { tab: "→", eol: "¬", space: "·", cr: "¤" });
    const code = "\tfirst\tsecond\n\tthird";
    const markdown = `\`\`\`text\n${code}\n\`\`\``;
    const sourceEditor = await lumine.workspace.open();
    sourceEditor.setText(markdown);
    const MarkdownPreviewView = require("../lib/markdown-preview-view");
    const preview = new MarkdownPreviewView({ editorId: sourceEditor.id });
    jasmine.attachToDOM(preview.element);
    preview.element.style.width = "100px";
    let cachedEditor;
    try {
      for (const useGitHubStyle of [true, false, true, false]) {
        lumine.config.set("markdown-preview.useGitHubStyle", useGitHubStyle);
        await preview.renderMarkdown();
        const codeElement = preview.element.querySelector("lumine-text-editor");
        const codeEditor = codeElement.getModel();
        if (cachedEditor) expect(codeEditor).toBe(cachedEditor);
        cachedEditor = codeEditor;
        expect(codeEditor.getText()).toBe(code);
        expect(codeEditor.getTabLength()).toBe(useGitHubStyle ? 8 : 2);
        expect(codeEditor.isSoftWrapped()).toBeFalse();
        expect(codeEditor.getInvisibles()).toEqual({});
        expect(codeEditor.getScreenLineCount()).toBe(2);
        codeEditor.component.updateSync();
        expect(codeElement.querySelector(".invisible-character")).toBeNull();

        const html = await renderer.toHTML(markdown);
        const exported = document.createElement("div");
        exported.innerHTML = html;
        expect(exported.querySelector(".invisible-character")).toBeNull();
        expect(exported.querySelector("pre").style.tabSize).toBe(useGitHubStyle ? "8" : "2");
        expect([...exported.querySelectorAll("pre .line")].map((line) => line.textContent)).toEqual(
          code.split("\n"),
        );
      }
    } finally {
      preview.destroy();
      sourceEditor.destroy();
    }
  });

  for (const useOriginalParser of [true, false]) {
    describe(`responsive images with ${useOriginalParser ? "marked" : "markdown-it"}`, () => {
      const filePath = path.join(__dirname, "fixtures", "subdir", "file.markdown");
      const imagePath = (name) => path.resolve(path.dirname(filePath), name);
      const imageURL = (name) => pathToFileURL(imagePath(name)).href;

      beforeEach(() => {
        lumine.config.set("markdown-preview.useOriginalParser", useOriginalParser);
      });

      it("resolves picture sources and raw image candidates beside the Markdown file", async () => {
        const element = await render(
          '<picture><source srcset="dark.png 1x, dark%20large.png 2x"><img src="light.png" srcset="small.png 480w, large.png 960w"></picture>',
          filePath,
        );
        expect(element.querySelector("source").getAttribute("srcset")).toBe(
          `${imageURL("dark.png")} 1x, ${imageURL("dark large.png")} 2x`,
        );
        expect(element.querySelector("img").getAttribute("src")).toBe(imagePath("light.png"));
        expect(element.querySelector("img").getAttribute("srcset")).toBe(
          `${imageURL("small.png")} 480w, ${imageURL("large.png")} 960w`,
        );
      });

      it("resolves a Markdown image before exposing an existing local file URL", async () => {
        const element = await render("![Existing local image](file.markdown)", filePath);
        expect(element.querySelector("img").getAttribute("src")).toBe(imagePath("file.markdown"));
      });

      it("loads GitHub blob image links as raw content without rewriting other hosts", async () => {
        const element = await render(
          [
            "![GitHub](https://github.com/lumine-code/lumine/blob/master/image.png)",
            "",
            "![Other](https://github.com.example.org/owner/repo/blob/main/image.png)",
            "",
            '<img alt="Raw" src="https://github.com/blob/blob/blob/master/image.png?raw=1#fragment">',
          ].join("\n"),
          filePath,
        );
        expect(element.querySelector('img[alt="GitHub"]').getAttribute("src")).toBe(
          "https://github.com/lumine-code/lumine/raw/master/image.png",
        );
        expect(element.querySelector('img[alt="Other"]').getAttribute("src")).toBe(
          "https://github.com.example.org/owner/repo/blob/main/image.png",
        );
        expect(element.querySelector('img[alt="Raw"]').getAttribute("src")).toBe(
          "https://github.com/blob/blob/raw/master/image.png?raw=1#fragment",
        );
      });

      it("retains data URL commas and remote URLs while localizing other candidates", async () => {
        const element = await render(
          '<img src="data:image/png;base64,AAAA" srcset="data:image/png;base64,AAAA 1x, https://example.com/image.png 2x, //cdn.example.com/image.png 3x, local.png 4x">',
          filePath,
        );
        expect(element.querySelector("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
        expect(element.querySelector("img").getAttribute("srcset")).toBe(
          `data:image/png;base64,AAAA 1x, https://example.com/image.png 2x, https://cdn.example.com/image.png 3x, ${imageURL("local.png")} 4x`,
        );
      });

      it("sanitizes every srcset candidate using the current protocol setting", async () => {
        for (const allowUnsafeProtocols of [false, true, false]) {
          lumine.config.set("markdown-preview.allowUnsafeProtocols", allowUnsafeProtocols);
          const element = await render(
            '<picture><source srcset="javascript:alert(1) 1x, file:///image.png 2x, preview-image://custom 3x, C:/images/example.png 4x, safe.png 5x"><img src="https://example.com/image.png"></picture>',
            filePath,
          );
          expect(element.querySelector("source").getAttribute("srcset")).toBe(
            (allowUnsafeProtocols
              ? "file:///image.png 2x, preview-image://custom 3x, file:///C:/images/example.png 4x, "
              : "") + `${imageURL("safe.png")} 5x`,
          );
        }
      });

      it("keeps authored relative paths when previewing an unsaved document", async () => {
        const element = await render(
          '<picture><source srcset="dark.png 1x"><img src="light.png"></picture>',
        );
        expect(element.querySelector("img").getAttribute("src")).toBe("light.png");
        expect(element.querySelector("source").getAttribute("srcset")).toBe("dark.png 1x");
      });

      it("selects picture sources using the forced GitHub theme and preserves media conditions", async () => {
        const markdown =
          '<picture><source media="screen and (PREFERS-COLOR-SCHEME: DARK)" srcset="dark.png"><source media="(prefers-color-scheme: light) and (min-width: 1px)" srcset="light.png"><img src="fallback.png"></picture>';
        lumine.config.set("markdown-preview.useGitHubStyle", true);
        for (const mode of ["light", "dark"]) {
          lumine.config.set("markdown-preview.gitHubStyleMode", mode);
          const element = await render(markdown, filePath);
          const [dark, light] = element.querySelectorAll("source");
          expect(dark.media).toBe(
            `screen and ${mode === "dark" ? "(width >= 0px)" : "(width < 0px)"}`,
          );
          expect(light.media).toBe(
            `${mode === "light" ? "(width >= 0px)" : "(width < 0px)"} and (min-width: 1px)`,
          );
          expect(window.matchMedia(dark.media).matches).toBe(mode === "dark");
          expect(window.matchMedia(light.media).matches).toBe(mode === "light");
        }
        for (const useGitHubStyle of [true, false]) {
          lumine.config.set("markdown-preview.useGitHubStyle", useGitHubStyle);
          lumine.config.set("markdown-preview.gitHubStyleMode", useGitHubStyle ? "auto" : "dark");
          const element = await render(markdown, filePath);
          expect(element.querySelector("source").media).toBe(
            "screen and (PREFERS-COLOR-SCHEME: DARK)",
          );
        }
      });

      it("normalizes tight, loose and nested task lists to GitHub's read-only structure", async () => {
        const element = await render(
          "- [ ] First\n  - [x] Nested\n\n- [x] Second\n\n  More text\n\n- Ordinary",
        );
        const tasks = [...element.querySelectorAll("li.task-list-item")];
        expect(tasks.length).toBe(3);
        expect(element.querySelectorAll("ul.contains-task-list").length).toBe(2);
        expect(element.querySelector("label")).toBeNull();
        expect(element.querySelector("[id^=cbx_]")).toBeNull();
        expect([...element.querySelectorAll("input")].map((checkbox) => checkbox.checked)).toEqual([
          false,
          true,
          true,
        ]);
        for (const task of tasks) {
          const checkbox = task.querySelector("input");
          expect(checkbox.disabled).toBeTrue();
          expect(checkbox.classList.contains("task-list-item-checkbox")).toBeTrue();
        }
        expect(element.textContent).toContain("More text");
        expect(element.textContent).toContain("Ordinary");
      });
    });
  }
});
