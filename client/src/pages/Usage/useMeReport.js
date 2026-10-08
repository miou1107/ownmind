import { useState, useEffect, useMemo } from 'react';
import { apiGet } from '../../api';

// v1.32.4 — one loader for the four 用量與規矩 tabs.
//
// Until v1.32.3 the usage page held its own three tabs and fetched /api/me/report once
// for all of them. The tabs are routes now (/usage/mine, /usage/rules, /usage/projects,
// /usage/team), each its own page, so each page asks for the report itself. The range
// control is the same on every tab; this hook owns it so the four pages cannot drift.
//
//   - range 變化會重新打 API；分頁切換換頁，各自再打一次（資料不大）。
//   - 自訂區間兩個日期都選好、而且沒反過來，才會查。

import { RANGES, ISO_DATE, reportQuery } from './report-query.js';

export { RANGES, reportQuery };

export default function useMeReport(initialRange = '14d') {
  const [range, setRange] = useState(initialRange);
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const customComplete = ISO_DATE.test(start) && ISO_DATE.test(end);
  const customReversed = customComplete && start > end;
  const queryString = useMemo(() => reportQuery({ custom, range, start, end }), [custom, range, start, end]);

  useEffect(() => {
    if (queryString === null) return undefined;   // custom range not ready: keep what we have
    let current = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      const r = await apiGet(`/api/me/report?${queryString}`);
      if (!current) return;
      setLoading(false);
      if (!r.ok) { setLoadError(r.error || 'load_failed'); setData(null); return; }
      setData(r.data || null);
    })();
    return () => { current = false; };
  }, [queryString]);

  const rangeBar = {
    range, custom, start, end, customComplete, customReversed,
    pick: (r) => { setCustom(false); setRange(r); },
    pickCustom: () => setCustom(true),
    setStart, setEnd,
  };

  return { data, loading, loadError, rangeBar };
}
