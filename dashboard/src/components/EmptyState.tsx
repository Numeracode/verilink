

export interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  hint?: string;
}

const ICONS: Record<string, string> = {
  edge: '\u{1F5A8}',
  agents: '\u{1F916}',
  decisions: '\u{1F4CB}',
  policy: '\u{2696}',
  graph: '\u{1F578}',
  tenants: '\u{1F3E2}',
  bootstrap: '\u{1F331}',
  shield: '\u{1F6E1}',
  keys: '\u{1F511}',
  score: '\u{1F4C8}',
  attest: '\u{1F4DD}',
  issuer: '\u{1F5D3}',
  clock: '\u{23F0}',
  chart: '\u{1F4CA}',
  plug: '\u{1F50C}',
  seedling: '\u{1F331}',
  warning: '\u{26A0}',
  empty: '\u{1F4ED}',
};

export function EmptyState({ icon, title, description, action, hint }: EmptyStateProps) {
  const glyph = ICONS[icon] ?? ICONS.empty;
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">{glyph}</div>
      <div className="empty-state__body">
        <p className="empty-state__title">{title}</p>
        <p className="empty-state__desc muted">{description}</p>
        {action && (
          <div className="empty-state__action">
            {action.href ? (
              <a href={action.href} className="empty-state__cta" target="_blank" rel="noopener noreferrer">
                {action.label}
              </a>
            ) : (
              <button type="button" className="empty-state__cta" onClick={action.onClick}>
                {action.label}
              </button>
            )}
          </div>
        )}
        {hint && <p className="empty-state__hint muted">{hint}</p>}
      </div>
    </div>
  );
}