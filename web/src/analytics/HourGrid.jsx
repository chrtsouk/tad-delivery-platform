const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const pad = (h) => String(h).padStart(2, '0');

/** 7 x 24 colour-intensity table of orders by weekday and hour, with a legend and a busiest-slot call-out. */
export default function HourGrid({ days, matrix }) {
  const flat = matrix.flatMap((row, d) => row.map((v, h) => ({ d, h, v })));
  const max = Math.max(0, ...flat.map((c) => c.v));
  const best = flat.reduce((a, c) => (c.v > a.v ? c : a), { v: 0 });
  const shade = (v) => (v <= 0 || max <= 0 ? 'transparent' : `rgba(227, 23, 28, ${(0.1 + 0.9 * (v / max)).toFixed(3)})`);
  const dark = (v) => max > 0 && v / max > 0.5;
  return (
    <div className="ana-hours">
      {max > 0 && (
        <p className="ana-callout">
          <strong>Busiest slot:</strong> {DAY_NAMES[days[best.d]] ?? days[best.d]}s {pad(best.h)}:00–{pad((best.h + 1) % 24)}:00 with <strong>{best.v}</strong> order{best.v === 1 ? '' : 's'} in this period.
        </p>
      )}
      <div className="ana-hours-scroll">
        <table className="ana-hourtable">
          <caption className="muted">Orders by weekday and hour of day (shop time)</caption>
          <thead>
            <tr><th scope="col" aria-label="Day" />{Array.from({ length: 24 }, (_, h) => <th key={h} scope="col">{pad(h)}</th>)}</tr>
          </thead>
          <tbody>
            {matrix.map((row, d) => (
              <tr key={days[d]}>
                <th scope="row">{days[d]}</th>
                {row.map((v, h) => (
                  <td key={h} className={`${dark(v) ? 'dark' : ''} ${best.v > 0 && d === best.d && h === best.h ? 'best' : ''}`} style={{ background: shade(v) }} title={`${DAY_NAMES[days[d]]} ${pad(h)}:00 — ${v} order${v === 1 ? '' : 's'}`}>{v > 0 ? v : ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ana-legend" aria-label="Colour legend">
        <span>0</span><span className="ana-legend-bar" /><span>{max}</span>
        <span className="muted"> orders per slot (darker = busier)</span>
      </div>
    </div>
  );
}
