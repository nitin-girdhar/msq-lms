'use client';

import { useState } from 'react';

interface Props {
  password: string;
  email: string;
}

export default function TemporaryPasswordPanel({ password, email }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard might be blocked — user can select and copy manually.
    }
  };

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        Temporary password — shown once
      </p>
      <p className="mt-1 text-xs text-amber-700">
        Share with {email} via a secure channel. It will not be retrievable again.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 select-all rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-sm text-[#0F172A]">
          {password}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
