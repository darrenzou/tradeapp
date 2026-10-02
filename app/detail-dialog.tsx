"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";

type DetailDialogProps = {
  title: string;
  subtitle?: string;
  // Shown beside the title, e.g. an Edit button.
  action?: ReactNode;
  onClose: () => void;
  children: ReactNode;
};

// How far the sheet has to be dragged down before letting go closes it.
const DISMISS_DISTANCE = 96;

// A modal detail screen: centered on wide screens, a bottom sheet on phones.
// Render it only while open; it opens itself on mount. Escape, the close
// button, clicking outside, and dragging the sheet down by its top all call
// onClose.
export default function DetailDialog({ title, subtitle, action, onClose, children }: DetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; offset: number } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    // Removing the element closes it, so no cleanup is needed (and closing
    // here would fire onClose during React's development double-mount).
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  function moveSheet(offset: number) {
    const dialog = dialogRef.current;

    if (dialog) {
      dialog.style.transform = offset > 0 ? `translateY(${offset}px)` : "";
    }
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    // Only touch drags: a mouse on a wide screen has the close button.
    if (event.pointerType === "mouse" || (event.target as HTMLElement).closest("button, a")) {
      return;
    }

    drag.current = { pointerId: event.pointerId, startY: event.clientY, offset: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    dialogRef.current?.classList.add("detail-dialog-dragging");
  }

  function continueDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) {
      return;
    }

    drag.current.offset = Math.max(0, event.clientY - drag.current.startY);
    moveSheet(drag.current.offset);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) {
      return;
    }

    const { offset } = drag.current;
    drag.current = null;
    dialogRef.current?.classList.remove("detail-dialog-dragging");

    if (offset >= DISMISS_DISTANCE) {
      onClose();
    } else {
      moveSheet(0);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="detail-dialog"
      aria-labelledby="detail-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // The dialog element itself only receives clicks on its backdrop.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="detail-dialog-body">
        <div
          className="detail-dialog-grip"
          onPointerDown={startDrag}
          onPointerMove={continueDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="detail-dialog-handle" aria-hidden="true" />
          <header className="detail-dialog-header">
            <div>
              <h2 id="detail-dialog-title">{title}</h2>
              {subtitle && <p className="detail-dialog-subtitle">{subtitle}</p>}
            </div>
            {action}
            <button type="button" className="detail-dialog-close" onClick={onClose} aria-label="Close">
              <span aria-hidden="true">×</span>
            </button>
          </header>
        </div>
        {children}
      </div>
    </dialog>
  );
}
