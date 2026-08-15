export function StalenessBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="banner banner--stale" role="status">
      <span className="banner--stale__icon" aria-hidden="true">{'\u26A0'}</span>
      <div className="banner--stale__body">
        <p className="banner--stale__title">Scores may be stale</p>
        <p className="banner--stale__desc">
          No successful network score write in over an hour. This usually means the trust-engine is not running or cannot reach the control plane.
        </p>
      </div>
      <a href="https://github.com/Numeracode/verilink/blob/main/docs/gate-contract.md" className="banner--stale__action" target="_blank" rel="noopener noreferrer">
        Troubleshoot
      </a>
    </div>
  );
}
