import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
interface Common { variant?: ButtonVariant; size?: 'md' | 'sm'; icon?: IconName; children?: ReactNode }

/** One primary (gradient) button per view. Everything else is secondary/ghost/outline. */
export const Button = forwardRef<HTMLButtonElement, Common & ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} className={cx('jb-btn', `jb-btn--${variant}`, size === 'sm' && 'jb-btn--sm', className)} {...rest}>
      {icon && <Icon name={icon} size={14} />}{children}
    </button>
  ),
);
Button.displayName = 'Button';

export const LinkButton = ({ variant = 'secondary', size = 'md', icon, className, children, ...rest }: Common & LinkProps) => (
  <Link className={cx('jb-btn', `jb-btn--${variant}`, size === 'sm' && 'jb-btn--sm', className)} {...rest}>{icon && <Icon name={icon} size={14} />}{children}</Link>
);

/** Square icon button. `label` is mandatory: it is the accessible name and the tooltip text. */
export const IconButton = forwardRef<HTMLButtonElement, { icon: IconName; label: string; pressed?: boolean; size?: 'md' | 'sm' } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>>(
  ({ icon, label, pressed, size = 'md', className, type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} aria-label={label} title={label} aria-pressed={pressed} className={cx('jb-btn', 'jb-btn--icon', size === 'sm' && 'jb-btn--sm', pressed && 'is-pressed', className)} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 13 : 15} />
    </button>
  ),
);
IconButton.displayName = 'IconButton';
