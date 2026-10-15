import { EventEmitter } from 'node:events';
/** In-process event bus: 'order' {order, from, to}, 'batch' {...}, 'notify' {...}. The board streams these over SSE. */
export const createBus = () => { const b = new EventEmitter(); b.setMaxListeners(100); return b; };
