import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { tokenFromLocation } from './api.js';
import { useOrder, useInbox } from './hooks.js';
import { headline, queueText, etaText, placedText, viewSteps, waDigits } from './format.js';
import Notify from './Notify.jsx';
import Rating from './Rating.jsx';

const TrackMap = lazy(() => import('./TrackMap.jsx'));

const LOGO = '/brand/texas-after-dark-black-bg.svg';

function Header({ number }) {
  return (
    <header className="top">
      <img src={LOGO} alt="Texas After Dark" className="logo" width="44" height="44" />
      <div className="top-text">
        <span className="top-label">Order</span>
        <strong className="top-number">{number || '—'}</strong>
      </div>
    </header>
  );
}

function Skeleton() {
  return (
    <main className="wrap" aria-busy="true" aria-label="Loading your order">
      <div className="card sk"><i className="sk-line w60" /><i className="sk-line w90 tall" /><i className="sk-line w40" /></div>
      <div className="card sk"><i className="sk-line w100 map" /></div>
      <div className="card sk"><i className="sk-line w70" /><i className="sk-line w50" /><i className="sk-line w60" /></div>
    </main>
  );
}

function Steps({ steps, finished }) {
  return (
    <ol className="steps" aria-label="Order progress">
      {steps.map((s) => (
        <li key={s.key} className={`step${s.done ? ' done' : ''}${s.current ? ' current' : ''}${s.current && finished ? ' final' : ''}`} aria-current={s.current ? 'step' : undefined}>
          <span className="bullet" aria-hidden="true">{s.done && (!s.current || finished) ? '✓' : ''}</span>
          <span className="step-label">{s.label}<span className="sr-only">{s.current ? ' (current step)' : s.done ? ' (done)' : ' (to do)'}</span></span>
        </li>
      ))}
    </ol>
  );
}

function Contact({ order }) {
  const { store, driver } = order;
  const showDriver = order.state === 'out' && driver?.phone;
  const shopWa = waDigits(store?.phone);
  const drvWa = waDigits(driver?.phone);
  if (!store?.phone && !showDriver) return null;
  return (
    <section className="card" aria-labelledby="help-h">
      <h2 id="help-h">Need to talk to someone?</h2>
      <div className="actions">
        {showDriver && <a className="btn btn-primary" href={`tel:${driver.phone}`}>Call {driver.first_name || 'driver'}</a>}
        {showDriver && <a className="btn btn-ghost" href={`sms:${driver.phone}`}>Message {driver.first_name || 'driver'}</a>}
        {showDriver && drvWa && <a className="btn btn-ghost" href={`https://wa.me/${drvWa}`} target="_blank" rel="noopener noreferrer">WhatsApp driver</a>}
        {store?.phone && <a className={`btn ${showDriver ? 'btn-ghost' : 'btn-primary'}`} href={`tel:${store.phone}`}>Call the shop</a>}
        {store?.phone && shopWa && <a className="btn btn-ghost" href={`https://wa.me/${shopWa}`} target="_blank" rel="noopener noreferrer">WhatsApp the shop</a>}
      </div>
    </section>
  );
}

function Items({ order }) {
  const placed = placedText(order.placed_at);
  return (
    <section className="card" aria-labelledby="items-h">
      <h2 id="items-h">Your order</h2>
      <ul className="items">
        {(order.items || []).map((i, k) => (<li key={k}><span className="qty">{i.qty}×</span> {i.name}</li>))}
      </ul>
      {placed && <p className="muted small">{placed}</p>}
    </section>
  );
}

function Banners({ banners, dismiss }) {
  if (!banners.length) return null;
  return (
    <div className="banners" role="status" aria-live="polite">
      {banners.map((m) => (
        <div className="banner" key={m.id}>
          <div><strong>{m.title}</strong><span>{m.body}</span></div>
          <button type="button" className="x" onClick={() => dismiss(m.id)} aria-label="Dismiss message">×</button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const token = useMemo(() => tokenFromLocation(), []);
  const { order, error, offline, loading, retry, refresh } = useOrder(token);
  const { banners, dismiss } = useInbox(token, Boolean(order), refresh);
  const [announce, setAnnounce] = useState('');

  const head = order ? headline(order) : '';
  const prev = useRef('');
  useEffect(() => {
    if (head && prev.current && head !== prev.current) setAnnounce(`Order update: ${head}`);
    prev.current = head;
  }, [head]);
  useEffect(() => { if (order) document.title = `${head} — order ${order.number} · Texas After Dark`; }, [order, head]);

  if (!token) return <Fail onRetry={null} message="We couldn’t find that order — check the link." />;
  if (loading && !order) return (<><Header /><Skeleton /></>);
  if (!order) {
    const notFound = error && (error.status === 404 || error.status === 400);
    return (
      <>
        <Header />
        <Fail onRetry={retry} message={notFound ? 'We couldn’t find that order — check the link.' : offline ? 'You appear to be offline. Check your connection and try again.' : 'Something went wrong loading your order. Please try again.'} />
      </>
    );
  }

  const o = order;
  const finished = ['delivered', 'collected'].includes(o.state);
  const eta = etaText(o);
  const queue = queueText(o);
  const out = o.state === 'out';

  return (
    <>
      <Header number={o.number} />
      {offline && <div className="offline" role="status">You’re offline — showing the last update. We’ll refresh when you’re back.</div>}
      <Banners banners={banners} dismiss={dismiss} />
      <main className="wrap">
        <p className="sr-only" role="status" aria-live="polite">{announce}</p>

        <section className={`card hero${o.failed ? ' hero-bad' : ''}${o.closed ? ' hero-closed' : ''}${finished ? ' hero-done' : ''}`} aria-labelledby="status-h">
          <p className="hero-kicker">{out ? 'On its way' : finished ? 'All done' : o.closed || o.failed ? 'Update' : 'Order status'}</p>
          <h1 id="status-h">{head}</h1>

          {o.failed && (
            <>
              <p className="lead">We couldn’t deliver your order. We’ll be in touch shortly — or call the shop and we’ll sort it out.</p>
              {o.store?.phone && <a className="btn btn-primary btn-block" href={`tel:${o.store.phone}`}>Call the shop</a>}
            </>
          )}
          {o.closed && (
            <>
              <p className="lead">This order has been cancelled. If you weren’t expecting that, call the shop and we’ll help.</p>
              {o.store?.phone && <a className="btn btn-primary btn-block" href={`tel:${o.store.phone}`}>Call the shop</a>}
            </>
          )}
          {finished && <p className="lead">{o.state === 'collected' ? 'Enjoy your order — thanks for choosing Texas After Dark.' : 'Your order has arrived. Enjoy — thanks for choosing Texas After Dark.'}</p>}

          {!o.closed && !o.failed && !finished && (
            <div className="facts">
              {eta && (
                <div className="fact">
                  <span className="fact-label">{o.fulfilment === 'collection' ? 'Ready in' : 'Arriving in'}</span>
                  <strong className="fact-big">{eta.approx}</strong>
                  {eta.clock && <span className="fact-sub">around {eta.clock}</span>}
                </div>
              )}
              {queue && (
                <div className="fact">
                  <span className="fact-label">{out ? 'Your stop' : 'Queue'}</span>
                  <strong className="fact-big">{queue}</strong>
                </div>
              )}
            </div>
          )}
        </section>

        {!o.closed && !o.failed && (
          <section className="card" aria-labelledby="prog-h">
            <h2 id="prog-h">Progress</h2>
            <Steps steps={viewSteps(o)} finished={finished} />
          </section>
        )}

        {o.fulfilment === 'delivery' && !o.closed && !o.failed && !finished && (
          <Suspense fallback={<div className="card sk"><i className="sk-line w100 map" /></div>}>
            <TrackMap order={o} />
          </Suspense>
        )}
        {out && o.driver && <p className="driver-line">{o.driver.first_name ? `${o.driver.first_name} is your driver.` : 'Your driver is on the way.'}</p>}

        {finished && <Rating token={token} order={o} onRated={refresh} />}

        {!o.closed && !finished && <Notify token={token} publicKey={o.push_public_key} />}
        {!finished && !o.closed && !o.failed && <Contact order={o} />}
        <Items order={o} />
        <footer className="foot">Texas After Dark</footer>
      </main>
    </>
  );
}

function Fail({ message, onRetry }) {
  return (
    <main className="wrap">
      <section className="card fail" role="alert">
        <h1>Hmm.</h1>
        <p className="lead">{message}</p>
        {onRetry && <button type="button" className="btn btn-primary btn-block" onClick={onRetry}>Try again</button>}
      </section>
    </main>
  );
}
