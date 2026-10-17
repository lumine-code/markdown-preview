const path = require("node:path");

describe("Markdown syntax palette ownership", () => {
  it("keeps document colors independent of UI theme names", () => {
    const sheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "../styles/markdown-preview-default.css"),
    );
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="markdown-preview"><h1>Heading</h1><blockquote>Quote</blockquote><code>Code</code></div>';
    jasmine.attachToDOM(host);
    try {
      for (const [foreground, background] of [
        ["rgb(230,230,230)", "rgb(20,20,20)"],
        ["rgb(20,20,20)", "rgb(240,240,240)"],
      ]) {
        host.style.setProperty("--syntax-text-color", foreground);
        host.style.setProperty("--syntax-background-color", background);
        const colors = () =>
          Array.from(host.firstElementChild.children, (node) => [
            getComputedStyle(node).color,
            getComputedStyle(node).backgroundColor,
          ]);
        const expected = colors();
        for (const theme of [
          "theme-one-day-ui",
          "theme-one-night-ui",
          "theme-aura-night-ui",
          "theme-vscode-night-ui",
        ]) {
          host.className = theme;
          expect(colors()).withContext(theme).toEqual(expected);
        }
        expect(getComputedStyle(host.querySelector("h1")).color).toBe(
          getComputedStyle(host.firstElementChild).color,
        );
      }
    } finally {
      host.remove();
      sheet.dispose();
    }
  });
});
