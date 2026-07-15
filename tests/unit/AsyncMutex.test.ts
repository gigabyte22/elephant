import { describe, expect, test } from 'vitest';
import { AsyncMutex } from '../../src/utils/AsyncMutex.ts';

describe('AsyncMutex', () => {
  test('tryAcquire returns a lock once; null while held', () => {
    const m = new AsyncMutex();
    const lock = m.tryAcquire();
    expect(lock).not.toBeNull();
    expect(m.tryAcquire()).toBeNull();
    lock!.release();
    expect(m.tryAcquire()).not.toBeNull();
  });

  test('acquire waits until release', async () => {
    const m = new AsyncMutex();
    const first = await m.acquire();
    let secondResolved = false;
    const secondP = m.acquire().then((lock) => {
      secondResolved = true;
      return lock;
    });
    // Give the event loop a tick — second should NOT have resolved yet.
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    first.release();
    const second = await secondP;
    expect(secondResolved).toBe(true);
    second.release();
  });

  test('serializes multiple waiters FIFO', async () => {
    const m = new AsyncMutex();
    const order: number[] = [];
    const run = async (n: number) => {
      const lock = await m.acquire();
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      lock.release();
    };
    await Promise.all([run(1), run(2), run(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});
