// Numbers for people: compact counts, percentages, and latencies. Tabular figures come from CSS (WB-5).

/** 906300 → "906.3k", 1250000 → "1.25M". */
export const compactCount = (value: number): string => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);

/** 0.9981 → "99.8%". */
export const percent = (ratio: number): string => `${(Math.floor(ratio * 1_000) / 10).toFixed(1)}%`;

/** 84 → "84 ms", 6200 → "6.2 s". */
export const latency = (ms: number): string => ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;

/** An ISO time as "6 Oct 2026". */
export const shortDate = (iso: string): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
