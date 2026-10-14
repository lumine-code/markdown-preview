// The same real preview is rendered with each of its GitHub colour modes.
module.exports = {
  version: 1,
  dependencies: ["language-gfm", "language-python"],
  viewport: { width: 1200, height: 860 },
  async prepare({ lumine, open, state }) {
    lumine.config.set("markdown-preview.useGitHubStyle", true);
    lumine.config.set("markdown-preview.openPreviewInSplitPane", true);
    const editor = await open("README.md");
    await lumine.packages
      .getActivePackage("markdown-preview")
      .mainModule.addPreviewForEditor(editor);
    state.preview = lumine.workspace
      .getPaneItems()
      .find((item) => item.getURI?.()?.startsWith("markdown-preview://"));
    if (!state.preview) throw new Error("Markdown preview did not open");
  },
  scenes: ["light", "dark"].map((mode, index) => ({
    id: mode,
    file: index ? "demo-2.png" : "demo.png",
    caption: `Markdown source beside the preview with GitHub ${mode} styling.`,
    async run({ lumine, state, command }) {
      lumine.config.set("theme.mode", mode);
      await lumine.themes.switchThemes();
      lumine.config.set("markdown-preview.gitHubStyleMode", mode);
      await state.preview.renderMarkdown();
      command("markdown-preview:reset-zoom", state.preview.element);
    },
    ready() {
      const view = document.querySelector(`.markdown-preview[data-use-github-style="${mode}"]`);
      return (
        view?.querySelector("h1")?.textContent === "Signal Lab" &&
        Boolean(view.querySelector("pre"))
      );
    },
  })),
};
