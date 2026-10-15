import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { get, post, put } from '../lib/api.js';
import { useBoard } from '../lib/useBoard.js';
import { playLate, playNewOrder, unlockAudio, useAudioLocked } from '../lib/sound.js';
import AskDialog from '../components/AskDialog.jsx';
import Icon from '../components/Icon.jsx';
import { useToasts } from '../components/Toasts.jsx';
import OrderCard from '../board/OrderCard.jsx';
import TimelineModal from '../board/TimelineModal.jsx';
import FlagModal from '../components/FlagModal.jsx';
import IncidentModal from '../components/IncidentModal.jsx';
import IngestFailures from '../board/IngestFailures.jsx';
import { useLateOrders, useSecond } from '../board/clock.js';
import { clock, printProblem, shortNo, stateLabel } from '../board/format.js';
import '../components/ui.css';
import '../board/board.css';

const BoardMap = lazy(() => import('../board/BoardMap.jsx'));

/* ---------- small live components (each subscribes to the shared ticker on its own) ---------- */

function LateCount({ board, snapAt }) {
  const late = useLateOrders(board, snapAt);
  return <span className={`brd-chip ${late.length ? 'late' : ''}`} aria-live="polite">{late.length ? `${late.length} late` : 'None late'}</span>;
}

function LateBanner({ board, snapAt, onPick }) {
  const late = useLateOrders(board, snapAt);
  const prev = useRef(new Set());
  const seeded = useRef(false);
  const key = late.map((o) => o.id).join(',');
  useEffect(() => {
    if (!board) return;
    const ids = new Set(late.map((o) => o.id));
    if (seeded.current && [...ids].some((id) => !prev.current.has(id)) && board.settings.sound) playLate();
    seeded.current = true;
    prev.current = ids;
  }, [key, board]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!late.length) return null;
  return (
    <div className="brd-late" role="alert">
      <Icon name="warn" size={22} />
      <strong>{late.length} order{late.length === 1 ? ' is' : 's are'} late</strong>
      <span className="brd-late-list">
        {late.map((o) => <button key={o.id} type="button" onClick={() => onPick(o.id)}>#{shortNo(o.number)} {o.customer_name || ''} · {Math.floor(o.age_minutes + (Date.now() - snapAt) / 60000)} min</button>)}
      </span>
    </div>
  );
}

function BackIn({ iso, offset }) {
  useSecond();
  if (!iso) return <>estimating…</>;
  const left = (Date.parse(iso) - (Date.now() + offset)) / 1000;
  return left > 0 ? <>back in {clock(left)}</> : <>due back</>;
}

const summariseTick = (r, verb) => {
  if (r.skipped) return 'The batcher is already running. Try again in a moment.';
  const parts = [];
  if (r.assigned?.length) parts.push(`${r.assigned.length} run${r.assigned.length > 1 ? 's' : ''} sent to drivers`);
  if (r.preassigned?.length) parts.push(`${r.preassigned.length} lined up for drivers who are out`);
  if (r.waiting?.length) parts.push(`${r.waiting.length} batch${r.waiting.length > 1 ? 'es' : ''} still filling`);
  if (r.queued) parts.push(`${r.queued} order${r.queued > 1 ? 's' : ''} queued, no driver is free`);
  return parts.length ? parts.join(' · ') : `${verb}: nothing was waiting`;
};

/* ---------- the page ---------- */

export default function Board() {
  const { board, error, live, refresh } = useBoard();
  const { toast, node } = useToasts();
  const locked = useAudioLocked();
  const snapAt = useMemo(() => Date.now(), [board]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(() => new Set());
  const [moves, setMoves] = useState({});
  const [movingId, setMovingId] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [timelineId, setTimelineId] = useState(null);
  const [flagFor, setFlagFor] = useState(null);
  const [incidentFor, setIncidentFor] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [mapOpen, setMapOpen] = useState(() => localStorage.getItem('tad.brd.map') !== '0');
  const [topBusy, setTopBusy] = useState('');
  const seen = useRef(null);

  /* new-order chime: diff ids between snapshots, never on first load */
  useEffect(() => {
    if (!board) return;
    const live_ = board.orders.filter((o) => o.state !== 'scheduled');
    const ids = new Set(live_.map((o) => o.id));
    if (seen.current && live_.some((o) => !seen.current.has(o.id) && o.state === 'new') && board.settings.sound) playNewOrder();
    seen.current = ids;
  }, [board]);

  const offset = board ? Date.parse(board.now) - snapAt : 0;

  /* orders as the user currently sees them (a drag shows instantly, before the server confirms) */
  const orders = useMemo(() => {
    if (!board) return [];
    return board.orders.map((o) => {
      const mv = moves[o.id];
      if (mv === undefined || !['ready', 'assigned'].includes(o.state)) return o;
      return mv === null ? { ...o, state: 'ready', driver_id: null, batch_id: null, stop_seq: null } : { ...o, state: 'assigned', driver_id: mv, batch_id: null, stop_seq: 99 };
    });
  }, [board, moves]);

  const groups = useMemo(() => (board ? board.preview.map((p, index) => ({ ...p, index })) : []), [board]);
  const waitByOrder = useMemo(() => { const m = new Map(); groups.forEach((g) => g.order_ids.forEach((id) => m.set(id, g))); return m; }, [groups]);
  const batchStatus = useMemo(() => new Map((board?.batches || []).map((b) => [b.id, b.status])), [board]);

  const lanes = useMemo(() => {
    if (!board) return [];
    const list = [...board.drivers.available, ...board.drivers.busy, ...board.drivers.offline].map((d) => ({ ...d }));
    const known = new Set(list.map((d) => d.driver_id));
    orders.forEach((o) => { if (o.driver_id && ['assigned', 'out'].includes(o.state) && !known.has(o.driver_id)) { known.add(o.driver_id); list.push({ driver_id: o.driver_id, name: o.driver_id, unknown: true }); } });
    return list.map((d) => ({
      ...d,
      orders: orders.filter((o) => o.driver_id === d.driver_id && ['assigned', 'out'].includes(o.state))
        .sort((a, b) => (batchStatus.get(a.batch_id) === 'planned') - (batchStatus.get(b.batch_id) === 'planned') || (a.stop_seq ?? 99) - (b.stop_seq ?? 99)),
    }));
  }, [board, orders, batchStatus]);

  const pins = useMemo(() => orders.filter((o) => o.fulfilment === 'delivery' && ['ready', 'assigned', 'out'].includes(o.state) && o.lat != null && o.lng != null), [orders]);
  const driverOptions = useMemo(() => lanes.filter((l) => !l.unknown), [lanes]);

  /* ---- helpers ---- */
  const withBusy = useCallback(async (key, fn) => {
    setBusy((b) => new Set(b).add(key));
    try { return await fn(); } finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  }, []);

  const call = useCallback(async (key, fn, okMsg) => {
    return withBusy(key, async () => {
      try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); await refresh(); return r; }
      catch (e) { toast(e.message, 'err'); await refresh(); return undefined; }
    });
  }, [refresh, toast, withBusy]);

  const moveOrder = useCallback(async (orderId, driverId) => {
    setMoves((m) => ({ ...m, [orderId]: driverId }));
    setMovingId(orderId);
    try { await post('/api/batcher/move', { orderId, driverId }); await refresh(); }
    catch (e) { toast(e.message, 'err'); await refresh(); }
    finally { setMoves((m) => { const n = { ...m }; delete n[orderId]; return n; }); setMovingId(null); }
  }, [refresh, toast]);

  const transition = (order, to, extra = {}) => post(`/api/orders/${order.id}/transition`, { to, ...extra });

  const select = useCallback((id, scroll = false) => {
    setSelectedId((cur) => (id === null ? null : scroll ? id : cur === id ? null : id));
    if (id != null && scroll) requestAnimationFrame(() => document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
  }, []);

  const onAct = useCallback((kind, order) => {
    const key = `o${order.id}`;
    const ask = (cfg) => setDialog(cfg);
    switch (kind) {
      case 'accept': return call(key, () => transition(order, 'accepted'), `${order.number} accepted`);
      case 'preparing': return call(key, () => transition(order, 'preparing'));
      case 'ready': return call(key, () => transition(order, 'ready'), order.fulfilment === 'collection' ? `${order.number} is ready to collect` : `${order.number} is ready, the batcher will assign it`);
      case 'collected': return call(key, () => transition(order, 'collected'), `${order.number} collected`);
      case 'delivered': return call(key, () => transition(order, 'delivered'), `${order.number} delivered`);
      case 'failed': return ask({ title: `Mark ${order.number} as failed`, body: 'The customer will not receive this order. It moves to the Failed column so you can send it again or remove it.', field: { label: 'Why did the delivery fail?', required: true, placeholder: 'e.g. Nobody answered the door' }, confirmText: 'Mark as failed', danger: true, onSubmit: (reason) => call(key, () => transition(order, 'failed', { reason })) });
      case 'cancel': return ask({ title: `Cancel ${order.number}`, body: `${order.customer_name || 'This customer'}'s order will be cancelled.`, field: { label: 'Reason for cancelling', required: true, placeholder: 'e.g. Customer called to cancel' }, confirmText: 'Cancel order', cancelText: 'Keep order', danger: true, onSubmit: (reason) => call(key, () => transition(order, 'cancelled', { reason }), `${order.number} cancelled`) });
      case 'requeue': return call(key, () => post(`/api/orders/${order.id}/requeue`), `${order.number} is back in the Ready queue`);
      case 'remove': return ask({ title: `Remove ${order.number}`, body: 'The order leaves the board for good.', field: { label: 'Reason', required: false, placeholder: 'e.g. Customer refunded' }, confirmText: 'Remove', danger: true, onSubmit: (reason) => call(key, () => post(`/api/orders/${order.id}/remove`, reason ? { reason } : {}), `${order.number} removed`) });
      case 'timeline': return setTimelineId(order.id);
      case 'flag': return setFlagFor(order);
      case 'incident': return setIncidentFor(order);
      case 'label': {
        window.open(`/api/orders/${order.id}/label`, '_blank', 'noopener');
        return withBusy(key, async () => {
          try { await post(`/api/orders/${order.id}/print`); toast(`Label for ${order.number} sent to the printer`, 'ok'); }
          catch (e) { toast(printProblem(e), 'err'); }
        });
      }
      case 'wa': return call(key, async () => {
        const { link } = await get(`/api/orders/${order.id}/wa-link`);
        if (!window.open(link, '_blank', 'noopener')) throw new Error('The browser blocked the WhatsApp window. Allow pop-ups for this site and try again.');
      });
      default: return undefined;
    }
  }, [call, withBusy, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDragEnd = (r) => {
    const { destination: dst, source: src, draggableId } = r;
    if (!dst || dst.droppableId === src.droppableId) return;
    moveOrder(Number(draggableId.slice(1)), dst.droppableId === 'ready' ? null : dst.droppableId.slice(5));
  };

  /* ---- top bar actions ---- */
  const setShop = async (open) => {
    setTopBusy('shop');
    try {
      const r = await post(open ? '/api/shop/open' : '/api/shop/close');
      toast(open ? 'Shop is open' : `Shop is closed${r.removed?.length ? `. Removed ${r.removed.length} failed order${r.removed.length > 1 ? 's' : ''}` : ''}`, 'ok');
      await refresh();
    } catch (e) { toast(e.message, 'err'); } finally { setTopBusy(''); }
  };
  const toggleShop = () => {
    if (!board.settings.open) return setShop(true);
    const failedCount = board.orders.filter((o) => o.state === 'failed').length;
    return setDialog({ title: 'Close the shop?', body: `Closing the shop also removes failed orders that are still waiting on the board${failedCount ? ` (${failedCount} right now)` : ''}. Orders already in progress carry on.`, confirmText: 'Close the shop', danger: true, onSubmit: () => setShop(false) });
  };
  const batcher = async (what) => {
    setTopBusy(what);
    try { const r = await post(what === 'send' ? '/api/batcher/send-now' : '/api/batcher/tick'); toast(summariseTick(r, what === 'send' ? 'Send now' : 'Batcher'), 'ok'); await refresh(); }
    catch (e) { toast(e.message, 'err'); } finally { setTopBusy(''); }
  };
  const toggleSound = async () => {
    setTopBusy('sound');
    try { await put('/api/settings', { sound: !board.settings.sound }); await refresh(); } catch (e) { toast(e.message, 'err'); } finally { setTopBusy(''); }
  };
  const enableSound = async () => { const ok = await unlockAudio(); if (ok) playNewOrder(); else toast('The browser still blocks sound. Click anywhere on the page and try again.', 'err'); };
  const toggleMap = () => setMapOpen((o) => { localStorage.setItem('tad.brd.map', o ? '0' : '1'); return !o; });

  /* ---- render ---- */
  if (!board) {
    return (
      <div className="brd">
        {error ? <div className="err" role="alert">Could not load the board: {error.message} <button type="button" onClick={refresh}>Try again</button></div> : <p className="muted"><span className="ui-spin" /> Loading the board…</p>}
        {node}
      </div>
    );
  }

  const s = board.settings;
  const col = (title, count, children, cls = '', hint) => (
    <section className={`brd-col ${cls}`} aria-label={title}>
      <h3>{title}<span className="brd-count">{count}</span></h3>
      <div className="brd-col-body scroll">{count === 0 && hint ? <p className="brd-empty">{hint}</p> : null}{children}</div>
    </section>
  );
  const plain = (o, extra = {}) => <OrderCard key={o.id} order={o} snapAt={snapAt} settings={s} busy={busy.has(`o${o.id}`)} selected={selectedId === o.id} onAct={onAct} onSelect={select} {...extra} />;
  const movable = (o) => o.fulfilment === 'delivery' && (o.state === 'ready' || o.state === 'assigned');
  const draggable = (o, index, extra = {}) => (
    <Draggable key={o.id} draggableId={`o${o.id}`} index={index} isDragDisabled={!movable(o)}>
      {(p, snap) => <OrderCard order={o} snapAt={snapAt} settings={s} busy={busy.has(`o${o.id}`)} selected={selectedId === o.id} onAct={onAct} onSelect={select}
        drag={{ innerRef: p.innerRef, draggableProps: p.draggableProps, dragHandleProps: p.dragHandleProps, isDragging: snap.isDragging, locked: !movable(o) }} {...extra} />}
    </Draggable>
  );

  const newOrders = orders.filter((o) => o.state === 'new');
  const scheduled = orders.filter((o) => o.state === 'scheduled');
  const prep = orders.filter((o) => ['accepted', 'preparing'].includes(o.state));
  const ready = orders.filter((o) => o.state === 'ready');
  const failedOrders = orders.filter((o) => o.state === 'failed');
  const clocked = board.drivers.available.length + board.drivers.busy.length + board.drivers.offline.length;

  return (
    <div className="brd">
      {/* top bar */}
      <div className="brd-top">
        <button type="button" role="switch" aria-checked={s.open} className={`brd-switch ${s.open ? 'open' : 'closed'}`} onClick={toggleShop} disabled={topBusy === 'shop'}>
          <span className="knob" /><span className="lbl">{s.open ? 'OPEN' : 'CLOSED'}</span>
        </button>
        <span className={`brd-live ${live && !error ? 'on' : 'off'}`} title={live && !error ? 'Live: updates arrive instantly' : 'Connection lost, retrying'}><i />{live && !error ? 'Live' : 'Reconnecting…'}</span>
        <LateCount board={board} snapAt={snapAt} />
        {board.engine === 'local' && <span className="brd-chip warn" title="The route planner (VROOM) did not answer, so runs were sequenced locally">Route planner offline</span>}
        <span className="brd-spacer" />
        {s.sound && locked && <button type="button" className="primary" onClick={enableSound}><Icon name="bell" /> Enable sound</button>}
        <button type="button" onClick={toggleSound} disabled={topBusy === 'sound'} aria-pressed={s.sound}><Icon name={s.sound ? 'bell' : 'mute'} /> Sound {s.sound ? 'on' : 'off'}</button>
        <button type="button" onClick={() => batcher('tick')} disabled={topBusy === 'tick'}>{topBusy === 'tick' ? 'Running…' : 'Run batcher'}</button>
        <button type="button" className="dark" onClick={() => batcher('send')} disabled={topBusy === 'send'}>{topBusy === 'send' ? 'Sending…' : 'Send now'}</button>
      </div>

      {error && <div className="err" role="alert">Connection problem: {error.message}. Showing the last data received.</div>}
      <LateBanner board={board} snapAt={snapAt} onPick={(id) => select(id, true)} />
      <IngestFailures count={board.ingest_failures} onChanged={refresh} />

      {/* drivers strip */}
      <div className="brd-drivers" aria-label="Drivers">
        <span className="brd-drivers-h">Drivers</span>
        {clocked === 0 && <span className="muted">No drivers are clocked in. <Link to="/drivers">Clock a driver in</Link> so orders can be sent out.</span>}
        {board.drivers.available.map((d) => <span key={d.driver_id} className="brd-dchip avail"><i />{d.name || d.driver_id} · available</span>)}
        {board.drivers.busy.map((d) => <span key={d.driver_id} className="brd-dchip busy"><i />{d.name || d.driver_id} · {d.batch_status === 'out' ? <BackIn iso={d.return_eta_at} offset={offset} /> : 'collecting at the shop'}</span>)}
        {board.drivers.offline.map((d) => <span key={d.driver_id} className="brd-dchip off"><i />{d.name || d.driver_id} · offline</span>)}
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="brd-cols">
          {col('New', newOrders.length + scheduled.length, <>
            {newOrders.map((o) => plain(o))}
            {scheduled.length > 0 && <div className="brd-sched-h">Scheduled for later ({scheduled.length})</div>}
            {scheduled.map((o) => plain(o))}
          </>, '', 'No new orders')}
          {col('Accepted / Preparing', prep.length, prep.map((o) => plain(o)), '', 'Nothing in the kitchen')}
          <section className="brd-col" aria-label="Ready">
            <h3>Ready<span className="brd-count">{ready.length}</span></h3>
            <Droppable droppableId="ready">
              {(p, snap) => (
                <div ref={p.innerRef} {...p.droppableProps} className={`brd-col-body brd-drop ${snap.isDraggingOver ? 'over' : ''}`}>
                  {ready.length === 0 && <p className="brd-empty">Nothing waiting. Drop an assigned order here to take it back.</p>}
                  {ready.map((o, i) => draggable(o, i, { wait: o.fulfilment === 'delivery' ? waitByOrder.get(o.id) : undefined }))}
                  {p.placeholder}
                </div>
              )}
            </Droppable>
          </section>
          <section className="brd-col drivers" aria-label="With drivers">
            <h3>With drivers<span className="brd-count">{lanes.reduce((n, l) => n + l.orders.length, 0)}</span></h3>
            <div className="brd-lanes">
              {lanes.length === 0 && <p className="brd-empty">No drivers clocked in.</p>}
              {lanes.map((l) => (
                <div key={l.driver_id} className={`brd-lane ${l.batch_status === 'out' ? 'out' : ''}`}>
                  <div className="brd-lane-h">
                    <strong><Icon name="user" size={16} /> {l.name || l.driver_id}</strong>
                    {l.zone && <span className="brd-lane-zone">{l.zone}</span>}
                    <div className="brd-lane-sub">
                      {l.batch_status === 'out' ? <><span className="brd-badge out">Out</span> <BackIn iso={l.return_eta_at} offset={offset} /></>
                        : l.batch_status === 'assigned' ? <><span className="brd-badge shop">At the shop</span>
                          {l.batch_id && <button type="button" className="brd-mini" disabled={busy.has(`b${l.batch_id}`)} onClick={() => setDialog({ title: `Mark ${l.name || l.driver_id} as left the shop?`, body: 'Use this only if the driver has already gone and did not scan the bags in the app. The orders become Out for delivery.', confirmText: 'Mark as out', onSubmit: () => call(`b${l.batch_id}`, () => post(`/api/batcher/runs/${l.batch_id}/out`), 'Run marked as out') })}>Mark out</button>}</>
                          : <span className="brd-badge free">{l.unknown ? 'Not clocked in' : 'Free'}</span>}
                    </div>
                  </div>
                  <Droppable droppableId={`lane:${l.driver_id}`}>
                    {(p, snap) => (
                      <div ref={p.innerRef} {...p.droppableProps} className={`brd-lane-body brd-drop ${snap.isDraggingOver ? 'over' : ''}`}>
                        {l.orders.length === 0 && !snap.isDraggingOver && <p className="brd-empty">Drop an order here</p>}
                        {l.orders.map((o, i) => draggable(o, i, { stopNo: o.stop_seq === 99 ? '+' : o.stop_seq, nextRun: batchStatus.get(o.batch_id) === 'planned' }))}
                        {p.placeholder}
                      </div>
                    )}
                  </Droppable>
                </div>
              ))}
            </div>
          </section>
          {col('Failed', failedOrders.length, failedOrders.map((o) => plain(o)), 'failed', 'No failed deliveries')}
        </div>
      </DragDropContext>

      {/* map */}
      <section className="brd-mapsec" aria-label="Map">
        <div className="brd-mapbar">
          <h3>Map</h3>
          <span className="muted">{pins.length} pending {pins.length === 1 ? 'delivery' : 'deliveries'}</span>
          <span className="brd-spacer" />
          <button type="button" onClick={toggleMap} aria-expanded={mapOpen}>{mapOpen ? 'Hide map' : 'Show map'}</button>
        </div>
        <div hidden={!mapOpen}>
          <Suspense fallback={<p className="muted"><span className="ui-spin" /> Loading the map…</p>}>
            <BoardMap store={s.store} pins={pins} groups={groups} drivers={driverOptions} selectedId={selectedId} onSelect={(id) => select(id, true)} onMove={moveOrder} movingId={movingId} snapAt={snapAt} visible={mapOpen} />
          </Suspense>
        </div>
      </section>

      {/* recently completed */}
      <details className="brd-recent">
        <summary>Recently completed ({board.recent.length})</summary>
        {board.recent.length === 0 ? <p className="muted">Nothing completed in the last 6 hours.</p> : (
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Postcode</th><th>Result</th><th>Time</th><th /></tr></thead>
            <tbody>
              {board.recent.map((o) => (
                <tr key={o.id}>
                  <td>{o.number}</td><td>{o.customer_name || '—'}</td><td>{o.postcode || '—'}</td><td>{stateLabel(o.state)}</td>
                  <td>{dayjs(o.delivered_at || o.cancelled_at || o.created_at).format('HH:mm')}</td>
                  <td><button type="button" className="brd-mini" onClick={() => setTimelineId(o.id)}>Timeline</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      {dialog && <AskDialog {...dialog} onClose={() => setDialog(null)} />}
      {timelineId != null && <TimelineModal orderId={timelineId} onClose={() => setTimelineId(null)} />}
      {flagFor && <FlagModal initial={{ phone: flagFor.customer_phone || '', line1: flagFor.address_line || '', postcode: flagFor.postcode || '', kind: flagFor.customer_phone ? 'phone' : 'address' }} onClose={() => setFlagFor(null)} onDone={() => { toast('Saved. See it under Flags.', 'ok'); refresh(); }} />}
      {incidentFor && <IncidentModal orderId={incidentFor.id} orderNumber={incidentFor.number} driverId={incidentFor.driver_id || ''} drivers={[...(board.drivers?.available || []), ...(board.drivers?.busy || []), ...(board.drivers?.offline || [])].map((d) => ({ id: d.driver_id, name: d.name }))} onClose={() => setIncidentFor(null)} onDone={() => { toast('Incident saved', 'ok'); refresh(); }} />}
      {node}
    </div>
  );
}
