const inlinePunctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const safeSchemes = new Set(["http:", "https:", "mailto:"]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderMarkdown(value) {
  const lines = String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  return renderBlocks(lines);
}

function renderBlocks(lines, depth = 0) {
  if (depth > 12) return `<p>${escapeHtml(lines.join(" "))}</p>`;
  const output = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }

    const fence = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
    if (fence) {
      const marker = fence[1];
      const language = (fence[2] || "").replace(/[^\w+-]/g, "");
      const code = [];
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        code.push(lines[index++]);
      }
      if (index < lines.length) index++;
      output.push(`<pre><code${language ? ` class="language-${language}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = lines[index].match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (/^ {0,3}(?:[-*_]\s*){3,}$/.test(lines[index])) {
      output.push("<hr>");
      index++;
      continue;
    }

    if (/^ {0,3}>/.test(lines[index])) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quote.push(lines[index++].replace(/^ {0,3}> ?/, ""));
      }
      output.push(`<blockquote>${renderBlocks(quote, depth + 1)}</blockquote>`);
      continue;
    }

    const listStart = listMarker(lines[index]);
    if (listStart) {
      const list = renderList(lines, index, depth);
      output.push(list.html);
      index = list.end;
      continue;
    }

    if (index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = tableCells(lines[index]);
      const alignments = tableCells(lines[index + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""
      );
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|")) rows.push(tableCells(lines[index++]));
      const renderCells = (cells, tag) => `<tr>${headers.map((_, cellIndex) => {
        const alignment = alignments[cellIndex];
        const style = alignment ? ` style="text-align:${alignment}"` : "";
        return `<${tag}${style}>${renderInline(cells[cellIndex] || "")}</${tag}>`;
      }).join("")}</tr>`;
      output.push(`<div class="markdown-table-wrap"><table><thead>${renderCells(headers, "th")}</thead><tbody>${rows.map((row) => renderCells(row, "td")).join("")}</tbody></table></div>`);
      continue;
    }

    const paragraph = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    output.push(`<p>${paragraph.map((line, lineIndex) => {
      const hardBreak = /(?: {2,}|\\)$/.test(line) && lineIndex < paragraph.length - 1;
      const clean = hardBreak ? line.replace(/(?: {2,}|\\)$/, "") : line;
      return `${renderInline(clean.trim())}${lineIndex < paragraph.length - 1 ? (hardBreak ? "<br>" : " ") : ""}`;
    }).join("")}</p>`);
  }

  return output.join("");
}

function startsBlock(lines, index) {
  return /^ {0,3}(?:`{3,}|~{3,}|#{1,6}\s|>|(?:[-*_]\s*){3,})/.test(lines[index]) ||
    Boolean(listMarker(lines[index])) || (index + 1 < lines.length && isTableDivider(lines[index + 1]));
}

function listMarker(line) {
  const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  if (!match) return null;
  return { indent: match[1].length, ordered: /^\d/.test(match[2]), text: match[3] };
}

function renderList(lines, start, depth) {
  const first = listMarker(lines[start]);
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let index = start;

  while (index < lines.length) {
    const match = lines[index].match(/^(\s*)([-+*]|\d+[.)])([ \t]+)(.*)$/);
    const marker = listMarker(lines[index]);
    if (!match || !marker || marker.indent !== baseIndent || marker.ordered !== ordered) break;

    const contentIndent = match[1].length + match[2].length + match[3].length;
    const itemLines = [match[4]];
    index++;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        const nextMarker = next < lines.length ? listMarker(lines[next]) : null;
        if (nextMarker?.indent === baseIndent && nextMarker.ordered === ordered) {
          index = next;
          break;
        }
        if (nextMarker && nextMarker.indent > baseIndent) {
          itemLines.push("");
          index++;
          continue;
        }
        if (next < lines.length && /^\s+/.test(lines[next])) {
          itemLines.push("");
          index++;
          continue;
        }
        break;
      }

      const childMarker = listMarker(line);
      if (childMarker) {
        if (childMarker.indent <= baseIndent) break;
        itemLines.push(line.slice(Math.min(contentIndent, childMarker.indent)));
        index++;
        continue;
      }

      const indentation = line.match(/^\s*/)[0].length;
      if (indentation >= contentIndent) {
        itemLines.push(line.slice(contentIndent));
        index++;
        continue;
      }
      // Markdown allows an unindented continuation of a list paragraph when
      // no blank line separates it from the list item.
      if (!startsBlock(lines, index)) {
        itemLines.push(line);
        index++;
        continue;
      }
      break;
    }

    while (itemLines.length && !itemLines.at(-1).trim()) itemLines.pop();
    const task = itemLines.length === 1 && itemLines[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1].toLowerCase() === "x" ? " checked" : "";
      items.push(`<li class="task-list-item"><input type="checkbox" disabled${checked}> ${renderInline(task[2])}</li>`);
    } else if (itemLines.length === 1 && !startsBlock(itemLines, 0)) {
      items.push(`<li>${renderInline(itemLines[0])}</li>`);
    } else {
      let content = renderBlocks(itemLines, depth + 1);
      if (!itemLines.some((line) => !line.trim())) content = content.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
      items.push(`<li>${content}</li>`);
    }
  }

  return { html: `<${tag}>${items.join("")}</${tag}>`, end: index };
}

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableDivider(line) {
  if (!line.includes("|")) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function findClosing(text, delimiter, start) {
  let index = start;
  while ((index = text.indexOf(delimiter, index)) !== -1) {
    if (isEscaped(text, index)) { index += delimiter.length; continue; }
    const before = text[index - 1] || "";
    const after = text[index + delimiter.length] || "";
    // A closing marker needs text immediately before it; whitespace after it
    // (as in "*Published* to GitHub") is perfectly valid Markdown.
    if (!before || /\s/.test(before)) { index += delimiter.length; continue; }
    if ((delimiter === "_" || delimiter === "__") && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) {
      index += delimiter.length;
      continue;
    }
    return index;
  }
  return -1;
}

function bracketEnd(text, start, open, close) {
  let nesting = 0;
  for (let index = start + 1; index < text.length; index++) {
    if (isEscaped(text, index)) continue;
    if (text[index] === open) nesting++;
    else if (text[index] === close) {
      if (nesting === 0) return index;
      nesting--;
    }
  }
  return -1;
}

function linkAt(text, start) {
  const labelStart = text[start] === "!" ? start + 1 : start;
  if (text[labelStart] !== "[") return null;
  const labelEnd = bracketEnd(text, labelStart, "[", "]");
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
  const destinationStart = labelEnd + 2;
  let nesting = 1;
  let destinationEnd = destinationStart;
  for (; destinationEnd < text.length; destinationEnd++) {
    if (isEscaped(text, destinationEnd)) continue;
    if (text[destinationEnd] === "(") nesting++;
    else if (text[destinationEnd] === ")" && --nesting === 0) break;
  }
  if (destinationEnd >= text.length) return null;
  let raw = text.slice(destinationStart, destinationEnd).trim();
  let title = "";
  if (raw.startsWith("<")) {
    const end = raw.indexOf(">");
    if (end >= 0) {
      const rest = raw.slice(end + 1).trim();
      raw = raw.slice(1, end);
      title = parseTitle(rest);
    }
  } else {
    const titleMatch = raw.match(/\s+("[^"]*"|'[^']*'|\([^)]*\))\s*$/);
    if (titleMatch) {
      title = titleMatch[1].slice(1, -1);
      raw = raw.slice(0, titleMatch.index).trim();
    }
  }
  raw = raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
  return {
    label: text.slice(labelStart + 1, labelEnd),
    destination: raw,
    title,
    image: labelStart !== start,
    end: destinationEnd + 1
  };
}

function parseTitle(value) {
  const match = value.match(/^(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function safeHref(destination) {
  const href = String(destination || "").trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^#[\w.-]+$/.test(href) || /^\/(?!\/)/.test(href) || /^\.\.?\//.test(href)) return href;
  try {
    const url = new URL(href);
    return safeSchemes.has(url.protocol) ? url.href : null;
  } catch {
    if (/^www\.[^\s/]+/i.test(href)) return `https://${href}`;
    return null;
  }
}

function renderInline(value, depth = 0) {
  const text = String(value ?? "");
  if (depth > 12) return escapeHtml(text);
  let output = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\" && index + 1 < text.length && inlinePunctuation.test(text[index + 1])) {
      output += escapeHtml(text[index + 1]);
      index += 2;
      continue;
    }

    if (text[index] === "`") {
      let ticks = 1;
      while (text[index + ticks] === "`") ticks++;
      const marker = "`".repeat(ticks);
      const end = text.indexOf(marker, index + ticks);
      if (end >= 0) {
        let code = text.slice(index + ticks, end).replaceAll("\n", " ");
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        output += `<code>${escapeHtml(code)}</code>`;
        index = end + ticks;
        continue;
      }
    }

    const image = text[index] === "!" && text[index + 1] === "[";
    const link = (text[index] === "[" || image) ? linkAt(text, index) : null;
    if (link) {
      const href = safeHref(link.destination);
      if (!href) {
        output += renderInline(link.label, depth + 1);
      } else {
        const title = link.title ? ` title="${escapeHtml(link.title)}"` : "";
        const label = renderInline(link.label, depth + 1);
        output += link.image
          ? `<a class="markdown-image-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${title}>Image: ${label}</a>`
          : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${title}>${label}</a>`;
      }
      index = link.end;
      continue;
    }

    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      if (end > index) {
        const candidate = text.slice(index + 1, end);
        const email = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(candidate);
        const href = safeHref(email ? `mailto:${candidate}` : candidate);
        if (href) {
          output += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>`;
          index = end + 1;
          continue;
        }
      }
    }

    const urlMatch = text.slice(index).match(/^(?:https?:\/\/|www\.)[^\s<>]+/i);
    if (urlMatch) {
      let raw = urlMatch[0];
      let trailing = "";
      while (/[.,!?;:]$/.test(raw)) { trailing = raw.at(-1) + trailing; raw = raw.slice(0, -1); }
      while (raw.endsWith(")") && (raw.match(/\(/g) || []).length < (raw.match(/\)/g) || []).length) {
        trailing = ")" + trailing;
        raw = raw.slice(0, -1);
      }
      const href = safeHref(raw.startsWith("www.") ? `https://${raw}` : raw);
      if (href) {
        output += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>${escapeHtml(trailing)}`;
        index += urlMatch[0].length;
        continue;
      }
    }

    const delimiter = ["**", "__", "~~", "*", "_"].find((candidate) => text.startsWith(candidate, index));
    if (delimiter && !/\s/.test(text[index + delimiter.length] || " ")) {
      const end = findClosing(text, delimiter, index + delimiter.length);
      if (end > index + delimiter.length) {
        const tag = delimiter === "~~" ? "del" : delimiter.length === 2 ? "strong" : "em";
        output += `<${tag}>${renderInline(text.slice(index + delimiter.length, end), depth + 1)}</${tag}>`;
        index = end + delimiter.length;
        continue;
      }
    }

    output += escapeHtml(text[index]);
    index++;
  }
  return output;
}
