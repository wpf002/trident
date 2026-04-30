import { useState } from "react";
import { formatDuration } from "../lib/format.js";

type Size = "1024x1024" | "1024x1792" | "1792x1024";
type Quality = "standard" | "hd";

interface ImageResult {
  url: string;
  revised_prompt?: string;
  duration_ms: number;
  model: string;
  size: Size;
  quality: Quality;
  error?: string;
}

export function ImageView() {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<Size>("1024x1024");
  const [quality, setQuality] = useState<Quality>("standard");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    if (!prompt.trim()) {
      setError("Prompt is required");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, size, quality }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`server returned ${res.status}: ${text}`);
      }
      const data = (await res.json()) as ImageResult;
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <header className="page-header">
        <h2 className="page-title">Image</h2>
        <p className="page-subtitle">
          Generate an image from a text prompt using DALL·E 3.
        </p>
        <div className="divider" />
      </header>

      <div className="card">
        <div className="column">
          <div>
            <div className="label">Prompt</div>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A photorealistic golden retriever riding a red bicycle through a sunlit park…"
            />
          </div>
          <div className="row">
            <div style={{ minWidth: 200 }}>
              <div className="label">Size</div>
              <select value={size} onChange={(e) => setSize(e.target.value as Size)}>
                <option value="1024x1024">Square — 1024×1024</option>
                <option value="1792x1024">Landscape — 1792×1024</option>
                <option value="1024x1792">Portrait — 1024×1792</option>
              </select>
            </div>
            <div style={{ minWidth: 200 }}>
              <div className="label">Quality</div>
              <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                <option value="standard">Standard</option>
                <option value="hd">HD (~2× cost)</option>
              </select>
            </div>
          </div>
          <div className="row">
            <button className="primary" onClick={generate} disabled={running}>
              {running ? (
                <span className="row" style={{ gap: 8 }}>
                  <span className="spinner" /> Generating…
                </span>
              ) : (
                "Generate"
              )}
            </button>
            {error && <span className="error">{error}</span>}
          </div>
        </div>
      </div>

      {result && (
        <div className="card bordered-gold" style={{ marginTop: 20 }}>
          <div className="card-header">
            <div className="row">
              <span className="tag claude">DALL·E 3</span>
              <span className="muted tiny">
                {result.size} · {result.quality}
              </span>
            </div>
            <span className="muted tiny">{formatDuration(result.duration_ms)}</span>
          </div>
          <a href={result.url} target="_blank" rel="noreferrer noopener" className="image-result">
            <img src={result.url} alt={prompt} />
          </a>
          {result.revised_prompt && (
            <div className="image-revised">
              <div className="label">Revised prompt</div>
              <div className="muted">{result.revised_prompt}</div>
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer noopener"
              className="muted tiny"
            >
              Open original ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
