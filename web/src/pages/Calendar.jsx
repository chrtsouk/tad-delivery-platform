import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar as BigCalendar, dayjsLocalizer } from 'react-big-calendar';
import dayjs from 'dayjs';
import 'dayjs/locale/en-gb';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { get } from '../lib/api.js';
import EventModal from '../calendar/EventModal.jsx';

// en-gb = weeks start on Monday. Wrapping dayjs (instead of switching its global locale) keeps every other page's dates untouched.
const CULTURE = 'en-gb';
const gbDayjs = new Proxy(dayjs, { apply: (target, _this, args) => target(...args).locale(CULTURE) });
const localizer = dayjsLocalizer(gbDayjs);
const VIEWS = ['month', 'week', 'day', 'agenda'];
const startOfWeek = (d) => { const x = dayjs(d).startOf('day'); return x.subtract((x.day() + 6) % 7, 'day'); };

/** The window of dates the current view needs (a little wider than visible, so month padding days are filled too). */
function windowFor(view, date) {
  const d = dayjs(date);
  if (view === 'month') return [startOfWeek(d.startOf('month')), startOfWeek(d.endOf('month')).add(7, 'day')];
  if (view === 'week') return [startOfWeek(d), startOfWeek(d).add(7, 'day')];
  if (view === 'day') return [d.startOf('day'), d.startOf('day').add(1, 'day')];
  return [d.startOf('day'), d.startOf('day').add(30, 'day')];
}

export default function Calendar() {
  const [view, setView] = useState('week');
  const [date, setDate] = useState(() => new Date());
  const [events, setEvents] = useState([]);
  const [state, setState] = useState({ loading: true, error: null });
  const [picked, setPicked] = useState(null);
  const [tick, setTick] = useState(0);
  const [show, setShow] = useState({ 'pre-order': true, shift: true });
  const [from, to] = useMemo(() => windowFor(view, date).map((x) => x.toISOString()), [view, date]);

  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null });
    get(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => {
      if (!live) return;
      setEvents(r.events.map((e) => ({ id: e.id, kind: e.kind, title: e.kind === 'shift' && e.open ? `${e.title} (on shift)` : e.title, start: new Date(e.start), end: new Date(Math.max(Date.parse(e.end), Date.parse(e.start) + 15 * 60000)), raw: e })));
      setState({ loading: false, error: null });
    }, (error) => live && setState({ loading: false, error }));
    return () => { live = false; };
  }, [from, to, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const close = useCallback(() => setPicked(null), []);
  const counts = useMemo(() => ({ pre: events.filter((e) => e.kind === 'pre-order').length, shift: events.filter((e) => e.kind === 'shift').length }), [events]);
  const visible = useMemo(() => events.filter((e) => show[e.kind]), [events, show]);
  const eventProps = (e) => {
    const cls = e.kind === 'shift' ? (e.raw.open ? 'cal-ev cal-shift cal-open' : 'cal-ev cal-shift') : ['cancelled', 'removed'].includes(e.raw.state) ? 'cal-ev cal-pre cal-cancelled' : e.raw.state === 'scheduled' ? 'cal-ev cal-pre' : 'cal-ev cal-pre cal-done';
    return { className: cls };
  };

  return (
    <div className="cal-page">
      <div className="row cal-head">
        <h2 style={{ margin: 0 }}>Calendar</h2>
        <Link className="cal-new" to="/add">+ New pre-order</Link>
        <div className="cal-legend" role="group" aria-label="Legend and filters">
          <label className="cal-tog"><input type="checkbox" checked={show['pre-order']} onChange={(e) => setShow((v) => ({ ...v, 'pre-order': e.target.checked }))} /><i className="cal-sw cal-sw-pre" /> Pre-orders ({counts.pre})</label>
          <span title="Pre-orders that are already delivered, collected or cancelled"><i className="cal-sw cal-sw-done" /> Already handled</span>
          <label className="cal-tog"><input type="checkbox" checked={show.shift} onChange={(e) => setShow((v) => ({ ...v, shift: e.target.checked }))} /><i className="cal-sw cal-sw-shift" /> Driver shifts ({counts.shift})</label>
          <span><i className="cal-sw cal-sw-open" /> Shift in progress</span>
        </div>
        {state.loading && <span className="muted" role="status">Loading…</span>}
      </div>
      {state.error && <div className="err" role="alert">{state.error.message} <button type="button" onClick={reload}>Try again</button></div>}
      {!state.loading && !state.error && visible.length === 0 && <p className="muted">{events.length ? 'Everything in this period is hidden by the filters above.' : `Nothing scheduled in this ${view === 'agenda' ? 'period' : view}.`}</p>}
      <div className="card cal-box">
        <BigCalendar
          localizer={localizer} culture={CULTURE} events={visible} startAccessor="start" endAccessor="end"
          views={VIEWS} view={view} onView={setView} date={date} onNavigate={setDate}
          onSelectEvent={setPicked} eventPropGetter={eventProps} popup
          scrollToTime={new Date(1970, 0, 1, 15)} style={{ minHeight: 620 }}
          tooltipAccessor={(e) => `${e.title}`}
        />
      </div>
      {picked && <EventModal ev={picked} onClose={close} onChanged={reload} />}
    </div>
  );
}
