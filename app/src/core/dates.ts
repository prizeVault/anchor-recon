// Day arithmetic shared with the registry contract: `day` = whole days since
// 1970-01-01 UTC, weekday(day) = (day + 3) % 7 with Monday = 0.

export const SECS_PER_DAY = 86_400;

export function dayOf(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`invalid date "${iso}" (want YYYY-MM-DD)`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function isoOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Unix seconds -> day number. */
export function dayOfTs(unix: number): number {
  return Math.floor(unix / SECS_PER_DAY);
}

export function weekday(day: number): number {
  return (day + 3) % 7;
}

export function isWeekend(day: number): boolean {
  return weekday(day) >= 5;
}

export function isExpected(mask: number, day: number): boolean {
  return (mask & (1 << weekday(day))) !== 0;
}

export function deadline(day: number, graceSecs: number): number {
  return (day + 1) * SECS_PER_DAY + graceSecs;
}

/** Business calendar: Monday-Friday minus configured holidays. */
export class BusinessCalendar {
  private readonly holidays: Set<number>;
  constructor(holidays: Iterable<string | number> = []) {
    this.holidays = new Set([...holidays].map((h) => (typeof h === 'number' ? h : dayOf(h))));
  }
  isBusinessDay(day: number): boolean {
    return !isWeekend(day) && !this.holidays.has(day);
  }
  /** Signed business-day distance from a to b (b - a). */
  diff(a: number, b: number): number {
    if (a === b) return 0;
    const sign = b > a ? 1 : -1;
    let n = 0;
    for (let d = a; d !== b; d += sign) {
      if (this.isBusinessDay(d + sign)) n += sign;
    }
    return n;
  }
  add(day: number, n: number): number {
    let d = day;
    const step = n >= 0 ? 1 : -1;
    let left = Math.abs(n);
    while (left > 0) {
      d += step;
      if (this.isBusinessDay(d)) left--;
    }
    return d;
  }
  /** Business days in [from, to]. */
  range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let d = from; d <= to; d++) if (this.isBusinessDay(d)) out.push(d);
    return out;
  }
}
