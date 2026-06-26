// Renders a provider's source URLs (e.g. Perplexity citations) as a numbered
// list of links, so inline [1][2] markers in the answer have somewhere to point.

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function Sources({ citations }: { citations?: string[] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="sources">
      <div className="sources-label">Sources</div>
      <ol className="sources-list">
        {citations.map((url, i) => (
          <li key={i}>
            <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
              {hostOf(url)}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
