'use client';

import { useState, type ReactNode } from 'react';

import { ApiError } from '../../api/http';
import { CopyText } from '../../components/CopyText';

/** An error as the API gave it (PA-3): its message, and its code to search for. */
export const ErrorNotice = ({ error }: { readonly error: Error | undefined }) => error
  ? <p className="notice notice-danger" role="alert">{error.message}{error instanceof ApiError ? <span className="mono faint"> ({error.code})</span> : null}</p>
  : null;

/** A key shown once (AK-1, AK-6): copy it now, and confirm before it's gone. */
export const ShownOnce = ({ title, value, warning, onDone }: { readonly title: string; readonly value: string; readonly warning: string; readonly onDone: () => void }) => {
  const [saved, setSaved] = useState(false);

  return (
    <div className="card stack shown-once" role="region" aria-label={title}>
      <h3>{title}</h3>
      <CopyText text={value} />
      <p className="notice">{warning}</p>
      <label className="row">
        <input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />
        <span>I saved it somewhere safe</span>
      </label>
      <div className="row"><button type="button" className="button button-primary" disabled={!saved} onClick={onDone}>Continue</button></div>
    </div>
  );
};

/** A button that asks once more before it acts, such as revoking a key. A failure shows the API's error beside it. */
export const ConfirmButton = ({ label, confirm, onConfirm, disabled }: { readonly label: string; readonly confirm: string; readonly onConfirm: () => Promise<void> | void; readonly disabled?: boolean }) => {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  if (!asking) {
    const button = <button type="button" className="button button-small" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;

    return error ? <span className="stack stack-start">{button}<ErrorNotice error={error} /></span> : button;
  }

  return (
    <span className="row">
      <button
        type="button"
        className="button button-small button-danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await onConfirm();
          }
          catch (caught) {
            setError(caught instanceof Error ? caught : new Error(String(caught)));
          }
          finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {confirm}
      </button>
      <button type="button" className="button button-small" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
};

/** One number with its label (a stat tile): the value large, proportional figures. */
export const StatTile = ({ label, value, note }: { readonly label: string; readonly value: ReactNode; readonly note?: ReactNode }) => (
  <div className="card stat">
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {note ? <div className="faint">{note}</div> : null}
  </div>
);

/** A page's heading row. */
export const ConsoleHeading = ({ title, children }: { readonly title: string; readonly children?: ReactNode }) => (
  <div className="section-head section"><div className="row"><h1>{title}</h1>{children}</div></div>
);
