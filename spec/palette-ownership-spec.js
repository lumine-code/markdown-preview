const path = require("node:path");

describe("Markdown syntax palette ownership", () => {
  function rgba(color) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }

  it("keeps document colors independent of UI theme names", () => {
    const sheet = lumine.themes.requireStylesheet(
      path.join(__dirname, "../styles/markdown-preview-default.css"),
    );
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="markdown-preview"><h1>Heading</h1><blockquote>Quote</blockquote><code>Code</code><lumine-text-editor>Block</lumine-text-editor></div>';
    jasmine.attachToDOM(host);
    try {
      for (const [foreground, background, heading, code, block] of [
        ["rgb(230,230,230)", "rgb(20,20,20)", 255, 40, 30],
        ["rgb(20,20,20)", "rgb(240,240,240)", 0, 225, 230],
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
        expect(rgba(getComputedStyle(host.querySelector("h1")).color)).toEqual([
          heading,
          heading,
          heading,
          255,
        ]);
        for (const [selector, value] of [
          ["code", code],
          ["lumine-text-editor", block],
        ]) {
          const channels = rgba(getComputedStyle(host.querySelector(selector)).backgroundColor);
          for (const channel of channels.slice(0, 3))
            expect(Math.abs(channel - value)).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      host.remove();
      sheet.dispose();
    }
  });
});
