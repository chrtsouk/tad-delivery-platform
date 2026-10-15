/** Dispatch: deliveries to customers, who is going where. Waiting drops, runs by postcode and room, drivers, and the people who order direct. */
import * as api from '../api.js';
import {
  h, card, tabs, table, badge, hint, field, input, select, checkbox, tryCatch, modal, confirmModal, mount, ok,
} from '../ui.js';
import { can } from '../perm.js';
import { uk } from '../fmt.js';

const clock = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '—');
const STATE = { free: ['free', 'green'], loaded: ['loaded', 'amber'], on_run: ['on a run', 'blue'], off: ['off', 'grey'] };

export default async function dispatchPage({ tab = 'board', state, refresh }) {
  const nav = tabs([
    { href: '#/dispatch', label: 'Board' },
    { href: '#/dispatch/drivers', label: 'Drivers' },
    ...(can(state.user, 'reports') ? [{ href: '#/dispatch/customers', label: 'Customers' }] : []),
  ], `#/dispatch${tab === 'board' ? '' : `/${tab}`}`);
  const body = tab === 'drivers' ? await driversTab(state, refresh)
    : tab === 'customers' ? (can(state.user, 'reports') ? await customersTab(state, refresh) : hint('The customer list is for managers. You can still type a customer in on a new delivery.'))
      : await boardTab(state, refresh);
  return h('div',
    h('div.page-head', h('div', h('h1', 'Dispatch'), h('div.sub', 'Deliveries to your customers: who is going where'))),
    nav, body);
}

/* ------------------------------------------------------------------ board */

async function boardTab(state, refresh) {
  const holder = h('div');
  const load = async () => api.get('/dispatch');

  const reload = async () => draw(await load());

  const msgModal = async (d) => {
    const got = await api.get(`/dispatch/deliveries/${d.id}/messages`);
    const text = input({ placeholder: 'Write a message', maxlength: '300' });
    const list = h('div.stack');
    const show = (msgs) => mount(list, msgs.length ? msgs.map((m) => h('div',
      h('b', m.from_kind === 'customer' ? 'Customer' : m.from_name || m.from_kind), ' ',
      m.audience === 'all' ? badge('customer sees', 'blue') : badge('team only', 'grey'),
      h('div', m.body))) : h('div.faint', 'No messages yet.'));
    show(got.messages);
    const send = async (audience) => {
      const r = await tryCatch(() => api.post(`/dispatch/deliveries/${d.id}/messages`, { body: text.value, audience }));
      if (r) { text.value = ''; show((await api.get(`/dispatch/deliveries/${d.id}/messages`)).messages); }
    };
    const m = modal({
      title: `Messages — ${d.recipient || 'delivery'}`,
      body: h('div.stack', list, field('New message', text),
        hint('"To the team" is seen by the office and the driver only. "To the customer" also shows on their tracking page, if tracking is switched on.'),
        h('div.faint', 'Tracking link for the customer: ', h('code', got.tracking_path))),
      actions: [h('button.btn.btn-ghost', { onclick: () => { m.close(); reload(); } }, 'Close'),
        h('button.btn', { onclick: () => send('team') }, 'To the team'),
        h('button.btn.btn-primary', { onclick: () => send('all') }, 'To the customer')],
    });
  };

  const reasonModal = (title, path, label) => {
    const why = input({ placeholder: 'Why?' });
    const m = modal({
      title, body: h('div.stack', field('Reason', why)),
      actions: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Back'),
        h('button.btn.btn-danger', { onclick: async () => { const r = await tryCatch(() => api.post(path, { reason: why.value })); if (r) { m.close(); reload(); } } }, label)],
    });
  };

  const act = async (path, body = {}, success = null) => {
    const r = await tryCatch(() => api.post(path, body), success ? { success } : {});
    if (r) await reload();
    return r;
  };

  const assignTo = async (driverId, ids) => {
    try {
      await api.post('/dispatch/assign', { driver_id: driverId, ids });
      ok('Given out');
      await reload();
    } catch (e) {
      if (e && e.details && e.details.over) {
        confirmModal('Over their limit', `${e.message}`, async () => {
          await tryCatch(() => api.post('/dispatch/assign', { driver_id: driverId, ids, allow_over: true }), { success: 'Given out' });
          await reload();
        }, { yes: 'Send them anyway', tone: 'btn-primary' });
      } else { await tryCatch(async () => { throw e; }); }
    }
  };

  const tag = (d) => h('span',
    d.late_for_promise ? badge('late', 'red') : null, ' ',
    d.waiting_minutes !== null ? h('span.faint', `${d.waiting_minutes} min`) : null);

  const dropCard = (d, drivers) => {
    const pick = select([{ value: '', label: 'Give to…' }, ...drivers.map((x) => ({ value: x.id, label: `${x.name}${x.room === null ? '' : ` (room ${x.room})`}` }))], {});
    const buttons = [];
    if (d.status === 'waiting') {
      buttons.push(pick, h('button.btn.btn-sm.btn-primary', { onclick: () => { if (pick.value) assignTo(pick.value, [d.id]); } }, 'Give out'));
    }
    if (d.status === 'assigned') buttons.push(h('button.btn.btn-sm', { onclick: () => act(`/dispatch/deliveries/${d.id}/unassign`) }, 'Take back'));
    if (d.status === 'out') {
      buttons.push(h('button.btn.btn-sm.btn-success', { onclick: () => act(`/dispatch/deliveries/${d.id}/delivered`, {}, 'Delivered') }, 'Delivered'),
        h('button.btn.btn-sm', { onclick: () => reasonModal('It could not be delivered', `/dispatch/deliveries/${d.id}/failed`, 'Mark failed') }, 'Failed'));
    }
    buttons.push(h('button.btn.btn-sm.btn-ghost', { onclick: () => msgModal(d) }, d.unread_messages ? `Messages (${d.unread_messages} new)` : 'Messages'));
    if (d.status !== 'delivered') buttons.push(h('button.btn.btn-sm.btn-ghost', { onclick: () => reasonModal('Cancel this delivery?', `/dispatch/deliveries/${d.id}/cancel`, 'Cancel it') }, 'Cancel'));
    return h('div.card.mb-2',
      h('div.card-body.p-2',
        h('div.row.between', h('b', `${d.recipient || '—'} · ${d.area}`), tag(d)),
        h('div', d.address ? `${d.address}, ${d.postcode}` : d.postcode),
        h('div.faint', `${d.driver_name ? `${d.driver_name} · ` : ''}${d.items} item(s)${d.order_number ? ` · order #${d.order_number}` : ''}${d.phone ? ` · ${d.phone}` : ''}${d.promised_at ? ` · promised ${clock(d.promised_at)}` : ''}`),
        d.note ? h('div', h('b', 'Note: '), d.note) : null,
        h('div.row.tight.mt', buttons)));
  };

  const suggestModal = async () => {
    const s = await api.get('/dispatch/suggest');
    if (!s.runs.length) { ok(s.left.length ? 'Nobody has room for what is waiting' : 'Nothing waiting'); return; }
    const m = modal({
      wide: true, title: 'Suggested runs',
      body: h('div.stack',
        ...s.runs.map((r) => card(`${r.driver_name} · ${r.items} item(s) · ${r.areas.join(', ')}${r.over ? ' · over their limit' : ''}`,
          h('div.stack',
            ...r.stops.map((p) => h('div', `${p.recipient || '—'} · ${p.postcode} · ${p.items} item(s)`)),
            h('div.row', h('button.btn.btn-primary', {
              onclick: async () => { m.close(); await assignTo(r.driver_id, r.delivery_ids); },
            }, `Give these to ${r.driver_name}`))))),
        s.left.length ? hint(`${s.left.length} drop(s) are left for the next run: ${s.left.map((d) => `${d.recipient || ''} ${d.postcode}`).join(', ')}`) : null,
        hint(s.note)),
      actions: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Close')],
    });
  };

  const newDelivery = async () => {
    const pass = await api.get('/pass').catch(() => ({ orders: [] }));
    const linked = await api.get('/dispatch').catch(() => ({ waiting: [], assigned: [], out: [] }));
    const used = new Set([...linked.waiting, ...linked.assigned, ...linked.out].map((x) => x.kitchen_order_id).filter(Boolean));
    const orderSel = select([{ value: '', label: 'Not linked to an order on the pass' },
      ...pass.orders.filter((o) => !used.has(o.id)).map((o) => ({ value: o.id, label: `#${o.number} · ${o.lines.map((l) => `${l.qty}× ${l.name}`).join(', ').slice(0, 60)}` }))], {});
    const f = {
      recipient: input({ placeholder: 'Name' }), phone: input({ placeholder: '07… (so the driver can ring)' }),
      address: input({ placeholder: 'House number and street' }), postcode: input({ placeholder: 'SW11 1AB' }),
      items: input({ type: 'number', min: '1', step: '1', placeholder: 'from the order, or 1' }),
      promised: input({ type: 'time' }), note: input({ placeholder: 'Gate code, ring twice, leave with neighbour…' }),
    };
    const remember = checkbox('Remember this customer (by phone number)', { checked: false });
    const m = modal({
      wide: true, title: 'New delivery',
      body: h('div.stack', field('For the order', orderSel),
        h('div.form-grid', field('Name', f.recipient), field('Phone', f.phone), field('Address', f.address), field('Postcode', f.postcode),
          field('Items', f.items), field('Promised by', f.promised)),
        field('Note for the driver', f.note), remember,
        hint('The postcode groups drops into runs: the same area first, then the next district of the same letters.')),
      actions: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            // "01:30" typed at 00:50 is half an hour from now, not 01:30 on the trading day (which was yesterday): the nearest such time that is not long past
            let promised_at;
            if (f.promised.value) {
              const [hh, mm] = f.promised.value.split(':').map(Number);
              const at = new Date(); at.setHours(hh, mm, 0, 0);
              if (at.getTime() < Date.now() - 12 * 3600000) at.setDate(at.getDate() + 1);
              promised_at = at.toISOString();
            }
            const body = {
              kitchen_order_id: orderSel.value || undefined, recipient: f.recipient.value, phone: f.phone.value, address: f.address.value,
              postcode: f.postcode.value, items: f.items.value || undefined, promised_at, note: f.note.value, remember: remember.checked || undefined,
            };
            const r = await tryCatch(() => api.post('/dispatch/deliveries', body), { success: 'Added to the board' });
            if (r) { m.close(); reload(); }
          },
        }, 'Add to the board')],
    });
  };

  function draw(b) {
    const col = (title, items, build) => card(`${title} (${items.length})`, items.length ? h('div', items.map(build)) : h('div.faint', 'None.'));
    const byDriver = {};
    for (const d of b.assigned) (byDriver[d.driver_id] = byDriver[d.driver_id] || []).push(d);
    const loaded = h('div', Object.keys(byDriver).length ? Object.entries(byDriver).map(([id, list]) => {
      const drv = b.drivers.find((x) => x.id === id);
      return h('div.mb-3',
        h('div.row.between', h('b', `${drv ? drv.name : 'Driver'} · ${list.reduce((a, d) => a + d.items, 0)} item(s)`),
          h('button.btn.btn-sm.btn-primary', { onclick: () => act(`/dispatch/drivers/${id}/out`, {}, 'Out for delivery') }, 'Driver leaves')),
        ...list.map((d) => dropCard(d, b.drivers)));
    }) : h('div.faint', 'None.'));
    mount(holder,
      h('div.row.between.mb-2',
        h('div', h('b', `${b.waiting.length} waiting`), h('span.faint', `  ·  ${b.delivered_tonight} delivered tonight${b.failed_tonight ? `  ·  ${b.failed_tonight} failed` : ''}${b.median_minutes !== null ? `  ·  middle time ${b.median_minutes} min` : ''}`)),
        h('div.row.tight',
          h('button.btn', { onclick: suggestModal }, 'Suggest runs'),
          h('button.btn.btn-primary', { onclick: newDelivery }, '+ New delivery'))),
      b.drivers.length ? h('div.row.tight.mb-2', b.drivers.map((d) => h('span', `${d.name} `, badge(STATE[d.state][0], STATE[d.state][1]), d.room !== null ? h('span.faint', ` room ${d.room}`) : null))) : hint('No drivers yet. Add them on the Drivers tab.', 'warn'),
      h('div.grid.wide',
        col('Waiting', b.waiting, (d) => dropCard(d, b.drivers)),
        card(`Loaded (${b.assigned.length})`, loaded),
        col('Out', b.out, (d) => dropCard(d, b.drivers))),
      b.failed.length ? card(`Could not be delivered (${b.failed.length})`, h('div.stack',
        hint('Put each one back on the board to try again, or cancel it. Nothing is lost until you decide.', 'warn'),
        ...b.failed.map((d) => h('div.row.between',
          h('span', h('b', d.recipient || d.postcode), ` · ${d.area} · ${d.failed_reason || 'no reason given'}`),
          h('div.row.tight',
            h('button.btn.btn-sm.btn-primary', { onclick: () => act(`/dispatch/deliveries/${d.id}/requeue`, {}, 'Back on the board') }, 'Try again'),
            h('button.btn.btn-sm.btn-ghost', { onclick: () => reasonModal('Cancel this delivery?', `/dispatch/deliveries/${d.id}/cancel`, 'Cancel it') }, 'Cancel')))))) : null,
      b.closed_tonight.length ? card('Finished tonight', table([
        { key: 'recipient', label: 'For' }, { key: 'area', label: 'Area' }, { key: 'driver_name', label: 'Driver' },
        { key: 'status', label: '', render: (d) => (d.status === 'delivered' ? badge('delivered', 'green') : badge(d.status, 'red')) },
        { key: 'took', label: 'Took', render: (d) => (d.took_minutes !== null ? `${d.took_minutes} min` : d.failed_reason || '—') },
      ], b.closed_tonight, { cls: 'table-compact' })) : null);
  }

  draw(await load());

  const timer = window.setInterval(() => {
    if (!document.body || !document.body.contains(holder)) { window.clearInterval(timer); return; }
    reload().catch(() => {});
  }, 10000);

  return h('div',
    hint('Drops waiting for a driver, who has what, and what is out. A run is built from the oldest waiting drop and the postcodes nearest to it, within each driver\'s limit '
      + '(set on the Drivers tab). There is no map: "near" means the same postcode area, then the next district of the same letters. '
      + 'When a driver leaves with a drop, its order is marked gone on the kitchen pass.'),
    holder);
}

/* ---------------------------------------------------------------- drivers */

async function driversTab(state, refresh) {
  const d = await api.get('/drivers');
  const owner = can(state.user, '*');

  const edit = (existing) => {
    const f = {
      name: input({ value: existing ? existing.name : '' }), phone: input({ value: existing && existing.phone ? existing.phone : '', placeholder: '07…' }),
      vehicle: input({ value: existing && existing.vehicle ? existing.vehicle : '', placeholder: 'Scooter, car, bike' }),
      max: input({ type: 'number', min: '1', step: '1', value: existing && existing.max_items ? existing.max_items : '', placeholder: 'blank = no limit' }),
    };
    const active = checkbox('Working', { checked: existing ? existing.active : true });
    const m = modal({
      title: existing ? `Change ${existing.name}` : 'New driver',
      body: h('div.stack',
        h('div.form-grid', field('Name', f.name), field('Phone', f.phone), field('Vehicle', f.vehicle), field('Most items on one run', f.max)),
        existing ? active : null,
        hint('The limit is yours to set: a bag of wings on a scooter is not a car boot. Blank means no limit.')),
      actions: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const body = { name: f.name.value, phone: f.phone.value, vehicle: f.vehicle.value, max_items: f.max.value, active: existing ? active.checked : undefined };
            const r = await tryCatch(() => (existing ? api.put(`/drivers/${existing.id}`, body) : api.post('/drivers', body)), { success: 'Saved' });
            if (r) { m.close(); refresh(); }
          },
        }, 'Save')],
    });
  };

  const newKey = async (drv) => {
    const r = await tryCatch(() => api.post(`/drivers/${drv.id}/key`, {}));
    if (!r) return;
    const m = modal({
      title: `Driver-app key for ${drv.name}`,
      body: h('div.stack', h('div', 'Copy it into the driver app now. It is not shown again, and any older key for this driver stops working.'), h('code', { style: 'font-size:1.1rem;word-break:break-all' }, r.key)),
      actions: [h('button.btn.btn-primary', { onclick: () => { m.close(); refresh(); } }, 'I have copied it')],
    });
  };

  return h('div',
    hint('The people who drive. Each can be given a key for the driver app, which sees only their own run. Customers\' addresses and phone numbers are shown to the driver for their own drops only.'),
    card('Drivers', h('div.stack',
      table([
        { key: 'name', label: 'Name', render: (x) => h('span', x.name, ' ', x.active ? '' : badge('not working', 'grey')) },
        { key: 'phone', label: 'Phone' }, { key: 'vehicle', label: 'Vehicle' },
        { key: 'max_items', label: 'Limit', render: (x) => (x.max_items ? `${x.max_items} items` : 'none') },
        { key: 'state', label: 'Now', render: (x) => badge(STATE[x.state][0], STATE[x.state][1]) },
        { key: 'seen', label: 'Last seen', render: (x) => (x.last_seen_at ? `${uk(x.last_seen_at.slice(0, 10))} ${clock(x.last_seen_at)}` : '—') },
        { key: 'key', label: 'App key', render: (x) => (x.has_key ? badge('set', 'green') : badge('none', 'grey')) },
        {
          key: 'act', label: '',
          render: (x) => h('div.row.tight',
            h('button.btn.btn-sm', { onclick: () => edit(x) }, 'Change'),
            owner ? h('button.btn.btn-sm', { onclick: () => newKey(x) }, x.has_key ? 'New key' : 'Make key') : null,
            owner && x.has_key ? h('button.btn.btn-sm.btn-ghost', { onclick: async () => { await tryCatch(() => api.del(`/drivers/${x.id}/key`), { success: 'Key revoked' }); refresh(); } }, 'Revoke') : null),
        },
      ], d.drivers, { cls: 'table-compact', empty: 'No drivers yet.' }),
      can(state.user, 'staff') ? h('div.row', h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ New driver')) : null)));
}

/* -------------------------------------------------------------- customers */

async function customersTab(state, refresh) {
  const q = input({ placeholder: 'Search name, phone or postcode' });
  const holder = h('div');
  const owner = can(state.user, '*');

  const edit = (existing) => {
    const f = {
      name: input({ value: existing ? existing.name : '' }), phone: input({ value: existing && existing.phone ? existing.phone : '' }),
      email: input({ value: existing && existing.email ? existing.email : '' }), address: input({ value: existing && existing.address ? existing.address : '' }),
      postcode: input({ value: existing && existing.postcode ? existing.postcode : '' }), note: input({ value: existing && existing.note ? existing.note : '' }),
    };
    const mk = checkbox('Happy to receive offers', { checked: existing ? existing.marketing_ok : false });
    const m = modal({
      wide: true, title: existing ? `Change ${existing.name}` : 'New customer',
      body: h('div.stack', h('div.form-grid', field('Name', f.name), field('Phone', f.phone), field('Email', f.email), field('Address', f.address), field('Postcode', f.postcode), field('Note', f.note)), mk),
      actions: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'),
        h('button.btn.btn-primary', {
          onclick: async () => {
            const body = { name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, postcode: f.postcode.value, note: f.note.value, marketing_ok: mk.checked };
            const r = await tryCatch(() => (existing ? api.put(`/customers/${existing.id}`, body) : api.post('/customers', body)), { success: 'Saved' });
            if (r) { m.close(); search(); }
          },
        }, 'Save')],
    });
  };

  const erase = (c) => confirmModal(`Erase ${c.name}?`,
    'Their name, phone, email, address and notes are removed for good, here and on every delivery made to them. The delivery times and areas stay. This cannot be undone.',
    async () => { await tryCatch(() => api.post(`/customers/${c.id}/erase`, {}), { success: 'Erased' }); search(); }, { yes: 'Erase for good' });

  async function search() {
    const r = await api.get(`/customers${api.qs({ q: q.value })}`);
    mount(holder, table([
      { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address', render: (c) => [c.address, c.postcode].filter(Boolean).join(', ') || '—' },
      { key: 'marketing_ok', label: 'Offers', render: (c) => (c.marketing_ok ? 'yes' : 'no') },
      { key: 'act', label: '', render: (c) => h('div.row.tight', h('button.btn.btn-sm', { onclick: () => edit(c) }, 'Change'), owner ? h('button.btn.btn-sm.btn-ghost', { onclick: () => erase(c) }, 'Erase') : null) },
    ], r.customers, { cls: 'table-compact', empty: 'No customers saved yet. Tick "Remember this customer" when you add a delivery.' }));
  }
  q.addEventListener('input', () => { search(); });
  await search();

  return h('div',
    hint('People who order direct from you (never delivery-platform customers: those apps hide theirs). This is personal data: keep only what you need, and erase a person on request.'),
    card('Customers', h('div.stack', h('div.row', q, h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ New customer')), holder)));
}
