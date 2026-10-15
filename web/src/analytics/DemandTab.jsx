import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import DemandMap from './DemandMap.jsx';
import HourGrid from './HourGrid.jsx';
import { Status, fmtNum } from './util.jsx';

export default function DemandTab({ demand }) {
  const [mode, setMode] = useState('heatmap');
  const { data, error, loading, reload } = demand;
  if (!data) return <Status loading={loading} error={error} onRetry={reload} />;
  const none = data.total === 0;
  const areas = data.by_area.slice(0, 20);
  return (
    <div className="ana-demand">
      {error && <Status error={error} onRetry={reload} />}
      <div className="row ana-demand-head">
        <p className="muted" style={{ margin: 0 }}>{fmtNum(data.total)} delivery order{data.total === 1 ? '' : 's'} in this period (cancelled and removed orders excluded).</p>
        <div className="ana-toggle" role="group" aria-label="Map view">
          <button type="button" className={mode === 'heatmap' ? 'on' : ''} aria-pressed={mode === 'heatmap'} onClick={() => setMode('heatmap')}>Heatmap</button>
          <button type="button" className={mode === 'clusters' ? 'on' : ''} aria-pressed={mode === 'clusters'} onClick={() => setMode('clusters')}>Clusters</button>
        </div>
      </div>
      {none && <section className="card ana-card"><Status empty emptyText="No delivery orders in this period, so there is nothing to show yet. Try a wider date range." /></section>}
      {!none && <>
      <section className="card ana-card">
        <h3>Where orders go</h3>
        <DemandMap points={data.points} mode={mode} />
        <p className="muted ana-note">{mode === 'heatmap' ? 'Warmer colours = more orders close together.' : 'Circles group nearby orders and show the count; click one to zoom in.'}</p>
      </section>
      <section className="card ana-card">
        <h3>Busy times</h3>
        <HourGrid days={data.by_hour_of_week.days} matrix={data.by_hour_of_week.matrix} />
      </section>
      <section className="card ana-card">
        <h3>Orders by postcode area</h3>
        {areas.length === 0 ? <Status empty emptyText="No areas yet." /> : (
          <div className="ana-chart" role="img" aria-label="Bar chart of orders by postcode area">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={areas} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="outcode" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,.05)' }} />
                <Bar dataKey="orders" name="Orders" fill="#e3171c" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
      </>}
    </div>
  );
}
