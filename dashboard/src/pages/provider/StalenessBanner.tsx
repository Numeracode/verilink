export function StalenessBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="banner banner--stale" role="status">
      Scores may be stale — no successful network score write in over an hour.
    </div>
  );
}
