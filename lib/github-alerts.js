const alertMarker = /^[ \t]*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
const alertIcons = {
  note: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4m0-7v.25"/>',
  tip: '<path d="M6 11v-.5c0-1.5-2.5-2.2-2.5-5a4.5 4.5 0 0 1 9 0c0 2.8-2.5 3.5-2.5 5v.5M6 13h4m-3 2h2"/>',
  important:
    '<path d="M3 2h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8l-3 3v-3H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm5 3v2.5m0 2v.25"/>',
  warning:
    '<path d="M7.1 2.5a1 1 0 0 1 1.8 0l5.7 10a1 1 0 0 1-.9 1.5H2.3a1 1 0 0 1-.9-1.5l5.7-10ZM8 6v3m0 2.5v.25"/>',
  caution: '<path d="M5 1.5h6l3.5 3.5v6L11 14.5H5L1.5 11V5L5 1.5ZM8 4.5v4m0 2.5v.25"/>',
};

function renderGitHubAlerts(fragment) {
  // Recognize the rendered quote so escaped brackets, HTML entities and raw
  // blockquotes follow the same alert rules as Markdown blockquotes.
  for (const quote of fragment.children) {
    if (quote.tagName === "BLOCKQUOTE") renderAlert(quote);
  }
}

function renderAlert(quote) {
  const paragraph = quote.firstElementChild;
  if (paragraph?.tagName !== "P") return;
  if (quote.firstChild?.nodeType === Node.TEXT_NODE && quote.firstChild.data.trim()) return;
  const text = paragraph.firstChild;
  if (text?.nodeType !== Node.TEXT_NODE) return;
  const marker = alertMarker.exec(text.data);
  if (!marker) return;

  const following = text.nextSibling;
  const hasLineFeed = marker[0].endsWith("\n");
  const separator = !hasLineFeed && following?.nodeName === "BR" ? following : null;
  // A tag immediately after the marker is still on the same line.
  if (!hasLineFeed && !separator && following) return;
  const hasParagraphBody =
    paragraph.textContent.slice(marker[0].length).trim() !== "" ||
    paragraph.childElementCount > (separator ? 1 : 0);
  if (!hasParagraphBody && !paragraph.nextElementSibling) return;

  if (hasParagraphBody) {
    text.deleteData(0, marker[0].length);
    if (!text.data) text.remove();
    if (separator) {
      const continuation = separator.nextSibling;
      if (continuation?.nodeType === Node.TEXT_NODE && continuation.data.startsWith("\n")) {
        continuation.deleteData(0, 1);
      }
      separator.remove();
    }
  } else {
    paragraph.remove();
  }

  const document = quote.ownerDocument;
  const type = marker[1].toLowerCase();
  const alert = document.createElement("div");
  for (const { name, value } of quote.attributes) alert.setAttribute(name, value);
  alert.classList.add("markdown-alert", `markdown-alert-${type}`);
  const title = document.createElement("p");
  title.className = "markdown-alert-title";
  title.innerHTML = `<svg class="markdown-alert-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${alertIcons[type]}</svg>`;
  title.append(type[0].toUpperCase() + type.slice(1));
  alert.append(title);
  while (quote.firstChild) alert.appendChild(quote.firstChild);
  quote.replaceWith(alert);
}

module.exports = { renderGitHubAlerts };
