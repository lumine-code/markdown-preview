describe("Markdown Preview application menu context", () => {
  let main;

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    main = (await lumine.packages.activatePackage("markdown-preview")).mainModule;
    spyOn(lumine.notifications, "addWarning");
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("markdown-preview");
  });

  it("disables document actions outside an editor or preview", () => {
    const context = spyOn(main, "commandContext").and.returnValue({ item: {}, editor: null });
    lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");
    expect(
      lumine.commands.canDispatch(lumine.workspace.getElement(), "markdown-preview:toggle"),
    ).toBe(false);
    expect(context).not.toHaveBeenCalled();
    expect(
      lumine.commands.canDispatch(
        lumine.workspace.getElement(),
        "markdown-preview:toggle-github-style",
      ),
    ).toBe(true);
  });

  it("checks the configured grammar without initializing a preview", async () => {
    const editor = await lumine.workspace.open();
    const changed = spyOn(lumine.commands, "invalidateAvailability").and.callThrough();
    lumine.config.set("markdown-preview.grammars", []);
    expect(lumine.commands.canDispatch(editor.getElement(), "markdown-preview:toggle")).toBe(false);
    lumine.config.set("markdown-preview.grammars", [editor.getGrammar().scopeName]);
    expect(lumine.commands.canDispatch(editor.getElement(), "markdown-preview:toggle")).toBe(true);
    expect(changed).toHaveBeenCalled();
    editor.destroy();
  });

  it("stays quiet when there is no active pane item", () => {
    spyOn(main, "commandContext").and.returnValue({ item: null, editor: null });
    lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });
  it("dispatches once when a preview contains an embedded editor", () => {
    const preview = document.createElement("div");
    preview.className = "markdown-preview";
    const editor = lumine.workspace.buildTextEditor();
    preview.appendChild(editor.element);
    jasmine.attachToDOM(preview);
    const toggle = spyOn(main, "toggle");
    lumine.config.set("markdown-preview.grammars", [editor.getGrammar().scopeName]);
    try {
      lumine.commands.dispatch(editor.element, "markdown-preview:toggle");
      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      editor.destroy();
      preview.remove();
    }
  });
});
