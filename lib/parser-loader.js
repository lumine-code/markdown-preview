function createParserLoader(
  importLibraries = () =>
    Promise.all([
      import("marked"),
      import("github-slugger"),
      import("innertext"),
      import("gray-matter"),
    ]),
) {
  let pending;
  return function loadParser() {
    pending ||= Promise.resolve()
      .then(importLibraries)
      .then(([marked, slugger, innertext, grayMatter]) => ({
        marked,
        GithubSlugger: slugger.default,
        innertext: innertext.default ?? innertext,
        grayMatter: grayMatter.default ?? grayMatter,
      }))
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };
}

module.exports = { createParserLoader, loadParser: createParserLoader() };
