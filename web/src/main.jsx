import React, { Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { get, post } from './lib/api.js';
import './styles.css';

const Board = lazy(() => import('./pages/Board.jsx'));
const AddOrder = lazy(() => import('./pages/AddOrder.jsx'));
const Drivers = lazy(() => import('./pages/Drivers.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Analytics = lazy(() => import('./pages/Analytics.jsx'));
const Calendar = lazy(() => import('./pages/Calendar.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Scan = lazy(() => import('./pages/Scan.jsx'));

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const go = async (e) => { e.preventDefault(); try { await post('/api/login', { password: pw }); onDone(); } catch (x) { setErr(x.message); } };
  return (
    <form className="login card" onSubmit={go}>
      <img src="/brand/texas-after-dark.svg" alt="Texas After Dark" />
      <h2>Delivery</h2>
      <label htmlFor="pw">Admin password</label>
      <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      {err && <div className="err">{err}</div>}
      <p><button className="primary" type="submit">Sign in</button></p>
    </form>
  );
}

function Shell() {
  const links = [['/', 'Board'], ['/add', 'Add order'], ['/scan', 'Scan'], ['/drivers', 'Drivers'], ['/calendar', 'Calendar'], ['/analytics', 'Analytics'], ['/audit', 'Audit'], ['/settings', 'Settings']];
  return (
    <>
      <header className="top">
        <img src="/brand/texas-after-dark-black-bg.svg" alt="Texas After Dark" />
        <nav>{links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}</nav>
        <button onClick={async () => { await post('/api/logout'); location.reload(); }}>Sign out</button>
      </header>
      <main>
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Board />} />
            <Route path="/add" element={<AddOrder />} />
            <Route path="/scan" element={<Scan />} />
            <Route path="/drivers" element={<Drivers />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Suspense>
      </main>
    </>
  );
}

function App() {
  const [admin, setAdmin] = useState(null);
  const check = () => get('/api/me').then((m) => setAdmin(m.admin)).catch(() => setAdmin(false));
  useEffect(() => { check(); }, []);
  if (admin === null) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  return admin ? <Shell /> : <Login onDone={check} />;
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
