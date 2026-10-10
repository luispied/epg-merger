// Las tarjetas de arriba de la lista de canales, en Preact (ver planes/react.md): la de los links (la primera vez los
// links se arman solos, con un dispositivo «Mi reproductor», y esta tarjeta los ofrece listos para copiar; se descarta
// con la X y después viven en Perfil) y la de los atajos, que aparece una sola vez cuando se descarta la de los links.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, copyText, pref, setPref, state, type Device } from '../app.ts';
import { Icon } from './icon.tsx';
import { renderLinkResult } from './perfiles.tsx';

export const LINKS_CARD_KEY = (id: string) => `grilla_links_card_${id}`;
const TIP_KEY = 'grilla_tip_gestures';

const el = (id: string) => document.getElementById(id) as HTMLElement;

/** Copia al tocar y dice «Copiado» un par de segundos. */
function CopyButton({ text, label, class: cls }: { text: string; label: string; class: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" class={cls} onClick={async () => { await copyText(text); setCopied(true); }}>
      <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copiado' : label}
    </button>
  );
}

function LinksCard({ dev, onClose }: { dev: Device; onClose: () => void }) {
  return (
    <>
      <div class="lc-head"><Icon name="tv" />
        <div class="lc-text"><strong>Tu lista está lista</strong><small>Copiá estos dos links en tu reproductor (TiviMate, IPTV Smarters…).</small></div>
        <button type="button" class="icon-btn" aria-label="Descartar" onClick={onClose}><Icon name="x" /></button></div>
      <div class="lc-actions">
        <CopyButton class="btn btn-primary" text={dev.playlistUrl} label="Copiar playlist" />
        <CopyButton class="btn btn-tonal" text={dev.epgUrl} label="Copiar guía" /></div>
      <button type="button" class="link-btn" onClick={() => {
        renderLinkResult(dev);
        (el('linksDialog') as HTMLDialogElement).showModal();
      }}>Ver código QR y otras formas de compartir<Icon name="chevron-right" class="sm" /></button>
    </>
  );
}

/** La tarjeta de los links, si esta lista la tiene pendiente y su primer link sigue activo. */
export async function renderLinksCard() {
  const card = el('linksCard');
  card.hidden = true;
  render(null, card);
  if (!state.local || pref(LINKS_CARD_KEY(state.local.cfgId), '') !== '1') return;
  const cfgId = state.local.cfgId;
  let dev: Device | undefined;
  try {
    dev = (await api<{ devices: Device[] }>(`/api/cfg/${cfgId}/devices`)).devices[0];
  } catch { /* sin conexión: no se muestra */ }
  if (!dev || !dev.active || state.local?.cfgId !== cfgId) return;
  const close = () => {
    setPref(LINKS_CARD_KEY(cfgId), '0');
    card.hidden = true;
    render(null, card);
    renderTipCard();
  };
  render(<LinksCard key={`${cfgId}:${dev.code}`} dev={dev} onClose={close} />, card);
  card.hidden = false;
}

function TipCard({ onClose }: { onClose: () => void }) {
  return (
    <div class="tip-head"><Icon name="lightbulb" /><div class="tip-text"><strong>Atajos</strong>
      <small><b>Deslizá</b> una fila hacia la izquierda para ocultarla o hacia la derecha para dejarla sin guía. <b>Mantenela apretada</b> para elegir varias.</small></div>
      <button type="button" class="icon-btn" aria-label="Entendido" onClick={onClose}><Icon name="x" /></button></div>
  );
}

/** Una sola vez, a quien arma su lista por primera vez: cómo se usan los gestos (que no se ven). Con la tarjeta de
 *  los links a la vista no se suma otra: aparece cuando se descarta. */
export function renderTipCard() {
  const card = el('tipCard');
  const fresh = state.local && localStorage.getItem(LINKS_CARD_KEY(state.local.cfgId)) !== null;
  card.hidden = !fresh || pref(TIP_KEY, '') === '1' || !el('linksCard').hidden;
  if (card.hidden) {
    render(null, card);
    return;
  }
  render(<TipCard onClose={() => {
    setPref(TIP_KEY, '1');
    card.hidden = true;
    render(null, card);
  }} />, card);
}
