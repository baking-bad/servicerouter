'use client';

import { useState } from 'react';

/** Text to copy, such as a prompt for an agent, with a Copy button. */
export const CopyText = ({ text, label = 'Copy' }: { readonly text: string; readonly label?: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }
    catch {
      setCopied(false);
    }
  };

  return (
    <div className="copy">
      <span className="copy-text">{text}</span>
      <button type="button" className="button button-small" onClick={() => void copy()} aria-live="polite">{copied ? 'Copied' : label}</button>
    </div>
  );
};
