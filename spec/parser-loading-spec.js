describe("Markdown parser loading", () => {
  let loader, renderer;

  beforeEach(async () => {
    await lumine.packages.activatePackage("markdown-preview");
    loader = require("../lib/parser-loader");
    renderer = require("../lib/renderer");
    lumine.config.set("markdown-preview.useOriginalParser", true);
  });

  it("shares concurrent first imports and normalizes CommonJS helpers", async () => {
    const marked = {};
    class GithubSlugger {}
    const innertext = () => "heading";
    const grayMatter = () => ({ content: "" });
    const imports = jasmine
      .createSpy("imports")
      .and.resolveTo([
        marked,
        { default: GithubSlugger },
        { default: innertext },
        { default: grayMatter },
      ]);
    const load = loader.createParserLoader(imports);
    const first = load();
    const second = load();

    expect(first).toBe(second);
    expect(imports).not.toHaveBeenCalled();
    await expectAsync(first).toBeResolvedTo({ marked, GithubSlugger, innertext, grayMatter });
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it("retries a failed import rather than retaining its rejection", async () => {
    const failure = new Error("parser unavailable");
    const imports = jasmine.createSpy("imports").and.rejectWith(failure);
    const load = loader.createParserLoader(imports);
    await expectAsync(load()).toBeRejectedWith(failure);

    imports.and.resolveTo([{}, { default: class {} }, { default: () => {} }, {}]);
    await expectAsync(load()).toBeResolved();
    expect(imports).toHaveBeenCalledTimes(2);
  });

  it("does not begin a cache session when cancelled during the import", async () => {
    let release;
    const libraries = loader.loadParser();
    spyOn(loader, "loadParser").and.returnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const cache = new renderer.EditorCache();
    spyOn(cache, "beginRender").and.callThrough();
    const controller = new AbortController();
    const pending = renderer.toDOMFragment("# Cancelled", undefined, undefined, cache, {
      signal: controller.signal,
    });
    controller.abort();
    release(await libraries);

    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(cache.beginRender).not.toHaveBeenCalled();
    cache.destroy();
  });

  it("keeps heading identifiers independent across concurrent first renders", async () => {
    const html = await Promise.all([
      renderer.toHTML("# Shared\n# Shared"),
      renderer.toHTML("# Shared"),
    ]);
    const headings = html.map((content) => {
      const element = document.createElement("div");
      element.innerHTML = content;
      return [...element.querySelectorAll("h1")].map((heading) => heading.id);
    });
    expect(headings).toEqual([
      ["user-content-shared", "user-content-shared-1"],
      ["user-content-shared"],
    ]);
  });

  it("uses the built-in parser without loading the package's parser", async () => {
    lumine.config.set("markdown-preview.useOriginalParser", false);
    spyOn(loader, "loadParser").and.callThrough();
    const html = await renderer.toHTML("# Built-in");
    expect(html).toContain("Built-in");
    expect(loader.loadParser).not.toHaveBeenCalled();
  });
});
