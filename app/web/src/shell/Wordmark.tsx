import { Link } from 'react-router-dom';
import { AiuLogo } from './AiuLogo';

export const PRODUCT_NAME = 'AI PhotoVault';
export const PRODUCT_TAGLINE = 'Your Intelligent Photography Library';

/** Camera-aperture mark: a ring and six iris blades, drawn in the existing aqua token. Decorative; the name beside it is the label. */
export function ApertureMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="jb-wordmark__mark" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="9.6" />
      <path d="M12 2.4 15.6 9.3M21.1 8 13.4 8.6M20.2 16.8 14.4 11.6M12 21.6 8.4 14.7M2.9 16 10.6 15.4M3.8 7.2 9.6 12.4" />
    </svg>
  );
}

export function Wordmark({ to, className = '' }: { to?: string; className?: string }) {
  const inner = <><span className="jb-wordmark__mark uni-brand" aria-hidden><AiuLogo size={22} /></span><span className="jb-wordmark__name"><b>AI</b> PhotoVault</span></>;
  return to
    ? <Link to={to} className={`jb-wordmark ${className}`} aria-label={`${PRODUCT_NAME}, home`}>{inner}</Link>
    : <span className={`jb-wordmark ${className}`}>{inner}</span>;
}
