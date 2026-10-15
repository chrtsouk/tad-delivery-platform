/**
 * The customer's tracking link: a small page and two calls, reached by a secret in the address (like the staff rota link).
 *
 *   GET  /track/<token>                 the page (the same for every token: it learns what to show from the call below)
 *   GET  /track-api/<token>             where the order stands (404 for an unknown or switched-off link)
 *   POST /track-api/<token>/message     the customer writes to the kitchen / driver
 *
 * Off until the owner sets `tracking_enabled`. The page loads nothing from anywhere else: no map tiles, no fonts, no scripts.
 * The driver's position is shown as a link the customer may choose to open on OpenStreetMap, not an embedded map.
 */
import express from 'express';
import dispatch from './core/dispatch.js';

/**
 * Two limits, so a flood of made-up links cannot fill memory or slow the server: one per visitor (generous, because a mobile
 * network puts many customers behind one address), and one per link that really exists (so the table is as small as the
 * number of deliveries). Both forget the oldest entries past a cap.
 */
function limiter(max, cap) {
  const hits = new Map();
  return {
    tooMany(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => t > now - 60_000);
      if (list.length >= max) { hits.set(key, list); return true; }
      list.push(now);
      hits.delete(key); hits.set(key, list);       // most recent last
      if (hits.size > cap) {
        for (const k of hits.keys()) { if (hits.size <= cap * 0.8) break; hits.delete(k); }
      }
      return false;
    },
    clear() { hits.clear(); },
    size: () => hits.size,
  };
}
const perVisitor = limiter(600, 5000);
const perLink = limiter(60, 5000);
export const resetTrackLimits = () => { perVisitor.clear(); perLink.clear(); };
export const trackLimiterSizes = () => ({ visitors: perVisitor.size(), links: perLink.size() });

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Your order</title>
<style>
body{font:16px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:560px;margin:auto;color:#1d273b;background:#fff}
h1{font-size:22px;margin:8px 0 2px}.sub{color:#667382;margin:0 0 16px}
.steps{display:flex;gap:6px;margin:18px 0}.steps div{flex:1;text-align:center;font-size:13px;padding:8px 4px;border-radius:8px;background:#eef1f5;color:#667382}
.steps .done{background:#d6f0dc;color:#17692b}.steps .now{background:#206bc4;color:#fff;font-weight:600}
.box{border:1px solid #e6e7e9;border-radius:10px;padding:12px 14px;margin:12px 0}.bad{border-color:#d63939;color:#a02525}
.msg{margin:6px 0;padding:8px 10px;border-radius:10px;background:#eef1f5;max-width:85%}.msg.me{margin-left:auto;background:#d9e8fb}
.msg small{display:block;color:#667382;font-size:12px}
form{display:flex;gap:8px;margin-top:10px}input{flex:1;font:inherit;padding:10px;border:1px solid #c9ced6;border-radius:8px}
button{font:inherit;padding:10px 16px;border:0;border-radius:8px;background:#206bc4;color:#fff}
</style></head><body>
<h1 id="kitchen">Your order</h1><p class="sub" id="line">Looking for your order…</p>
<div class="steps" id="steps"></div><div id="detail"></div>
<h2 style="font-size:17px">Messages</h2><div id="msgs"></div>
<form id="f" hidden><input id="t" maxlength="300" placeholder="Write to the kitchen or the driver"><button>Send</button></form>
<script>
(function(){
var token=location.pathname.split('/').pop();
var LABEL={waiting:'Being prepared',assigned:'Ready for the driver',out:'On its way',delivered:'Delivered'};
var $=function(i){return document.getElementById(i)};
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e}
function draw(d){
  $('kitchen').textContent=d.kitchen||'Your order';
  var line=d.problem?(d.status==='cancelled'?'This order was cancelled. Please contact the kitchen.':'We could not deliver this order. Please contact the kitchen.'):(LABEL[d.status]||d.status);
  $('line').textContent=line;
  var st=$('steps');st.textContent='';
  var idx=d.steps.indexOf(d.status);
  d.steps.forEach(function(s,i){st.appendChild(el('div',i<idx?'done':i===idx&&!d.problem?'now':'',LABEL[s]))});
  var det=$('detail');det.textContent='';
  if(d.driver&&!d.problem){det.appendChild(el('div','box',d.driver+' is bringing your order.'))}
  if(d.promised_at&&d.status!=='delivered'&&!d.problem){det.appendChild(el('div','box','Promised for about '+new Date(d.promised_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})))}
  if(d.delivered_at){det.appendChild(el('div','box','Delivered at '+new Date(d.delivered_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})))}
  if(d.position){var b=el('div','box');b.appendChild(document.createTextNode('Last location '+(d.position.seen_minutes_ago<1?'just now':d.position.seen_minutes_ago+' min ago')+'. '));
    var a=el('a',null,'Open on a map');a.href='https://www.openstreetmap.org/?mlat='+d.position.lat+'&mlon='+d.position.lng+'#map=16/'+d.position.lat+'/'+d.position.lng;a.rel='noopener noreferrer';a.target='_blank';b.appendChild(a);det.appendChild(b)}
  var m=$('msgs');m.textContent='';
  d.messages.forEach(function(x){var e=el('div','msg'+(x.from==='customer'?' me':''),x.body);var s=el('small',null,(x.from==='customer'?'You':x.from==='driver'?'Driver':'Kitchen')+' · '+new Date(x.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));e.appendChild(s);m.appendChild(e)});
  $('f').hidden=!(d.status==='waiting'||d.status==='assigned'||d.status==='out');
}
function load(){fetch('/track-api/'+encodeURIComponent(token),{cache:'no-store'}).then(function(r){
  if(!r.ok){$('line').textContent='We could not find this order. Check the link you were sent.';$('steps').textContent='';return null}
  return r.json()}).then(function(d){if(d)draw(d)}).catch(function(){})}
$('f').addEventListener('submit',function(ev){ev.preventDefault();var t=$('t').value.trim();if(!t)return;
  fetch('/track-api/'+encodeURIComponent(token)+'/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:t})}).then(function(r){return r.json().then(function(j){if(!r.ok)alert(j.error||'Not sent');else{$('t').value='';load()}})})});
load();setInterval(load,15000);
})();
</script></body></html>`;

export function trackRouter() {
  const r = express.Router();
  const noStore = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); };

  r.get('/track/:token', (req, res) => {
    noStore(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    res.type('html').send(PAGE);
  });
  r.get('/track-api/:token', (req, res) => {
    noStore(res);
    if (perVisitor.tooMany(req.ip)) return res.status(429).json({ error: 'Too many requests', status: 429 });
    const t = dispatch.tracking(req.params.token);
    if (!t) return res.status(404).json({ error: 'Not found', status: 404 });
    if (perLink.tooMany(String(req.params.token))) return res.status(429).json({ error: 'Too many requests', status: 429 });
    return res.json(t);
  });
  r.post('/track-api/:token/message', express.json({ limit: '4kb' }), (req, res) => {
    noStore(res);
    if (perVisitor.tooMany(req.ip)) return res.status(429).json({ error: 'Too many requests', status: 429 });
    try {
      if (dispatch.tracking(req.params.token) && perLink.tooMany(String(req.params.token))) return res.status(429).json({ error: 'Too many requests', status: 429 });
      const m = dispatch.trackingMessage(req.params.token, req.body?.body);
      if (!m) return res.status(404).json({ error: 'Not found', status: 404 });
      return res.json({ ok: true });
    } catch (e) {
      const status = e.status && e.status < 500 ? e.status : 500;
      return res.status(status).json({ error: status < 500 ? e.message : 'Something went wrong', status });
    }
  });
  return r;
}

export default { trackRouter, resetTrackLimits, trackLimiterSizes };
