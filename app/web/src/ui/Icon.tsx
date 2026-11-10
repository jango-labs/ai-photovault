import type { SVGProps } from 'react';

/** Small stroke icon set (1.5px, 16px grid). Decorative by default (aria-hidden); pass `title` to make it meaningful. */
const P: Record<string, string> = {
  star: 'M8 1.8l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.4 4.1 13.6 5 9.3 1.8 6.3l4.3-.5z',
  heart: 'M8 13.6S2 10 2 5.9A3 3 0 018 4.6 3 3 0 0114 5.9C14 10 8 13.6 8 13.6z',
  check: 'M3 8.5l3.2 3.2L13 4.8',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l3.5 3.5',
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9H7v4.5H2.5zM9 9h4.5v4.5H9z',
  arrowUpRight: 'M5 11l6-6M6 5h5v5',
  chevronLeft: 'M10 3L5 8l5 5',
  chevronRight: 'M6 3l5 5-5 5',
  chevronDown: 'M3 6l5 5 5-5',
  clock: 'M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.5V8l2.5 1.5',
  alert: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.2v.1',
  info: 'M8 14A6 6 0 108 2a6 6 0 000 12zM8 7.2V11M8 5v.1',
  sliders: 'M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7M10.5 3v3M5.5 10v3',
  calendar: 'M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2v3M10.5 2v3',
  image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3L11 8l3 3M5.5 6.2v.1',
  library: 'M2 3h12v10H2zM6 3v10M10 3v10',
  inbox: 'M2 9l2-6h8l2 6v4H2zM2 9h3.5l1 1.5h3L11 9H14',
  folder: 'M2 4.5h4l1.5 1.5H14v7H2z',
  curator: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM11 9v4M9 11h4',
  map: 'M8 14s4.5-4 4.5-7.5a4.5 4.5 0 10-9 0C3.5 10 8 14 8 14zM8 8.2v.1',
  send: 'M14 2L7 9M14 2l-4.5 12-2.5-5-5-2.5z',
  post: 'M2.5 2.5h11v11h-11zM8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM11 5v.1',
  compare: 'M6 3H2.5v10H6M10 3h3.5v10H10M8 2v12',
  pin: 'M8 14.2V9M5 9h6l-.7-4 1.2-1.5h-7.4L5.7 5z',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 9.8a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6z',
  panel: 'M2 3h12v10H2zM10 3v10',
  moon: 'M13 9.5A5.5 5.5 0 116.5 3 4.5 4.5 0 0013 9.5z',
  drag: 'M6 4v.1M6 8v.1M6 12v.1M10 4v.1M10 8v.1M10 12v.1',
  external: 'M9 3h4v4M13 3L7 9M12 9v4H3V4h4',
  more: 'M3.5 8v.1M8 8v.1M12.5 8v.1',
  refresh: 'M13 8a5 5 0 11-1.5-3.6M13 2.5v3h-3',
  user: 'M8 8a3 3 0 100-6 3 3 0 000 6zM2.5 14c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  zoomIn: 'M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l3.5 3.5M7 4.8v4.4M4.8 7h4.4',
  zoomOut: 'M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l3.5 3.5M4.8 7h4.4',
  fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  filter: 'M2 3.5h12L9.5 9v4l-3-1.5V9z',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 015 0v2',
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 16, title, ...rest }: { name: IconName; size?: number; title?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const filled = name === 'star' || name === 'heart';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={name === 'more' || name === 'drag' ? 2.6 : 1.5}
      strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} focusable="false" {...rest}>
      <path d={P[name]} />
    </svg>
  );
}
export const ICON_NAMES = Object.keys(P) as IconName[];
