export function TridentIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 6861.1533 7752"
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      className={className}
      aria-hidden="true"
    >
      <path
        id="trident-half"
        fill="currentColor"
        d="M3430.5767 0c-260 709-525 1447-1092 2012 176-58 484-110 682-105v2982l-842 125c-30-3-40-50-40-114-81-926-300-1704-552-2509-18-110-337-530-91-456 30 4 359 138 307 74-448-464-1103-798-1739-897-56-14-89 14-39 79 844 1299 1550 2832 1544 4651 328 0 1123-194 1452-194v2104h415l95-5876z"
      />
      <use xlinkHref="#trident-half" transform="matrix(-1 0 0 1 6861.1533 0)" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="sidebar-brand">
      <TridentIcon className="icon" />
      <div className="text">
        <div className="brand-wordmark">TRIDENT</div>
        <div className="brand-subtitle">Multi-AI Orchestration</div>
      </div>
    </div>
  );
}
