// «La guía no coincide»: canales que alguien marcó desde el modo «solo ver» (ver.tsx). Arriba de la lista de Canales
// aparece un aviso; al tocarlo, una hoja con cada canal marcado para abrirlo y cambiarle la guía, o darlo por resuelto.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, plural, state } from '../app.ts';
import { openChannel } from './canal.tsx';
import { Icon } from './icon.tsx';
import { toast } from './toast.tsx';

interface Report { id: string; name: string; epg: string | null; title?: string; by: string; at: string }
let reports: Report[] = [];

const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `hace ${Math.max(1, min)} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} d`;
};

/** Baja los canales marcados y dibuja el aviso (o lo esconde si no hay). */
export async function loadReports() {
  if (!state.local) return;
  const cfgId = state.local.cfgId;
  try {
    const r = await api<{ items: Report[] }>(`/api/cfg/${cfgId}/reports`);
    if (state.local?.cfgId !== cfgId) return;
    reports = r.items ?? [];
  } catch { /* sin conexión: queda lo último */ }
  renderReportNotice();
}

function renderReportNotice() {
  const box = document.getElementById('reportNotice') as HTMLButtonElement | null;
  if (!box) return;
  box.hidden = !reports.length;
  const who = [...new Set(reports.map((r) => r.by))];
  render(reports.length ? (
    <>
      <Icon name="triangle-alert" />
      <span class="pn-text"><strong>{reports.length === 1 ? `La guía de «${reports[0].name}» no coincide` : `${plural(reports.length, 'canal', 'canales')} con la guía que no coincide`}</strong>
        <small>Lo marcó {who.join(', ')} desde el modo ver · tocá para revisar</small></span>
      <Icon name="chevron-right" />
    </>
  ) : null, box);
  box.onclick = () => openReports();
}

function openReports() {
  let host = document.getElementById('reportsHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'reportsHost';
    document.body.appendChild(host);
  }
  render(<ReportsSheet key={Date.now()} close={() => render(null, host!)} />, host);
}

function ReportsSheet({ close }: { close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState(reports);
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const done = async (r: Report) => {
    try {
      await api(`/api/cfg/${state.local!.cfgId}/reports/${encodeURIComponent(r.id)}`, { method: 'DELETE', body: {} });
      reports = reports.filter((x) => x.id !== r.id);
      setItems(reports);
      renderReportNotice();
      if (!reports.length) dlg.current?.close();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const open = (r: Report) => {
    const i = state.channels.findIndex((c) => c.id === r.id);
    if (i < 0) return void toast('Ese canal ya no está en la lista', 'bad');
    dlg.current?.close();
    openChannel(i);
  };
  return (
    <dialog class="sheet settings-sheet rp-sheet" ref={dlg} onClose={close} aria-labelledby="rpTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="rpTitle">La guía no coincide</h2>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <p class="help">Desde el modo ver avisaron que lo que dan en la tele no es lo que muestra la guía. Abrí el canal para
          elegir otra guía y después marcalo como resuelto.</p>
        {items.map((r) => (
          <div class="rp-row" key={r.id}>
            <div class="rp-text"><strong>{r.name}</strong>
              <small>{r.title ? `La guía decía «${r.title}» · ` : ''}{r.by} · {ago(r.at)}</small></div>
            <div class="rp-actions">
              <button type="button" class="btn btn-tonal sm" onClick={() => open(r)}><Icon name="pencil" />Cambiar guía</button>
              <button type="button" class="btn btn-plain sm" onClick={() => void done(r)}><Icon name="check" />Resuelto</button>
            </div>
          </div>
        ))}
      </div>
    </dialog>
  );
}
