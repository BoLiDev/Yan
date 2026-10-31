import { cn } from '../../lib/utils';
import { Icon, type IconName } from '../Icon';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface ToolProps {
  name: IconName;
  label: string;
  onClick?: () => void;
  href?: string | null;
  /** A link opens in a new tab unless this is false. */
  newTab?: boolean;
  small?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  blocked?: boolean;
}

/**
 * An icon button, or an icon link when it has somewhere to go, named by its
 * tooltip; a link with nowhere to go is a button, so it can be disabled.
 */
export function Tool({ name, label, onClick, href, newTab = true, small, pressed, disabled, blocked }: ToolProps) {
  const look = cn('text-ink-3 hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground', blocked && 'opacity-40 hover:bg-transparent hover:text-ink-3');
  const size = small ? 'icon-sm' : 'icon';
  const icon = <Icon name={name} size={small ? 15 : 17} />;
  const trigger = href
    ? <Button variant="ghost" size={size} className={look} aria-label={label} nativeButton={false}
      render={<a href={href} target={newTab ? '_blank' : undefined} rel="noopener" onClick={onClick} />}>{icon}</Button>
    : <Button variant="ghost" size={size} className={look} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{icon}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
