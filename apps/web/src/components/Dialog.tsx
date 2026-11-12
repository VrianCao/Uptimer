import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MODAL_OVERLAY_CLASS, MODAL_PANEL_CLASS, cn } from './ui';

export function Dialog({
  label,
  onClose,
  children,
  className,
  dismissOnBackdrop = true,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  dismissOnBackdrop?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const previousInert = root?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = 'hidden';
    // Focus the dialog rather than opening a mobile software keyboard.
    element.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const items = [
        ...element.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]',
        ),
      ].filter((e) => e.tabIndex >= 0 && !e.matches(':disabled') && e.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        element.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (root) root.inert = previousInert;
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className={MODAL_OVERLAY_CLASS}
      onClick={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(MODAL_PANEL_CLASS, className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
