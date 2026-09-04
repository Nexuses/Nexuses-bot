export function BrandMark({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="14.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="7.5" r="2.15" fill="currentColor" />
      <circle cx="23.8" cy="12" r="2.15" fill="currentColor" />
      <circle cx="23.8" cy="20" r="2.15" fill="currentColor" />
      <circle cx="16" cy="24.5" r="2.15" fill="currentColor" />
      <circle cx="8.2" cy="20" r="2.15" fill="currentColor" />
      <circle cx="8.2" cy="12" r="2.15" fill="currentColor" />
      <path
        d="M16 7.5 23.8 12 23.8 20 16 24.5 8.2 20 8.2 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <circle cx="16" cy="16" r="2.4" fill="currentColor" />
    </svg>
  );
}
