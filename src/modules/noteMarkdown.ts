import { marked } from "marked";
import katex from "katex";

type ProtectedFormula = {
  content: string;
  isBlock: boolean;
};

export type FollowUpChatPairNoteHtmlOptions = {
  pairId: string;
  userMessage: string;
  assistantMessage: string;
  savedAt?: Date | string;
  sourceLabel?: string;
};

export type FollowUpChatPair = {
  id: string;
  user: string;
  assistant: string;
};

const FOLLOW_UP_CHAT_PAIR_STYLE =
  "margin-top:14px; padding-top:8px; border-top:1px dashed #8a8a8a;";
const FOLLOW_UP_CHAT_USER_STYLE =
  "padding:10px; border-left:3px solid #4f8fd9; border-radius:4px; margin-bottom:8px; color:inherit; background:transparent;";
const FOLLOW_UP_CHAT_ASSISTANT_STYLE =
  "padding:10px; border-left:3px solid #59c0bc; border-radius:4px; color:inherit; background:transparent;";
const FOLLOW_UP_CHAT_TIME_STYLE =
  "font-size:11px; color:inherit; opacity:0.65; margin-top:6px;";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlCodePoint(raw: string, radix: 10 | 16): string {
  const codePoint = parseInt(raw, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

export function decodeMathHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      decodeHtmlCodePoint(hex, 16),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      decodeHtmlCodePoint(dec, 10),
    );
}

function stripZeroWidthChars(text: string): string {
  return text
    .replace(/\u200b/g, "")
    .replace(/\u200c/g, "")
    .replace(/\u200d/g, "")
    .replace(/\u2060/g, "")
    .replace(/\ufeff/g, "");
}

function isFenceLine(line: string): boolean {
  return /^\s*```(?:[A-Za-z0-9_-]+)?\s*$/.test(line);
}

function isMathDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "$$" || trimmed === "\\[" || trimmed === "\\]";
}

function previousNonEmptyLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

function nextNonEmptyLine(lines: string[], start: number): string {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

function normalizeMathCodeFences(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceLine(line)) {
      const prev = previousNonEmptyLine(out);
      const next = nextNonEmptyLine(lines, i + 1);
      // Some models wrap display math as ```text + $$...$$, or even forget
      // the closing fence. Drop fences adjacent to math delimiters so formulas
      // can be protected before marked turns them into <pre><code>.
      if (isMathDelimiterLine(prev) || isMathDelimiterLine(next)) {
        continue;
      }
    }
    out.push(line);
  }

  return out.join("\n");
}

function splitLooseTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) return null;
  if (/^\s*\|.*\|\s*$/.test(line)) return null;

  const cells = trimmed.includes("\t")
    ? trimmed.split(/\t+/)
    : trimmed.split(/\s{2,}/);
  const normalized = cells.map((cell) => cell.trim()).filter(Boolean);
  return normalized.length >= 2 ? normalized : null;
}

function escapeMarkdownTableCell(cell: string): string {
  return cell.replace(/\|/g, "\\|");
}

function isLooseTableRow(line: string): boolean {
  return splitLooseTableCells(line) !== null;
}

function normalizeLooseTables(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  let inFence = false;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }

    if (!inFence && isLooseTableRow(line)) {
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && isLooseTableRow(lines[j])) {
        rows.push(splitLooseTableCells(lines[j])!);
        j++;
      }

      const columnCount = Math.max(...rows.map((row) => row.length));
      const tableLike =
        rows.length >= 2 &&
        columnCount >= 2 &&
        rows.every((row) => row.length >= 2);
      if (tableLike) {
        if (out.length > 0 && out[out.length - 1].trim()) out.push("");
        const normalizedRows = rows.map((row) => {
          const padded = [...row];
          while (padded.length < columnCount) padded.push("");
          return padded.slice(0, columnCount).map(escapeMarkdownTableCell);
        });
        out.push(`| ${normalizedRows[0].join(" | ")} |`);
        out.push(`| ${Array(columnCount).fill("---").join(" | ")} |`);
        for (const row of normalizedRows.slice(1)) {
          out.push(`| ${row.join(" | ")} |`);
        }
        if (j < lines.length && lines[j].trim()) out.push("");
        i = j;
        continue;
      }
    }

    out.push(line);
    i++;
  }

  return out.join("\n");
}

function looksLikeStandaloneMathLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 220) return false;
  if (/^(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(trimmed)) return false;
  if (/^\$\$|^\$|^\\\[|^\\\(/.test(trimmed)) return false;
  if (/[，。；：、！？]/.test(trimmed)) return false;
  if (/[\u4e00-\u9fff]/.test(trimmed)) return false;

  const hasEquation = /=|≤|≥|<|>|≈|∝/.test(trimmed);
  const hasLatex =
    /\\[A-Za-z]+/.test(trimmed) || /[_^]\{?[A-Za-z0-9]/.test(trimmed);
  const hasMathSymbols = /[∥‖⊤⋆∈∑Σμσλ×⋅−∞√]/.test(trimmed);
  return hasEquation && (hasLatex || hasMathSymbols);
}

function normalizeUnicodeMathForLatex(line: string): string {
  return stripZeroWidthChars(line)
    .replace(/⋆/g, "^*")
    .replace(/[∥‖]/g, "\\lVert ")
    .replace(/⊤/g, "^\\top ")
    .replace(/∈/g, " \\in ")
    .replace(/∑/g, "\\sum ")
    .replace(/Σ/g, "\\Sigma ")
    .replace(/μ/g, "\\mu ")
    .replace(/σ/g, "\\sigma ")
    .replace(/λ/g, "\\lambda ")
    .replace(/×/g, " \\times ")
    .replace(/⋅/g, " \\cdot ")
    .replace(/−/g, "-")
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/≈/g, "\\approx ")
    .replace(/∞/g, "\\infty ")
    .replace(/√/g, "\\sqrt{}")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStandaloneMath(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && looksLikeStandaloneMathLine(line)) {
      if (out.length > 0 && out[out.length - 1].trim()) out.push("");
      out.push("$$");
      out.push(normalizeUnicodeMathForLatex(line));
      out.push("$$");
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

export function normalizeMarkdownForRendering(markdown: string): string {
  return normalizeStandaloneMath(
    normalizeLooseTables(
      normalizeMathCodeFences(stripZeroWidthChars(markdown)),
    ),
  );
}

/**
 * Convert Markdown into the HTML dialect Zotero notes can render, including
 * Zotero-native math spans. Shared by summary notes and saved follow-up chats.
 */
export function markdownToZoteroNoteHtml(markdown: string): string {
  const formulas: ProtectedFormula[] = [];
  let processedMarkdown = normalizeMarkdownForRendering(markdown);

  processedMarkdown = processedMarkdown.replace(
    /(\$\$|\\\[)([\s\S]*?)(\$\$|\\\])/g,
    (_match, _start, formula) => {
      const placeholder = `FORMULA_BLOCK_${formulas.length}_END`;
      formulas.push({ content: formula.trim(), isBlock: true });
      return placeholder;
    },
  );

  processedMarkdown = processedMarkdown.replace(
    // eslint-disable-next-line no-useless-escape
    /((?<!\$)\$(?!\$)|\\\()([^\$\n]+?)((?<!\$)\$(?!\$)|\\\))/g,
    (_match, _start, formula) => {
      const placeholder = `FORMULA_INLINE_${formulas.length}_END`;
      formulas.push({ content: formula.trim(), isBlock: false });
      return placeholder;
    },
  );

  processedMarkdown = processedMarkdown.replace(
    // eslint-disable-next-line no-useless-escape
    /\*\*([^\*\n]+?)\*\*/g,
    "<strong>$1</strong>",
  );

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let html = marked.parse(processedMarkdown) as string;
  html = html.replace(/\s+style="[^"]*"/g, "");

  return html.replace(
    /FORMULA_(BLOCK|INLINE)_(\d+)_END/g,
    (_match, _type, index) => {
      const formulaData = formulas[parseInt(index)];
      if (!formulaData) return _match;

      const escapedContent = escapeHtml(formulaData.content);
      if (formulaData.isBlock) {
        return `<p style="text-align: center;"><span class="math">$\\displaystyle ${escapedContent}$</span></p>`;
      }
      return `<span class="math">$${escapedContent}$</span>`;
    },
  );
}

/**
 * Convert Markdown into display HTML for plugin UI surfaces, including KaTeX
 * rendering for LaTeX formulas.
 */
export function markdownToDisplayHtml(markdown: string): string {
  const formulas: ProtectedFormula[] = [];
  let html = normalizeMarkdownForRendering(markdown);

  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula) => {
    const placeholder = `AI_BUTLER_FORMULA_BLOCK_${formulas.length}_END`;
    formulas.push({ content: formula.trim(), isBlock: true });
    return placeholder;
  });

  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_match, formula) => {
    const placeholder = `AI_BUTLER_FORMULA_BLOCK_${formulas.length}_END`;
    formulas.push({ content: formula.trim(), isBlock: true });
    return placeholder;
  });

  html = html.replace(/\\\((.*?)\\\)/g, (_match, formula) => {
    const placeholder = `AI_BUTLER_FORMULA_INLINE_${formulas.length}_END`;
    formulas.push({ content: formula.trim(), isBlock: false });
    return placeholder;
  });

  // eslint-disable-next-line no-useless-escape
  html = html.replace(/\$([^\$\n]+?)\$/g, (_match, formula) => {
    const placeholder = `AI_BUTLER_FORMULA_INLINE_${formulas.length}_END`;
    formulas.push({ content: formula.trim(), isBlock: false });
    return placeholder;
  });

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  try {
    html = marked.parse(html) as string;
  } catch {
    html = `<p>${escapeHtml(html)}</p>`;
  }

  const renderFormula = (_match: string, _type: string, index: string) => {
    const formulaData = formulas[parseInt(index)];
    if (!formulaData) return _match;

    const { isBlock } = formulaData;
    const content = decodeMathHtmlEntities(formulaData.content);
    try {
      const rendered = katex.renderToString(content, {
        throwOnError: false,
        displayMode: isBlock,
        output: "html",
        trust: true,
        strict: false,
      });

      if (isBlock) {
        return `<div class="katex-display">${rendered}</div>`;
      }
      return `<span class="katex-inline">${rendered}</span>`;
    } catch {
      const escapedContent = escapeHtml(content);
      if (isBlock) {
        return `<pre class="math-fallback">$$${escapedContent}$$</pre>`;
      }
      return `<code class="math-fallback">$${escapedContent}$</code>`;
    }
  };

  html = html.replace(
    /<p>\s*AI_BUTLER_FORMULA_BLOCK_(\d+)_END\s*<\/p>/g,
    (match, index) => renderFormula(match, "BLOCK", index),
  );

  return html.replace(
    /AI_BUTLER_FORMULA_(BLOCK|INLINE)_(\d+)_END/g,
    renderFormula,
  );
}

function escapeJsonForHtmlComment(json: string): string {
  return json
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/--/g, "-\\u002D");
}

function encodeFollowUpChatPair(raw: FollowUpChatPair): string {
  return encodeURIComponent(JSON.stringify(raw));
}

function decodeFollowUpChatPair(raw: string): FollowUpChatPair | null {
  try {
    return normalizeFollowUpChatPair(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return null;
  }
}

function normalizeFollowUpChatPair(raw: unknown): FollowUpChatPair | null {
  if (!raw || typeof raw !== "object") return null;
  const pair = raw as Partial<FollowUpChatPair>;
  if (
    pair.id === undefined ||
    pair.user === undefined ||
    pair.assistant === undefined
  ) {
    return null;
  }

  return {
    id: String(pair.id),
    user: String(pair.user),
    assistant: String(pair.assistant),
  };
}

export function parseFollowUpChatPairsFromNoteHtml(
  html: string,
): FollowUpChatPair[] {
  const pairs: FollowUpChatPair[] = [];
  const seenIds = new Set<string>();
  const attrPattern = /data-ai-butler-chat-json="([^"]*)"/g;
  const markerPattern = /<!--\s*AI_BUTLER_CHAT_JSON:\s*([\s\S]*?)\s*-->/g;
  let match: RegExpExecArray | null;

  while ((match = attrPattern.exec(html)) !== null) {
    const parsed = decodeFollowUpChatPair(decodeMathHtmlEntities(match[1]));
    if (!parsed || seenIds.has(parsed.id)) continue;
    seenIds.add(parsed.id);
    pairs.push(parsed);
  }

  while ((match = markerPattern.exec(html)) !== null) {
    try {
      const parsed = normalizeFollowUpChatPair(JSON.parse(match[1].trim()));
      if (!parsed || seenIds.has(parsed.id)) continue;
      seenIds.add(parsed.id);
      pairs.push(parsed);
    } catch {
      // Ignore malformed legacy markers and keep scanning later pairs.
    }
  }

  return pairs;
}

export function buildFollowUpChatPairNoteHtml(
  options: FollowUpChatPairNoteHtmlOptions,
): string {
  const renderedUserMessage = markdownToZoteroNoteHtml(options.userMessage);
  const renderedAssistantMessage = markdownToZoteroNoteHtml(
    options.assistantMessage,
  );
  const pairId = escapeHtml(options.pairId);
  const savedAt =
    typeof options.savedAt === "string"
      ? options.savedAt
      : (options.savedAt ?? new Date()).toLocaleString("zh-CN");
  const sourceSuffix = options.sourceLabel
    ? ` (${escapeHtml(options.sourceLabel)})`
    : "";
  const jsonMarker = `<!-- AI_BUTLER_CHAT_JSON: ${escapeJsonForHtmlComment(
    JSON.stringify({
      id: options.pairId,
      user: options.userMessage,
      assistant: options.assistantMessage,
    }),
  )} -->`;
  const attrMarker = `<span data-ai-butler-chat-json-source="v1" data-ai-butler-chat-json="${escapeHtml(
    encodeFollowUpChatPair({
      id: options.pairId,
      user: options.userMessage,
      assistant: options.assistantMessage,
    }),
  )}" style="display:none"></span>`;

  return `
<!-- AI_BUTLER_CHAT_PAIR_START id=${pairId} -->
${jsonMarker}
${attrMarker}
<div id="ai-butler-pair-${pairId}" style="${FOLLOW_UP_CHAT_PAIR_STYLE}">
  <div style="${FOLLOW_UP_CHAT_USER_STYLE}"><strong>👤 用户:</strong><div>${renderedUserMessage}</div></div>
  <div style="${FOLLOW_UP_CHAT_ASSISTANT_STYLE}"><strong>🤖 AI管家:</strong><div>${renderedAssistantMessage}</div></div>
  <div style="${FOLLOW_UP_CHAT_TIME_STYLE}">保存时间: ${escapeHtml(savedAt)}${sourceSuffix}</div>
</div>
<!-- AI_BUTLER_CHAT_PAIR_END id=${pairId} -->
`;
}

export function normalizeFollowUpChatNoteHtml(html: string): string {
  return html
    .replace(
      /style="background-color:\s*#e3f2fd;\s*padding:\s*10px;\s*border-radius:\s*6px;\s*margin-bottom:\s*8px;?"/gi,
      `style="${FOLLOW_UP_CHAT_USER_STYLE}"`,
    )
    .replace(
      /style="background-color:\s*#f5f5f5;\s*padding:\s*10px;\s*border-radius:\s*6px;?"/gi,
      `style="${FOLLOW_UP_CHAT_ASSISTANT_STYLE}"`,
    )
    .replace(
      /style="font-size:\s*11px;\s*color:\s*#999;\s*margin-top:\s*6px;?"/gi,
      `style="${FOLLOW_UP_CHAT_TIME_STYLE}"`,
    )
    .replace(
      /style="margin-top:\s*14px;\s*padding-top:\s*8px;\s*border-top:\s*1px\s+dashed\s+#ccc;?"/gi,
      `style="${FOLLOW_UP_CHAT_PAIR_STYLE}"`,
    );
}
