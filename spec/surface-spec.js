const fs = require("fs");
const os = require("os");
const path = require("path");
const MarkdownPreviewView = require("../lib/markdown-preview-view");

describe("MarkdownPreviewView window surfaces", () => {
  let directory, preview, frame;

  beforeEach(async () => {
    jasmine.useRealClock();
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-preview-surface-"));
    const filePath = path.join(directory, "preview.md");
    fs.writeFileSync(
      filePath,
      `# Heading\n\nA paragraph for selection.\n\n${"More content.\n\n".repeat(50)}`,
    );
    preview = new MarkdownPreviewView({ filePath });
    jasmine.attachToDOM(preview.element);
    await preview.renderMarkdown();
  });

  afterEach(() => {
    preview?.destroy();
    frame?.remove();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function moveTo(document, reason) {
    const context = Object.freeze({
      id: `markdown-${reason}`,
      reason,
      item: preview,
      from: null,
      to: null,
      signal: new AbortController().signal,
    });
    const participant = await preview.beginWindowSurfaceTransition(context);
    document.body.appendChild(preview.element);
    await participant.commit(context);
  }

  it("renders, selects, and scrolls in the destination document and back", async () => {
    preview.element.style.maxHeight = "10px";
    preview.element.style.overflow = "auto";
    preview.element.scrollTop = 12;
    const range = document.createRange();
    range.selectNodeContents(preview.element.querySelector("p"));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    frame = document.createElement("iframe");
    document.body.appendChild(frame);
    await moveTo(frame.contentDocument, "detach");

    expect(preview.element.ownerDocument).toBe(frame.contentDocument);
    expect(preview.element.querySelector("p").ownerDocument).toBe(frame.contentDocument);
    expect(frame.contentWindow.getSelection().toString()).toContain("paragraph");
    expect(preview.element.scrollTop).toBe(12);

    await moveTo(document, "attach");
    expect(preview.element.ownerDocument).toBe(document);
  });
});
