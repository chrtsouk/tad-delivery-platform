/**
 * Labels: the unique order number printed as human-readable text AND inside the QR code (payload "TAD|<number>"),
 * so the driver scans the bag at pickup and the app checks it is the right bag for the right driver.
 * Printing: node-thermal-printer over the network (ESC/POS). Preview: SVG from node-qrcode.
 */
import QRCode from 'qrcode';
import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';
import { AppError } from '../lib/util.js';

export const qrPayload = (number) => `TAD|${number}`;
export function parseQr(code) {
  const m = /^TAD\|(TAD-\d{8}-\d{3,})$/.exec(String(code ?? '').trim());
  return m ? m[1] : null;
}

export function createLabels(ctx) {
  const { config, settings } = ctx;

  function layout(order) {
    const s = settings.all();
    return {
      shop: s.store.name,
      number: order.number,
      qr: qrPayload(order.number),
      kind: order.fulfilment === 'delivery' ? 'DELIVERY' : 'COLLECTION',
      name: order.customer_name || '',
      postcode: order.postcode || '',
      address: order.address_line || '',
      items: order.items.map((i) => `${i.qty} x ${i.name}`),
      notes: order.notes || '',
      time: (ctx.now()).toISOString().slice(11, 16),
      stop: order.stop_seq ?? null,
    };
  }

  const svg = (order) => QRCode.toString(qrPayload(order.number), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

  /** The label page the tablet can also print from the browser (same layout, QR as SVG). */
  async function html(order) {
    const l = layout(order);
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!doctype html><meta charset="utf-8"><title>${esc(l.number)}</title>
<style>@page{size:80mm auto;margin:3mm}body{font-family:Arial,sans-serif;width:74mm;margin:0}h1{font-size:30px;margin:2px 0}.n{font-size:22px;font-weight:700;letter-spacing:1px}.q{width:38mm;margin:4px auto;display:block}.k{font-weight:700}</style>
<div class="k">${esc(l.shop)} — ${l.kind}</div><div class="n">${esc(l.number)}</div>${await svg(order)}
<h1>${esc(l.postcode)}</h1><div>${esc(l.name)}</div><div>${esc(l.address)}</div><hr>${l.items.map((i) => `<div>${esc(i)}</div>`).join('')}${l.notes ? `<hr><div>${esc(l.notes)}</div>` : ''}<div>${l.time}${l.stop ? ` · stop ${l.stop}` : ''}</div>`;
  }

  /** Print to the shop's label printer. `printer` can be injected (tests use a fake TCP printer). */
  async function print(order, { host = config.printer.host, port = config.printer.port, type = config.printer.type } = {}) {
    if (!host) throw new AppError('No label printer is set up (PRINTER_HOST)', 503, 'not_configured');
    const l = layout(order);
    const p = new ThermalPrinter({ type: PrinterTypes[type.toUpperCase()] ?? PrinterTypes.EPSON, interface: `tcp://${host}:${port}`, characterSet: CharacterSet.PC858_EURO, options: { timeout: 5000 } });
    p.alignCenter(); p.bold(true); p.println(`${l.shop} - ${l.kind}`); p.bold(false);
    p.setTextSize(1, 1); p.println(l.number); p.setTextNormal();
    p.printQR(l.qr, { cellSize: 6, correction: 'M', model: 2 });
    p.setTextSize(1, 1); p.bold(true); p.println(l.postcode); p.bold(false); p.setTextNormal();
    p.alignLeft(); p.println(l.name); if (l.address) p.println(l.address);
    p.drawLine(); for (const i of l.items) p.println(i);
    if (l.notes) { p.drawLine(); p.println(l.notes); }
    p.println(`${l.time}${l.stop ? `  stop ${l.stop}` : ''}`);
    p.cut();
    try { await p.execute(); } catch (e) { throw new AppError(`The label printer did not answer: ${e.message}`, 502, 'printer_unreachable'); }
    return { printed: l.number };
  }

  return { layout, svg, html, print };
}
