"use client";

import { useEffect, useRef, type ReactNode } from "react";

type DetailDialogProps = {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
};

// A modal detail screen: centered on wide screens, a bottom sheet on phones.
// Render it only while open; it opens itself on mount. Escape, the close
// button, and clicking outside all call onClose.
export default function DetailDialog({ title, subtitle, onClose, children }: DetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    // Removing the element closes it, so no cleanup is needed (and closing
    // here would fire onClose during React's development double-mount).
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

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
        <header className="detail-dialog-header">
          <div>
            <h2 id="detail-dialog-title">{title}</h2>
            {subtitle && <p className="detail-dialog-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="detail-dialog-close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
