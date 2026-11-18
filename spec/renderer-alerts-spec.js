describe("Markdown renderer GitHub alerts", () => {
  let renderer;

  async function render(markdown) {
    const cache = new renderer.EditorCache();
    try {
      const [fragment] = await renderer.toDOMFragment(markdown, undefined, undefined, cache);
      return fragment;
    } finally {
      cache.destroy();
    }
  }

  const alertTypes = [
    ["NOTE", "Note"],
    ["TIP", "Tip"],
    ["IMPORTANT", "Important"],
    ["WARNING", "Warning"],
    ["CAUTION", "Caution"],
    ["nOtE", "Note"],
  ];

  for (const useOriginalParser of [true, false]) {
    describe(useOriginalParser ? "with marked" : "with markdown-it", () => {
      beforeEach(async () => {
        await lumine.packages.activatePackage("markdown-preview");
        renderer = require("../lib/renderer");
        lumine.config.set("markdown-preview.useOriginalParser", useOriginalParser);
      });

      it("renders all five alert types and recognizes mixed-case markers", async () => {
        const markdown = alertTypes.map(([marker]) => `> [!${marker}]\n> Alert body.`).join("\n\n");
        const fragment = await render(markdown);
        const alerts = [...fragment.querySelectorAll("div.markdown-alert")];

        expect(alerts.length).toBe(alertTypes.length);
        for (const [index, [, expectedTitle]] of alertTypes.entries()) {
          const alert = alerts[index];
          const title = alert?.querySelector("p.markdown-alert-title");
          expect(
            alert?.classList.contains(`markdown-alert-${expectedTitle.toLowerCase()}`),
          ).toBeTrue();
          expect(title?.textContent.trim()).toBe(expectedTitle);
          expect(title?.querySelector("svg path")).toBeTruthy();
          expect(title?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
          expect(title?.nextElementSibling?.textContent).toBe("Alert body.");
        }
        expect(fragment.querySelector("blockquote")).toBeNull();
      });

      it("preserves rendered alert content in the preview and HTML output", async () => {
        lumine.config.set("markdown-preview.useGitHubStyle", false);
        const markdown = [
          "> [!TIP]",
          "> **Read** [the guide](https://example.com/guide).",
          ">",
          "> Another paragraph.",
          ">",
          "> - List item",
        ].join("\n");
        const preview = await render(markdown);
        const exported = document.createElement("template");
        exported.innerHTML = await renderer.toHTML(markdown);

        const alert = preview.querySelector("div.markdown-alert-tip");
        expect(alert?.querySelector("strong")?.textContent).toBe("Read");
        expect(alert?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/guide");
        expect(alert?.querySelector("p:nth-of-type(3)")?.textContent).toBe("Another paragraph.");
        expect(alert?.querySelector("ul > li")?.textContent).toBe("List item");
        expect(exported.content.querySelector("div.markdown-alert-tip")?.outerHTML).toBe(
          alert?.outerHTML,
        );
      });

      it("accepts a hard break after the marker and retains line breaks in the alert body", async () => {
        lumine.config.set("markdown-preview.breakOnSingleNewline", true);
        const fragment = await render(
          [
            "> [!NOTE]  ",
            "> First line",
            "> Second line",
            "",
            "> [!TIP]\\",
            "> Backslash break.",
          ].join("\n"),
        );

        const body = fragment.querySelector(".markdown-alert-note > .markdown-alert-title + p");
        expect(body?.innerHTML.trim()).toMatch(/^First line<br>\s*Second line$/);
        expect(
          fragment
            .querySelector(".markdown-alert-tip > .markdown-alert-title + p")
            ?.innerHTML.trim(),
        ).toBe("Backslash break.");
      });

      it("keeps ordinary quotes and literal markers unchanged", async () => {
        const markdown = [
          "> Ordinary quote.",
          "",
          "> [!UNKNOWN]",
          "> Unknown type.",
          "",
          "> Quoted introduction.",
          "> [!NOTE]",
          "",
          "> [!NOTE] Text on the marker line.",
          "",
          "> [!NOTE]",
          "",
          "> \\[!NOTE]",
          "> Escaped marker.",
          "",
          "> `[!NOTE]`",
          "",
          "```md",
          "> [!NOTE]",
          "> Fenced example.",
          "```",
        ].join("\n");
        const fragment = await render(markdown);
        const quotes = [...fragment.querySelectorAll("blockquote")];

        expect(fragment.querySelector(".markdown-alert")).toBeNull();
        expect(quotes.map((quote) => quote.textContent.trim())).toEqual([
          "Ordinary quote.",
          "[!UNKNOWN]\nUnknown type.",
          "Quoted introduction.\n[!NOTE]",
          "[!NOTE] Text on the marker line.",
          "[!NOTE]",
          "[!NOTE]\nEscaped marker.",
          "[!NOTE]",
        ]);
        expect(fragment.querySelector("blockquote code")?.textContent).toBe("[!NOTE]");
        expect(fragment.querySelector("pre code")?.textContent).toBe(
          "> [!NOTE]\n> Fenced example.\n",
        );
      });

      it("keeps alert-shaped quotes inside Markdown blockquotes and raw details as quotes", async () => {
        const fragment = await render(
          [
            "> Outer quote.",
            ">",
            "> > [!NOTE]",
            "> > Inside a quote.",
            "",
            "<details>",
            "",
            "> [!NOTE]",
            "> Inside details.",
            "",
            "</details>",
          ].join("\n"),
        );

        expect(fragment.querySelector(".markdown-alert")).toBeNull();
        expect(fragment.querySelector("blockquote > blockquote")?.textContent.trim()).toBe(
          "[!NOTE]\nInside a quote.",
        );
        expect(fragment.querySelector("details > blockquote")?.textContent.trim()).toBe(
          "[!NOTE]\nInside details.",
        );
      });
    });
  }
});
