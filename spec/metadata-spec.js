describe("Markdown preview metadata", () => {
  let editor, preview;

  beforeEach(async () => {
    jasmine.useRealClock();
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    await lumine.packages.activatePackage("markdown-preview");
    editor = await lumine.workspace.open();
    editor.setText("# Current document\n\nUnsaved content.");
    const MarkdownPreviewView = require("../lib/markdown-preview-view");
    preview = new MarkdownPreviewView({ editorId: editor.id });
  });

  afterEach(() => preview.destroy());

  it("includes current source metadata without rereading the backing file", async () => {
    const sections = await preview.getMetadata();
    const text = sections.find((section) => section.id === "markdown-source:text");
    expect(text).toBeDefined();
    expect(text.rows.find((row) => row.id === "length").value).toBe(editor.buffer.getLength());
    expect(sections[0].rows.find((row) => row.id === "source").value).toBe("Open editor");
  });

  it("invalidates source properties and disposes the observer", () => {
    const changed = jasmine.createSpy("metadata changed");
    const subscription = preview.onDidChangeMetadata(changed);
    editor.setEncoding("utf16le");
    expect(changed).toHaveBeenCalled();
    subscription.dispose();
    changed.calls.reset();
    editor.setEncoding("utf8");
    expect(changed).not.toHaveBeenCalled();
  });

  it("rejects cancelled requests and ignores results after destruction", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectAsync(preview.getMetadata({ signal: controller.signal })).toBeRejected();
    const deferred = Promise.withResolvers();
    spyOn(editor, "getMetadata").and.returnValue(deferred.promise);
    const request = preview.getMetadata();
    preview.destroy();
    deferred.resolve([]);
    await expectAsync(request).toBeResolvedTo([]);
  });
});
