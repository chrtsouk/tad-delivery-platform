import React from 'react';

const P = {
  bike: <><circle cx="5.5" cy="17" r="3" /><circle cx="18.5" cy="17" r="3" /><path d="M5.5 17 9 9h4l2 4h3.5M13 9l-1.5-3H9" /></>,
  bag: <><path d="M5 8h14l-1 12H6L5 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  bell: <><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15L6 17Z" /><path d="M10 21h4" /></>,
  mute: <><path d="M6 17V11a6 6 0 0 1 9-5.2M18 11v6l1.5 2H9" /><path d="M4 4l16 16" /></>,
  warn: <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v5M12 17.5v.5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>,
};

export default function Icon({ name, size = 18 }) {
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name]}</svg>
  );
}
