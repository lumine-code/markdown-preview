const MarkdownPreviewView = require("../lib/markdown-preview-view");

describe("Markdown export theme snapshots", () => {
  let preview;
  let host;

  beforeEach(() => {
    preview = Object.create(MarkdownPreviewView.prototype);
    preview.element = document.createElement("div");
    preview.element.className = "markdown-preview";
    host = document.createElement("div");
    host.appendChild(preview.element);
    jasmine.attachToDOM(host);
  });

  afterEach(() => host.remove());

  function trackCollectorSubscriptions() {
    const subscriptions = [];
    for (const method of [
      "observeStyleElements",
      "onDidRemoveStyleElement",
      "onDidUpdateStyleElement",
    ]) {
      const original = lumine.styles[method].bind(lumine.styles);
      spyOn(lumine.styles, method).and.callFake((...args) => {
        const subscription = original(...args);
        spyOn(subscription, "dispose").and.callThrough();
        subscriptions.push(subscription);
        return subscription;
      });
    }
    return subscriptions;
  }

  it("detaches every temporary collector and disposes its subscriptions after repeated exports", () => {
    const subscriptions = trackCollectorSubscriptions();
    const collectorCount = document.querySelectorAll("lumine-styles").length;
    const stylesheet = lumine.styles.addStyleSheet("lumine-text-editor { color: rgb(10,20,30); }", {
      context: "lumine-text-editor",
    });
    try {
      for (let i = 0; i < 3; i++) {
        expect(preview.getTextEditorStyles()).toContain(
          "lumine-text-editor { color: rgb(10,20,30); }",
        );
        expect(document.querySelectorAll("lumine-styles").length).toBe(collectorCount);
      }
      expect(subscriptions.length).toBe(9);
      for (const subscription of subscriptions)
        expect(subscription.dispose).toHaveBeenCalledTimes(1);
    } finally {
      stylesheet.dispose();
    }
  });

  it("disposes a collector even when reading its rules fails", () => {
    const subscriptions = trackCollectorSubscriptions();
    const createElement = document.createElement.bind(document);
    let collector;
    spyOn(document, "createElement").and.callFake((name, ...args) => {
      const element = createElement(name, ...args);
      if (name === "lumine-styles") {
        collector = element;
        Object.defineProperty(element, "childNodes", {
          get() {
            throw new Error("rule read failed");
          },
        });
      }
      return element;
    });
    expect(() => preview.getTextEditorStyles()).toThrowError("rule read failed");
    expect(collector.isConnected).toBe(false);
    expect(subscriptions.length).toBe(3);
    for (const subscription of subscriptions) expect(subscription.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves transitive relative colors, quoted font families, percentages and em spacing", async () => {
    jasmine.useRealClock();
    host.style.cssText =
      'font-size:20px; line-height:1.6; --export-base:rgb(10,20,30); --export-mix:color-mix(in srgb,var(--export-base) 60%,white); --export-relative:rgb(from var(--export-mix) r g b / 50%); --export-family:"Uninstalled; Family",monospace; --export-font:var(--export-family); --export-scale:125%; --export-width:40%; --export-space:1.5em;';
    const css =
      ".markdown-preview { width:400px; margin:0; padding:0; font-size:1.2em; font-family:var(--export-font); } .markdown-preview .export-probe { color:var(--export-relative); font-size:var(--export-scale); width:var(--export-width); margin-left:var(--export-space); } .markdown-preview .small-probe { font-size:14px; } .markdown-preview .rem-probe { font-size:1rem; }";
    const stylesheet = lumine.styles.addStyleSheet(css, { priority: 2 });
    preview.element.innerHTML =
      '<p class="export-probe">Exported content</p><p class="small-probe">Small text</p><p class="rem-probe">Root-scaled text</p>';
    preview.loading = false;
    preview.getHTML = async () => preview.element.innerHTML;
    spyOn(preview, "getMarkdownPreviewCSS").and.returnValue(css);
    const iframe = document.createElement("iframe");
    try {
      const exported = await preview.buildStandaloneDocument();
      expect(exported).toContain('--export-font: "Uninstalled; Family",monospace;');
      expect(exported).toContain("--export-scale: 125%;");
      await new Promise((resolve) => {
        iframe.onload = resolve;
        iframe.srcdoc = exported;
        document.body.appendChild(iframe);
      });
      const source = getComputedStyle(preview.element.querySelector(".export-probe"));
      const target = iframe.contentWindow.getComputedStyle(
        iframe.contentDocument.querySelector(".export-probe"),
      );
      for (const property of [
        "color",
        "fontFamily",
        "fontSize",
        "width",
        "marginLeft",
        "lineHeight",
      ]) {
        expect(target[property]).withContext(property).toBe(source[property]);
      }
      for (const selector of [".small-probe", ".rem-probe"]) {
        const source = getComputedStyle(preview.element.querySelector(selector));
        const target = iframe.contentWindow.getComputedStyle(
          iframe.contentDocument.querySelector(selector),
        );
        expect(target.fontSize).withContext(selector).toBe(source.fontSize);
        expect(target.lineHeight).withContext(selector).toBe(source.lineHeight);
      }
    } finally {
      iframe.remove();
      stylesheet.dispose();
    }
  });
});
