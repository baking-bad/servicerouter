'use client';

import { useEffect, useRef, useState } from 'react';

import { displayUsd, formatMicroUsd } from '../../money';

// Single-series charts in the house mint: one hue, so no legend box; the title names the series. Thin
// bars, 4px rounded tops squared at the baseline, 2px gaps, a hairline grid, a tooltip on hover and
// focus, and a table view so no value hides behind the hover (dataviz).

const usd = (micro: bigint): string => displayUsd(formatMicroUsd(micro));

/** The smallest of 1, 2, 2.5, or 5 times a power of ten at or above the value, in micro-USD. */
export const niceCeiling = (micro: bigint): bigint => {
  if (micro <= 0n)
    return 1_000n;
  let scale = 1n;
  while (scale * 10n < micro)
    scale *= 10n;
  for (const step of [1n, 2n, 5n, 10n]) {
    if (step * scale >= micro)
      return step * scale;
  }

  return 10n * scale;
};

/** A bar's outline: 4px rounded top corners, square at the baseline. */
const columnPath = (x: number, y: number, width: number, height: number): string => {
  const radius = Math.min(4, height, width / 2);

  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
};

const shortDay = (day: string): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

export interface DaySpend {
  readonly day: string;
  readonly amount: bigint;
  readonly calls: number;
}

/** Spend per UTC day: a column per day, today last. */
/** The element's width in CSS pixels, so the chart draws at its real size and its text stays legible. */
const useWidth = (fallback: number) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element)
      return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
};

export const SpendChart = ({ days, title }: { readonly days: readonly DaySpend[]; readonly title: string }) => {
  const [active, setActive] = useState<number | undefined>(undefined);
  const { ref, width } = useWidth(480);
  const height = 200;
  const plot = { left: 52, right: 8, top: 10, bottom: 24 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const ceiling = niceCeiling(days.reduce((max, day) => day.amount > max ? day.amount : max, 0n));
  const band = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.min(24, band - 2);
  const yOf = (micro: bigint) => plot.top + plotHeight - Number(micro * 10_000n / ceiling) / 10_000 * plotHeight;
  const ticks = [0n, ceiling / 2n, ceiling];
  const hovered = active === undefined ? undefined : days[active];
  const labeled = new Set([0, Math.floor(days.length / 2), days.length - 1]);

  return (
    <figure className="chart">
      <figcaption className="chart-title"><h3>{title}</h3></figcaption>
      <div className="chart-frame" ref={ref}>
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="group" aria-label={title} onPointerLeave={() => setActive(undefined)}>
          {ticks.map(tick => (
            <g key={String(tick)}>
              <line x1={plot.left} x2={width - plot.right} y1={yOf(tick)} y2={yOf(tick)} className="chart-grid" />
              <text x={plot.left - 8} y={yOf(tick)} className="chart-axis" textAnchor="end" dominantBaseline="middle">{usd(tick)}</text>
            </g>
          ))}
          {days.map((day, index) => {
            const x = plot.left + index * band + (band - barWidth) / 2;
            const y = yOf(day.amount);

            return (
              <g key={day.day}>
                {day.amount > 0n ? <path d={columnPath(x, y, barWidth, plot.top + plotHeight - y)} className={index === active ? 'chart-bar chart-bar-active' : 'chart-bar'} /> : null}
                {labeled.has(index)
                  ? <text x={x + barWidth / 2} y={height - 6} className="chart-axis" textAnchor="middle">{index === days.length - 1 ? 'Today' : shortDay(day.day)}</text>
                  : null}
                <rect
                  x={plot.left + index * band}
                  y={plot.top}
                  width={band}
                  height={plotHeight}
                  className="chart-hit"
                  tabIndex={0}
                  role="img"
                  aria-label={`${shortDay(day.day)}: ${usd(day.amount)}, ${day.calls} paid calls`}
                  onPointerEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(undefined)}
                />
              </g>
            );
          })}
        </svg>
        {hovered && active !== undefined
          ? (
            <div className="chart-tooltip" style={{ left: `${((plot.left + (active + 0.5) * band) / width) * 100}%` }} role="status">
              <strong className="num">{usd(hovered.amount)}</strong>
              <span className="faint">{shortDay(hovered.day)} · {hovered.calls} paid calls</span>
            </div>
          )
          : null}
      </div>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <table className="table">
          <thead><tr><th>Day</th><th className="num">Spend</th><th className="num">Paid calls</th></tr></thead>
          <tbody>{[...days].reverse().map(day => <tr key={day.day}><td>{day.day}</td><td className="num">{usd(day.amount)}</td><td className="num">{day.calls}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
};

export interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly href?: string;
  readonly amount: bigint;
  readonly note?: string;
}

/** A ranked list with a bar each: the value printed at the bar's end, so nothing needs a hover. */
export const BarList = ({ items, title }: { readonly items: readonly BarItem[]; readonly title: string }) => {
  const max = items.reduce((top, item) => item.amount > top ? item.amount : top, 0n);

  return (
    <figure className="chart">
      <figcaption className="chart-title"><h3>{title}</h3></figcaption>
      <ul className="bar-list">
        {items.map(item => (
          <li key={item.key}>
            <span className="bar-list-label">{item.href ? <a href={item.href} className="mono">{item.label}</a> : <span className="mono">{item.label}</span>}</span>
            <span className="bar-list-track"><span className="bar-list-bar" style={{ width: `${max === 0n ? 0 : Math.max(1, Number(item.amount * 1_000n / max) / 10)}%` }} /></span>
            <span className="bar-list-value num">{usd(item.amount)}{item.note ? <span className="faint"> · {item.note}</span> : null}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
};
