// The PhotoVault mark (two orbits and a core), animated once on load and on hover/focus of its parent `.uni-brand` (see css/universe.css).
export function AiuLogo({ size = 26 }: { size?: number }) {
  return (
    <svg className="uni-logo" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <g fill="none" strokeWidth="3">
        <ellipse className="orbit orbit-a" cx="32" cy="32" rx="25" ry="10" stroke="currentColor" transform="rotate(-24 32 32)" />
        <ellipse className="orbit orbit-b" cx="32" cy="32" rx="25" ry="10" stroke="#a78bfa" transform="rotate(36 32 32)" />
      </g>
      <circle className="core" cx="32" cy="32" r="5" fill="#8b5cf6" />
    </svg>
  );
}
