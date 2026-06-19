import { expect } from "chai";
import {
  buildFollowUpChatPairNoteHtml,
  decodeMathHtmlEntities,
  markdownToDisplayHtml,
  markdownToZoteroNoteHtml,
  normalizeMarkdownForRendering,
  normalizeFollowUpChatNoteHtml,
  parseFollowUpChatPairsFromNoteHtml,
} from "../src/modules/noteMarkdown";
import { buildQuickChatConversation } from "../src/modules/chatContext";

describe("note Markdown rendering", function () {
  it("renders saved follow-up headings and formulas (#307, #264)", function () {
    const html = markdownToZoteroNoteHtml(
      "## Follow-up answer\n\nMass energy: $E=mc^2$.\n\n$$\na_b = c^2\n$$",
    );

    expect(html).to.contain("<h2>Follow-up answer</h2>");
    expect(html).to.contain('<span class="math">$E=mc^2$</span>');
    expect(html).to.contain("\\displaystyle a_b = c^2");
    expect(html).not.to.contain("## Follow-up answer");
  });

  it("normalizes loose tab-separated tables into GFM tables", function () {
    const markdown = [
      "3.1 三种运行模式",
      "模式\t时机\t内容",
      "Calibration（校准）\t每个模型、每个目标压缩比各做一次\t收集校准数据 KV，算 PCA 基",
      "Compression（压缩）\tprefill/decode 之间\t用校准参数压缩 Key/Value",
    ].join("\n");

    const normalized = normalizeMarkdownForRendering(markdown);
    expect(normalized).to.contain("| 模式 | 时机 | 内容 |");
    expect(normalized).to.contain("| --- | --- | --- |");

    const html = markdownToZoteroNoteHtml(markdown);
    expect(html).to.contain("<table>");
    expect(html).to.contain("<th>模式</th>");
    expect(html).to.contain("<td>Compression（压缩）</td>");
  });

  it("wraps standalone naked math lines so Zotero can render them", function () {
    const markdown = [
      "对中心化矩阵做 SVD：",
      "C−μ=UΣV⊤",
      "",
      "对任意 KV 矩阵：",
      "D=(X−μ)V,X=DV⊤+μ",
    ].join("\n");

    const normalized = normalizeMarkdownForRendering(markdown);
    expect(normalized).to.contain("$$\nC-\\mu =U\\Sigma V^\\top\n$$");
    expect(normalized).to.contain("D=(X-\\mu )V,X=DV^\\top +\\mu");

    const html = markdownToZoteroNoteHtml(markdown);
    expect(html).to.contain('<span class="math">$\\displaystyle');
    expect(html).to.contain("\\Sigma");
    expect(html).to.contain("^\\top");
  });

  it("unwraps formula-only fenced code blocks before math rendering", function () {
    const markdown = [
      "3.2 单次频域 KV 压缩",
      "",
      "```text",
      "$$",
      "\\hat{K}_{0:L-1} = \\sqrt{\\frac{L}{N}}\\,\\mathrm{IDCT}(Z^K_{0:L-1})",
      "$$",
      "```",
      "",
      "```text",
      "$$",
      "\\tilde{A}^{(N,L)} = \\mathrm{Softmax}\\!\\left(\\frac{q_N K^\\top}{\\sqrt{d}}\\right)V",
      "$$",
    ].join("\n");

    const normalized = normalizeMarkdownForRendering(markdown);
    expect(normalized).not.to.contain("```text");
    expect(normalized).not.to.contain("```");
    expect(normalized).to.contain("\\hat{K}_{0:L-1}");

    const html = markdownToZoteroNoteHtml(markdown);
    expect(html).to.contain('<span class="math">$\\displaystyle');
    expect(html).to.contain("\\hat{K}_{0:L-1}");
    expect(html).to.contain("\\tilde{A}^{(N,L)}");
    expect(html).not.to.contain("<code>");
  });

  it("escapes formula contents before writing Zotero note HTML", function () {
    const html = markdownToZoteroNoteHtml("Compare $a < b & c$ safely.");

    expect(html).to.contain('<span class="math">$a &lt; b &amp; c$</span>');
  });

  it("decodes escaped prime entities before KaTeX rendering", function () {
    expect(decodeMathHtmlEntities("X&#39;_t + Y&#x27;_t + Z&apos;_t")).to.equal(
      "X'_t + Y'_t + Z'_t",
    );

    const html = markdownToDisplayHtml("Prime formula: $X&#39;_t = A$");

    expect(html).to.contain('class="katex-inline"');
    expect(html).not.to.contain("katex-error");
    expect(html).not.to.contain("&#39;");
  });

  it("renders follow-up display Markdown formulas with KaTeX (#320)", function () {
    const html = markdownToDisplayHtml(
      [
        "Mass energy: $E=mc^2$.",
        "",
        "$$a_b = c^2$$",
        "",
        "Inline alt: \\(x_i\\)",
        "",
        "\\[\\sum_i x_i\\]",
      ].join("\n"),
    );

    expect(html).to.contain('class="katex-inline"');
    expect(html).to.contain('class="katex-display"');
    expect(html).to.contain("katex-html");
    expect(html).not.to.contain('<span class="math">');
  });

  it("builds quick-chat context from the current dialog only", function () {
    const dialogHistory = [
      { role: "user" as const, content: "First question" },
      { role: "assistant" as const, content: "First answer" },
    ];

    const conversation = buildQuickChatConversation(
      dialogHistory,
      "Follow up?",
    );

    expect(conversation).to.deep.equal([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow up?" },
    ]);
  });

  it("renders saved follow-up chats without fixed light backgrounds (#193)", function () {
    const html = buildFollowUpChatPairNoteHtml({
      pairId: "pair_193",
      userMessage: "Why is **social contagion** important?",
      assistantMessage: "Because $x < y$ can spread across peers.",
      savedAt: "2026/5/8 12:10:56",
      sourceLabel: "来自快速追问",
    });

    expect(html).to.contain("AI_BUTLER_CHAT_PAIR_START id=pair_193");
    expect(html).to.contain("<strong>social contagion</strong>");
    expect(html).to.contain('<span class="math">$x &lt; y$</span>');
    expect(html).to.contain("保存时间: 2026/5/8 12:10:56");
    expect(html).to.contain("background:transparent");
    expect(html).not.to.contain("background-color:#e3f2fd");
    expect(html).not.to.contain("background-color:#f5f5f5");
  });

  it("restores saved follow-up chat metadata with JSON-like answer text", function () {
    const html = buildFollowUpChatPairNoteHtml({
      pairId: "pair_178",
      userMessage: "How does {context} affect the next question?",
      assistantMessage:
        'It should preserve {"role":"assistant"} and arrows --> safely.',
      savedAt: "2026/5/12 12:10:56",
    });

    const pairs = parseFollowUpChatPairsFromNoteHtml(html);

    expect(pairs).to.deep.equal([
      {
        id: "pair_178",
        user: "How does {context} affect the next question?",
        assistant:
          'It should preserve {"role":"assistant"} and arrows --> safely.',
      },
    ]);
  });

  it("restores follow-up chats from XML-safe data attributes when comments are gone", function () {
    const html = buildFollowUpChatPairNoteHtml({
      pairId: "pair_attr_178",
      userMessage: "文章是如何处理 attention sink 的问题的",
      assistantMessage:
        "它保留 sink token，并通过频域压缩降低 KV cache 体积。\n\n| 项 | 说明 |\n| --- | --- |\n| sink | 保留 |",
      savedAt: "2026/6/19 12:10:56",
    });
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");

    expect(html).to.contain('data-ai-butler-chat-json-source="v1"');
    expect(withoutComments).not.to.contain("AI_BUTLER_CHAT_JSON");
    expect(parseFollowUpChatPairsFromNoteHtml(withoutComments)).to.deep.equal([
      {
        id: "pair_attr_178",
        user: "文章是如何处理 attention sink 的问题的",
        assistant:
          "它保留 sink token，并通过频域压缩降低 KV cache 体积。\n\n| 项 | 说明 |\n| --- | --- |\n| sink | 保留 |",
      },
    ]);
  });

  it("parses legacy follow-up JSON comments that contain braces", function () {
    const html = `<!-- AI_BUTLER_CHAT_JSON: {"id":"legacy_178","user":"Why {this}?","assistant":"Because {that}."} -->`;

    const pairs = parseFollowUpChatPairsFromNoteHtml(html);

    expect(pairs).to.deep.equal([
      {
        id: "legacy_178",
        user: "Why {this}?",
        assistant: "Because {that}.",
      },
    ]);
  });

  it("normalizes legacy follow-up chat blocks for dark notes (#193)", function () {
    const legacy = `
<div id="ai-butler-pair-pair_193" style="margin-top:14px; padding-top:8px; border-top:1px dashed #ccc;">
  <div style="background-color:#e3f2fd; padding:10px; border-radius:6px; margin-bottom:8px;">user</div>
  <div style="background-color:#f5f5f5; padding:10px; border-radius:6px;">assistant</div>
  <div style="font-size:11px; color:#999; margin-top:6px;">saved</div>
</div>`;

    const normalized = normalizeFollowUpChatNoteHtml(legacy);

    expect(normalized).to.contain("background:transparent");
    expect(normalized).to.contain("border-left:3px solid #4f8fd9");
    expect(normalized).to.contain("border-left:3px solid #59c0bc");
    expect(normalized).to.contain("opacity:0.65");
    expect(normalized).not.to.contain("background-color:#e3f2fd");
    expect(normalized).not.to.contain("background-color:#f5f5f5");
    expect(normalized).not.to.contain("color:#999");
  });
});
