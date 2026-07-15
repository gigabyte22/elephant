// localStorage-backed bearer token store. The dashboard prompts once per
// session; subsequent reads short-circuit. A 401 from the API flips the
// stored token off so the prompt re-appears.

const KEY = 'elephant:auth-token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    /* no-op — private mode, etc. */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* no-op */
  }
}
