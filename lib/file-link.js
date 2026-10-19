const path = require("node:path");
const { fileURLToPath } = require("node:url");

module.exports = function resolveFileLink(href, documentPath) {
  if (!href || href.startsWith("#") || href.startsWith("?") || href.startsWith("//")) {
    return null;
  }

  try {
    if (/^file:/i.test(href)) {
      const url = new URL(href);
      url.search = "";
      url.hash = "";
      const filePath = fileURLToPath(url);
      return filePath.includes("\0") ? null : filePath;
    }

    const windowsPath = /^[a-z]:[\\/]/i.test(href) || href.startsWith("\\\\");
    if (windowsPath && process.platform !== "win32") return null;
    if (!windowsPath && /^[a-z][a-z\d+.-]*:/i.test(href)) return null;

    // Split suffixes before decoding so escaped # and ? remain part of a filename.
    const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    if (!pathname || pathname.includes("\0")) return null;
    if (path.isAbsolute(pathname)) return path.normalize(pathname);
    if (!documentPath) return null;
    return path.resolve(path.dirname(documentPath), pathname);
  } catch {
    // Invalid percent encoding and malformed file URLs are not navigable destinations.
    return null;
  }
};
