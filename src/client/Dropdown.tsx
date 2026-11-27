import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

interface DropdownProps {
  label: ReactNode;
  ariaLabel: string;
  className?: string;
  panelClassName?: string;
  title?: string;
  align?: 'start' | 'end';
  minWidth?: number;
  maxWidth?: number;
  /** Close an open menu when its session layer is no longer visible. */
  active?: boolean;
  children: (close: () => void) => ReactNode;
}

const EDGE = 8;

/**
 * A small fixed-position popover: it overlays the ledger instead of expanding it.
 * Children mount only while open, so their data requests stay lazy.
 */
export function Dropdown({
  label,
  ariaLabel,
  className,
  panelClassName,
  title,
  align = 'start',
  minWidth = 260,
  maxWidth = 440,
  active = true,
  children,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId().replaceAll(':', '');
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(rect.width, minWidth), Math.min(maxWidth, window.innerWidth - EDGE * 2));
    const preferred = align === 'end' ? rect.right - width : rect.left;
    const left = Math.min(Math.max(preferred, EDGE), window.innerWidth - width - EDGE);
    const top = rect.bottom + 4;
    setPlacement({
      left,
      top,
      width,
      maxHeight: Math.max(160, window.innerHeight - top - EDGE),
    });
  }, [align, maxWidth, minWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    place();
    const reposition = () => place();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [...(panel.current?.querySelectorAll<HTMLElement>('[data-dropdown-option]:not(:disabled)') ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const active = document.activeElement;
    const current = active instanceof HTMLElement ? options.indexOf(active) : -1;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = (current + step + options.length) % options.length;
    options[next]?.focus();
  };

  return <>
    <button
      ref={trigger}
      type="button"
      className={className}
      title={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      data-open={open || undefined}
      onClick={() => {
        if (!open) place();
        setOpen(value => !value);
      }}
      onKeyDown={event => {
        if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        place();
        setOpen(true);
      }}
    >
      {label}
      <span className="dropdown-chevron" aria-hidden="true">▾</span>
    </button>
    {open && placement ? createPortal(
      <div
        ref={panel}
        id={panelId}
        className={['dropdown-panel', panelClassName].filter(Boolean).join(' ')}
        style={{
          left: placement.left,
          top: placement.top,
          width: placement.width,
          maxHeight: placement.maxHeight,
        }}
        role="dialog"
        aria-label={ariaLabel}
        onKeyDown={onPanelKeyDown}
      >
        {children(close)}
      </div>,
      document.body,
    ) : null}
  </>;
}
