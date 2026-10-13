describe("Markdown Preview application menu context", () => {
  let main;

  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("markdown-preview")).mainModule;
    spyOn(lumine.notifications, "addWarning");
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("markdown-preview");
  });

  it("explains why a non-editor pane item has no Markdown preview", () => {
    spyOn(main, "commandContext").and.returnValue({ item: {}, editor: null });
    lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");
    expect(lumine.notifications.addWarning).toHaveBeenCalledOnceWith(
      "Activate a Markdown source file before opening its preview.",
    );
  });

  it("stays quiet when there is no active pane item", () => {
    spyOn(main, "commandContext").and.returnValue({ item: null, editor: null });
    lumine.commands.dispatch(lumine.workspace.getElement(), "markdown-preview:toggle");
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });
});
