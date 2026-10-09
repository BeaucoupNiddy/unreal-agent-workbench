// Account-wide increase since this thread started, NOT a measured per-thread
// contribution: other clients/threads can change the account percentage too.
export function subscriptionIncrease(start, current) {
  if (!Number.isFinite(start?.percent) || !Number.isFinite(current?.percent)) return null;
  if (start.percent < 0 || current.percent < 0 || start.percent > 100 || current.percent > 100) return null;
  const firstReset = start.resetsAt && Date.parse(start.resetsAt);
  const lastReset = current.resetsAt && Date.parse(current.resetsAt);
  if (Number.isFinite(firstReset) && Number.isFinite(lastReset) && firstReset !== lastReset) return null;
  const delta = current.percent - start.percent;
  if (delta < 0) return null; // A window reset or corrected provider sample.
  return Math.round(delta * 10) / 10;
}
