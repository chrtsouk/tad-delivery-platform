// Lifted from the hub's server/api/v1.js (commit 59e29e0) on the move out. Needs: express, integrations.rateLimit, dispatch.
import express from 'express';
import dispatch from '../dispatch.js';
// AppError (../util.js) and integrations.rateLimit (../integrations.js) are the hub's: rewire them when this project is started.
const fail = (res, status, message) => res.status(status).json({ error: message, status });

/** The driver app's routes: a driver key, one run, no one else's data. */
function driverApi() {
  const d = express.Router();
  d.use((req, res, next) => {
    const presented = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1] || '';
    let driver = null;
    try { driver = dispatch.authenticateDriver(presented); } catch { return fail(res, 500, 'Something went wrong'); }
    if (!driver) return fail(res, 401, 'Send the driver key as "Authorization: Bearer drv_…"');
    const wait = integrations.rateLimit(`driver:${driver.id}`);
    if (wait) { res.setHeader('Retry-After', String(wait)); return fail(res, 429, `Too many calls — try again in ${wait} second(s)`); }
    req.driver = driver;
    return next();
  });
  const run = (handler) => (req, res) => {
    try { return res.json(handler(req)); } catch (e) {
      const status = e.status && e.status < 500 ? e.status : 500;
      if (status >= 500) console.error('Driver API error:', req.method, req.originalUrl, e);
      return res.status(status).json({ error: status < 500 && e.message ? e.message : 'Something went wrong', details: (status < 500 && e.details) || null, status });
    }
  };
  d.get('/run', run((req) => dispatch.driverRun(req.driver)));
  d.post('/location', run((req) => dispatch.ping(req.driver.id, req.body || {})));
  d.post('/deliveries/:id/status', run((req) => dispatch.driverSetStatus(req.driver, req.params.id, req.body?.status, { reason: req.body?.reason })));
  d.get('/deliveries/:id/messages', run((req) => {
    const x = dispatch.driverRun(req.driver).deliveries.find((q) => q.id === req.params.id);
    if (!x) throw new AppError('That drop is not on your run', 403);
    return { messages: dispatch.messages(req.params.id, { markRead: true, reader: 'driver' }) };
  }));
  d.post('/deliveries/:id/messages', run((req) => {
    const x = dispatch.driverRun(req.driver).deliveries.find((q) => q.id === req.params.id);
    if (!x) throw new AppError('That drop is not on your run', 403);
    return dispatch.addMessage(req.params.id, { from_kind: 'driver', from_name: req.driver.name.split(' ')[0], body: req.body?.body, audience: req.body?.audience });
  }));
  d.use((req, res) => fail(res, 404, 'No such driver route'));
  return d;
}


export default driverApi;
