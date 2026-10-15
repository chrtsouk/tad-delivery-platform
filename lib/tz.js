/** Local-time helpers (the shop trades in Europe/London, which is UTC+1 in summer). Built on Intl, no dependency. */
export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}
export const localDate = (date, tz) => { const p = localParts(date, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

function offsetMs(date, tz) { const p = localParts(date, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(date.getTime() / 60000) * 60000; }

/** [from, to) in UTC ISO for one local calendar day. */
export function dayRangeUtc(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const edge = (yy, mm, dd) => { const guess = Date.UTC(yy, mm - 1, dd); const t = guess - offsetMs(new Date(guess), tz); return new Date(guess - offsetMs(new Date(t), tz)).toISOString(); };
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return [edge(y, m, d), edge(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())];
}
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
