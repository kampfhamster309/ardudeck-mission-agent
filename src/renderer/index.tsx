// Jetrover mission agent, renderer side: a small status panel in the module dock.

import { useEffect, useState } from 'react';
import type { RendererHostApi } from '@ardudeck/module-sdk';

interface Status {
  guided: { connected: boolean; armed: boolean; guided: boolean; vehicleClass: string; ardupilot: boolean };
  telemetry: { groundspeed?: number; heading?: number; lat?: number; lon?: number };
  canDrive: boolean;
  refusal: string | null;
  path: string | null;
  link: { describe: string; error: string | null } | null;
  behaviour: string | null;
}

function Panel({ host }: { host: RendererHostApi }) {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = (await host.invoke('status', null)) as Status;
        if (alive) setS(next);
      } catch { /* main side not ready yet */ }
    };
    void tick();
    const id = setInterval(tick, 500);
    return () => { alive = false; clearInterval(id); };
  }, [host]);

  const g = s?.guided;
  const canDrive = !!s?.canDrive;
  return (
    <div style={{ padding: 12, fontSize: 12, lineHeight: 1.6, minWidth: 240 }}>
      <div>Vehicle: {g ? `${g.vehicleClass}${g.connected ? '' : ' (not connected)'}` : '…'}</div>
      <div>Armed: {g?.armed ? 'yes' : 'no'}</div>
      <div style={{ color: canDrive ? '#4ade80' : '#f87171' }}>
        {canDrive ? 'Agent may drive' : `Agent may not drive: ${s?.refusal ?? 'needs armed + Guided'}`}
      </div>
      <div style={{ opacity: 0.6 }}>Agent link: {s?.link?.describe ?? '–'}{s?.link?.error ? ` (${s.link.error})` : ''}</div>
      <div>Speed: {s?.telemetry.groundspeed?.toFixed(2) ?? '–'} m/s · Heading: {s?.telemetry.heading ?? '–'}°</div>
      <div>Behaviour: {s?.behaviour ?? 'none'}</div>
      <div style={{ opacity: 0.6 }}>Control port: http://127.0.0.1:8765</div>
      <button
        style={{ marginTop: 8, padding: '4px 12px' }}
        onClick={() => void host.invoke('stop', null)}
      >
        Stop agent
      </button>
    </div>
  );
}

export async function activate(host: RendererHostApi) {
  host.panels.register({
    id: 'status',
    title: 'Mission Agent',
    badge: 'MA',
    component: () => <Panel host={host} />,
  });
}

export function deactivate() {}
