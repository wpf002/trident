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

interface Props {
  text: string;
  /** Optional className for the wrapper. */
  className?: string;
}

export function MarkdownView({ text, className }: Props) {
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
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}
