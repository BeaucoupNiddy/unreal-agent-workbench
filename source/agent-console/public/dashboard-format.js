// Short display only: retain exact token counters and expose them in cell titles.
// Truncate to one decimal so 1,264,877 displays as 1.2M, not 1.3M.
export function formatDashboardTokens(value) {
  const count = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (count < 1_000) return String(count);
  const [unit, suffix] = count >= 1_000_000_000 ? [1_000_000_000, 'B']
    : count >= 1_000_000 ? [1_000_000, 'M'] : [1_000, 'K'];
  return `${Number((Math.floor(count / unit * 10) / 10).toFixed(1))}${suffix}`;
}
