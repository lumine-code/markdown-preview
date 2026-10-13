// Regenerate both the standalone assets and the stylesheet loaded by the package.
const fs = require("fs/promises");
const path = require("path");
const prettier = require("prettier");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const VERSION = require("github-markdown-css/package.json").version;

// github-markdown-css leaves these Primer variables unresolved. Values come from
// GitHub's light-5dbcec9494a4b72a.css and dark-3e377256317f2e0c.css theme assets.
const PRIMER_COLORS = {
  light: {
    "--borderColor-accent-emphasis": "#0969da",
    "--borderColor-muted": "#d1d9e0b3",
    "--fgColor-danger": "#d1242f",
    "--bgColor-danger-muted": "#ffebe9",
  },
  dark: {
    "--borderColor-accent-emphasis": "#1f6feb",
    "--borderColor-muted": "#3d444db3",
    "--fgColor-danger": "#f85149",
    "--bgColor-danger-muted": "#f851491a",
  },
};

function resolveRemLengths(css) {
  // GitHub's document root is 16px; Lumine's root follows its UI font setting.
  // Resolve upstream rem lengths here without changing the rest of the app.
  // Quoted strings, comments and URLs are kept intact.
  return css.replace(
    /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\((?:\\[\s\S]|[^)\\])*\)|(?<![\w-])(-?(?:\d*\.)?\d+)rem\b/gi,
    (match, number) => (number == null ? match : `${Number(number) * 16}px`),
  );
}

function propertiesForSelector(css, selector) {
  const declarations = {};
  for (const [, selectors, block] of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    if (!selectors.split(",").some((candidate) => candidate.trim() === selector)) continue;
    for (const [, property, value] of block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      declarations[property] = value.trim();
    }
  }
  return declarations;
}

function scopeTheme(css, mode, theme, pre) {
  const selector = `.markdown-preview[data-use-github-style="${mode}"]`;
  const variables = {
    ...PRIMER_COLORS[theme],
    "--markdown-preview-code-fg": pre.color,
    "--markdown-preview-code-bg": pre["background-color"],
  };
  // Keep Lumine's grammar scopes, with GitHub's palette for their shared token
  // categories. The same scopes are preserved on the exported pre elements.
  const tokenAliases = [
    [".pl-c", [".syntax--comment"]],
    [".pl-k", [".syntax--keyword", ".syntax--storage"]],
    [".pl-s", [".syntax--string"]],
    [".pl-c1", [".syntax--constant", ".syntax--support"]],
    [
      ".pl-en",
      [
        ".syntax--entity.syntax--name.syntax--function",
        ".syntax--entity.syntax--name.syntax--type",
        ".syntax--entity.syntax--name.syntax--class",
      ],
    ],
    [".pl-smi", [".syntax--variable"]],
    [".pl-v", [".syntax--variable.syntax--language"]],
  ];
  const tokenCSS = tokenAliases
    .map(([githubToken, scopes]) => {
      const color = propertiesForSelector(css, `.markdown-body ${githubToken}`).color;
      if (!color) throw new Error(`Missing GitHub token color for ${githubToken}`);
      return (
        scopes
          .map((scope) => `${selector} :is(lumine-text-editor, pre.editor-colors) ${scope}`)
          .join(",\n") + ` {\n  color: ${color};\n}\n`
      );
    })
    .join("\n");
  return (
    css.replace(/\.markdown-body\b/g, selector) +
    `\n${selector} {\n` +
    Object.entries(variables)
      .map(([name, value]) => `  ${name}: ${value};`)
      .join("\n") +
    `\n}\n\n${tokenCSS}`
  );
}

async function run() {
  const [lightSource, darkSource, formatOptions] = await Promise.all([
    fs.readFile(require.resolve("github-markdown-css/github-markdown-light.css"), "utf8"),
    fs.readFile(require.resolve("github-markdown-css/github-markdown-dark.css"), "utf8"),
    prettier.resolveConfig(path.join(ROOT, "package.json")),
  ]);
  const light = resolveRemLengths(lightSource);
  const dark = resolveRemLengths(darkSource);
  const lightPre = propertiesForSelector(light, ".markdown-body pre");
  const darkPre = propertiesForSelector(dark, ".markdown-body pre");
  const editorProperties = ["padding", "font-family", "font-size", "line-height", "border-radius"];
  for (const property of editorProperties) {
    if (!lightPre[property] || lightPre[property] !== darkPre[property]) {
      throw new Error(`Expected matching GitHub code-block ${property} in both themes`);
    }
  }

  const lightCSS = scopeTheme(light, "light", "light", lightPre);
  const darkCSS = scopeTheme(dark, "dark", "dark", darkPre);
  const autoCSS =
    `@media (prefers-color-scheme: light) {\n${scopeTheme(light, "auto", "light", lightPre)}\n}\n` +
    `@media (prefers-color-scheme: dark) {\n${scopeTheme(dark, "auto", "dark", darkPre)}\n}\n`;

  const integrationCSS = `
/* Runtime integration: keep application UI rules out of Markdown content and
   give the read-only editor the same box and typography as GitHub's pre. */
.markdown-preview[data-use-github-style] {
  padding: 32px;
  overflow: auto;

  p {
    line-height: inherit;
  }

  blockquote {
    font-size: inherit;
  }

  dt,
  dd {
    line-height: inherit;
  }

  code,
  tt {
    color: inherit;
    font-weight: inherit;
    border: 0;
  }

  pre {
    border: 0;
    word-break: normal;
  }

  lumine-text-editor {
${editorProperties.map((property) => `    ${property}: ${lightPre[property]};`).join("\n")}
    margin: 0 0 16px;
    border: 0;
    overflow: auto;
    color: var(--markdown-preview-code-fg);
    background-color: var(--markdown-preview-code-bg);
  }
}
`;

  const header = `/* Generated from github-markdown-css ${VERSION}.
   Run npm run generate-github-markdown-css to update the assets and this file.
   Upstream rem lengths use GitHub's 16px document root. */\n\n`;
  const outputs = [
    [path.join(ASSETS, "github-markdown-auto.css"), autoCSS],
    [path.join(ASSETS, "github-markdown-light.css"), lightCSS],
    [path.join(ASSETS, "github-markdown-dark.css"), darkCSS],
    // Keep independent, pristine references available to the bundled specs,
    // where the generator's development dependency is not installed.
    [path.join(ROOT, "spec", "fixtures", "github-markdown-reference-light.css"), lightSource],
    [path.join(ROOT, "spec", "fixtures", "github-markdown-reference-dark.css"), darkSource],
    [
      path.join(ROOT, "styles", "markdown-preview-github.css"),
      header + autoCSS + lightCSS + darkCSS + integrationCSS,
    ],
  ];

  for (const [filePath, css] of outputs) {
    const formatted = await prettier.format(css, {
      ...formatOptions,
      filepath: filePath,
      endOfLine: "lf",
    });
    await fs.writeFile(filePath, formatted);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
