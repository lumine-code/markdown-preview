const { StringDecoder } = require("node:string_decoder");
const MAX_SOURCE_UNITS = 2 * 1024 * 1024;
const MAX_HTML_UNITS = 8 * 1024 * 1024;

function checkSource(length) {
  if (length > MAX_SOURCE_UNITS)
    throw Object.assign(
      new RangeError(
        "Markdown preview accepts at most 2 Mi UTF-16 units. Preview a smaller document or selection.",
      ),
      { code: "ERR_MARKDOWN_SOURCE_LIMIT" },
    );
}

function checkHTML(html) {
  if (html.length > MAX_HTML_UNITS)
    throw Object.assign(new RangeError("Rendered Markdown exceeds the 8 Mi UTF-16 HTML budget."), {
      code: "ERR_MARKDOWN_HTML_LIMIT",
    });
  let count = 0;
  for (let index = html.indexOf("<"); index >= 0; index = html.indexOf("<", index + 1))
    if (++count > 100000)
      throw Object.assign(
        new RangeError("Rendered Markdown exceeds the 100,000 markup-token budget."),
        { code: "ERR_MARKDOWN_HTML_LIMIT" },
      );
}

async function readFile(filePath, { signal } = {}) {
  signal?.throwIfAborted();
  const handle = await require("node:fs").promises.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (before.size > MAX_SOURCE_UNITS * 4) checkSource(Infinity);
    const decoder = new StringDecoder("utf8"),
      chunk = Buffer.alloc(65536),
      parts = [];
    let length = 0,
      bytes = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_SOURCE_UNITS * 4) checkSource(Infinity);
      const part = decoder.write(chunk.subarray(0, bytesRead));
      length += part.length;
      checkSource(length);
      parts.push(part);
    }
    const tail = decoder.end();
    checkSource(length + tail.length);
    parts.push(tail);
    signal?.throwIfAborted();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("Markdown source changed while reading; retry the preview.");
    return parts.join("");
  } finally {
    await handle.close();
  }
}

module.exports = { MAX_SOURCE_UNITS, checkSource, checkHTML, readFile };
