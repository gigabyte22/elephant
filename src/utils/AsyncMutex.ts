// Minimal in-process mutex. acquire() resolves when the lock is free; the
// returned `release` MUST be called (use try/finally). tryAcquire() returns
// null if the lock is held — use when the caller wants to skip instead of wait.

export interface AsyncMutexLock {
  release(): void;
}

export class AsyncMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  isLocked(): boolean {
    return this.locked;
  }

  tryAcquire(): AsyncMutexLock | null {
    if (this.locked) return null;
    this.locked = true;
    return this.makeLock();
  }

  async acquire(): Promise<AsyncMutexLock> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.locked = true;
    return this.makeLock();
  }

  private makeLock(): AsyncMutexLock {
    return { release: () => this.release() };
  }

  private release(): void {
    this.locked = false;
    const next = this.waiters.shift();
    if (next) next();
  }
}
