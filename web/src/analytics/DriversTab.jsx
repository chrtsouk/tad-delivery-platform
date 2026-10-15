import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Status, fmtMin, fmtNum, fmtPct } from './util.jsx';

const axis = { fontSize: 12 };
export const driverLabel = (d) => d.name || d.driver_id;

/** Deliveries, on-time % and average pickup -> drop minutes per driver. Deliberately nothing about money. */
export default function DriversTab({ drivers }) {
  const { data, error, loading, reload } = drivers;
  if (!data) return <Status loading={loading} error={error} onRetry={reload} />;
  const rows = data.drivers.map((d) => ({ ...d, label: driverLabel(d) }));
  if (!rows.length) return <Status empty emptyText="No finished deliveries by drivers in this period." />;
  return (
    <div className="ana-drivers">
      {error && <Status error={error} onRetry={reload} />}
      <section className="card ana-card">
        <h3>Drivers</h3>
        <div className="ana-tablewrap">
          <table>
            <thead><tr><th>Driver</th><th className="ana-num">Deliveries</th><th className="ana-num">On time</th><th className="ana-num">Avg pickup → drop</th><th className="ana-num">Avg order → door</th><th className="ana-num">Failed</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.driver_id}>
                  <td>{d.label}</td><td className="ana-num">{fmtNum(d.deliveries)}</td>
                  <td className="ana-num"><span className={`pill ${d.on_time_pct == null ? '' : d.on_time_pct >= 80 ? 'ok' : d.on_time_pct >= 60 ? 'warn' : 'late'}`}>{fmtPct(d.on_time_pct)}</span></td>
                  <td className="ana-num">{fmtMin(d.avg_pickup_to_drop_min)}</td><td className="ana-num">{fmtMin(d.avg_order_to_door_min)}</td><td className="ana-num">{fmtNum(d.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted ana-note">On time = delivered within the shop’s “late after” limit, counted from when the order was accepted.</p>
      </section>
      <div className="grid2 ana-charts3">
        <section className="card ana-card">
          <h3>Deliveries and failures</h3>
          <div className="ana-chart" role="img" aria-label="Bar chart of deliveries and failed deliveries per driver">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={axis} /><YAxis allowDecimals={false} tick={axis} /><Tooltip cursor={{ fill: 'rgba(0,0,0,.05)' }} /><Legend />
                <Bar dataKey="deliveries" name="Delivered" fill="#141414" radius={[4, 4, 0, 0]} />
                <Bar dataKey="failed" name="Failed" fill="#e3171c" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="card ana-card">
          <h3>On-time %</h3>
          <div className="ana-chart" role="img" aria-label="Bar chart of on-time percentage per driver">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={axis} /><YAxis domain={[0, 100]} unit="%" tick={axis} /><Tooltip cursor={{ fill: 'rgba(0,0,0,.05)' }} formatter={(v) => `${v}%`} />
                <Bar dataKey="on_time_pct" name="On time" fill="#1a7f37" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="card ana-card">
          <h3>Average pickup → drop (minutes)</h3>
          <div className="ana-chart" role="img" aria-label="Bar chart of average minutes from pickup to drop per driver">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={axis} /><YAxis tick={axis} /><Tooltip cursor={{ fill: 'rgba(0,0,0,.05)' }} formatter={(v) => `${v} min`} />
                <Bar dataKey="avg_pickup_to_drop_min" name="Minutes" fill="#b7791f" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </div>
  );
}
