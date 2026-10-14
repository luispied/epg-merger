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

function CodeRow({ label, onCopy }: { label: string; onCopy: () => Promise<string | null> }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div class="cd-row">
      <div class="cd-text"><small>{label}</small></div>
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

/** Un código para ver con los dos caminos de «Compartir para ver»: copiar el código (para pegar) o el link (abre directo). */
function ViewRow({ label, onCopy }: { label: string; onCopy: (kind: 'code' | 'link') => Promise<string | null> }) {
  const [copied, setCopied] = useState<'' | 'code' | 'link'>('');
  const [busy, setBusy] = useState(false);
  const copy = async (kind: 'code' | 'link') => {
    setBusy(true);
    const text = await onCopy(kind);
    setBusy(false);
    if (!text) return;
    await copyText(text);
    setCopied(kind);
    setTimeout(() => setCopied(''), 2000);
  };
  return (
    <div class="cd-row cd-stack">
      <div class="cd-text"><small>{label}</small></div>
      <div class="cd-actions">
        <button type="button" class="btn btn-tonal sm" disabled={busy} aria-label={`Copiar código: ${label}`} onClick={() => void copy('code')}>
          {copied === 'code' ? <><Icon name="check" />Copiado</> : <><Icon name="copy" />Copiar código</>}
        </button>
        <button type="button" class="btn btn-primary sm" disabled={busy} aria-label={`Copiar link: ${label}`} onClick={() => void copy('link')}>
          {copied === 'link' ? <><Icon name="check" />Copiado</> : <><Icon name="link-2" />Copiar link</>}
        </button>
      </div>
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
  /** El texto a copiar: el código «ver.<código>» o el link /ver#<código>. Un perfil sin código lo crea al copiar. */
  const viewText = async (id: string, kind: 'code' | 'link') => {
    let code = views[id];
    if (!code) {
      try {
        code = (await api<{ code: string }>(`/api/cfg/${state.local!.cfgId}/profiles/${id}/view`, { method: 'POST', body: {} })).code;
        setViews((v) => ({ ...v, [id]: code }));
        void loadProfiles(false);
      } catch (e) {
        toast((e as Error).message, 'bad');
        return null;
      }
    }
    return kind === 'link' ? `${location.origin}/ver#${code}` : `ver.${code}`;
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
        <CodeRow label="Código para editar" onCopy={async () => homeCode} />
        {profileDefs.length > 0 && (
          <>
            <h3 class="sec-title">Modo ver</h3>
            <p class="help">Se pega en el mismo lugar y la app queda en modo ver: la grilla y la Guía de ese perfil, con letra
              grande y sin poder cambiar nada. <b>Copiar link</b> lo da listo para mandar: abre directo, sin pegar nada.</p>
            {profileDefs.map((p) => (
              <ViewRow key={p.id} label={`Para ver «${p.name}»`} onCopy={(kind) => viewText(p.id, kind)} />
            ))}
          </>
        )}
      </div>
    </dialog>
  );
}
