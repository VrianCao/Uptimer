import { renewLease } from './lock';

export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export function startRenewableLease(opts: {
  db: D1Database;
  name: string;
  leaseSeconds: number;
  initialExpiresAt: number;
  renewIntervalMs: number;
  renewMinRemainingSeconds: number;
  logPrefix: string;
}): {
  assertHeld(context: string): void;
  getExpiresAt(): number;
  signal: AbortSignal;
  stop(): Promise<void>;
} {
  let claimedLeaseExpiresAt = opts.initialExpiresAt;
  let leaseLossReason: string | null = null;
  let stopRenewal = false;
  let renewalTask = Promise.resolve();
  const abortController = new AbortController();

  const markLeaseLost = (reason: string): void => {
    if (!leaseLossReason) {
      leaseLossReason = reason;
    }
    stopRenewal = true;
    if (!abortController.signal.aborted) {
      abortController.abort(new LeaseLostError(`${opts.logPrefix}: ${leaseLossReason}`));
    }
  };

  const timer = setInterval(() => {
    renewalTask = renewalTask.then(async () => {
      if (stopRenewal || leaseLossReason) {
        return;
      }

      const renewalNow = Math.floor(Date.now() / 1000);
      if (claimedLeaseExpiresAt - renewalNow > opts.renewMinRemainingSeconds) {
        return;
      }

      const nextExpiresAt = renewalNow + opts.leaseSeconds;

      try {
        const renewed = await renewLease(opts.db, opts.name, claimedLeaseExpiresAt, nextExpiresAt);
        if (!renewed) {
          markLeaseLost('lease renewal lost');
          console.warn(`${opts.logPrefix}: lease renewal lost`);
          return;
        }

        claimedLeaseExpiresAt = nextExpiresAt;
      } catch (err) {
        markLeaseLost(
          err instanceof Error
            ? `failed to renew lease (${err.message})`
            : `failed to renew lease (${String(err)})`,
        );
        console.warn(`${opts.logPrefix}: failed to renew lease`, err);
      }
    });
  }, opts.renewIntervalMs);

  return {
    assertHeld(context: string) {
      if (!leaseLossReason && Math.floor(Date.now() / 1000) >= claimedLeaseExpiresAt) {
        markLeaseLost('lease expired before renewal completed');
      }

      if (!leaseLossReason) {
        return;
      }

      throw new LeaseLostError(`${opts.logPrefix}: ${context} aborted because ${leaseLossReason}`);
    },
    getExpiresAt() {
      return claimedLeaseExpiresAt;
    },
    signal: abortController.signal,
    async stop() {
      stopRenewal = true;
      clearInterval(timer);
      await renewalTask;
    },
  };
}
