// PROTOTYPE: never merge. Three structurally different layouts for the options
// page's Restore section, switchable via ?variant=A|B|C and ?state=start|progress|complete.
// Read-only: every button is inert. The data is a fixture covering every row
// state settled in wayfinder ticket #7 (restore queue behaviour).
import { useEffect, useState } from 'react';

type Status = 'todo' | 'opened' | 'proposal' | 'differs' | 'declined' | 'wont-allow' | 'done' | 'skipped' | 'gone' | 'info';
type Stage = 'start' | 'progress' | 'complete';

interface Row {
  key: string;
  name: string;
  status: Status;
  target: boolean;
  badge: string;
  primary?: string;
  secondary?: string[];
  note?: string;
  proposal?: { name: string; signal: string };
  added?: boolean;
}

const DEVICES = [
  { id: 'laptop', label: 'Laptop (Helium)', family: 'Chromium', seen: '2 days ago', count: 12, preselected: true },
  { id: 'desktop', label: 'Desktop (Firefox)', family: 'Firefox', seen: 'today', count: 9 },
  { id: 'self', label: 'This device', family: 'Chromium', seen: 'last upload 3 weeks ago', count: 3 },
  { id: 'file', label: 'From file: Old desktop', family: 'Chromium', seen: 'imported 5 Sep', count: 7 },
];

const PROGRESS: Row[] = [
  { key: 'ubo', name: 'uBlock Origin', status: 'proposal', target: true, badge: 'Bundled with Helium', proposal: { name: 'uBlock Origin (Chrome Web Store)', signal: 'same name' } },
  { key: 'json', name: 'JSON Viewer', status: 'differs', target: false, badge: 'Store page' },
  { key: 'gram', name: 'Grammarly', status: 'declined', target: true, badge: 'Store page', note: 'You declined Chrome\'s permission prompt. Asked for new permissions.' },
  { key: 'proxy', name: 'Proxy Helper', status: 'opened', target: true, badge: 'Self-hosted', primary: 'Developer site', secondary: ['Search Chrome Web Store'] },
  { key: 'refined', name: 'Refined GitHub', status: 'todo', target: true, badge: 'Store page', primary: 'Store page', added: true },
  { key: 'momentum', name: 'Momentum', status: 'todo', target: true, badge: 'Store page', primary: 'Store page', secondary: ['Developer site'] },
  { key: 'dev', name: 'My Dev Tool', status: 'todo', target: true, badge: 'Unpacked', note: 'Unpacked on Laptop (Helium): load it from its source folder.' },
  { key: 'bw', name: 'Bitwarden', status: 'done', target: true, badge: 'Store page' },
  { key: 'adi', name: 'Ad Inspector', status: 'wont-allow', target: false, badge: 'Store page', note: 'Browser won\'t allow changes (managed).' },
  { key: 'sb', name: 'Session Buddy', status: 'skipped', target: true, badge: 'Store page' },
  { key: 'old', name: 'Old Translator', status: 'gone', target: true, badge: 'Store page' },
  { key: 'corp', name: 'Corp SSO', status: 'info', target: true, badge: 'Policy', note: 'Installed by policy on Laptop (Helium).' },
];
const ALREADY_HERE = [
  { key: 'dark', name: 'Dark Reader', here: false, source: true, included: false },
  { key: 'vim', name: 'Vimium', here: true, source: false, included: true },
];
const CANT_PLACE = [{ id: 'iaiomicjab', name: 'Tab Session Manager' }];

const OUTSTANDING: Status[] = ['todo', 'opened', 'proposal', 'differs', 'declined'];
const NEEDS_YOU: Status[] = ['proposal', 'differs', 'declined'];

function rowsFor(stage: Stage): Row[] {
  if (stage !== 'complete') return PROGRESS;
  return PROGRESS.map((r): Row => (OUTSTANDING.includes(r.status) ? { ...r, status: r.key === 'dev' ? 'skipped' : 'done' } : r));
}

const STATUS_LABEL: Record<Status, string> = {
  todo: 'To do', opened: 'Waiting for the install', proposal: 'Is this the same?', differs: 'On/off differs',
  declined: 'Prompt declined', 'wont-allow': 'Can\'t change', done: 'Done', skipped: 'Skipped', gone: 'No longer on source', info: 'Info only',
};
const STATUS_TONE: Record<Status, string> = {
  todo: 'neutral', opened: 'wait', proposal: 'attn', differs: 'attn', declined: 'attn', 'wont-allow': 'muted', done: 'ok', skipped: 'muted', gone: 'muted', info: 'muted',
};

function Actions({ row, compact = false }: { row: Row; compact?: boolean }) {
  const btn = (label: string, primary = false) => (
    <button key={label} className={primary ? 'rp-btn rp-primary' : 'rp-btn'} onClick={() => console.log('[prototype] inert:', row.key, label)}>{label}</button>
  );
  switch (row.status) {
    case 'todo':
    case 'opened':
      return (
        <div className="rp-actions">
          {row.primary && btn(`${row.primary} ↗`, true)}
          {!compact && row.secondary?.map((s) => btn(`${s} ↗`))}
          {row.note && <span className="rp-note">{row.note}</span>}
          {btn('Pick installed…')}
          {btn('Skip')}
        </div>
      );
    case 'proposal':
      return (
        <div className="rp-actions">
          <span className="rp-note">Just installed: <strong>{row.proposal!.name}</strong> · {row.proposal!.signal}</span>
          {btn('Link', true)}{btn('Not the same')}{!compact && btn('Skip')}
        </div>
      );
    case 'differs':
      return <div className="rp-actions">{btn(row.target ? 'Turn on' : 'Turn off', true)}{!compact && btn('Skip')}</div>;
    case 'declined':
      return <div className="rp-actions">{btn('Turn on again', true)}{!compact && <span className="rp-note">{row.note}</span>}{btn('Skip')}</div>;
    case 'skipped':
      return <div className="rp-actions">{btn('Undo skip')}</div>;
    default:
      return row.note ? <span className="rp-note">{row.note}</span> : null;
  }
}

function useCounts(rows: Row[]) {
  const outstanding = rows.filter((r) => OUTSTANDING.includes(r.status)).length + ALREADY_HERE.filter((a) => a.included && a.here !== a.source).length;
  const done = rows.filter((r) => r.status === 'done').length;
  const counted = rows.filter((r) => !['gone', 'info', 'skipped'].includes(r.status)).length;
  const applyAll = rows.filter((r) => r.status === 'differs').length + ALREADY_HERE.filter((a) => a.included).length;
  return { outstanding, done, counted, applyAll };
}

/* ------------------------- Variant A: grouped checklist ------------------------- */
function VariantA({ stage }: { stage: Stage }) {
  const rows = rowsFor(stage);
  const c = useCounts(rows);
  if (stage === 'start') {
    return (
      <section className="compare-card">
        <div className="section-heading"><div><h2>Guided restore</h2><p>Install what another device has, one click at a time. Cairn only counts what it sees installed.</p></div></div>
        <div className="rp-pad">
          <span className="field-label">Restore from</span>
          <div className="rp-radio-list">
            {DEVICES.map((d) => (
              <label key={d.id} className="rp-radio"><input type="radio" name="src-a" defaultChecked={d.preselected} /><span><strong>{d.label}</strong><small>{d.family} · last seen {d.seen} · {d.count} not on this profile</small></span></label>
            ))}
          </div>
          <div className="rp-row-between"><span className="rp-note">Pulled today 09:00 · 12 to restore · 2 already here with a different on/off state</span><button className="rp-btn rp-primary">Start guided restore</button></div>
        </div>
      </section>
    );
  }
  const groups: [string, Status[]][] = [['Needs you', NEEDS_YOU], ['To install', ['todo', 'opened']], ['Done', ['done', 'wont-allow']], ['Not counted', ['skipped', 'gone', 'info']]];
  return (
    <section className="compare-card">
      <div className="section-heading">
        <div><h2>Guided restore · from Laptop (Helium)</h2><p>Pulled today 09:00 · Laptop last seen 2 days ago</p></div>
        <div className="compare-actions">
          {stage === 'complete' ? <span className="rp-pill rp-ok">Complete</span> : <span className="rp-note">{c.outstanding} still to do</span>}
          {stage !== 'complete' && <button className="rp-btn">Apply all ({c.applyAll})</button>}
          <button className={stage === 'complete' ? 'rp-btn rp-primary' : 'rp-btn'}>Finish restore</button>
        </div>
      </div>
      <div className="rp-progress"><div style={{ width: `${(c.done / c.counted) * 100}%` }} /></div>
      <div className="rp-pad">
        {groups.map(([title, sts]) => {
          const g = rows.filter((r) => sts.includes(r.status));
          if (!g.length) return null;
          return (
            <div className="difference-group" key={title}>
              <h3>{title} <span className="rp-count">{g.length}</span></h3>
              {g.map((r) => (
                <article key={r.key} className="rp-line">
                  <div><strong>{r.name}</strong><span>{r.badge} · source has it {r.target ? 'on' : 'off'}{r.added ? ' · added on Pull' : ''}</span></div>
                  <span className={`rp-pill rp-${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  <Actions row={r} />
                </article>
              ))}
            </div>
          );
        })}
        <div className="difference-group">
          <h3>Already here, but on/off differs from Laptop</h3>
          {ALREADY_HERE.map((a) => (
            <article key={a.key} className="rp-line">
              <div><strong>{a.name}</strong><span>here {a.here ? 'on' : 'off'} · Laptop {a.source ? 'on' : 'off'}</span></div>
              <label className="rp-check"><input type="checkbox" defaultChecked={a.included} /> Include</label>
              <div className="rp-actions">{a.included && stage !== 'complete' && <button className="rp-btn rp-primary">Turn {a.source ? 'on' : 'off'}</button>}</div>
            </article>
          ))}
        </div>
        {stage !== 'complete' && (
          <div className="difference-group">
            <h3>New installs Cairn can't place</h3>
            {CANT_PLACE.map((x) => (
              <article key={x.id} className="rp-line"><div><strong>{x.name}</strong><span>{x.id}</span></div><span /><div className="rp-actions"><button className="rp-btn">Link to…</button></div></article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------- Variant B: one at a time ------------------------- */
function VariantB({ stage }: { stage: Stage }) {
  const rows = rowsFor(stage);
  const c = useCounts(rows);
  const rank: Partial<Record<Status, number>> = { proposal: 0, differs: 1, declined: 2, opened: 3, todo: 4 };
  const queue = [...rows].sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5));
  const firstOpen = queue.find((r) => OUTSTANDING.includes(r.status));
  const [focusKey, setFocusKey] = useState<string | undefined>(firstOpen?.key);
  const focus = rows.find((r) => r.key === focusKey) ?? firstOpen;
  if (stage === 'start') {
    return (
      <section className="compare-card">
        <div className="section-heading"><div><h2>Guided restore</h2><p>Step 1 of 2 · Choose a device to restore from</p></div></div>
        <div className="rp-tiles">
          {DEVICES.map((d) => (
            <button key={d.id} className={`rp-tile ${d.preselected ? 'rp-tile-on' : ''}`}>
              <span className="rp-tile-family">{d.family}</span>
              <strong>{d.label}</strong>
              <span>{d.count} extensions not on this profile</span>
              <small>last seen {d.seen}</small>
            </button>
          ))}
        </div>
        <div className="rp-pad rp-row-between"><span className="rp-note">Step 2 shows them one at a time. Nothing installs until you click.</span><button className="rp-btn rp-primary">Continue with Laptop (Helium)</button></div>
      </section>
    );
  }
  return (
    <section className="compare-card">
      <div className="section-heading">
        <div><h2>Guided restore</h2><p>Laptop (Helium) · {stage === 'complete' ? 'everything is handled' : `${c.outstanding} still need you`}</p></div>
        <div className="compare-actions"><button className={stage === 'complete' ? 'rp-btn rp-primary' : 'rp-btn'}>Finish restore</button></div>
      </div>
      <div className="rp-split">
        <div className="rp-focus">
          {stage === 'complete' || !focus ? (
            <div className="empty-state compact"><strong>Complete</strong><p>Every extension from Laptop (Helium) is installed, skipped, or not counted. Finish to stop tracking.</p></div>
          ) : (
            <>
              <span className="rp-kicker">{STATUS_LABEL[focus.status]}</span>
              <h3 className="rp-focus-title">{focus.name}</h3>
              <p className="rp-note">{focus.badge} · Laptop has it {focus.target ? 'on' : 'off'}{focus.added ? ' · added on Pull' : ''}</p>
              {focus.status === 'proposal' && <p className="rp-big">You just installed <strong>{focus.proposal!.name}</strong>. Is it the same extension? <span className="rp-pill rp-neutral">{focus.proposal!.signal}</span></p>}
              {focus.status === 'differs' && <p className="rp-big">Installed, but it's {focus.target ? 'off' : 'on'} here and {focus.target ? 'on' : 'off'} on Laptop.</p>}
              {focus.status === 'todo' && <p className="rp-big">Not installed here yet. Open its page, install it, and Cairn will notice.</p>}
              {focus.status === 'opened' && <p className="rp-big">Page opened. Waiting to see it installed.</p>}
              <Actions row={focus} />
              <div className="rp-row-between rp-nav"><button className="rp-btn">← Previous</button><button className="rp-btn">Next →</button></div>
            </>
          )}
        </div>
        <div className="rp-rail">
          <div className="rp-progress"><div style={{ width: `${(c.done / c.counted) * 100}%` }} /></div>
          {queue.map((r) => (
            <button key={r.key} className={`rp-rail-item ${focus?.key === r.key ? 'rp-rail-on' : ''}`} onClick={() => setFocusKey(r.key)}>
              <span className={`rp-dot rp-${STATUS_TONE[r.status]}`} /><span>{r.name}</span><small>{STATUS_LABEL[r.status]}</small>
            </button>
          ))}
          <h3 className="rp-rail-h">Already here, on/off differs</h3>
          {ALREADY_HERE.map((a) => <label key={a.key} className="rp-check rp-rail-item"><input type="checkbox" defaultChecked={a.included} />{a.name}<small>here {a.here ? 'on' : 'off'}</small></label>)}
          {stage !== 'complete' && <><h3 className="rp-rail-h">Can't place</h3>{CANT_PLACE.map((x) => <div key={x.id} className="rp-rail-item"><span className="rp-dot rp-attn" /><span>{x.name}</span><small>link to…</small></div>)}</>}
        </div>
      </div>
    </section>
  );
}

/* ------------------------- Variant C: board ------------------------- */
function VariantC({ stage }: { stage: Stage }) {
  const rows = rowsFor(stage);
  const c = useCounts(rows);
  const columns: { title: string; hint: string; sts: Status[] }[] = [
    { title: 'Install', hint: 'Open the page, install it; Cairn notices.', sts: ['todo', 'opened'] },
    { title: 'Confirm', hint: 'Is the install the same extension?', sts: ['proposal'] },
    { title: 'Turn on/off', hint: 'Match the on/off state on Laptop.', sts: ['differs', 'declined'] },
    { title: 'Finished', hint: 'Done, skipped, or not counted.', sts: ['done', 'wont-allow', 'skipped', 'gone', 'info'] },
  ];
  return (
    <section className="compare-card">
      <div className="section-heading">
        <div><h2>Guided restore</h2><p>{stage === 'start' ? 'Pick a device, then Start' : `Pulled today 09:00 · ${c.outstanding} still to do`}</p></div>
        <div className="compare-actions">
          <div className="rp-seg">
            {DEVICES.map((d) => <button key={d.id} className={d.preselected ? 'rp-seg-on' : ''} title={`last seen ${d.seen}`}>{d.label}</button>)}
          </div>
          {stage === 'start' ? <button className="rp-btn rp-primary">Start</button> : <button className={stage === 'complete' ? 'rp-btn rp-primary' : 'rp-btn'}>Finish restore</button>}
        </div>
      </div>
      {stage === 'start' ? (
        <div className="rp-board rp-board-ghost">
          {columns.map((col) => <div key={col.title} className="rp-col"><h3>{col.title}</h3><p className="rp-note">{col.hint}</p>{col.title === 'Install' && <div className="rp-card rp-card-ghost">12 extensions from Laptop (Helium) will start here</div>}</div>)}
        </div>
      ) : (
        <div className="rp-board">
          {columns.map((col) => {
            const cards = rows.filter((r) => col.sts.includes(r.status));
            const extra = col.title === 'Confirm' && stage !== 'complete' ? CANT_PLACE : [];
            const had = col.title === 'Turn on/off' ? ALREADY_HERE.filter((a) => a.included && stage !== 'complete') : [];
            return (
              <div key={col.title} className="rp-col">
                <h3>{col.title} <span className="rp-count">{cards.length + extra.length + had.length}</span></h3>
                <p className="rp-note">{col.hint}</p>
                {col.title === 'Turn on/off' && stage !== 'complete' && <button className="rp-btn rp-wide">Apply all ({c.applyAll})</button>}
                {cards.map((r) => (
                  <div key={r.key} className={`rp-card ${col.title === 'Finished' ? 'rp-card-quiet' : ''}`}>
                    <div className="rp-row-between"><strong>{r.name}</strong><span className={`rp-pill rp-${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span></div>
                    <small className="rp-note">{r.badge}{r.added ? ' · added on Pull' : ''}</small>
                    {col.title !== 'Finished' && <Actions row={r} compact />}
                    {r.status === 'skipped' && <Actions row={r} compact />}
                  </div>
                ))}
                {had.map((a) => <div key={a.key} className="rp-card"><div className="rp-row-between"><strong>{a.name}</strong><span className="rp-pill rp-neutral">already here</span></div><div className="rp-actions"><button className="rp-btn rp-primary">Turn {a.source ? 'on' : 'off'}</button></div></div>)}
                {extra.map((x) => <div key={x.id} className="rp-card"><div className="rp-row-between"><strong>{x.name}</strong><span className="rp-pill rp-neutral">can't place</span></div><div className="rp-actions"><button className="rp-btn">Link to…</button></div></div>)}
              </div>
            );
          })}
        </div>
      )}
      {stage !== 'start' && (
        <div className="rp-pad rp-note">
          Already here, on/off differs: {ALREADY_HERE.map((a) => <label key={a.key} className="rp-check"><input type="checkbox" defaultChecked={a.included} /> {a.name}</label>)}
        </div>
      )}
    </section>
  );
}

/* ------------------------- switcher ------------------------- */
const VARIANTS = [
  { key: 'A', name: 'Grouped checklist', C: VariantA },
  { key: 'B', name: 'One at a time', C: VariantB },
  { key: 'C', name: 'Board', C: VariantC },
] as const;
const STAGES: Stage[] = ['start', 'progress', 'complete'];

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const v = VARIANTS.findIndex((x) => x.key === p.get('variant'));
  const s = p.get('state') as Stage | null;
  return { v: v < 0 ? 0 : v, s: s && STAGES.includes(s) ? s : 'progress' };
}

export function RestoreSectionPrototype() {
  const [{ v, s }, setParams] = useState(readParams);
  const go = (nv: number, ns: Stage) => {
    const p = new URLSearchParams(window.location.search);
    p.set('variant', VARIANTS[nv]!.key);
    p.set('state', ns);
    history.replaceState(null, '', `${window.location.pathname}?${p}${window.location.hash || '#restore'}`);
    setParams({ v: nv, s: ns });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') go((v + VARIANTS.length - 1) % VARIANTS.length, s);
      if (e.key === 'ArrowRight') go((v + 1) % VARIANTS.length, s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const variant = VARIANTS[v]!;
  const { C } = variant;
  return (
    <div id="restore" className="rp-host">
      <style>{CSS}</style>
      <C key={`${v}-${s}`} stage={s} />
      <div className="rp-switcher" role="toolbar" aria-label="Prototype variant switcher">
        <button onClick={() => go((v + VARIANTS.length - 1) % VARIANTS.length, s)} aria-label="Previous variant">←</button>
        <span>{variant.key} ({variant.name})</span>
        <button onClick={() => go((v + 1) % VARIANTS.length, s)} aria-label="Next variant">→</button>
        <select value={s} onChange={(e) => go(v, e.target.value as Stage)} aria-label="Restore stage">
          {STAGES.map((x) => <option key={x} value={x}>{x === 'start' ? 'before start' : x === 'progress' ? 'in progress' : 'complete'}</option>)}
        </select>
      </div>
    </div>
  );
}

const CSS = `
.rp-host { margin-top: 18px; }
.rp-pad { padding: 16px 20px; }
.rp-row-between { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.rp-btn { border: 1px solid #d8deea; border-radius: 8px; padding: 6px 11px; background: #fff; color: #344054; font-size: 12px; font-weight: 650; cursor: pointer; }
.rp-btn.rp-primary { background: #315efb; border-color: #315efb; color: #fff; }
.rp-wide { width: 100%; margin-bottom: 8px; }
.rp-host .rp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; justify-content: flex-end; }
.rp-note { color: #7d8798; font-size: 11px; }
.rp-count { color: #8a94a6; font-weight: 500; margin-left: 4px; }
.rp-pill { padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; white-space: nowrap; }
.rp-ok { color: #197447; background: #e3f5eb; } .rp-attn { color: #8a4b00; background: #fff1d6; } .rp-wait { color: #315efb; background: #e8edff; }
.rp-neutral { color: #6d7789; background: #eceff4; } .rp-muted { color: #98a1b2; background: #f3f5f8; }
.rp-line { display: grid !important; grid-template-columns: minmax(0, 1fr) 130px minmax(0, 1.3fr); }
.rp-progress { height: 4px; background: #edf0f4; } .rp-progress div { height: 100%; background: #315efb; }
.rp-radio-list { display: grid; gap: 8px; margin-bottom: 14px; }
.rp-radio { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid #e0e4ec; border-radius: 9px; }
.rp-radio span { display: grid; gap: 2px; } .rp-radio small { color: #8a94a6; font-size: 11px; }
.rp-check { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; margin-right: 12px; }
.rp-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 18px 20px 4px; }
.rp-tile { display: grid; gap: 4px; text-align: left; padding: 16px; border: 1px solid #e0e4ec; border-radius: 12px; background: #fff; cursor: pointer; }
.rp-tile strong { font-size: 14px; } .rp-tile span, .rp-tile small { color: #7d8798; font-size: 11px; }
.rp-tile.rp-tile-on { border: 2px solid #315efb; box-shadow: 0 0 0 4px #315efb14; }
.rp-tile-family { text-transform: uppercase; letter-spacing: .06em; font-size: 10px !important; }
.rp-split { display: grid; grid-template-columns: minmax(0, 1fr) 280px; min-height: 360px; }
.rp-focus { padding: 26px 30px; display: grid; align-content: start; gap: 8px; }
.rp-kicker { color: #8a4b00; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; }
.rp-focus-title { font-size: 24px; margin: 0; letter-spacing: -.02em; }
.rp-big { font-size: 14px; margin: 8px 0; }
.rp-focus .rp-actions { justify-content: flex-start; margin-top: 6px; }
.rp-nav { margin-top: 26px; }
.rp-rail { border-left: 1px solid #e6e9f0; background: #fafbfc; padding: 0 0 12px; display: grid; align-content: start; }
.rp-rail-item { display: grid; grid-template-columns: 10px 1fr auto; gap: 8px; align-items: center; text-align: left; border: 0; background: transparent; padding: 8px 14px; font-size: 12px; cursor: pointer; }
.rp-rail-item small { color: #98a1b2; font-size: 10px; }
.rp-rail-on { background: #e8edff; }
.rp-rail-h { font-size: 11px; color: #697386; text-transform: uppercase; letter-spacing: .06em; margin: 14px 14px 4px; }
.rp-dot { width: 8px; height: 8px; border-radius: 50%; padding: 0; }
.rp-seg { display: flex; border: 1px solid #d8deea; border-radius: 9px; overflow: hidden; }
.rp-seg button { border: 0; border-right: 1px solid #d8deea; background: #fff; padding: 6px 10px; font-size: 11px; cursor: pointer; }
.rp-seg button:last-child { border-right: 0; } .rp-seg .rp-seg-on { background: #315efb; color: #fff; }
.rp-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 16px; background: #f6f7f9; }
.rp-col { display: grid; align-content: start; gap: 8px; }
.rp-col h3 { margin: 0; font-size: 12px; } .rp-col > .rp-note { margin: -4px 0 4px; }
.rp-card { display: grid; gap: 6px; padding: 10px 12px; background: #fff; border: 1px solid #e0e4ec; border-radius: 10px; }
.rp-card .rp-actions { justify-content: flex-start; }
.rp-card-quiet { opacity: .75; } .rp-card-ghost { border-style: dashed; color: #8a94a6; font-size: 12px; text-align: center; padding: 30px 10px; }
.rp-board-ghost .rp-col { min-height: 180px; }
.rp-switcher { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 1000; display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-radius: 999px; background: #111827; color: #fff; box-shadow: 0 10px 30px #0006; font: 600 12px system-ui, sans-serif; }
.rp-switcher button { border: 0; background: #374151; color: #fff; border-radius: 999px; width: 28px; height: 28px; cursor: pointer; }
.rp-switcher select { background: #374151; color: #fff; border: 0; border-radius: 6px; padding: 4px; font: inherit; }
@media (prefers-color-scheme: dark) {
  .rp-btn, .rp-tile, .rp-seg button { background: #1a2130; border-color: #394357; color: #dfe5ef; }
  .rp-radio, .rp-card { background: #1a2130; border-color: #2b3547; }
  .rp-board { background: #131a26; }
  .rp-rail { background: #151c29; border-color: #2b3547; }
  .rp-rail-item { color: #dfe5ef; } .rp-rail-on { background: #273351; }
  .rp-progress { background: #2b3547; }
  .rp-ok { color: #72d69f; background: #173c2a; } .rp-attn { color: #f2b765; background: #3d2c12; } .rp-wait { color: #9db4ff; background: #273351; }
  .rp-neutral { color: #aab3c3; background: #2a3342; } .rp-muted { color: #7d8798; background: #1f2735; }
  .rp-kicker { color: #f2b765; }
}
`;
