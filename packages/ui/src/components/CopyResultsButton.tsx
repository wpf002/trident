import { useState } from "react";
import { aiLabel } from "../types.js";

interface CopyResponse {
  ai: string;
  content: string;
  error?: string;
}

/** Plain-text rendering of a run: the original prompt followed by each AI's answer. */
export function buildCopyText(prompt: string, responses: CopyResponse[]): string {
  const parts: string[] = [`Prompt:\n${prompt.trim()}`, ""];
  for (const r of responses) {
    parts.push(`--- ${aiLabel(r.ai)} ---`);
    parts.push(r.error ? `[Error: ${r.error}]` : r.content.trim());
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyResultsButton({
  prompt,
  responses,
  className,
}: {
  prompt: string;
  responses: CopyResponse[];
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const onClick = async () => {
    const ok = await copyToClipboard(buildCopyText(prompt, responses));
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      className={"secondary" + (className ? " " + className : "")}
      onClick={onClick}
      disabled={responses.length === 0}
    >
      {state === "copied" ? "Copied!" : state === "failed" ? "Copy failed" : "Copy Results"}
    </button>
  );
}
