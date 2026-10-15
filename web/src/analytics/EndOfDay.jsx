import { useState } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { Status, addDays, fmtMin, fmtNum, fmtPct, hhmm, isDay, longDay, todayUtc, useFetch } from './util.jsx';
import { driverLabel } from './DriversTab.jsx';

const SLICES = ['#e3171c', '#141414', '#b7791f', '#1a7f37', '#6b6b66', '#9b2226'];
const SOURCE_NAMES = { 'own-site': 'Own website', hubrise: 'HubRise', ubereats: 'Uber Eats', deliveroo: 'Deliveroo', justeat: 'Just Eat', manual: 'Added by hand' };
const srcName = (s) => SOURCE_NAMES[s] ?? s;

function Kpi({ label, value, tone }) {
  return <div className={`card ana-kpi ${tone ?? ''}`}><div className="ana-kpi-v">{value}</div><div className="ana-kpi-l">{label}</div></div>;
}

/** The report itself — also what gets printed. No money anywhere: order counts, timings and failures only. */
export function Report({ r, title }) {
  const bySource = r.by_source.map((s) => ({ name: srcName(s.source), value: s.orders }));
  return (
    <article className="ana-report">
      <h2 className="ana-report-title">{title}</h2>
      <div className="ana-kpis">
        <Kpi label="Orders" value={fmtNum(r.orders)} />
        <Kpi label="Delivered" value={fmtNum(r.delivered)} tone="good" />
        <Kpi label="Collected" value={fmtNum(r.collected)} />
        <Kpi label="Cancelled" value={fmtNum(r.cancelled)} />
        <Kpi label="Failed" value={fmtNum(r.failed)} tone={r.failed ? 'bad' : ''} />
        <Kpi label="Still open" value={fmtNum(r.still_open)} tone={r.still_open ? 'warn' : ''} />
        <Kpi label="Late" value={fmtNum(r.late)} tone={r.late ? 'bad' : ''} />
        <Kpi label="On time" value={fmtPct(r.on_time_pct)} />
        <Kpi label="Avg order → door" value={fmtMin(r.avg_order_to_door_min)} />
      </div>

      <div className="grid2 ana-eod-grid">
        <section className="card ana-card">
          <h3>Orders by source</h3>
          {bySource.length === 0 ? <p className="muted">No orders.</p> : (
            <div className="ana-source">
              <PieChart width={170} height={150} role="img" aria-label="Pie chart of orders by source">
                <Pie data={bySource} dataKey="value" nameKey="name" innerRadius={34} outerRadius={68} isAnimationActive={false} stroke="#fff">
                  {bySource.map((s, i) => <Cell key={s.name} fill={SLICES[i % SLICES.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
              <table>
                <thead><tr><th>Source</th><th className="ana-num">Orders</th></tr></thead>
                <tbody>{bySource.map((s, i) => <tr key={s.name}><td><span className="ana-dot" style={{ background: SLICES[i % SLICES.length] }} />{s.name}</td><td className="ana-num">{s.value}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card ana-card">
          <h3>Failures and problems</h3>
          {r.failures.length === 0 ? <p className="muted">No failed deliveries.</p> : (
            <table>
              <thead><tr><th>Order</th><th>Postcode</th><th>Status</th><th>Reason</th></tr></thead>
              <tbody>{r.failures.map((f) => <tr key={f.number}><td>{f.number}</td><td>{f.postcode ?? '—'}</td><td>{f.state}</td><td>{f.reason ?? '—'}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card ana-card">
        <h3>Drivers</h3>
        {r.drivers.length === 0 ? <p className="muted">No finished deliveries by a driver.</p> : (
          <div className="ana-tablewrap">
            <table>
              <thead><tr><th>Driver</th><th className="ana-num">Deliveries</th><th className="ana-num">On time</th><th className="ana-num">Avg pickup → drop</th><th className="ana-num">Failed</th></tr></thead>
              <tbody>{r.drivers.map((d) => <tr key={d.driver_id}><td>{driverLabel(d)}</td><td className="ana-num">{d.deliveries}</td><td className="ana-num">{fmtPct(d.on_time_pct)}</td><td className="ana-num">{fmtMin(d.avg_pickup_to_drop_min)}</td><td className="ana-num">{d.failed}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card ana-card">
        <h3>Shifts</h3>
        {r.shifts.length === 0 ? <p className="muted">Nobody clocked in on this day.</p> : (
          <div className="ana-tablewrap">
            <table>
              <thead><tr><th>Driver</th><th>Zone</th><th>Clocked in (UTC)</th><th>Clocked out (UTC)</th><th className="ana-num">Hours</th></tr></thead>
              <tbody>{r.shifts.map((s, i) => (
                <tr key={`${s.driver_id}-${i}`}><td>{s.driver_name || s.driver_id}</td><td>{s.zone ?? '—'}</td><td>{hhmm(s.clock_in_at)}</td><td>{s.clock_out_at ? hhmm(s.clock_out_at) : <span className="pill warn">Still on shift</span>}</td><td className="ana-num">{s.hours ?? '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted ana-foot">The day runs 00:00–24:00 UTC. Late = delivered more than the shop’s “late after” limit after the order was accepted. {fmtNum(r.audit_events)} audit events were logged.</p>
    </article>
  );
}

function Actions({ onReload, loading }) {
  return (
    <div className="row no-print ana-actions">
      <button type="button" onClick={onReload} disabled={loading}>Refresh</button>
      <button type="button" className="dark" onClick={() => window.print()} disabled={loading}>Print report</button>
    </div>
  );
}

export function EndOfDayTab() {
  const [day, setDay] = useState(todayUtc());
  const rep = useFetch(isDay(day) ? `/api/analytics/end-of-day?day=${day}` : null);
  const today = todayUtc();
  return (
    <div className="ana-eod">
      <div className="ana-range no-print">
        <div className="ana-daystep">
          <button type="button" aria-label="Previous day" onClick={() => setDay(addDays(day, -1))}>‹</button>
          <div><label htmlFor="ana-day">Day</label><input id="ana-day" type="date" value={day} max={today} onChange={(e) => isDay(e.target.value) && setDay(e.target.value)} /></div>
          <button type="button" aria-label="Next day" disabled={day >= today} onClick={() => setDay(addDays(day, 1))}>›</button>
        </div>
        <button type="button" onClick={() => setDay(today)} disabled={day === today}>Today</button>
        <Actions onReload={rep.reload} loading={rep.loading || !rep.data} />
      </div>
      {!rep.data ? <Status loading={rep.loading} error={rep.error} onRetry={rep.reload} /> : (
        <>
          {rep.error && <Status error={rep.error} onRetry={rep.reload} />}
          {rep.data.orders === 0 && <p className="muted no-print">No orders were placed on this day.</p>}
          <Report r={rep.data} title={`End of day — ${longDay(rep.data.day)}`} />
        </>
      )}
    </div>
  );
}

/** Live picture of today: the same numbers as the end-of-day report, refreshed every 30 seconds. */
export function TodayTab({ onOpenEod }) {
  const rep = useFetch('/api/analytics/end-of-day?day=' + todayUtc(), { every: 30000 });
  if (!rep.data) return <Status loading={rep.loading} error={rep.error} onRetry={rep.reload} />;
  return (
    <div className="ana-today">
      <div className="row no-print ana-actions">
        <span className="pill ok">Live — refreshes every 30 s</span>
        <button type="button" onClick={rep.reload} disabled={rep.loading}>Refresh now</button>
        <button type="button" onClick={onOpenEod}>Open the printable end-of-day report</button>
      </div>
      {rep.error && <Status error={rep.error} onRetry={rep.reload} />}
      <Report r={rep.data} title={`Today — ${longDay(rep.data.day)}`} />
    </div>
  );
}
