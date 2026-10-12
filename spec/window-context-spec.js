describe("Markdown preview window presentation", () => {
  let main;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    await lumine.packages.activatePackage("language-gfm");
    main = (await lumine.packages.activatePackage("markdown-preview")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("markdown-preview");
    await lumine.workspace.discardEditorWindows();
  });
  it("keeps preview styles, selection, scrolling and commands with their window", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.gfm"));
    editor.setText("# First\n" + "A paragraph.\n\n".repeat(80));
    const preview = main.createMarkdownPreviewView({ editorId: editor.id });
    await workspace.open(preview);
    await preview.renderMarkdown();
    const extra = await workspace.detachItem(preview);
    const document = extra.getDocument();
    expect(main.stylesByWindow.get(extra)).not.toBe(main.style);
    expect(document.adoptedStyleSheets).toContain(main.stylesByWindow.get(extra));
    expect(preview.presentationDocument).toBe(document);
    preview.element.style.maxHeight = "100px";
    preview.element.scrollTop = 120;
    const scrollTop = preview.element.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    await extra.focus();
    preview.element.focus();
    preview.selectAll();
    expect(document.defaultView.getSelection().toString()).toContain("First");
    document.dispatchEvent(new document.defaultView.Event("selectionchange"));
    expect(preview.element.classList.contains("has-selection")).toBe(true);
    expect(preview.serialize().scrollTop).toBe(scrollTop);
    const dialog = spyOn(extra, "showSaveDialog").and.resolveTo({ canceled: true });
    await lumine.commands.dispatch(preview.element, "markdown-preview:export-to-pdf");
    expect(dialog).toHaveBeenCalled();
    await workspace.attachWindow(extra);
    expect(preview.presentationDocument).toBe(workspace.getMainWindow().getDocument());
    expect(preview.element.scrollTop).toBe(scrollTop);
    expect(main.stylesByWindow.has(extra)).toBe(false);
  });
});
