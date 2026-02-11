/**
 * Execution timeout management.
 *
 * Provides utilities for wrapping async operations with a timeout, cancelling
 * long-running VM commands, and managing per-gate time budgets.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Error thrown when an operation exceeds its time budget. */
export class TimeoutError extends Error {
  /** The configured timeout in milliseconds. */
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an async function with a timeout.
 *
 * If the function does not resolve within `timeoutMs` milliseconds, the
 * returned promise rejects with a {@link TimeoutError}.
 *
 * **Note:** The underlying operation is *not* cancelled -- only the promise
 * is rejected.  Callers are responsible for cleaning up resources (e.g.
 * killing VM processes) if needed.
 *
 * @param fn        The async function to execute.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @param message   Optional error message for the timeout.
 * @returns         The resolved value of `fn`.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return fn();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new TimeoutError(
            message ?? `Operation timed out after ${timeoutMs}ms`,
            timeoutMs,
          ),
        );
      }
    }, timeoutMs);

    fn().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

/**
 * A cancellable timer that tracks remaining time for multi-step operations.
 *
 * Usage:
 * ```ts
 * const budget = new TimeBudget(300_000); // 5 minutes total
 * await stepOne(budget.remaining());
 * await stepTwo(budget.remaining());
 * if (budget.isExpired()) throw new TimeoutError("...", budget.totalMs);
 * ```
 */
export class TimeBudget {
  /** Total budget in milliseconds. */
  public readonly totalMs: number;

  private readonly startTime: number;

  constructor(totalMs: number) {
    this.totalMs = totalMs;
    this.startTime = Date.now();
  }

  /** Milliseconds elapsed since the budget was created. */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** Milliseconds remaining in the budget. Returns 0 if expired. */
  remaining(): number {
    return Math.max(0, this.totalMs - this.elapsed());
  }

  /** Whether the budget has been fully consumed. */
  isExpired(): boolean {
    return this.remaining() === 0;
  }

  /**
   * Assert that the budget has not expired.
   * Throws {@link TimeoutError} if it has.
   */
  assertNotExpired(context?: string): void {
    if (this.isExpired()) {
      throw new TimeoutError(
        context ?? `Time budget of ${this.totalMs}ms exhausted`,
        this.totalMs,
      );
    }
  }
}

/**
 * Sleep for the specified duration.  Resolves immediately if `ms <= 0`.
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
