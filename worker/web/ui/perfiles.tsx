// Perfil: cuentas, perfiles y links, en Preact (ver planes/react.md). Los datos (qué cuentas, perfiles y links hay, la
// cuenta en uso) y las llamadas al Worker siguen en app.ts; acá están las páginas de la hoja «Perfiles» y cómo se pasa
// de una a otra. Ningún paso cambia la dirección de un link. Ver planes/perfiles.md.
//
// Importa de app.ts y app.ts importa de acá: mientras dure la migración, lo compartido vive en app.ts. Acá no se usa
// nada de app.ts al cargar el módulo, solo dentro de funciones, así que el orden de carga no importa.
import { Fragment, render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  accountData, accountName, activeAccount, addProvider, ago, api, apiWrites, confirmDialog, connectionsInUse, copyText, daysLeft,
  eventTz, EVENT_TZ_KEY, exportBackup, fold, forgetConfig, groupLabel, groupOf, groups, initialOf, liveAt, loadHome, loadProfiles,
  loadStreamHealth, matchesFilter, myAccounts, otherAccounts, otherProviders, plural, profileDefs, profileDevices, profilesAt,
  promptDialog, providerName, providerTz, relayTrouble, render as renderGrid, renderDownRow, renderTabAvatar, saveHome, saveNow, sectionHeaders,
  sectionTitle, setActiveAccount, setPref, shareText, showHomeCode, showOnboarding, showQr, state, switchProvider, useHomeCode,
  useOtherAccount, useViewCode, wireDownRow,
  type Account, type AccountView, type Device, type DeviceFilter, type LinkResult, type OtherProvider, type ProfileDef, type ProfileView,
} from '../app.ts';
import { Icon } from './icon.tsx';
import { closeSheet } from './sheet.ts';
import { changeTaste, deviceTz, loadTaste, openTasteSheet, pushEndpoint, tasteSummary, WHEN_HOURS, WHEN_LABEL, type TasteView } from './avisos-gusto.tsx';
import { Skeleton } from './kit.tsx';
import { Settings } from './settings.tsx';
import { toast } from './toast.tsx';

// ------------------------------------------------------------------ navegación
// Una lista corta (por proveedor, cada cuenta con sus perfiles debajo) y una página por cuenta, por perfil, por proveedor
// y para el hogar. Los formularios son subpáginas: «‹» vuelve a la página de donde salieron.
export type LinksView = { v: 'list' } | { v: 'account'; account: string; cfgId?: string } | { v: 'profile'; id: string; cfgId?: string }
  | { v: 'provider'; cfgId: string } | { v: 'hogar' } | { v: 'connections'; account: string } | { v: 'ajustes' };
type LinksSub =
  | { k: 'move'; dev: Device }
  | { k: 'add-device'; p: ProfileView; a: AccountView }
  | { k: 'add-profile'; account: string }
  | { k: 'add-account' }
  | { k: 'creds'; a: AccountView }
  | { k: 'profile-account'; p: ProfileView; a: AccountView }
  | { k: 'delete-profile'; p: ProfileView }
  | { k: 'delete-account'; a: AccountView }
  | { k: 'servers' }
  | { k: 'filter'; p: ProfileView }
  | { k: 'view'; p: ProfileView }
  | { k: 'kids-hidden'; p: ProfileView }
  | { k: 'result'; result: LinkResult };

let linksView: LinksView = { v: 'list' };
let linksSub: LinksSub | null = null;
/** Si se llegó a «Usar en otro dispositivo» desde Configuración, a dónde volver con «‹». */
let backToSettings: (() => void) | null = null;
/** Cada subpágina se dibuja de cero (con su propio estado), aunque sea del mismo tipo que la anterior. */
let subSeq = 0;
const el = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const linksBody = () => el('#linksBody');
const setTitle = (t: string) => { el('#linksTitle').textContent = t; };
const dialogOpen = () => el<HTMLDialogElement>('#linksDialog').open;
const isCurrent = (cfgId?: string) => !cfgId || cfgId === state.local?.cfgId;
const otherOf = (cfgId?: string) => (isCurrent(cfgId) ? undefined : otherProviders.find((o) => o.cfgId === cfgId));

/** Abre la hoja en una página (la lista, si no se dice otra). `from`: a dónde volver con «‹» desde esa página. */
export function openLinksView(v: LinksView = { v: 'list' }, from?: () => void) {
  linksView = v;
  backToSettings = from ?? null;
  void renderLinks();
}
function openSub(s: LinksSub) {
  linksSub = s;
  el('#linksBack').hidden = false;
  render(<SubPage key={++subSeq} s={s} />, linksBody());
}
/** «‹»: de una subpágina vuelve a su página; de las conexiones, a su cuenta; de otra página, a la lista. */
export function linksBack() {
  if (!linksSub && linksView.v === 'hogar' && backToSettings) {
    const back = backToSettings;
    backToSettings = null;
    back();
    return;
  }
  if (!linksSub) linksView = linksView.v === 'connections' ? { v: 'account', account: linksView.account } : { v: 'list' };
  void renderLinks();
}
/** Los links de un dispositivo (copiar, compartir, QR). */
export function renderLinkResult(result: LinkResult) {
  openSub({ k: 'result', result });
}

/** Dibuja la página en la que se está (la lista, si esa página ya no existe). Con `result`, los links de un dispositivo. */
export async function renderLinks(result?: LinkResult) {
  if (result) return renderLinkResult(result);
  const body = linksBody();
  linksSub = null;
  if (!body.firstElementChild) render(<p class="help">Cargando…</p>, body);
  // Si lo que se tiene está al día (nada cambió desde que se bajó), se dibuja ya y se actualiza por detrás; si no, se espera.
  const sig = () => JSON.stringify([profileDevices, profileDefs, otherProviders.map((o) => [o.devices, o.profiles])]);
  if (profilesAt >= 0 && profilesAt === apiWrites && drawLinksView()) {
    const before = sig();
    const view = linksView;
    void loadProfiles(false).then(() => {
      if (sig() !== before && linksView === view && !linksSub && dialogOpen()) void renderLinks();
    });
  } else {
    await loadProfiles(false);
    drawLinksView(false);
  }
  // Vencimiento y conexiones en uso al momento: se piden al abrir (si hace más de un minuto) y se vuelve a dibujar.
  if (Date.now() - liveAt > 60_000) {
    void loadProfiles().then(() => {
      // Solo si llegaron datos nuevos (sin relay no hay bucle) y se sigue en la misma página.
      if (Date.now() - liveAt <= 60_000 && dialogOpen() && !linksSub) void renderLinks();
    });
  }
}

/** Qué ayuda abre el «?» de Perfil: la de Configuración cuando es la página que se ve. */
export function linksHelpTopic(): 'links' | 'settings' {
  return linksView.v === 'ajustes' ? 'settings' : 'links';
}

/** Dibuja la página en la que se está; con `strict`, devuelve false si esa página no existe (sin caer a la lista). */
function drawLinksView(strict = true): boolean {
  const v = linksView;
  const page = v.v === 'account' ? accountPage(v.account, v.cfgId)
    : v.v === 'profile' ? profilePage(v.id, v.cfgId)
    : v.v === 'provider' ? providerPage(v.cfgId)
    : v.v === 'hogar' ? { title: 'Otro dispositivo', node: <HogarPage /> }
    : v.v === 'ajustes' ? { title: 'Configuración', node: <Settings /> }
    : v.v === 'connections' ? connectionsPage(v.account)
    : null;
  if (!page && strict && v.v !== 'list') return false;
  if (page) {
    setTitle(page.title);
    render(<Fragment key={JSON.stringify(v)}>{page.node}</Fragment>, linksBody());
  } else {
    linksView = { v: 'list' };
    setTitle('Perfiles');
    render(<Fragment key="list"><ProfileList /></Fragment>, linksBody());
  }
  el('#linksBack').hidden = linksView.v === 'list';
  return true;
}

// ------------------------------------------------------------------ piezas
const Avatar = ({ name, on = false, cls = '' }: { name: string; on?: boolean; cls?: string }) => (
  <span class={`avatar${cls ? ` ${cls}` : ''}${on ? ' on' : ''}`} aria-hidden="true">{initialOf(name)}</span>
);

function MenuRow({ ico, title, sub = '', cls = '', chevron = true, onClick }: {
  ico: string; title: string; sub?: string; cls?: string; chevron?: boolean; onClick?: () => void;
}) {
  return (
    <button type="button" class={`menu-row${cls ? ` ${cls}` : ''}`} onClick={onClick}>
      <span class="menu-icon"><Icon name={ico} /></span>
      <span class="menu-text">{title}{sub ? <small>{sub}</small> : null}</span>
      {chevron ? <Icon name="chevron-right" /> : null}
    </button>
  );
}

/** Para los envíos: un segundo toque (o Enter) mientras se guarda no vuelve a mandar. */
function useBusy() {
  const ref = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    if (ref.current) return;
    ref.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      ref.current = false;
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

const SubTitle = ({ children }: { children: ComponentChildren }) => <h3 class="sub-title">{children}</h3>;
const Help = ({ children }: { children: ComponentChildren }) => <p class="help">{children}</p>;

export const filterSummary = (f?: DeviceFilter) => {
  if (!f) return 've todo';
  const n = f.groups.length, c = f.channels.length;
  const parts = [n ? `${n} ${n === 1 ? 'categoría' : 'categorías'}` : '', c ? `${c} ${c === 1 ? 'canal' : 'canales'}` : ''].filter(Boolean).join(' y ');
  return f.only ? `solo ${parts}` : `sin ${parts}`;
};

/** Una línea con lo importante de una cuenta: días, conexiones en uso y perfiles. */
function accountLine(a: AccountView, acc?: Account): { text: string; tone: string } {
  const days = daysLeft(acc);
  const parts: string[] = [];
  if (days !== null) parts.push(days < 0 ? 'Vencida' : days === 0 ? 'Vence hoy' : days <= 7 ? `Vence en ${plural(days, 'día', 'días')}` : plural(days, 'día', 'días'));
  if (acc?.maxConnections) parts.push(acc.activeConnections === undefined ? `hasta ${acc.maxConnections} a la vez` : `${connectionsInUse(acc)} de ${acc.maxConnections} en uso`);
  if (!a.devices.length) parts.push('sin links');
  return { text: parts.join(' · ') || 'Cuenta del proveedor', tone: days === null ? '' : days <= 3 ? 'bad' : days <= 7 ? 'warn' : '' };
}
const profileSub = (p: ProfileView) => `${filterSummary(p.filter)} · ${p.devices.length ? plural(p.devices.length, 'link', 'links') : 'sin links'}`;

/** `onConnections`: la de conexiones se toca para ver qué links están conectados. */
function AccountStats({ acc, on, onConnections }: { acc?: Account; on: boolean; onConnections?: () => void }) {
  const days = daysLeft(acc);
  const down = on ? state.channels.filter((c) => matchesFilter(c, 'caidos')).length : null;
  const connsValue = !acc?.maxConnections ? '—' : acc.activeConnections === undefined ? `Hasta ${acc.maxConnections}` : `${connectionsInUse(acc)} de ${acc.maxConnections}`;
  const connsLabel = acc?.activeConnections === undefined ? 'Conexiones' : 'Conexiones en uso';
  const connsCls = acc?.maxConnections && (acc.activeConnections ?? 0) >= acc.maxConnections ? 'warn' : '';
  const Stat = ({ value, label, cls = '' }: { value: string; label: string; cls?: string }) => (
    <div class="pc-stat"><b class={cls}>{value}</b><small>{label}</small></div>
  );
  return (
    <div class="pc-stats">
      <Stat value={days === null ? '—' : days < 0 ? 'Vencida' : plural(days, 'día', 'días')} label="Suscripción"
        cls={days === null ? '' : days <= 3 ? 'bad' : days <= 7 ? 'warn' : 'ok'} />
      {onConnections ? (
        <button type="button" class="pc-stat pc-link" aria-label="Conexiones en uso: ver qué links están conectados" onClick={onConnections}>
          <b class={connsCls}>{connsValue}</b><small>{connsLabel}</small><Icon name="chevron-right" class="sm" />
        </button>
      ) : <Stat value={connsValue} label={connsLabel} cls={connsCls} />}
      {on ? <Stat value={String(down)} label="Caídos" cls={down ? 'bad' : ''} /> : null}
    </div>
  );
}

function AccountRow({ a, acc, on, cfgId }: { a: AccountView; acc?: Account; on: boolean; cfgId?: string }) {
  const l = accountLine(a, acc);
  return (
    <button type="button" class="menu-row profile-row account-row"
      onClick={() => openLinksView({ v: 'account', account: a.account, ...(cfgId ? { cfgId } : {}) })}>
      <Avatar name={a.name} on={on} />
      <span class="menu-text"><span class="pr-title">{a.name}{on ? <span class="pc-badge">En uso</span> : null}</span><small class={l.tone}>{l.text}</small></span>
      <Icon name="chevron-right" />
    </button>
  );
}

function ProfileRow({ p, cfgId, nested = true }: { p: ProfileView; cfgId?: string; nested?: boolean }) {
  return (
    <button type="button" class={`menu-row profile-row${nested ? ' sub-row' : ''}`}
      onClick={() => openLinksView({ v: 'profile', id: p.id, ...(cfgId ? { cfgId } : {}) })}>
      <Avatar name={p.name} cls="sm" />
      <span class="menu-text">{p.name}<small>{profileSub(p)}</small></span>
      <Icon name="chevron-right" />
    </button>
  );
}

/** Los campos de usuario y contraseña (o URL) de una cuenta; se leen con readCreds. */
function CredsFields({ prefix }: { prefix: string }) {
  return state.cfg!.provider.type === 'xtream' ? (
    <>
      <label class="field"><span>Usuario de esa cuenta</span><input class="input" id={`${prefix}User`} autocapitalize="off" spellcheck={false} /></label>
      <label class="field"><span>Contraseña de esa cuenta</span><input class="input" id={`${prefix}Pass`} type="password" /></label>
    </>
  ) : <label class="field"><span>URL de la lista</span><input class="input" id={`${prefix}Url`} type="url" /></label>;
}
const readCreds = (prefix: string): Record<string, string> => (state.cfg!.provider.type === 'xtream'
  ? { username: el<HTMLInputElement>(`#${prefix}User`).value.trim(), password: el<HTMLInputElement>(`#${prefix}Pass`).value }
  : { url: el<HTMLInputElement>(`#${prefix}Url`).value.trim() });

/** Elegir uno de una lista (perfil o cuenta) con su inicial. */
function PickList<T>({ items, sel, onSel, name, title, sub }: {
  items: T[]; sel: number; onSel: (i: number) => void; name: string; title: (x: T) => string; sub: (x: T) => string;
}) {
  return (
    <div class="profile-pick">
      {items.map((x, i) => (
        <label class="profile-opt" key={i}>
          <input type="radio" name={name} value={String(i)} checked={i === sel} onChange={() => onSel(i)} />
          <Avatar name={title(x)} />
          <span class="po-text"><strong>{title(x)}</strong><small>{sub(x)}</small></span>
        </label>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ la lista
/** Por proveedor (el de la grilla abierta primero), cada cuenta con sus perfiles debajo. */
function ProfileList() {
  const h = loadHome();
  const cur = state.local!.cfgId;
  const xtream = state.cfg!.provider.type === 'xtream';
  const Head = ({ name, cfgId, inUse }: { name: string; cfgId: string; inUse: boolean }) => (
    <button type="button" class="provider-head" onClick={() => openLinksView({ v: 'provider', cfgId })}>
      <span class="provider-tag">{name}{inUse ? ' · en uso' : ''}</span>
      <Icon name="chevron-right" />
    </button>
  );
  return (
    <>
      <div class="menu">
        <MenuRow ico="plus" title="Agregar proveedor" sub="Otra lista de IPTV, con su propia grilla" cls="add-row" chevron={false} onClick={() => void addProvider()} />
      </div>
      <Head name={providerName(h, cur)} cfgId={cur} inUse={otherProviders.length > 0} />
      {myAccounts().map((a) => (
        <div class="menu" key={`a:${a.account}`}>
          <AccountRow a={a} acc={accountData(a)} on={a.account === activeAccount()} />
          {a.profiles.map((p) => <ProfileRow key={p.id} p={p} />)}
          <MenuRow ico="plus" title="Agregar perfil" cls="add-row sub-row" chevron={false} onClick={() => openSub({ k: 'add-profile', account: a.account })} />
        </div>
      ))}
      {xtream ? (
        <div class="menu menu-bare">
          <MenuRow ico="plus" title="Agregar cuenta" sub="La de un familiar u otra del mismo proveedor" cls="add-row sub-row" chevron={false}
            onClick={() => openSub({ k: 'add-account' })} />
        </div>
      ) : null}
      {otherProviders.map((o) => (
        <Fragment key={o.cfgId}>
          <Head name={o.name} cfgId={o.cfgId} inUse={false} />
          {otherAccounts(o).map((a) => (
            <div class="menu" key={`a:${a.account}`}>
              <AccountRow a={a} acc={a.key ? o.accounts[a.key] : undefined} on={false} cfgId={o.cfgId} />
              {a.profiles.map((p) => <ProfileRow key={p.id} p={p} cfgId={o.cfgId} />)}
            </div>
          ))}
        </Fragment>
      ))}
      <h3 class="sec-title">Dispositivos</h3>
      <div class="menu">
        <MenuRow ico="arrow-right-left" title="Usar en otro dispositivo" sub="Con un código o un archivo de respaldo" onClick={() => openLinksView({ v: 'hogar' })} />
      </div>
      <h3 class="sec-title">Aplicación</h3>
      <div class="menu">
        <MenuRow ico="settings" title="Configuración" sub="Avisos, guía y letra grande" onClick={() => openLinksView({ v: 'ajustes' })} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ cuenta
/** La página de una cuenta: su vencimiento y conexiones, usarla, los canales caídos (la en uso), sus perfiles y sus
 *  datos. Una de otro proveedor se ve sin editar: al usarla se abre su grilla. */
function accountPage(account: string, cfgId?: string) {
  const other = otherOf(cfgId);
  if (cfgId && !isCurrent(cfgId) && !other) return null;
  const a = (other ? otherAccounts(other) : myAccounts()).find((x) => x.account === account);
  if (!a) return null;
  return { title: a.name, node: <AccountPage a={a} other={other} /> };
}

function AccountPage({ a, other }: { a: AccountView; other?: OtherProvider }) {
  const on = !other && a.account === activeAccount();
  const acc = other ? (a.key ? other.accounts[a.key] : undefined) : accountData(a);
  const xtream = state.cfg!.provider.type === 'xtream';
  // La fila de canales caídos se completa sola (renderDownRow) con lo de la última prueba.
  useEffect(() => {
    if (!on) return;
    wireDownRow();
    renderDownRow();
    void loadStreamHealth().then(renderDownRow);
  }, [on]);
  const use = async () => {
    if (other) return void useOtherAccount(other.cfgId, a.account);
    await setActiveAccount(a.account);
    void renderLinks();
  };
  return (
    <>
      <div class="profile-hero">
        <Avatar name={a.name} on={on} cls="big" />
        <strong>{a.name}</strong>
        <small>Cuenta de {other ? other.name : providerName(loadHome(), state.local!.cfgId)}{on ? <> · <span class="pc-badge">En uso</span></> : null}</small>
      </div>
      <AccountStats acc={acc} on={on}
        onConnections={!other && a.devices.length > 0 ? () => openLinksView({ v: 'connections', account: a.account }) : undefined} />
      {on ? null : <button type="button" class="btn btn-primary btn-block" onClick={() => void use()}>Usar esta cuenta</button>}
      {other ? <Help>Es de otro proveedor: al usarla se abre su grilla. Para cambiar sus perfiles o sus datos, usala primero.</Help> : null}
      {on ? (
        <div class="menu">
          <div class="menu-row" id="downRow" role="button" tabIndex={0} aria-label="Canales caídos: ver la lista">
            <span class="menu-icon"><Icon name="triangle-alert" /></span>
            <span class="menu-text">Canales caídos<small id="downSub">Calculando…</small></span>
            <button type="button" class="btn btn-tonal sm" id="runCheckBtn">Probar ahora</button>
          </div>
        </div>
      ) : null}
      <SubTitle>Perfiles</SubTitle>
      <div class="menu">
        {a.profiles.map((p) => <ProfileRow key={p.id} p={p} cfgId={other?.cfgId} nested={false} />)}
        {other ? null : <MenuRow ico="plus" title="Agregar perfil" sub="Otro nombre y otra selección de canales, con la misma cuenta" cls="add-row" chevron={false}
          onClick={() => openSub({ k: 'add-profile', account: a.account })} />}
      </div>
      {other ? null : (
        <>
          <SubTitle>Cuenta</SubTitle>
          <div class="menu">
            <MenuRow ico="pencil" title="Nombre" sub={a.name} onClick={() => void renameAccount(a)} />
            <MenuRow ico="key-round" title={xtream ? 'Usuario y contraseña' : 'URL de la lista'} sub="Si cambiaron en tu proveedor: los links quedan iguales"
              onClick={() => openSub({ k: 'creds', a })} />
            {a.account ? <MenuRow ico="trash-2" title="Borrar cuenta" sub="Sus perfiles pasan a otra cuenta, con los mismos links" cls="danger"
              onClick={() => openSub({ k: 'delete-account', a })} /> : null}
          </div>
        </>
      )}
    </>
  );
}

/** Un link «está mirando» si abrió un canal hace menos de esto. El Worker solo ve cuándo empieza cada canal, no cuándo
 *  se deja, así que es una estimación. */
const RECENT_PLAY_MS = 60 * 60 * 1000;
const sinceText = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? 'recién' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} d`;
};

function connectionsPage(account: string) {
  const a = myAccounts().find((x) => x.account === account);
  return a ? { title: 'Conexiones', node: <ConnectionsPage a={a} /> } : null;
}

/** Qué links de una cuenta están conectados. El proveedor dice cuántas conexiones hay, no cuáles; nowline ve cuándo cada
 *  link abre un canal (sus streams pasan por el Worker) y pone arriba los que abrieron uno hace poco. */
function ConnectionsPage({ a }: { a: AccountView }) {
  const acc = accountData(a);
  const inUse = connectionsInUse(acc);
  const chName = new Map(state.channels.map((c) => [c.id, state.cfg?.channels[c.name]?.name || c.name]));
  const recent = (d: Device) => d.active && !!d.lastPlay && Date.now() - Date.parse(d.lastPlay.t) < RECENT_PLAY_MS;
  const byPlay = (x: Device, y: Device) => (y.lastPlay?.t ?? '').localeCompare(x.lastPlay?.t ?? '');
  // El proveedor dice cuántas conexiones hay: no se muestran más links mirando que conexiones.
  const candidates = a.devices.filter(recent).sort(byPlay);
  const watching = inUse === undefined ? candidates : candidates.slice(0, inUse);
  const rest = a.devices.filter((d) => !watching.includes(d)).sort(byPlay);
  const unseen = inUse === undefined ? 0 : inUse - watching.length;
  const Row = ({ d }: { d: Device }) => {
    const prof = a.profiles.find((p) => p.id === d.profile)?.name;
    const play = d.lastPlay ? `${chName.get(d.lastPlay.ch) ?? 'Un canal'} · ${sinceText(d.lastPlay.t)}` : 'Sin canales registrados todavía';
    const sub = !d.active ? 'Desactivado' : recent(d) ? play : d.lastPlay ? `Último canal: ${play}` : play;
    return (
      <div class={`device conn-row${d.active ? '' : ' off'}`}>
        <span class={`conn-dot${recent(d) ? ' on' : ''}`} aria-hidden="true" />
        <div class="device-info"><strong>{d.name}{prof && a.profiles.length > 1 ? <> <span class="conn-prof">· {prof}</span></> : null}</strong><small>{sub}</small></div>
      </div>
    );
  };
  const List = ({ ds }: { ds: Device[] }) => (
    <section class="profile-card"><div class="device-list">{ds.map((d) => <Row key={d.code} d={d} />)}</div></section>
  );
  return (
    <>
      <div class="pc-stats">
        <div class="pc-stat">
          <b class={acc?.maxConnections && (acc.activeConnections ?? 0) >= acc.maxConnections ? 'warn' : ''}>
            {inUse === undefined ? '—' : `${inUse}${acc?.maxConnections ? ` de ${acc.maxConnections}` : ''}`}
          </b>
          <small>En uso, según el proveedor</small>
        </div>
        <div class="pc-stat"><b class={watching.length ? 'ok' : ''}>{watching.length}</b><small>{watching.length === 1 ? 'Link mirando' : 'Links mirando'}</small></div>
      </div>
      <SubTitle>Mirando ahora</SubTitle>
      {watching.length ? <List ds={watching} /> : <Help>{inUse === 0 ? 'El proveedor no tiene conexiones abiertas ahora.' : 'Ningún link de esta cuenta abrió un canal en la última hora.'}</Help>}
      {unseen > 0 ? <Help>{unseen === 1 ? 'Una conexión no aparece' : `${unseen} conexiones no aparecen`} acá: puede ser otra app o dispositivo con la misma cuenta, un mismo link usado en varios dispositivos a la vez (Nowline ve un solo registro por link), o un canal que dejaron hace un momento y el proveedor todavía cuenta.</Help> : null}
      {rest.length ? <><SubTitle>Los demás links</SubTitle><List ds={rest} /></> : null}
      <Help>El proveedor dice cuántas conexiones hay, no cuáles. nowline ve cuándo cada link abre un canal, no cuándo lo deja: un link figura mirando hasta una hora después del último canal que abrió. Si hay más conexiones que links mirando, puede ser un link compartido por varios dispositivos.{state.cfg?.directUrls ? ' Con los streams directos al proveedor, nowline no ve los canales que se abren.' : ''}</Help>
    </>
  );
}

const profileApi = (id: string, method: 'PUT' | 'DELETE', body: Record<string, unknown>) =>
  api<{ moved?: number }>(`/api/cfg/${state.local!.cfgId}/profiles/${id}`, { method, body });

/** Cambiar el nombre de una cuenta. El de la principal se guarda en la configuración; vacío vuelve a «Tu cuenta». */
async function renameAccount(a: AccountView) {
  const name = await promptDialog({ title: 'Nombre de la cuenta', ok: 'Guardar',
    input: { label: 'Nombre', value: a.account || state.cfg?.mainName || '', placeholder: a.account ? 'Mamá' : 'Tu cuenta' } });
  if (name === null) return;
  const to = name.trim().replace(/\s+/g, ' ').slice(0, 30);
  if (a.account && !to) return void toast('Poné un nombre para la cuenta', 'bad');
  if (to === (a.account || state.cfg?.mainName || '')) return;
  if (a.account && myAccounts().some((x) => x.account === to)) return void toast(`Ya hay una cuenta «${to}»`, 'bad');
  try {
    await api(`/api/cfg/${state.local!.cfgId}/account-name`, { method: 'PUT', body: { from: a.account, to } });
    if (state.cfg) {
      if (!a.account) {
        if (to) state.cfg.mainName = to;
        else delete state.cfg.mainName;
      } else if (state.cfg.activeAccount === a.account) state.cfg.activeAccount = to;
    }
    if (a.account) linksView = { v: 'account', account: to };
    toast(`Listo: la cuenta se llama «${accountName(a.account ? to : '')}». Los links no cambiaron`, 'ok', 5000);
    renderTabAvatar();
    void renderLinks();
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  }
}

// ------------------------------------------------------------------ perfil
/** La página de un perfil: qué ve, su cuenta y sus links (cada uno sirve para varios dispositivos). */
function profilePage(id: string, cfgId?: string) {
  const other = otherOf(cfgId);
  if (cfgId && !isCurrent(cfgId) && !other) return null;
  const accounts = other ? otherAccounts(other) : myAccounts();
  const a = accounts.find((x) => x.profiles.some((p) => p.id === id));
  const p = a?.profiles.find((x) => x.id === id);
  if (!a || !p) return null;
  return { title: p.name, node: <ProfilePage p={p} a={a} accounts={accounts} other={other} /> };
}

function ProfilePage({ p, a, accounts, other }: { p: ProfileView; a: AccountView; accounts: AccountView[]; other?: OtherProvider }) {
  // A otra cuenta solo se puede pasar si tiene links (de ahí sale con qué reproducir).
  const canChangeAccount = !other && accounts.some((x) => x.account !== a.account && x.devices.length);
  const where = other || otherProviders.length ? ` · ${other ? other.name : providerName(loadHome(), state.local!.cfgId)}` : '';
  return (
    <>
      <div class="profile-hero">
        <Avatar name={p.name} cls="big" />
        <strong>{p.name}</strong>
        <small>Perfil de {a.name}{where}</small>
      </div>
      <div class="menu">
        <MenuRow ico="list-filter" title="Qué ve" sub={filterSummary(p.filter)} cls={other ? 'static' : ''} chevron={!other}
          onClick={other ? undefined : () => openSub({ k: 'filter', p })} />
        <MenuRow ico="key-round" title="Cuenta" sub={a.name} cls={canChangeAccount ? '' : 'static'} chevron={canChangeAccount}
          onClick={canChangeAccount ? () => openSub({ k: 'profile-account', p, a }) : undefined} />
      </div>
      {other ? null : <KidsRows p={p} />}
      {other ? null : <TasteRows p={p} />}
      <SubTitle>Links</SubTitle>
      {p.devices.length ? (
        <section class="profile-card">
          <div class="device-list">
            {p.devices.map((d) => (other ? (
              <div class={`device${d.active ? '' : ' off'}`} key={d.code}>
                <div class="device-top"><div class="device-info"><strong>{d.name}</strong><small>{d.active ? ago(d.lastUsed) : 'Desactivado'}</small></div></div>
              </div>
            ) : <DeviceRow key={d.code} d={d} />))}
          </div>
        </section>
      ) : <Help>Este perfil todavía no tiene links.</Help>}
      {other ? null : (
        <>
          <Help>Un mismo link sirve para varios dispositivos: copialo y cargalo en cada uno. Hacé otro solo si querés apagarlo o pasarlo a otro perfil por separado.</Help>
          <button type="button" class="btn btn-tonal btn-block" onClick={() => openSub({ k: 'add-device', p, a })}>
            <Icon name="plus" />{p.devices.length ? 'Agregar otro link' : 'Agregar link'}
          </button>
          <SubTitle>Para mirar</SubTitle>
          <div class="menu">
            <MenuRow ico="eye" title="Compartir para ver" sub={p.view ? 'Código activo: la grilla y la Guía, sin poder cambiar nada'
              : 'Un código para abrir la app solo para ver este perfil, sin poder cambiar nada'} onClick={() => openSub({ k: 'view', p })} />
          </div>
          <div class="menu">
            <MenuRow ico="pencil" title="Cambiar nombre" sub="Los links no cambian" onClick={() => void renameProfile(p)} />
            <MenuRow ico="trash-2" title="Borrar perfil" sub={p.devices.length ? 'Sus links pasan a otro perfil, sin cambiar' : ''} cls="danger"
              onClick={() => openSub({ k: 'delete-profile', p })} />
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ perfil infantil
// Un interruptor en la página del perfil: al prenderlo se abre una hoja con los géneros y las reglas; ya activo, suma
// «Géneros que entran» y «Qué se está ocultando». La regla la aplica el Worker en el modo ver del perfil (src/kids.ts);
// se activa y se quita solo desde acá, con la clave de edición. Ver planes/perfil-infantil.md.
const KIDS_ALWAYS = ['Infantil', 'Educativo'];
const KIDS_OPTIONAL = ['Documental', 'Cocina', 'Música', 'Deportes', 'Estilo de vida'];
/** «Infantil, Educativo y Documental». */
const listY = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}` : xs[0] ?? '');

function KidsRows({ p }: { p: ProfileView }) {
  const toggle = async (on: boolean) => {
    if (on) return openKidsSheet(p);
    if (!(await confirmDialog({
      title: 'Quitar el perfil infantil', danger: true, ok: 'Quitar', icon: 'hand',
      text: `«${p.name}» va a volver a ver todo lo que dejan sus categorías: películas, noticias, publicidad y también los programas sin clasificar.`,
    }))) return void renderLinks();
    try {
      await profileApi(p.id, 'PUT', { kids: null });
      toast(`«${p.name}» ya no es un perfil infantil`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
    void renderLinks();
  };
  return (
    <>
      <SubTitle>Para chicos</SubTitle>
      <div class="menu">
        <label class="menu-row static">
          <span class="menu-icon"><Icon name="hand" /></span>
          <span class="menu-text">Perfil infantil<small>{p.kids ? 'Activo' : 'Solo programas aptos, nunca publicidad'}</small></span>
          <input type="checkbox" class="switch" role="switch" aria-label={`Perfil infantil: ${p.name}`} checked={!!p.kids}
            onChange={(ev) => { const on = ev.currentTarget.checked; ev.currentTarget.checked = !!p.kids; void toggle(on); }} />
        </label>
        {p.kids ? (
          <>
            <MenuRow ico="check" title="Géneros que entran" sub={listY(p.kids.genres)} onClick={() => openKidsSheet(p)} />
            <MenuRow ico="eye" title="Qué se está ocultando" sub="Lo que no entra en las próximas horas" onClick={() => openSub({ k: 'kids-hidden', p })} />
          </>
        ) : null}
      </div>
      {p.kids ? <Help>El modo ver de este perfil aplica las mismas reglas. Para sacarlo hace falta la clave de edición, que el modo ver no tiene.</Help> : null}
    </>
  );
}

/** La hoja del perfil infantil: dice qué cambia y deja elegir los géneros opcionales (Infantil y Educativo entran siempre). */
// ------------------------------------------------------------------ avisos por gusto
// Un interruptor por perfil: prende los avisos de este perfil en este dispositivo, con la misma fila que el perfil infantil.
// La hoja (géneros, horario, últimos avisos) está en ui/avisos-gusto.tsx; el Worker manda solo a los dispositivos del perfil.
function TasteRows({ p }: { p: ProfileView }) {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [v, setV] = useState<TasteView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void pushEndpoint()
      .then((ep) => { setEndpoint(ep); return ep ? loadTaste(p.id, ep) : null; })
      .then((r) => { if (r) setV(r); })
      .catch(() => setFailed(true));
  };
  useEffect(load, [p.id]);
  if (endpoint === null && !failed) return <Skeleton rows={1} />;
  const toggle = (on: boolean) => {
    if (!v || !endpoint) return;
    changeTaste(p.id, { endpoint, on, ...(on ? { tz: deviceTz() } : {}) })
      .then(setV)
      .catch(() => toast('No se pudo guardar. Probá de nuevo.', 'bad'));
  };
  const hint = !endpoint ? 'Primero prendé Avisos en Configuración' : failed ? 'No se pudo cargar. Probá de nuevo.' : '';
  return (
    <div class="menu">
      <label class="menu-row static">
        <span class="menu-icon"><Icon name="bell" /></span>
        <span class="menu-text">Avisos por gusto<small>{hint || tasteSummary(v)}</small></span>
        <input type="checkbox" class="switch" role="switch" aria-label={`Avisos por gusto: ${p.name}`} checked={!!v?.on}
          disabled={!v || !endpoint} onChange={(ev) => toggle(ev.currentTarget.checked)} />
      </label>
      {v ? <MenuRow ico="sparkles" title="Géneros, horario y últimos avisos" sub={`${WHEN_LABEL[v.when]} · ${WHEN_HOURS[v.when]} horas`}
        onClick={() => openTasteSheet(p, setV)} /> : null}
      {failed ? <button type="button" class="btn btn-tonal btn-block" onClick={load}><Icon name="refresh-cw" />Probar de nuevo</button> : null}
    </div>
  );
}

function openKidsSheet(p: ProfileView) {
  const dlg = el<HTMLDialogElement>('#kidsDialog');
  render(<KidsSheet key={`${p.id}:${Date.now()}`} p={p} dlg={dlg} />, dlg);
  if (!dlg.open) dlg.showModal();
}

function KidsSheet({ p, dlg }: { p: ProfileView; dlg: HTMLDialogElement }) {
  const [on, setOn] = useState(() => new Set((p.kids?.genres ?? []).filter((g) => KIDS_OPTIONAL.includes(g))));
  const [busy, run] = useBusy();
  const active = !!p.kids;
  const save = (ev: Event) => {
    ev.preventDefault();
    void run(async () => {
      try {
        await profileApi(p.id, 'PUT', { kids: { genres: KIDS_OPTIONAL.filter((g) => on.has(g)) } });
        toast(active ? 'Géneros guardados' : `«${p.name}» ahora es un perfil infantil`, 'ok');
        closeSheet(dlg);
        void renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <form class="sheet-body" onSubmit={save}>
      <div class="title-row">
        <h2 id="kidsTitle">{active ? 'Géneros que entran' : 'Perfil infantil'}</h2>
        <button type="button" class="icon-btn" aria-label="Cerrar" onClick={() => closeSheet(dlg)}><Icon name="x" /></button>
      </div>
      <p>En «{p.name}» solo se van a ver programas de estos géneros. Lo que la IA no pudo clasificar no se muestra.</p>
      <h3 class="sec-title">Géneros que entran</h3>
      <div class="filter-chips">
        {KIDS_ALWAYS.map((g) => <button type="button" key={g} class="chip-btn" aria-pressed="true" disabled>{g}</button>)}
        {KIDS_OPTIONAL.map((g) => (
          <button type="button" key={g} class="chip-btn" aria-pressed={on.has(g)}
            onClick={() => setOn((cur) => { const next = new Set(cur); if (!next.delete(g)) next.add(g); return next; })}>{g}</button>
        ))}
      </div>
      <ul class="rules">
        <li><Icon name="check" /><span>Vale en el modo ver de este perfil y en la guía de sus links del reproductor: la Guía, Tu plan y la lista de canales.</span></li>
        <li><Icon name="ban" /><span>Nunca entran la publicidad, las películas, las series ni las noticias, ni lo que no tenga género.</span></li>
        <li><Icon name="info" /><span>La IA se equivoca a veces y va clasificando de a poco: al principio se ve poco y se completa solo. No es control parental: la playlist y el canal en vivo que abre el reproductor no se filtran por programa.</span></li>
      </ul>
      <div class="sheet-actions">
        <button type="button" class="btn btn-plain" onClick={() => closeSheet(dlg)}>Cancelar</button>
        <button type="submit" class="btn btn-primary" disabled={busy}>{active ? 'Guardar' : 'Activar'}</button>
      </div>
    </form>
  );
}

interface KidsReport { hours: number; shown: number; hidden: number; by: { genre: string; n: number; sample: string[] }[] }

/** «Qué se está ocultando»: de lo que dan en las próximas horas en los canales del perfil, cuántos programas se ven y
 *  cuáles se ocultan, por género (y los sin clasificar). */
function KidsHidden({ p }: { p: ProfileView }) {
  const [r, setR] = useState<KidsReport | null | 'bad'>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setR(null);
    api<KidsReport>(`/api/cfg/${state.local!.cfgId}/profiles/${p.id}/kids`).then((v) => live && setR(v)).catch(() => live && setR('bad'));
    return () => { live = false; };
  }, [tries]);
  if (r === null) return <div aria-busy="true" aria-label="Calculando lo que se oculta"><Skeleton /></div>;
  if (r === 'bad') {
    return (
      <>
        <SubTitle>Qué se está ocultando</SubTitle>
        <Help>No se pudo calcular. Revisá la conexión y probá de nuevo.</Help>
        <button type="button" class="btn btn-tonal btn-block" onClick={() => setTries(tries + 1)}><Icon name="refresh-cw" />Probar de nuevo</button>
      </>
    );
  }
  return (
    <>
      <SubTitle>Qué se está ocultando en «{p.name}»</SubTitle>
      <Help>
        En las próximas {r.hours} horas, en los canales de este perfil: {plural(r.shown, 'programa se ve', 'programas se ven')} y {plural(r.hidden, 'se oculta', 'se ocultan')}.
      </Help>
      {r.by.length ? (
        <div class="menu">
          {r.by.map((x) => (
            <MenuRow key={x.genre} ico={x.genre ? 'ban' : 'circle-help'} cls="static" chevron={false}
              title={`${x.genre || 'Sin clasificar'} · ${plural(x.n, 'programa', 'programas')}`} sub={x.sample.join(', ')} />
          ))}
        </div>
      ) : <Help>Por ahora no se oculta nada.</Help>}
      <Help>Lo «sin clasificar» es lo que la IA todavía no vio: se muestra recién cuando tiene un género apto. Cada día se clasifican más programas, así que este perfil se va completando.</Help>
    </>
  );
}

/** Un link de un perfil: prenderlo o apagarlo, copiarlo, pasarlo a otro perfil, cambiarle el nombre o quitarlo. */
function DeviceRow({ d }: { d: Device }) {
  const path = `/api/cfg/${state.local!.cfgId}/devices/${d.code}`;
  const setActive = async (active: boolean) => {
    try {
      await api(path, { method: 'PATCH', body: { active } });
      toast(active ? `“${d.name}” activado` : `“${d.name}” desactivado: su playlist muestra un aviso hasta que lo actives`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
    void renderLinks();
  };
  const rename = async () => {
    const name = await promptDialog({ title: 'Nombre del link', ok: 'Guardar', input: { label: 'Nombre', value: d.name } });
    if (name === null || !name.trim()) return;
    try {
      await api(path, { method: 'PATCH', body: { name } });
      void renderLinks();
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({
      title: `¿Quitar “${d.name}”?`, text: 'Deja de funcionar al instante en todos los dispositivos donde esté cargado. Los demás links no se tocan.', ok: 'Quitar', danger: true,
    }))) return;
    try {
      await api(path, { method: 'DELETE' });
      toast(`“${d.name}” quitado`, 'ok');
      void renderLinks();
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
  };
  return (
    <div class={`device${d.active ? '' : ' off'}`}>
      <div class="device-top">
        <div class="device-info"><strong>{d.name}</strong><small>{d.active ? ago(d.lastUsed) : 'Desactivado: la playlist muestra un aviso'}</small></div>
        <input type="checkbox" class="switch" role="switch" aria-label={`Link activo: ${d.name}`} checked={d.active}
          onChange={(ev) => void setActive(ev.currentTarget.checked)} />
      </div>
      <button type="button" class="btn btn-tonal" data-dev="show" onClick={() => renderLinkResult(d)}><Icon name="copy" />Copiar o compartir</button>
      <button type="button" class="icon-btn" aria-label={`Pasar ${d.name} a otro perfil`} onClick={() => openSub({ k: 'move', dev: d })}><Icon name="arrow-right-left" /></button>
      <button type="button" class="icon-btn" aria-label={`Cambiar nombre de ${d.name}`} onClick={() => void rename()}><Icon name="pencil" /></button>
      <button type="button" class="icon-btn" aria-label={`Quitar ${d.name}`} onClick={() => void remove()}><Icon name="trash-2" /></button>
    </div>
  );
}

async function renameProfile(p: ProfileView) {
  const name = await promptDialog({ title: 'Nombre del perfil', ok: 'Guardar', input: { label: 'Nombre', value: p.name, placeholder: 'Chicos' } });
  if (name === null) return;
  const to = name.trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!to || to === p.name) return;
  try {
    await profileApi(p.id, 'PUT', { name: to });
    toast(`Listo: el perfil se llama «${to}». Los links no cambiaron`, 'ok', 5000);
    void renderLinks();
  } catch (e) {
    toast((e as Error).message, 'bad', 6000);
  }
}

// ------------------------------------------------------------------ proveedor y hogar
const EVENT_TZS: [string, string][] = [
  ['America/Mexico_City', 'México'], ['America/Bogota', 'Colombia / Perú'], ['America/Argentina/Buenos_Aires', 'Argentina / Uruguay'],
  ['America/Santiago', 'Chile'], ['America/New_York', 'EE. UU. Este'], ['America/Chicago', 'EE. UU. Centro'],
  ['America/Los_Angeles', 'EE. UU. Oeste'], ['Europe/Madrid', 'España'], ['UTC', 'UTC'],
];

/** La página de un proveedor: su nombre, la dirección del servicio, recargar la lista, la hora de eventos (solo si
 *  el proveedor no informa su zona) y quitarlo. Uno de otro proveedor solo se renombra o se abre. */
function providerPage(cfgId: string) {
  const other = otherOf(cfgId);
  if (!isCurrent(cfgId) && !other) return null;
  const name = other ? other.name : providerName(loadHome(), state.local!.cfgId);
  return { title: name, node: <ProviderPage cfgId={cfgId} name={name} other={other} /> };
}

function ProviderPage({ cfgId, name, other }: { cfgId: string; name: string; other?: OtherProvider }) {
  const prov = state.cfg!.provider;
  const rename = async () => {
    const h = loadHome();
    const c = h.configs.find((x) => x.cfgId === cfgId);
    if (!c) return;
    const n = await promptDialog({ title: 'Nombre del proveedor', ok: 'Guardar', input: { label: 'Nombre', value: providerName(h, cfgId) } });
    if (n === null) return;
    c.name = n.trim().slice(0, 30) || undefined;
    saveHome(h);
    if (other) other.name = providerName(h, cfgId);
    void renderLinks();
  };
  if (other) {
    return (
      <div class="menu">
        <MenuRow ico="pencil" title="Nombre" sub={name} onClick={() => void rename()} />
        <MenuRow ico="tv" title="Abrir su grilla" sub="Para cambiar sus ajustes, abrilo primero" onClick={() => void switchProvider(cfgId)} />
      </div>
    );
  }
  // Las zonas para elegir a mano; una guardada que no está en la lista (no debería pasar) se muestra igual.
  const tz = eventTz();
  const tzs: [string, string][] = EVENT_TZS.some(([v]) => v === tz) ? EVENT_TZS : [...EVENT_TZS, [tz, tz]];
  return (
    <>
      <div class="menu">
        <MenuRow ico="pencil" title="Nombre" sub={name} onClick={() => void rename()} />
        {prov.type === 'xtream' ? <MenuRow ico="server" title="Dirección del servicio" sub={plural(prov.servers.length, 'servidor', 'servidores')}
          onClick={() => openSub({ k: 'servers' })} /> : null}
        <MenuRow ico="refresh-cw" title="Recargar la lista" sub="Trae los canales nuevos del proveedor" onClick={() => {
          el<HTMLDialogElement>('#linksDialog').close();
          showOnboarding(true);
        }} />
        {providerTz() ? null : (
          <label class="menu-row static">
            <span class="menu-icon"><Icon name="clock" /></span>
            <span class="menu-text">Hora de eventos<small>El proveedor no informa su zona</small></span>
            <select class="select compact" id="eventTzSelect" value={tz} onChange={(ev) => {
              setPref(EVENT_TZ_KEY(), ev.currentTarget.value);
              renderGrid();
            }}>
              {tzs.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
      </div>
      <div class="menu danger-zone">
        <MenuRow ico="trash-2" title="Quitar proveedor" sub="Sus links dejan de funcionar. No se puede deshacer" cls="danger" chevron={false} onClick={() => void forgetConfig()} />
      </div>
    </>
  );
}

/** Usar en otro dispositivo: el código del hogar (lo recomendado) y, como alternativa, el archivo de respaldo. */
function HogarPage() {
  return (
    <>
      <Help>Pasá todos tus proveedores, cuentas y perfiles a otro celular, TV o computadora. Se suman a los que ya tenga; tu usuario y tu contraseña no viajan.</Help>
      <h3 class="sec-title">Con un código (recomendado)</h3>
      <div class="menu">
        <MenuRow ico="key-round" title="Ver tu código" sub="Se mantiene al día solo" onClick={() => void showHomeCode()} />
        <MenuRow ico="house" title="Pegar un código" sub="El que muestra tu otro dispositivo" onClick={() => void useHomeCode()} />
      </div>
      <h3 class="sec-title">Con un archivo</h3>
      <div class="menu">
        <MenuRow ico="download" title="Descargar respaldo" sub="Una copia de hoy, para guardar" onClick={() => exportBackup()} />
        <MenuRow ico="upload" title="Importar respaldo" sub="Un archivo descargado antes" onClick={() => el<HTMLInputElement>('#backupFile').click()} />
      </div>
      <Help>Guardá el código y el archivo en privado: con ellos se pueden editar tus configuraciones.</Help>
    </>
  );
}

// ------------------------------------------------------------------ subpáginas
function SubPage({ s }: { s: LinksSub }) {
  switch (s.k) {
    case 'move': return <MoveDevice dev={s.dev} />;
    case 'add-device': return <AddDevice p={s.p} a={s.a} />;
    case 'add-profile': return <AddProfile account={s.account} />;
    case 'add-account': return <AddAccount />;
    case 'creds': return <Creds a={s.a} />;
    case 'profile-account': return <ProfileAccount p={s.p} a={s.a} />;
    case 'delete-profile': return <DeleteProfile p={s.p} />;
    case 'delete-account': return <DeleteAccount a={s.a} />;
    case 'servers': return <Servers />;
    case 'filter': return <ProfileFilter p={s.p} />;
    case 'view': return <ViewShare p={s.p} />;
    case 'kids-hidden': return <KidsHidden p={s.p} />;
    case 'result': return <LinkResultView result={s.result} />;
  }
}

/** Pasar un link a otro perfil (de esta cuenta, de otra o de otro proveedor): la dirección sigue siendo la misma; cambian
 *  lo que ve y, si es de otra cuenta, con qué cuenta reproduce. */
function MoveDevice({ dev }: { dev: Device }) {
  const [sel, setSel] = useState(0);
  const [busy, run] = useBusy();
  const h = loadHome();
  const mine = myAccounts().flatMap((a) => a.profiles.filter((p) => p.id !== dev.profile).map((p) => ({ p, a, cfg: undefined as OtherProvider | undefined })));
  const remote = otherProviders.flatMap((o) => otherAccounts(o).flatMap((a) => a.profiles.map((p) => ({ p, a, cfg: o as OtherProvider | undefined }))));
  const all = [...mine, ...remote];
  const curAcc = dev.account ?? '';
  const t = all[sel];
  const submit = (ev: Event) => {
    ev.preventDefault();
    const needCreds = !t.a.devices.length;
    const creds = needCreds ? readCreds('move') : {};
    if (needCreds && Object.values(creds).some((x) => !x)) return void toast('Completá los datos de esa cuenta', 'bad');
    void run(async () => {
      try {
        await api(`/api/cfg/${state.local!.cfgId}/devices/${dev.code}/move`, { method: 'POST',
          body: { ...creds, profile: t.p.id, ...(t.cfg ? { to: t.cfg.cfgId, toKey: t.cfg.editKey } : {}) } });
        toast(`«${dev.name}» ahora es de ${t.p.name}${t.cfg ? ` en ${t.cfg.name}` : ''}. Su link no cambió`, 'ok', 6000);
        void renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>Pasar «{dev.name}» a otro perfil</SubTitle>
      <Help>La dirección <b>no cambia</b>: el reproductor no hay que tocarlo. Con la próxima actualización de la lista ve lo de ese perfil (y usa su cuenta).</Help>
      <div class="url-box">{dev.playlistUrl}</div>
      {all.length ? (
        <form class="stack" id="moveForm" autocomplete="off" onSubmit={submit}>
          <PickList items={all} sel={sel} onSel={setSel} name="moveTo" title={(x) => x.p.name} sub={(x) => [
            x.cfg ? `${x.cfg.name} · otra grilla` : remote.length ? providerName(h, state.local!.cfgId) : '',
            x.cfg || x.a.account !== curAcc ? `cuenta ${x.a.name}` : 'misma cuenta',
            filterSummary(x.p.filter)].filter(Boolean).join(' · ')} />
          <div class="stack" id="moveCreds" hidden={t.a.devices.length > 0}>
            <Help>Esa cuenta todavía no tiene links: hacen falta sus datos.</Help>
            <CredsFields prefix="move" />
          </div>
          <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" disabled={busy}><Icon name="arrow-right-left" />Pasar</button></div>
        </form>
      ) : <Help>No hay otro perfil. Creá uno desde la página de una cuenta, con «Agregar perfil».</Help>}
    </>
  );
}

/** Agregar un link a un perfil: ve lo de ese perfil y reproduce con su cuenta. */
function AddDevice({ p, a }: { p: ProfileView; a: AccountView }) {
  const [busy, run] = useBusy();
  // Una cuenta sin links necesita sus datos (la principal, si no están en este navegador); las demás usan los de sus links.
  const needsCreds = !a.devices.length && !(!a.account && state.creds);
  const submit = (ev: Event) => {
    ev.preventDefault();
    let creds: Record<string, string> = {};
    if (needsCreds) {
      creds = readCreds('lnk');
      if (Object.values(creds).some((v) => !v)) return void toast('Completá los datos del proveedor', 'bad');
    } else if (!a.account && !a.devices.length && state.creds) creds = state.creds as Record<string, string>;
    // Se lee todo antes de esperar a la red: un segundo toque (o Enter) mientras guarda ya no encuentra el formulario.
    const form = ev.currentTarget as HTMLFormElement;
    const name = el<HTMLInputElement>('#lnkName').value.trim();
    void run(async () => {
      try {
        await saveNow();
        const r = await api<LinkResult>(`/api/cfg/${state.local!.cfgId}/token`, { method: 'POST', body: { ...creds, profile: p.id, name } });
        if (needsCreds && !a.account) state.creds = creds as typeof state.creds;
        if (form.isConnected) renderLinkResult({ ...r, name });
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>Link nuevo para {p.name}</SubTitle>
      <Help>Ponele el nombre del dispositivo (o de la casa) donde lo vas a usar. Si ya tenés un link de este perfil, también podés cargar ese mismo en el otro dispositivo.</Help>
      <form class="stack" id="linksForm" autocomplete="off" onSubmit={submit}>
        <label class="field"><span>Nombre</span><input class="input" id="lnkName" maxLength={40} placeholder="TV del living" required /></label>
        {needsCreds ? <CredsFields prefix="lnk" /> : null}
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" id="makeLinks" disabled={busy}><Icon name="tv" />Generar link</button></div>
      </form>
    </>
  );
}

/** Un perfil nuevo dentro de una cuenta: empieza viendo todo; después se elige qué ve y se le agregan links. */
function AddProfile({ account }: { account: string }) {
  const [busy, run] = useBusy();
  const submit = (ev: Event) => {
    ev.preventDefault();
    const name = el<HTMLInputElement>('#npName').value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    void run(async () => {
      try {
        const r = await api<{ profile: ProfileDef }>(`/api/cfg/${state.local!.cfgId}/profiles`, { method: 'POST', body: { name, ...(account ? { account } : {}) } });
        toast(`Perfil «${name}» creado: elegí qué ve y agregale un link`, 'ok', 5000);
        openLinksView({ v: 'profile', id: r.profile.id });
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>Perfil nuevo en {accountName(account)}</SubTitle>
      <Help>Usa la misma cuenta (su vencimiento y sus conexiones), con su propia selección de canales y sus links. Por ejemplo, «Chicos» sin contenido para adultos.</Help>
      <form class="stack" id="profileForm" autocomplete="off" onSubmit={submit}>
        <label class="field"><span>Nombre del perfil</span><input class="input" id="npName" maxLength={30} placeholder="Chicos" required /></label>
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" disabled={busy}><Icon name="plus" />Crear perfil</button></div>
      </form>
    </>
  );
}

/** Una cuenta nueva (la de un familiar u otra del mismo proveedor): con un perfil que ve todo y su primer link. */
function AddAccount() {
  const [busy, run] = useBusy();
  const submit = (ev: Event) => {
    ev.preventDefault();
    const account = el<HTMLInputElement>('#naName').value.trim().replace(/\s+/g, ' ');
    if (myAccounts().some((x) => x.account === account || x.name === account)) return void toast(`Ya hay una cuenta «${account}»`, 'bad');
    const name = el<HTMLInputElement>('#naDevice').value.trim();
    const creds = readCreds('na');
    if (!account || !name || Object.values(creds).some((x) => !x)) return void toast('Completá el nombre, los datos y el link', 'bad');
    void run(async () => {
      let pid = '';
      try {
        await saveNow();
        pid = (await api<{ profile: ProfileDef }>(`/api/cfg/${state.local!.cfgId}/profiles`, { method: 'POST', body: { name: account, account } })).profile.id;
        const r = await api<LinkResult>(`/api/cfg/${state.local!.cfgId}/token`, { method: 'POST', body: { ...creds, profile: pid, name } });
        linksView = { v: 'profile', id: pid };
        setTitle(account);
        toast(`Cuenta «${account}» creada`, 'ok');
        renderLinkResult({ ...r, name });
      } catch (e) {
        // Sin link, el perfil vacío no sirve: se quita.
        if (pid) await profileApi(pid, 'DELETE', {}).catch(() => {});
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>Cuenta nueva</SubTitle>
      <Help>Otro usuario y contraseña del mismo proveedor, por ejemplo el de un familiar. Tiene su vencimiento, sus conexiones y sus perfiles.</Help>
      <form class="stack" id="accountForm" autocomplete="off" onSubmit={submit}>
        <label class="field"><span>Nombre de la cuenta</span><input class="input" id="naName" maxLength={30} placeholder="Mamá" required /></label>
        <CredsFields prefix="na" />
        <label class="field"><span>Su primer link</span><input class="input" id="naDevice" maxLength={40} placeholder="TV de Mamá" required /></label>
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" disabled={busy}><Icon name="plus" />Crear cuenta</button></div>
      </form>
    </>
  );
}

/** Cambiaron el usuario y la contraseña (o la URL) de una cuenta: sus links quedan iguales y usan los datos nuevos. */
function Creds({ a }: { a: AccountView }) {
  const [busy, run] = useBusy();
  const xtream = state.cfg!.provider.type === 'xtream';
  const submit = (ev: Event) => {
    ev.preventDefault();
    const creds = readCreds('chg');
    if (Object.values(creds).some((v) => !v)) return void toast('Completá los datos nuevos', 'bad');
    void run(async () => {
      try {
        const r = await api<{ updated: number }>(`/api/cfg/${state.local!.cfgId}/credentials`, { method: 'PUT', body: { ...creds, ...(a.account ? { account: a.account } : {}) } });
        if (!a.account) state.creds = creds as typeof state.creds;
        toast(`Listo: ${r.updated} ${r.updated === 1 ? 'link' : 'links'} con los datos nuevos, sin cambiar de dirección`, 'ok', 6000);
        void renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>{xtream ? 'Usuario y contraseña' : 'URL de la lista'} de {a.name}</SubTitle>
      <Help>Si cambiaron en tu proveedor. Los links de todos sus perfiles <b>quedan exactamente iguales</b>: solo pasan a usar los datos nuevos, sin tocar nada en el reproductor.</Help>
      <form class="stack" id="credsForm" autocomplete="off" onSubmit={submit}>
        <CredsFields prefix="chg" />
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" disabled={busy}>Actualizar sus links</button></div>
      </form>
    </>
  );
}

/** Pasar un perfil (con sus links) a otra cuenta: sus links reproducen con esa cuenta; la dirección no cambia. */
function ProfileAccount({ p, a }: { p: ProfileView; a: AccountView }) {
  const [sel, setSel] = useState(0);
  const [busy, run] = useBusy();
  const targets = myAccounts().filter((x) => x.account !== a.account && x.devices.length);
  const submit = (ev: Event) => {
    ev.preventDefault();
    const to = targets[sel]?.account ?? '';
    void run(async () => {
      try {
        await profileApi(p.id, 'PUT', { account: to });
        toast(`«${p.name}» ahora usa la cuenta ${accountName(to)}. Sus links no cambiaron`, 'ok', 6000);
        void renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>Cuenta de «{p.name}»</SubTitle>
      <Help>Sus links pasan a reproducir con la cuenta que elijas: usan su vencimiento y sus conexiones. Las direcciones <b>no cambian</b>.</Help>
      <form class="stack" id="paForm" onSubmit={submit}>
        <PickList items={targets} sel={sel} onSel={setSel} name="paTo" title={(x) => x.name} sub={(x) => plural(x.profiles.length, 'perfil', 'perfiles')} />
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" disabled={busy}>Cambiar de cuenta</button></div>
      </form>
    </>
  );
}

/** Borrar un perfil: sus links pasan a otro perfil (con la misma dirección). Nunca se borra un link. */
function DeleteProfile({ p }: { p: ProfileView }) {
  const [sel, setSel] = useState(0);
  const [busy, run] = useBusy();
  const accounts = myAccounts();
  const own = accounts.find((x) => x.profiles.some((y) => y.id === p.id));
  // A otro perfil de la misma cuenta, o de una cuenta con links (de ahí sale con qué reproducir).
  const targets = accounts.flatMap((x) => x.profiles.filter((y) => y.id !== p.id && (x.account === own?.account || x.devices.length)).map((y) => ({ p: y, a: x })));
  const submit = (ev: Event) => {
    ev.preventDefault();
    const target = p.devices.length ? targets[sel] : undefined;
    void run(async () => {
      try {
        await profileApi(p.id, 'DELETE', target ? { to: target.p.id } : {});
        toast(target ? `«${p.name}» borrado: sus links pasaron a ${target.p.name}, sin cambiar` : `«${p.name}» borrado`, 'ok', 6000);
        linksView = own ? { v: 'account', account: own.account } : { v: 'list' };
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
      void renderLinks();
    });
  };
  const Submit = () => (
    <div class="form-actions"><button type="submit" class="btn btn-danger btn-block" disabled={busy}><Icon name="trash-2" />Borrar perfil</button></div>
  );
  return (
    <>
      <SubTitle>Borrar «{p.name}»</SubTitle>
      {!p.devices.length ? (
        <>
          <Help>No tiene links: desaparece y listo.</Help>
          <form class="stack" id="deleteForm" onSubmit={submit}><Submit /></form>
        </>
      ) : !targets.length ? <Help>Para borrarlo, sus links tienen que pasar a otro perfil. Creá otro perfil primero.</Help> : (
        <>
          <Help>{p.devices.length === 1 ? 'Su link pasa' : `Sus ${p.devices.length} links pasan`} al perfil que elijas y ven lo de ese perfil. Las direcciones <b>no cambian</b>: el reproductor no hay que tocarlo.</Help>
          <form class="stack" id="deleteForm" onSubmit={submit}>
            <PickList items={targets} sel={sel} onSel={setSel} name="delTo" title={(x) => x.p.name} sub={(x) => `cuenta ${x.a.name} · ${filterSummary(x.p.filter)}`} />
            <Submit />
          </form>
        </>
      )}
    </>
  );
}

/** Borrar una cuenta: sus perfiles (con sus links) pasan a otra cuenta con links. Nunca se borra un link. */
function DeleteAccount({ a }: { a: AccountView }) {
  const [sel, setSel] = useState(0);
  const [busy, run] = useBusy();
  const targets = myAccounts().filter((x) => x.account !== a.account && x.devices.length);
  const submit = (ev: Event) => {
    ev.preventDefault();
    const target = targets[sel];
    void run(async () => {
      try {
        for (const p of a.profiles) await profileApi(p.id, 'PUT', { account: target.account });
        if (activeAccount() === a.account) await setActiveAccount(target.account);
        toast(`Cuenta «${a.name}» borrada: sus perfiles pasaron a ${target.name} con los mismos links`, 'ok', 6000);
        linksView = { v: 'account', account: target.account };
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
      void renderLinks();
    });
  };
  return (
    <>
      <SubTitle>Borrar la cuenta «{a.name}»</SubTitle>
      {!targets.length ? <Help>Para borrarla, sus perfiles tienen que pasar a otra cuenta con links. Agregá primero un link a otra cuenta.</Help> : (
        <>
          <Help>{a.profiles.length === 1 ? 'Su perfil pasa' : `Sus ${a.profiles.length} perfiles pasan`} a la cuenta que elijas, con sus links. Las direcciones <b>no cambian</b>: el reproductor no hay que tocarlo.</Help>
          <form class="stack" id="deleteForm" onSubmit={submit}>
            <PickList items={targets} sel={sel} onSel={setSel} name="delTo" title={(x) => x.name} sub={(x) => plural(x.profiles.length, 'perfil', 'perfiles')} />
            <div class="form-actions"><button type="submit" class="btn btn-danger btn-block" disabled={busy}><Icon name="trash-2" />Borrar cuenta</button></div>
          </form>
        </>
      )}
    </>
  );
}

/** Cambió la dirección del servicio de IPTV: los links no cambian. */
function Servers() {
  const [busy, run] = useBusy();
  const prov = state.cfg!.provider;
  if (prov.type !== 'xtream') return null;
  const submit = (ev: Event) => {
    ev.preventDefault();
    const servers = el<HTMLTextAreaElement>('#chgServers').value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (!servers.length) return void toast('Poné al menos una dirección', 'bad');
    void run(async () => {
      try {
        const r = await api<{ servers: string[] }>(`/api/cfg/${state.local!.cfgId}/servers`, { method: 'PUT', body: { servers } });
        prov.servers = r.servers;
        toast('Listo: el servicio quedó con la dirección nueva y los links siguen iguales', 'ok', 6000);
        void renderLinks();
      } catch (e) {
        toast((e as Error).message, 'bad', 6000);
      }
    });
  };
  return (
    <>
      <SubTitle>Dirección del servicio</SubTitle>
      <Help>Es la dirección (URL) del servidor de tu proveedor. Una por línea: la primera es la principal y las demás, de respaldo. Los links de tus dispositivos <b>no cambian</b>: se actualizan solos la próxima vez que el reproductor pida la lista.</Help>
      <form class="stack" id="serversForm" autocomplete="off" onSubmit={submit}>
        <label class="field"><span>Servidores</span>
          <textarea class="input mono" id="chgServers" rows={3} spellcheck={false} autocapitalize="off" placeholder="http://servidor.ejemplo:8080" required
            defaultValue={prov.servers.join('\n')} /></label>
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block" disabled={busy}>Guardar servidores</button></div>
      </form>
    </>
  );
}

/** Qué ve un perfil: qué categorías y canales salen en la playlist de sus links (un interruptor por fila: encendido = se
 *  ve). Vale para todos sus links; las direcciones no cambian. Mismo patrón que Categorías. */
function ProfileFilter({ p }: { p: ProfileView }) {
  const [q, setQ] = useState('');
  const [, redraw] = useState(0);
  // Lo de la grilla no cambia mientras se está en esta página: se calcula una vez.
  const base = useRef<{ hiddenG: Set<string>; headers: Set<string>; cats: string[]; count: Map<string, number>; members: Map<string, string[]> }>();
  if (!base.current) {
    const hiddenG = new Set(state.cfg!.groups.hidden ?? []);
    const headers = sectionHeaders();
    const cats = groups().filter((g) => !hiddenG.has(g));
    const count = new Map<string, number>();
    for (const ch of state.channels) {
      if (state.cfg!.channels[ch.name]?.hidden) continue;
      count.set(groupOf(ch), (count.get(groupOf(ch)) ?? 0) + 1);
    }
    // Categorías de cada sección (hasta la siguiente).
    const members = new Map<string, string[]>();
    let cur: string | null = null;
    for (const g of cats) {
      if (headers.has(g)) {
        cur = g;
        members.set(g, []);
      } else if (cur) members.get(cur)!.push(g);
    }
    base.current = { hiddenG, headers, cats, count, members };
  }
  const { hiddenG, headers, cats, count, members } = base.current;
  // Lo que NO se ve. Un filtro viejo de «solo lo marcado» se convierte: queda oculto lo que no estaba marcado.
  const off = useRef<{ g: Set<string>; c: Set<string> }>();
  if (!off.current) {
    const g = new Set<string>();
    const c = new Set<string>();
    if (p.filter?.only) for (const x of cats) { if (!p.filter.groups.includes(x)) g.add(x); }
    else for (const x of p.filter?.groups ?? []) g.add(x);
    if (!p.filter?.only) for (const n of p.filter?.channels ?? []) c.add(n);
    off.current = { g, c };
  }
  const { g: offG, c: offC } = off.current;
  const current = (): DeviceFilter => ({ groups: [...offG], channels: [...offC] });
  const qn = fold(q.trim());
  const matches = (g: string) => !qn || fold(`${groupLabel(g)} ${g}`).includes(qn);
  // Un canal suelto de una categoría ya oculta sobra.
  const prune = () => {
    for (const n of [...offC]) {
      const ch = state.channels.find((x) => x.name === n);
      if (ch && offG.has(groupOf(ch))) offC.delete(n);
    }
  };
  const flip = (on: boolean, keys: string[], set: Set<string>) => {
    for (const k of keys) on ? set.delete(k) : set.add(k);
    prune();
    redraw((n) => n + 1);
  };
  const Row = ({ title, sub, on, head = false, onToggle }: { title: string; sub: string; on: boolean; head?: boolean; onToggle: (on: boolean) => void }) => (
    <label class={`menu-row static pf-row${head ? ' pf-head' : ''}${on ? '' : ' is-off'}`}>
      <span class="menu-text">{title}<small>{sub}</small></span>
      <input type="checkbox" class="switch" checked={on} aria-label={`${title}: se ve en este perfil`} onChange={(ev) => onToggle(ev.currentTarget.checked)} />
    </label>
  );
  const chans = qn ? state.channels.filter((ch) => !state.cfg!.channels[ch.name]?.hidden && !hiddenG.has(groupOf(ch)) && !offG.has(groupOf(ch))
    && fold(state.cfg!.channels[ch.name]?.name || ch.name).includes(qn)).slice(0, 30) : [];
  const rows = cats.filter(matches).map((g) => {
    if (!headers.has(g)) {
      return <Row key={g} title={groupLabel(g)} sub={plural(count.get(g) ?? 0, 'canal', 'canales')} on={!offG.has(g)} onToggle={(on) => flip(on, [g], offG)} />;
    }
    const mem = members.get(g) ?? [];
    const shown = mem.filter((m) => !offG.has(m)).length;
    const sub = shown && shown < mem.length ? `${shown} de ${plural(mem.length, 'categoría', 'categorías')} se ven` : plural(mem.length, 'categoría', 'categorías');
    // Un toque en la sección enciende (o apaga) todas sus categorías, y a ella misma.
    return <Row key={g} head title={sectionTitle(groupLabel(g))} sub={sub} on={mem.length > 0 ? shown > 0 : !offG.has(g)} onToggle={(on) => flip(on, [...mem, g], offG)} />;
  });
  const save = async (filter: DeviceFilter | null, msg: string) => {
    try {
      await profileApi(p.id, 'PUT', { filter });
      toast(msg, 'ok');
      void renderLinks();
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
    }
  };
  // «Mostrar todo» y «Ocultar todo» actúan sobre lo que se ve (con búsqueda, solo lo que coincide).
  const showAll = () => {
    for (const g of cats.filter(matches)) offG.delete(g);
    if (!qn) offC.clear();
    redraw((n) => n + 1);
  };
  const hideAll = () => flip(false, cats.filter(matches), offG);
  return (
    <>
      <SubTitle>{p.name}</SubTitle>
      <Help>Apagá lo que no querés que vea este perfil. Vale para {p.devices.length ? `sus ${plural(p.devices.length, 'link', 'links')}` : 'sus links'}, que no cambian: la lista se actualiza sola la próxima vez que el reproductor la baje.</Help>
      <label class="search-field cat-filter">
        <Icon name="search" />
        <input type="search" id="pfQ" placeholder="Buscar categoría o canal" autocomplete="off" aria-label="Buscar categoría o canal"
          value={q} onInput={(ev) => setQ(ev.currentTarget.value)} />
      </label>
      <div class="ch-chips cat-chips">
        <button type="button" class="chip-btn" id="pfAll" onClick={showAll}><Icon name="eye" />Mostrar todo</button>
        <button type="button" class="chip-btn" id="pfNone" onClick={hideAll}><Icon name="eye-off" />Ocultar todo</button>
      </div>
      <div id="pfList">
        {rows.length ? <div class="menu">{rows}</div> : (qn && !chans.length ? null : <Help>Ninguna categoría coincide.</Help>)}
        {qn ? (
          <>
            <h3 class="sec-title">Canales</h3>
            {chans.length ? (
              <div class="menu">
                {chans.map((ch) => <Row key={`c:${ch.name}`} title={state.cfg!.channels[ch.name]?.name || ch.name} sub={groupLabel(groupOf(ch))}
                  on={!offC.has(ch.name)} onToggle={(on) => flip(on, [ch.name], offC)} />)}
              </div>
            ) : <Help>Ningún canal coincide.</Help>}
          </>
        ) : null}
      </div>
      <p class="meta-line" id="pfSum">{offG.size || offC.size ? `Este perfil: ${filterSummary(current())}` : 'Este perfil ve todo (sin filtro).'}</p>
      <div class="form-actions">
        <button type="button" class="btn btn-primary btn-block" id="pfSave" onClick={() => {
          if (!offG.size && !offC.size) return void save(null, 'Sin filtro: ve todo');
          void save(current(), `Filtro guardado: ${filterSummary(current())}`);
        }}>Guardar filtro</button>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-gray btn-block" id="pfClear" onClick={() => void save(null, 'Sin filtro: ve todo')}>Quitar filtro (ver todo)</button></div>
    </>
  );
}

/** «Compartir para ver»: un código (ver.<código>) para que otra persona abra nowline en modo «solo ver» y mire la grilla
 *  y la Guía de este perfil sin poder cambiar nada. Se pega donde va el código del hogar (o se abre como link /ver#…).
 *  Se crea al tocar el botón; quitarlo lo invalida. Los links de reproducción no cambian. */
function ViewShare({ p }: { p: ProfileView }) {
  const [code, setCode] = useState(p.view ?? '');
  const [copied, setCopied] = useState('');
  const [busy, run] = useBusy();
  const path = `/api/cfg/${state.local!.cfgId}/profiles/${p.id}/view`;
  const url = code ? `${location.origin}/ver#${code}` : '';
  const viewCode = code ? `ver.${code}` : '';
  useEffect(() => { if (url) void showQr(url, 'O escaneá con el celular o la tablet de quien va a mirar: abre directo'); }, [url]);
  const changed = () => void loadProfiles(false);
  const create = () => run(async () => {
    try {
      setCode((await api<{ code: string }>(path, { method: 'POST', body: {} })).code);
      changed();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  });
  const remove = async (again: boolean) => {
    const ok = await confirmDialog(again
      ? { title: 'Hacer un código nuevo', icon: 'refresh-cw', ok: 'Hacer otro', text: 'El código de ahora deja de funcionar (también en los dispositivos que ya lo usan) y vas a tener que pasar el nuevo. Los links de reproducción no cambian.' }
      : { title: 'Quitar el acceso', icon: 'eye-off', ok: 'Quitar', danger: true, text: 'Quien tenga el código ya no va a poder ver la grilla. Los links de reproducción no cambian.' });
    if (!ok) return;
    await run(async () => {
      try {
        await api(path, { method: 'DELETE', body: {} });
        setCode('');
        if (again) setCode((await api<{ code: string }>(path, { method: 'POST', body: {} })).code);
        toast(again ? 'Código nuevo listo' : 'Acceso quitado', 'ok');
        changed();
      } catch (e) {
        toast((e as Error).message, 'bad');
      }
    });
  };
  const openHere = async () => {
    try {
      await useViewCode(code);
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  if (!code) {
    return (
      <>
        <SubTitle>Compartir para ver</SubTitle>
        <Help>Un código para otra persona (por ejemplo, alguien a quien le cuesta usar apps): lo pega al abrir nowline,
          donde va el código de otro dispositivo, y la app queda en modo «solo ver»: la grilla con lo que dan ahora y la
          Guía, con letra grande, solo con los canales de «{p.name}». No puede cambiar nada, ni ver tus cuentas ni tus
          links.</Help>
        <Help>Lo podés quitar cuando quieras. Los links de reproducción no cambian.</Help>
        <button type="button" class="btn btn-primary btn-block" disabled={busy} onClick={() => void create()}><Icon name="eye" />Crear el código para ver</button>
      </>
    );
  }
  return (
    <>
      <SubTitle>Código para ver «{p.name}»</SubTitle>
      <Help>Copiá el link y mandáselo: lo abre directo, sin pegar nada. O copiá el código: en su celular o tablet abrí nowline,
        tocá <b>Pegá el código</b> y pegalo. Desde ahí la app abre siempre en modo ver. Si después agrega nowline a la pantalla
        de inicio, queda como una app.</Help>
      <div class="lc-actions">
        <button type="button" class="btn btn-tonal" onClick={async () => {
          await copyText(viewCode);
          setCopied('code');
          setTimeout(() => setCopied(''), 2000);
        }}>{copied === 'code' ? <><Icon name="check" />Copiado</> : <><Icon name="copy" />Copiar código</>}</button>
        <button type="button" class="btn btn-primary" onClick={async () => {
          await copyText(url);
          setCopied('link');
          setTimeout(() => setCopied(''), 2000);
        }}>{copied === 'link' ? <><Icon name="check" />Copiado</> : <><Icon name="link-2" />Copiar link</>}</button>
      </div>
      <div class="share-row">
        <button type="button" class="btn btn-gray" onClick={async () => {
          if (!('share' in navigator)) return void copyText(url).then(() => toast('Link copiado', 'ok'));
          try {
            await navigator.share({ title: 'nowline', text: 'Para ver qué dan en la tele', url });
          } catch { /* cancelado */ }
        }}><Icon name="share-2" />Compartir</button>
      </div>
      <div class="qr" id="qr" />
      <Help>Ve solo los canales de este perfil; si cambiás qué ve el perfil, también cambia ahí.</Help>
      <div class="menu">
        <MenuRow ico="eye" title="Abrir en modo ver" sub={`Este dispositivo pasa a modo ver con «${p.name}». Para salir, el código de la casa`}
          onClick={() => void openHere()} />
        <MenuRow ico="refresh-cw" title="Hacer un código nuevo" sub="El de ahora deja de funcionar" onClick={() => void remove(true)} />
        <MenuRow ico="eye-off" title="Quitar el acceso" sub="Los links de reproducción no cambian" cls="danger" onClick={() => void remove(false)} />
      </div>
    </>
  );
}

/** Los links de un dispositivo: copiar la playlist y la guía, compartirlos y el QR. */
function LinkResultView({ result }: { result: LinkResult }) {
  const [copied, setCopied] = useState('');
  useEffect(() => { void showQr(result.playlistUrl); }, [result.playlistUrl]);
  const copy = async (what: string, text: string) => {
    await copyText(text);
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? '' : c)), 2000);
  };
  const CopyBtn = ({ what, text, cls, label }: { what: string; text: string; cls: string; label: string }) => (
    <button type="button" class={`btn ${cls}`} onClick={() => void copy(what, text)}>
      {copied === what ? <><Icon name="check" />Copiado</> : <><Icon name="copy" />{label}</>}
    </button>
  );
  const text = shareText(result);
  return (
    <>
      {result.name ? <SubTitle>{result.name}</SubTitle> : null}
      <div class="lc-actions">
        <CopyBtn what="playlist" text={result.playlistUrl} cls="btn-primary" label="Copiar playlist" />
        <CopyBtn what="epg" text={result.epgUrl} cls="btn-tonal" label="Copiar guía" />
      </div>
      <div class="share-row">
        <button type="button" class="btn btn-gray" onClick={async () => {
          if (!('share' in navigator)) return void copyText(text).then(() => toast('Links copiados', 'ok'));
          try {
            await navigator.share({ title: 'nowline: mis links', text });
          } catch { /* cancelado */ }
        }}><Icon name="share-2" />Compartir</button>
      </div>
      <div class="qr" id="qr" />
      <Help>En TiviMate: Agregar playlist → Ingresar URL → pegá la playlist; la guía la toma sola
        (si no, agregala en Ajustes → EPG). Los cambios que guardes llegan a la playlist al
        instante y a la guía en unos minutos. Los links no cambian: no hace falta volver a
        cargarlos en el reproductor.</Help>
      <Help>Son links inadivinables pero no privados: quien los tenga puede ver tus canales. No
        los publiques.</Help>
    </>
  );
}

// ------------------------------------------------------------------ fuera de la hoja
/** Mantener apretada la pestaña (o clic derecho): lista corta de cuentas para cambiar la que está en uso sin entrar. Con
 *  varios proveedores, agrupadas por proveedor; elegir una de otro proveedor abre su grilla. */
export function openProfileSwitch() {
  const dlg = el<HTMLDialogElement>('#profileSwitch');
  const pick = async (account: string, cfgId?: string) => {
    dlg.close();
    if (cfgId) await useOtherAccount(cfgId, account);
    else await setActiveAccount(account);
  };
  const Opt = ({ a, acc, on, cfgId }: { a: AccountView; acc?: Account; on: boolean; cfgId?: string }) => {
    const days = daysLeft(acc);
    return (
      <button type="button" class={`profile-opt${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => void pick(a.account, cfgId)}>
        <Avatar name={a.name} on={on} />
        <span class="po-text"><strong>{a.name}</strong><small>{[days === null ? '' : days < 0 ? 'vencida' : plural(days, 'día', 'días'),
          plural(a.profiles.length, 'perfil', 'perfiles')].filter(Boolean).join(' · ')}</small></span>
        {on ? <Icon name="check" /> : null}
      </button>
    );
  };
  const multi = otherProviders.length > 0;
  render(
    <>
      {multi ? <div class="provider-tag">{providerName(loadHome(), state.local!.cfgId)}</div> : null}
      {myAccounts().map((a) => <Opt key={`m:${a.account}`} a={a} acc={accountData(a)} on={a.account === activeAccount()} />)}
      {otherProviders.map((o) => (
        <Fragment key={o.cfgId}>
          <div class="provider-tag">{o.name}</div>
          {otherAccounts(o).map((a) => <Opt key={`${o.cfgId}:${a.account}`} a={a} acc={a.key ? o.accounts[a.key] : undefined} on={false} cfgId={o.cfgId} />)}
        </Fragment>
      ))}
    </>,
    el('#profileSwitchList'),
  );
  dlg.showModal();
}

/** Aviso arriba de los canales, solo si la cuenta en uso necesita atención: vence pronto;
 *  si no, si el relay dejó de responder (la lista o la prueba de canales no se actualizan). Las conexiones llenas ya no
 *  avisan acá: se ven en la página de la cuenta y en Conexiones en uso. */
export function renderProfileNotice() {
  const box = document.querySelector<HTMLButtonElement>('#profileNotice');
  if (!box) return;
  const a = myAccounts().find((x) => x.account === activeAccount());
  const acc = a && accountData(a);
  const days = daysLeft(acc);
  const who = a && (a.account || state.cfg?.mainName) ? `La cuenta de ${a.name}` : 'Tu cuenta';
  let text = '';
  if (days !== null && days <= 7) text = days < 0 ? `${who} está vencida` : days === 0 ? `${who} vence hoy` : `${who} vence en ${plural(days, 'día', 'días')}`;
  let sub = 'Tocá para ver la cuenta o cambiar de cuenta';
  let ico = 'clock';
  const trouble = !text && relayTrouble();
  if (trouble) {
    ico = 'triangle-alert';
    text = trouble.list ? `La lista del proveedor no se actualiza desde ${trouble.list}`
      : trouble.probe ? `Los canales caídos y la cuenta no se actualizan desde ${trouble.probe}` : 'No se pudo probar los canales ni leer la cuenta';
    sub = 'El servicio que habla con tu proveedor no responde. Los canales nuevos y los datos de la cuenta van a tardar en aparecer';
  }
  box.hidden = !text;
  render(text ? (
    <>
      <Icon name={ico} />
      <span class="pn-text"><strong>{text}</strong><small>{sub}</small></span>
      <Icon name="chevron-right" />
    </>
  ) : null, box);
}
