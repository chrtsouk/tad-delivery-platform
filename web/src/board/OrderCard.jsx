import React, { useState } from 'react';
import dayjs from 'dayjs';
import Icon from '../components/Icon.jsx';
import { ageMinutes, useSecond, useSla } from './clock.js';
import { clock, itemsSummary, shortNo, sourceLabel } from './format.js';

function AgeTimer({ order, snapAt }) {
  useSecond();
  return <span className="brd-age" title="Time since accepted">{clock(ageMinutes(order, snapAt) * 60)}</span>;
}

/** "Batch 2 · waits 1:12" counting down from the snapshot. */
function WaitBadge({ info, snapAt }) {
  useSecond();
  if (!info) return <div className="brd-wait queue">Waiting for the batcher…</div>;
  const left = info.waits_seconds - (Date.now() - snapAt) / 1000;
  const label = `Batch ${info.index + 1}`;
  if (info.full) return <div className="brd-wait ripe">{label} · full, sending now</div>;
  if (info.ripe || left <= 0) return <div className="brd-wait ripe">{label} · sending when a driver is free</div>;
  return <div className="brd-wait">{label} · waits {clock(left)}</div>;
}

/**
 * One order. `drag` (optional) carries react-beautiful-dnd props; `onAct(kind, order)` is every button on the card.
 */
export default function OrderCard({ order, snapAt, settings, stopNo, nextRun, wait, busy, selected, onAct, onSelect, drag }) {
  const level = useSla(order, snapAt, settings);
  const [menu, setMenu] = useState(false);
  const isCollection = order.fulfilment === 'collection';
  const st = order.state;
  const act = (kind) => (e) => { e.stopPropagation(); onAct(kind, order); };
  const dragging = Boolean(drag?.isDragging);
  const cls = ['brd-card', `sla-${level}`, isCollection ? 'collection' : 'delivery', selected ? 'selected' : '', dragging ? 'dragging' : '', drag && !drag.locked ? 'draggable' : ''].filter(Boolean).join(' ');

  return (
    <article
      ref={drag?.innerRef} {...(drag?.draggableProps || {})} {...(drag?.dragHandleProps || {})}
      id={`card-${order.id}`} className={cls} onClick={() => onSelect?.(order.id)}
      aria-label={`Order ${order.number}, ${order.customer_name || 'no name'}, ${isCollection ? 'collection' : 'delivery'}`}
    >
      <div className="brd-card-head">
        {stopNo != null && <span className="brd-stop" title="Stop number on the run">{stopNo}</span>}
        <span className="brd-no" title={order.number}>#{shortNo(order.number)}</span>
        <span className={`brd-kind ${isCollection ? 'col' : 'del'}`}><Icon name={isCollection ? 'bag' : 'bike'} size={14} />{isCollection ? 'Collection' : 'Delivery'}</span>
        <span className="brd-spacer" />
        {order.sla !== 'done' && st !== 'scheduled' && <span className={`brd-timer ${level}`}><Icon name="clock" size={14} /> <AgeTimer order={order} snapAt={snapAt} /></span>}
        {st === 'scheduled' && <span className="brd-timer"><Icon name="clock" size={14} /> {dayjs(order.scheduled_for).format('ddd HH:mm')}</span>}
        {st === 'failed' && order.failed_at && <span className="brd-timer late">Failed {dayjs(order.failed_at).format('HH:mm')}</span>}
      </div>

      <div className="brd-who"><strong>{order.customer_name || 'No name'}</strong>{order.postcode && <span className="brd-pc">{order.postcode}</span>}<span className="brd-src">{sourceLabel(order.source)}</span></div>
      {order.flag && <div className={`brd-flag ${order.flag.level}`} role="alert"><Icon name="warn" size={14} /> {order.flag.level === 'blocked' ? 'Blocked customer' : 'Flagged customer'}: {order.flag.reasons.join('; ')}</div>}
      {order.address_line && <div className="brd-addr">{order.address_line}</div>}
      <div className="brd-items" title={itemsSummary(order.items)}>{itemsSummary(order.items)}</div>
      {order.custom_view?.length > 0 && <div className="brd-custom">{order.custom_view.map((c) => <div key={c.key}><strong>{c.label}:</strong> {c.value}</div>)}</div>}
      {order.notes && <div className="brd-notes"><Icon name="warn" size={14} /> {order.notes}</div>}
      {nextRun && <div className="brd-nextrun">Next run — waiting for the driver to return</div>}
      {wait !== undefined && st === 'ready' && !isCollection && <WaitBadge info={wait} snapAt={snapAt} />}
      {st === 'ready' && isCollection && <div className="brd-wait col">Waiting for the customer to collect</div>}
      {st === 'failed' && (
        <div className="brd-fail">
          <div><strong>Reason:</strong> {order.fail_reason || 'No reason given'}</div>
          {order.fail_photo && <a href={`/api/uploads/${encodeURIComponent(order.fail_photo)}`} target="_blank" rel="noreferrer"><img src={`/api/uploads/${encodeURIComponent(order.fail_photo)}`} alt={`Photo from the driver for order ${order.number}`} loading="lazy" /></a>}
        </div>
      )}

      <div className="brd-actions">
        {st === 'new' && <button type="button" className="primary" disabled={busy} onClick={act('accept')}>Accept</button>}
        {st === 'accepted' && <><button type="button" className="primary" disabled={busy} onClick={act('ready')}>Ready</button><button type="button" disabled={busy} onClick={act('preparing')}>Preparing</button></>}
        {st === 'preparing' && <button type="button" className="primary" disabled={busy} onClick={act('ready')}>Ready</button>}
        {st === 'ready' && isCollection && <button type="button" className="primary" disabled={busy} onClick={act('collected')}>Collected</button>}
        {st === 'out' && <><button type="button" className="ok-btn" disabled={busy} onClick={act('delivered')}>Delivered</button><button type="button" className="danger" disabled={busy} onClick={act('failed')}>Failed</button></>}
        {st === 'failed' && <><button type="button" className="dark" disabled={busy} onClick={act('requeue')}>Back to queue</button><button type="button" className="danger" disabled={busy} onClick={act('remove')}>Remove</button></>}
        {['scheduled', 'new', 'accepted', 'preparing', 'ready', 'assigned'].includes(st) && <button type="button" disabled={busy} onClick={act('cancel')}>Cancel</button>}
        <button type="button" className="brd-more" aria-label="More actions" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}><Icon name="more" /></button>
      </div>
      {menu && (
        <div className="brd-menu">
          <button type="button" onClick={act('label')}>Print label</button>
          <button type="button" onClick={act('wa')} disabled={!order.customer_phone} title={order.customer_phone ? '' : 'No phone number on this order'}>WhatsApp</button>
          <button type="button" onClick={act('timeline')}>Timeline</button>
          <button type="button" onClick={act('flag')} disabled={!order.customer_phone && !order.address_line} title="Flag or block this customer or address">Flag customer</button>
          <button type="button" onClick={act('incident')}>Report incident</button>
        </div>
      )}
    </article>
  );
}
