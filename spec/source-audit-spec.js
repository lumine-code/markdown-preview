describe("Markdown source and syntax mapping audit", () => {
  let renderer, helper, languageIds, shipped;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("markdown-preview");
    renderer = require("../lib/renderer");
    helper = require("../lib/extension-helper");
    languageIds = require("../lib/linguist");
    shipped = { ...languageIds };
    lumine.config.set("markdown-preview.useOriginalParser", true);
    lumine.config.set("markdown-preview.syntaxHighlightingLanguageIdentifier", "linguist");
  });
  afterEach(async () => {
    for (const key of [
      "useOriginalParser",
      "syntaxHighlightingLanguageIdentifier",
      "customSyntaxHighlightingLanguageIdentifiers",
    ])
      lumine.config.unset("markdown-preview." + key);
    await lumine.packages.deactivatePackage("markdown-preview");
    for (const name of Object.keys(languageIds)) delete languageIds[name];
    Object.assign(languageIds, shipped);
  });
  it("restores shipped aliases and removes custom aliases when the configured override is cleared", () => {
    const shipped = helper.scopeForFenceName("js");
    lumine.config.set(
      "markdown-preview.customSyntaxHighlightingLanguageIdentifiers",
      "js:source.ruby,private-audit:source.js",
    );
    expect(helper.scopeForFenceName("js")).toBe("source.ruby");
    expect(helper.scopeForFenceName("private-audit")).toBe("source.js");
    lumine.config.set("markdown-preview.customSyntaxHighlightingLanguageIdentifiers", "");
    expect(helper.scopeForFenceName("js")).toBe(shipped);
    expect(helper.scopeForFenceName("private-audit")).toBe("source.private-audit");
  });
  it("keeps a language mapping failure literal below its notification heading", () => {
    const message = String.raw`Cannot read C:\Projects\[demo]\_mapping <unknown>`;
    const error = new Error(message);
    const originalGet = lumine.config.get.bind(lumine.config);
    spyOn(lumine.config, "get").and.callFake((key, ...args) => {
      if (key === "markdown-preview.customSyntaxHighlightingLanguageIdentifiers") throw error;
      return originalGet(key, ...args);
    });
    const notify = spyOn(lumine.notifications, "addError");
    expect(helper.scopeForFenceName("js")).toBe(shipped.js);
    expect(notify).toHaveBeenCalledOnceWith(
      "Unable to load custom syntax highlighting language identifiers",
      { detail: error.toString() },
    );
  });
  it("renders a valid null-valued YAML field without failing the complete document", async () => {
    const html = await renderer.toHTML("---\nnullable: null\n---\n# Body", __filename);
    const element = document.createElement("div");
    element.innerHTML = html;
    expect(element.querySelector("h1").textContent).toBe("Body");
    expect(element.querySelector("table")).not.toBeNull();
  });
  it("renders a valid multiple-class raw code element using its language class", async () => {
    const html = await renderer.toHTML(
      '<pre><code class="extra language-js additional">const value = 1;</code></pre>',
      __filename,
    );
    const element = document.createElement("div");
    element.innerHTML = html;
    expect(element.querySelector("pre")).not.toBeNull();
    expect(element.textContent).toContain("const value = 1;");
  });
});
