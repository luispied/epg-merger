// «Tu código»: el código del hogar (para editar desde otro dispositivo) y, abajo, el código para ver de cada perfil
// (modo «solo ver», ver.tsx), los dos a la vista y cada uno con su «Copiar». Un perfil sin código lo crea al copiar.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, copyText, loadProfiles, profileDefs, state } from '../app.ts';
import { Icon } from './icon.tsx';
import { toast } from './toast.tsx';

export function openCodes(homeCode: string) {
  let host = document.getElementById('codesHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'codesHost';
    document.body.appendChild(host);
  }
  render(<CodesSheet key={Date.now()} homeCode={homeCode} close={() => render(null, host!)} />, host);
}

function CodeRow({ label, code, empty, onCopy }: { label: string; code: string; empty?: string; onCopy: () => Promise<string | null> }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div class="cd-row">
      <div class="cd-text"><small>{label}</small><code class={code ? '' : 'muted'}>{code || empty}</code></div>
      <button type="button" class="btn btn-tonal sm" disabled={busy} aria-label={`Copiar: ${label}`} onClick={async () => {
        setBusy(true);
        const text = await onCopy();
        setBusy(false);
        if (!text) return;
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}>{copied ? <><Icon name="check" />Copiado</> : <><Icon name="copy" />Copiar</>}</button>
    </div>
  );
}

function CodesSheet({ homeCode, close }: { homeCode: string; close: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [views, setViews] = useState<Record<string, string>>(() => Object.fromEntries(profileDefs.filter((p) => p.view).map((p) => [p.id, p.view!])));
  useLayoutEffect(() => {
    dlg.current?.showModal();
    return () => dlg.current?.close();
  }, []);
  const viewCode = async (id: string) => {
    if (views[id]) return `ver.${views[id]}`;
    try {
      const { code } = await api<{ code: string }>(`/api/cfg/${state.local!.cfgId}/profiles/${id}/view`, { method: 'POST', body: {} });
      setViews((v) => ({ ...v, [id]: code }));
      void loadProfiles(false);
      return `ver.${code}`;
    } catch (e) {
      toast((e as Error).message, 'bad');
      return null;
    }
  };
  return (
    <dialog class="sheet settings-sheet cd-sheet" ref={dlg} onClose={close} aria-labelledby="cdTitle">
      <div class="sheet-body">
        <div class="title-row">
          <h2 id="cdTitle">Tu código</h2>
          <form method="dialog"><button class="icon-btn" aria-label="Cerrar"><Icon name="x" /></button></form>
        </div>
        <h3 class="sec-title">Para editar</h3>
        <p class="help">Abre todos tus proveedores y perfiles en otro dispositivo (Perfil → Usar en otro dispositivo → Pegar un
          código). Se mantiene al día solo. Guardalo en privado: quien lo tenga puede editar tus configuraciones.</p>
        <CodeRow label="Código para editar" code={homeCode} onCopy={async () => homeCode} />
        {profileDefs.length > 0 && (
          <>
            <h3 class="sec-title">Modo ver</h3>
            <p class="help">Se pega en el mismo lugar y la app queda en modo ver: la grilla y la Guía de ese perfil, con letra
              grande y sin poder cambiar nada. Ideal para alguien a quien le cuesta usar apps.</p>
            {profileDefs.map((p) => (
              <CodeRow key={p.id} label={`Para ver «${p.name}»`} code={views[p.id] ? `ver.${views[p.id]}` : ''}
                empty="Se crea al copiarlo" onCopy={() => viewCode(p.id)} />
            ))}
          </>
        )}
      </div>
    </dialog>
  );
}
