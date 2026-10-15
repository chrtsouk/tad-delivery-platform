import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RangePicker, addDays, todayUtc, useFetch } from '../analytics/util.jsx';
import DemandTab from '../analytics/DemandTab.jsx';
import DriversTab from '../analytics/DriversTab.jsx';
import { EndOfDayTab, TodayTab } from '../analytics/EndOfDay.jsx';

const TABS = [['today', 'Today'], ['demand', 'Demand'], ['drivers', 'Drivers'], ['eod', 'End of day']];

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'today';
  const [range, setRange] = useState({ from: addDays(todayUtc(), -13), to: todayUtc() });
  // the API's "to" is exclusive, the picker's is inclusive
  const qs = `from=${range.from}&to=${addDays(range.to, 1)}`;
  const demand = useFetch(tab === 'demand' ? `/api/analytics/demand?${qs}` : null);
  const drivers = useFetch(tab === 'drivers' ? `/api/analytics/drivers?${qs}` : null);
  const go = (k) => setParams(k === 'today' ? {} : { tab: k }, { replace: true });

  return (
    <div className="ana-page">
      <div className="row ana-head no-print">
        <h2 style={{ margin: 0 }}>Analytics</h2>
        <div className="ana-tabs" role="tablist" aria-label="Analytics views">
          {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>{label}</button>)}
        </div>
      </div>
      {(tab === 'demand' || tab === 'drivers') && <RangePicker from={range.from} to={range.to} onChange={setRange} />}
      {tab === 'today' && <TodayTab onOpenEod={() => go('eod')} />}
      {tab === 'demand' && <DemandTab demand={demand} />}
      {tab === 'drivers' && <DriversTab drivers={drivers} />}
      {tab === 'eod' && <EndOfDayTab />}
    </div>
  );
}
