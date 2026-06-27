import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// remark-math expects $...$ / $$...$$ delimiters. The OpenAI/Anthropic
// stack often emits LaTeX-style \( \) / \[ \]. Normalize to dollar form
// before parsing so the math is rendered instead of shown raw.
function normalizeMath(input: string): string {
  if (!input) return "";
  return (
    input
      // Block math: \[ ... \] -> $$ ... $$
      .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `\n$$\n${inner.trim()}\n$$\n`)
      // Inline math: \( ... \) -> $ ... $
      .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner.trim()}$`)
  );
}

// Perplexity emits messy markdown: numbered ATX headings with no space after
// the hashes ("##1." — not a valid heading, so it renders literally) and dense
// inline citation markers ("[1][2][3]"). Clean both up; the Sources list under
// the answer already carries the references.
function cleanPerplexity(input: string): string {
  return input
    .replace(/\[\d+\]/g, "") // drop inline [1][2][3] citation markers
    .replace(/[ \t]{2,}/g, " ") // collapse the double-spaces that leaves
    .replace(/^(#{1,6})(?=[A-Za-z0-9])/gm, "$1 "); // space after heading hashes
}

interface Props {
  text: string;
  /** Optional className for the wrapper. */
  className?: string;
  /** Apply Perplexity-specific markdown cleanup (heading spacing, citations). */
  perplexity?: boolean;
}

export function MarkdownView({ text, className, perplexity }: Props) {
  const cleaned = perplexity ? cleanPerplexity(text) : text;
  return (
    <div className={"markdown-body " + (className ?? "")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // Open links in a new tab so we don't lose UI state.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {normalizeMath(cleaned)}
      </ReactMarkdown>
    </div>
  );
}
