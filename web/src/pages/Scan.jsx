import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { post } from '../lib/api.js';

/** Counter check: scan a bag label (QR "TAD|<order number>") with the tablet camera, or type the number. Says whose bag it is. */
export default function Scan() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [camera, setCamera] = useState('idle');
  const [manual, setManual] = useState('');
  const scanner = useRef(null);
  const last = useRef({ code: '', at: 0 });

  const check = async (code) => {
    const now = Date.now();
    if (code === last.current.code && now - last.current.at < 3000) return;
    last.current = { code, at: now };
    try { setResult(await post('/api/scan', { code })); setError(''); } catch (e) { setResult(null); setError(e.message); }
  };

  const start = async () => {
    setCamera('starting');
    try {
      scanner.current = new Html5Qrcode('scan-view');
      await scanner.current.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, (text) => check(text), () => {});
      setCamera('on');
    } catch (e) { setCamera('idle'); setError(`Could not start the camera: ${e?.message || e}`); }
  };
  const stop = async () => { try { await scanner.current?.stop(); scanner.current?.clear(); } catch { /* already stopped */ } setCamera('idle'); };
  useEffect(() => () => { scanner.current?.isScanning && scanner.current.stop().catch(() => {}); }, []);

  return (
    <div style={{ maxWidth: 560 }}>
      <h2>Scan a bag</h2>
      <p className="muted">Scan the QR on the label to see whose bag it is. The order number printed under the code works too.</p>
      <div id="scan-view" style={{ width: '100%', minHeight: camera === 'on' ? 280 : 0, borderRadius: 12, overflow: 'hidden' }} />
      <div className="row" style={{ margin: '12px 0' }}>
        {camera !== 'on' ? <button className="primary" onClick={start} disabled={camera === 'starting'}>Start camera</button> : <button onClick={stop}>Stop camera</button>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) check(`TAD|${manual.trim().toUpperCase()}`); }}>
          <input aria-label="Order number" placeholder="TAD-20261015-007" value={manual} onChange={(e) => setManual(e.target.value)} style={{ width: 200 }} />
          <button type="submit">Check</button>
        </form>
      </div>
      {error && <div className="err" role="alert">{error}</div>}
      {result && (
        <div className={result.ok ? 'ok' : 'err'} role="status" style={{ fontSize: 18 }}>
          <strong>{result.order.number}</strong> — {result.message}
          <div style={{ fontSize: 14 }}>{result.order.name || 'No name'} · {result.order.postcode || 'collection'}{result.order.stop_seq ? ` · stop ${result.order.stop_seq}` : ''}</div>
        </div>
      )}
    </div>
  );
}
