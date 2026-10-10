// La hoja de la selección múltiple, en Preact (ver planes/react.md), con el mismo patrón que la del canal: buscar una
// guía para todos con «Automática» y «Sin guía», las opciones que más se repiten entre los seleccionados y, abajo,
// mover de categoría y lo que se puede restaurar. Todo se aplica a los seleccionados y sale del modo selección.
//
// Importa de app.ts y app.ts importa de acá, como ui/perfiles.tsx: nada de app.ts se usa al cargar el módulo.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import {
  applyBulk, autoEpg, confirmDialog, groupLabel, groups, info, newCategoryName, noEpg, pickEpg, plural, sectionHeaders, selection,
  state,
} from '../app.ts';
import { Candidate, GuideSearch } from './epg.tsx';
import { Icon } from './icon.tsx';

const dialog = () => document.getElementById('bulkDialog') as HTMLDialogElement;
let seq = 0;

export function openBulkMenu() {
  const n = selection.items.size;
  document.getElementById('bulkTitle')!.textContent = plural(n, 'seleccionado', 'seleccionados');
  render(<BulkSheet key={++seq} />, document.getElementById('bulkBody')!);
  dialog().showModal();
}

function MenuRow({ ico, text, onClick }: { ico: string; text: string; onClick: () => void }) {
  return <button type="button" class="menu-row " onClick={onClick}><span class="menu-icon"><Icon name={ico} /></span><span class="menu-text">{text}</span></button>;
}

function BulkSheet() {
  const chs = [...selection.items].map((i) => state.channels[i]);
  const n = chs.length;
  const cfg = state.cfg!;
  const [dest, setDest] = useState('');
  const allHidden = chs.every((ch) => cfg.channels[ch.name]?.hidden);
  // Primero las opciones que más se repiten entre los seleccionados (su guía actual y sus alternativas).
  const score = new Map<string, number>();
  for (const ch of chs) {
    const cur = cfg.channels[ch.name]?.epg;
    const ids = [...(cur ? [cur] : []), ...(state.auto.get(ch.name)?.ranked ?? []).map((c) => c.channelId)];
    for (const id of new Set(ids)) score.set(id, (score.get(id) ?? 0) + 1);
  }
  const suggestions = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const anyManual = chs.some((ch) => cfg.channels[ch.name]?.manual);
  const headers = sectionHeaders();
  const many = (one: string, more: string) => plural(n, one, more);
  const done = (fn: Parameters<typeof applyBulk>[0], msg: string) => {
    dialog().close();
    applyBulk(fn, msg);
  };
  const pick = (id: string) => done((e, ch) => { if (!info(ch).divider) pickEpg(e, id); }, `Guía elegida para ${many('canal', 'canales')}`);
  const noGuide = async () => {
    const yes = await confirmDialog({
      title: `¿Dejar ${many('canal', 'canales')} sin guía?`,
      text: 'No se les asigna guía ni logo, ni siquiera automáticamente. Se puede deshacer.',
      ok: 'Dejar sin guía', danger: true,
    });
    if (yes) done(noEpg, `${many('canal', 'canales')} sin guía a propósito`);
  };
  const move = async () => {
    const to = dest === '__new__' ? (await newCategoryName()) ?? '' : dest;
    if (to) done((e, ch) => { e.group = to === ch.category ? undefined : to; }, `${many('canal movido', 'canales movidos')} a ${to}`);
  };
  const resets = [
    <MenuRow key="vis" ico={allHidden ? 'eye' : 'eye-off'} text={allHidden ? 'Mostrar en la playlist' : 'Ocultar de la playlist'} onClick={() => (allHidden
      ? done((e) => { delete e.hidden; }, `${many('canal visible', 'canales visibles')} en la playlist`)
      : done((e) => { e.hidden = true; }, `${many('canal oculto', 'canales ocultos')} de la playlist`))} />,
    chs.some((ch) => cfg.channels[ch.name]?.name)
      && <MenuRow key="names" ico="rotate-ccw" text="Restaurar nombres originales" onClick={() => done((e) => { delete e.name; }, 'Nombres originales restaurados')} />,
    chs.some((ch) => cfg.channels[ch.name]?.group)
      && <MenuRow key="cat" ico="rotate-ccw" text="Volver a las categorías originales" onClick={() => done((e) => { delete e.group; }, 'Categorías originales restauradas')} />,
  ];

  return (
    <>
      <h3 class="sec-title">{n === 1 ? 'Guía del canal' : `Guía para los ${n}`}</h3>
      <GuideSearch placeholder="Buscar una guía para todos" label="Buscar una guía para todos" onPick={pick}>
        <div class="ch-chips">
          <button type="button" class="chip-btn" data-act="auto" disabled={!anyManual}
            onClick={() => done(autoEpg, `${many('canal vuelve', 'canales vuelven')} a la guía automática`)}><Icon name="undo-2" class="sm" />Automática</button>
          <button type="button" class="chip-btn" data-act="no-epg" onClick={noGuide}><Icon name="ban" class="sm" />Sin guía</button>
        </div>
      </GuideSearch>
      {suggestions.length > 0 && <div class="list opts">
        {suggestions.map(([id, count]) => <Candidate key={id} id={id} note={count > 1 ? `· opción de ${count} de ${n}` : ''} onPick={pick} />)}
      </div>}
      <h3 class="sec-title">Categoría</h3>
      <div class="bulk-move">
        <label class="field"><span class="sr-only">Mover a la categoría</span>
          <select class="select bulk-cat" aria-label="Mover a la categoría" value={dest} onChange={(ev) => setDest(ev.currentTarget.value)}>
            <option value="" disabled>Elegir categoría…</option>
            {groups().filter((g) => !headers.has(g) && !cfg.groups.hidden.includes(g)).map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
            <option value="__new__">Nueva categoría…</option>
          </select></label>
        <button type="button" class="btn btn-tonal" data-act="move" disabled={!dest} onClick={move}>Mover</button>
      </div>
      <h3 class="sec-title">Más</h3>
      <div class="menu">{resets}</div>
    </>
  );
}
