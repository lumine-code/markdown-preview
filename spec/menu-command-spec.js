describe("Markdown Preview application menu context", () => {
  let main;

  beforeEach(async () => {
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
    try {
      lumine.commands.dispatch(editor.element, "markdown-preview:toggle");
      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      editor.destroy();
      preview.remove();
    }
  });
});
