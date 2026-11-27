import { cloneElement } from 'react';
import type { ReactElement } from 'react';

interface Props {
  label: string | (() => string);
  side?: 'right' | 'bottom';
  delayMs?: number;
  children: ReactElement<{ title?: string }>;
}

export function Tooltip({ label, children }: Props) {
  return cloneElement(children, { title: typeof label === 'function' ? label() : label });
}
