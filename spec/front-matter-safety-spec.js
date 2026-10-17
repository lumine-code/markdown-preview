describe("Markdown front matter safety", () => {
  let renderer;

  beforeEach(() => {
    renderer = require("../lib/renderer");
    lumine.config.set("markdown-preview.useOriginalParser", true);
    delete process.lumineAuditFrontMatter;
  });

  afterEach(() => delete process.lumineAuditFrontMatter);

  for (const language of ["js", "javascript"]) {
    it(`does not execute ${language} front matter while rendering a document`, async () => {
      const source = [
        `---${language}`,
        '(process.lumineAuditFrontMatter = true, { title: "Unexpected execution" })',
        "---",
        "# Document",
      ].join("\n");

      await expectAsync(renderer.toHTML(source)).toBeRejectedWithError(
        "JavaScript front matter is not supported",
      );
      expect(process.lumineAuditFrontMatter).toBeUndefined();
    });

    it(`keeps ${language} front matter inert with the built-in renderer`, async () => {
      lumine.config.set("markdown-preview.useOriginalParser", false);
      const source = [
        `---${language}`,
        '(process.lumineAuditFrontMatter = true, { title: "Unexpected execution" })',
        "---",
        "# Document",
      ].join("\n");

      const html = await renderer.toHTML(source);

      expect(html).toContain("Document");
      expect(process.lumineAuditFrontMatter).toBeUndefined();
    });
  }

  it("keeps YAML and JSON front matter as data", async () => {
    for (const source of [
      "---\ntitle: Safe metadata\n---\n# Document",
      '---json\n{"title":"Safe metadata"}\n---\n# Document',
    ]) {
      const html = await renderer.toHTML(source);
      expect(html).toContain("Safe metadata");
      expect(html).toContain("Document");
    }
  });
});
