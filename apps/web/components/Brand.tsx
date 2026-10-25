/** A+ TradePlay mark: a peak (the "A") and a gold plus. Works on dark and light grounds. */
export function Logo({ className = "h-8 w-8", title = "A+ TradePlay" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label={title}>
      <rect x="1" y="1" width="62" height="62" rx="16" fill="#121317" stroke="#2A2C33" strokeWidth="1.5" />
      <path d="M14 47 L28 17 L42 47" fill="none" stroke="#ECEDF0" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 36 L35 36" fill="none" stroke="#ECEDF0" strokeWidth="5" strokeLinecap="round" opacity="0.35" />
      <path d="M49 13 L49 27 M42 20 L56 20" fill="none" stroke="#F2C14E" strokeWidth="5.5" strokeLinecap="round" />
    </svg>
  );
}

/** Bare mark (no tile) for dark surfaces like the icon rail. */
export function Mark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <path d="M13 49 L28 15 L43 49" fill="none" stroke="#ECEDF0" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M50 10 L50 28 M41 19 L59 19" fill="none" stroke="#F2C14E" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}
