// Show the same real preview with GitHub styling and the active syntax palette.
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
  scenes: [
    { mode: "light", github: true },
    { mode: "dark", github: true },
    { mode: "light", github: false },
    { mode: "dark", github: false },
  ].map(({ mode, github }, index) => ({
    id: github ? mode : `syntax-${mode}`,
    file: index ? `demo-${index + 1}.png` : "demo.png",
    caption: github
      ? `Markdown source beside the preview with GitHub ${mode} styling.`
      : `Markdown source beside a preview that follows the ${mode} syntax palette.`,
    async run({ lumine, state, command }) {
      lumine.config.set("theme.mode", mode);
      await lumine.themes.whenThemesSettled();
      lumine.config.set("markdown-preview.useGitHubStyle", github);
      lumine.config.set("markdown-preview.gitHubStyleMode", mode);
      await state.preview.renderMarkdown();
      command("markdown-preview:reset-zoom", state.preview.element);
    },
    ready() {
      const view = document.querySelector(
        github
          ? `.markdown-preview[data-use-github-style="${mode}"]`
          : ".markdown-preview:not([data-use-github-style])",
      );
      return (
        view?.querySelector("h1")?.textContent === "Signal Lab" &&
        Boolean(view.querySelector("pre"))
      );
    },
  })),
};
