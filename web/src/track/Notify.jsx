import { useEffect, useState } from 'react';
import { postSubscription } from './api.js';
import { urlBase64ToUint8Array } from './format.js';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** "Get updates on this phone": registers /sw.js, asks permission, subscribes with the VAPID key and tells the server. */
export default function Notify({ token, publicKey }) {
  const [status, setStatus] = useState('idle'); // idle | working | on | denied | error
  const [msg, setMsg] = useState('');
  const usable = Boolean(publicKey) && supported();

  // already subscribed on this device? keep the server copy fresh and show the "on" state
  useEffect(() => {
    if (!usable || Notification.permission !== 'granted') return undefined;
    let dead = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        const sub = await reg?.pushManager.getSubscription();
        if (sub && !dead) { await postSubscription(token, sub.toJSON()); if (!dead) setStatus('on'); }
      } catch { /* leave the button available */ }
    })();
    return () => { dead = true; };
  }, [usable, token]);

  if (!usable) return null;

  const enable = async () => {
    setStatus('working'); setMsg('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setStatus('denied'); setMsg('Notifications are blocked for this site. You can allow them in your browser settings — or just keep this page open.'); return; }
      await navigator.serviceWorker.register('/sw.js');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await postSubscription(token, sub.toJSON());
      setStatus('on');
    } catch (e) {
      setStatus('error');
      setMsg(e?.status === 0 ? 'You appear to be offline — try again in a moment.' : 'We couldn’t turn updates on for this phone. You can keep this page open and it will update itself.');
    }
  };

  return (
    <section className="card notify" aria-label="Notifications">
      {status === 'on' ? (
        <p className="notify-on"><span className="tick" aria-hidden="true">✓</span> Updates are on for this phone. We’ll message you as your order moves.</p>
      ) : (
        <>
          <button type="button" className="btn btn-primary btn-block" onClick={enable} disabled={status === 'working'}>
            {status === 'working' ? 'Turning on…' : 'Get updates on this phone'}
          </button>
          <p className="muted small">We’ll only message you about this order.</p>
        </>
      )}
      {msg && <p className="notice notice-warn" role="alert">{msg}</p>}
    </section>
  );
}
