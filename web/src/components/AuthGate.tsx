import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { getToken, setToken } from '../lib/auth.ts';

// Gates the entire app behind a single bearer-token prompt. On 401, our API
// client clears the stored token; this component listens for storage events
// and re-prompts. Keeps the auth flow off the rest of the codebase.

interface Props {
  children: ReactNode;
}

export function AuthGate({ children }: Props) {
  const [token, setLocalToken] = useState<string | null>(() => getToken());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'elephant:auth-token') setLocalToken(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // The API client clears the token directly via clearToken() — that doesn't
  // fire a storage event in the same tab, so re-check on focus too.
  useEffect(() => {
    const onFocus = () => setLocalToken(getToken());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!token)
    return (
      <TokenPrompt
        onSubmit={(t) => {
          setToken(t);
          setLocalToken(t);
        }}
      />
    );
  return <>{children}</>;
}

function TokenPrompt({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [value, setValue] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/92 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="projected halo relative w-[min(90vw,560px)] border border-accent-500/40 bg-ink-900 px-10 py-9 animate-fade-up"
      >
        <div className="flex items-center gap-3 pb-7">
          <span className="tick h-3" />
          <span className="font-mono text-2xs tracking-kerned uppercase text-ink-300">
            elephant / memory inspector
          </span>
        </div>
        <h1 className="font-cinema text-[3.25rem] font-light uppercase tracking-wide text-ink-100 chroma leading-none">
          authenticate
        </h1>
        <p className="mt-5 max-w-md text-sm leading-relaxed text-ink-300">
          Paste the bearer token configured as{' '}
          <code className="font-mono text-ink-100">MEMORY_SERVICE_TOKEN</code> on the backend.
          Stored locally; cleared on any 401.
        </p>
        <label className="mt-9 block">
          <span className="label-meta block pb-2">token</span>
          <input
            type="password"
            // biome-ignore lint/a11y/noAutofocus: token entry is the page's only interaction
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. ts3cr3t…"
            className="w-full border-0 border-b border-hairline-strong bg-transparent px-0 pb-2 font-mono text-base text-ink-100 placeholder:text-ink-500 focus:border-accent-500 focus:outline-none"
          />
        </label>
        <div className="mt-8 flex items-center justify-between">
          <span className="label-key text-ink-500">[ENTER] to continue</span>
          <button
            type="submit"
            disabled={value.trim().length === 0}
            className="group flex items-center gap-2 border border-hairline-strong px-5 py-2 font-mono text-2xs uppercase tracking-widest text-ink-100 transition-colors hover:border-accent-500 hover:text-accent-300 disabled:cursor-not-allowed disabled:border-hairline disabled:text-ink-500 disabled:hover:border-hairline"
          >
            <span>connect</span>
            <span className="tick h-3 transition-all group-hover:h-4" aria-hidden />
          </button>
        </div>
      </form>
    </div>
  );
}
