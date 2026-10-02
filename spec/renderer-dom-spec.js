describe("Markdown renderer sanitized DOM", () => {
  let renderer;

  beforeEach(async () => {
    await lumine.packages.activatePackage("markdown-preview");
    // Package teardown replaces these modules between specs.
    renderer = require("../lib/renderer");
    lumine.config.set("markdown-preview.useOriginalParser", true);
    lumine.config.set("markdown-preview.allowUnsafeProtocols", false);
  });

  async function render(markdown) {
    const cache = new renderer.EditorCache();
    try {
      const [fragment] = await renderer.toDOMFragment(markdown, undefined, undefined, cache);
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
});
