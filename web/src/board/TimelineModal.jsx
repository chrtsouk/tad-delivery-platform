import React, { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import Modal from '../components/Modal.jsx';
import { get } from '../lib/api.js';
import { eventDetail, eventLabel, itemsSummary, sourceLabel, stateLabel } from './format.js';

/** GET /api/orders/:id -> the order plus its event timeline. */
export default function TimelineModal({ orderId, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    get(`/api/orders/${orderId}`).then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [orderId]);
  const o = data?.order;
  return (
    <Modal title={o ? `Order ${o.number}` : 'Order timeline'} onClose={onClose} wide footer={<button type="button" onClick={onClose}>Close</button>}>
      {err && <div className="err" role="alert">{err}</div>}
      {!data && !err && <p className="muted"><span className="ui-spin" /> Loading…</p>}
      {o && (
        <>
          <p className="brd-tl-sum">
            <strong>{o.customer_name || 'No name'}</strong> · {stateLabel(o.state)} · {o.fulfilment === 'collection' ? 'Collection' : 'Delivery'} · {sourceLabel(o.source)}<br />
            {o.address_line && <>{o.address_line}, {o.postcode}<br /></>}
            {itemsSummary(o.items)}
            {o.notes && <><br /><em>Note: {o.notes}</em></>}
          </p>
          {data.timeline.length === 0 ? <p className="ui-empty">No events yet.</p> : (
            <ol className="brd-tl">
              {data.timeline.map((e, i) => (
                <li key={i}>
                  <time dateTime={e.at}>{dayjs(e.at).format('HH:mm:ss')}</time>
                  <div><strong>{eventLabel(e.type)}</strong>{eventDetail(e) && <span className="muted"> — {eventDetail(e)}</span>}</div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Modal>
  );
}
