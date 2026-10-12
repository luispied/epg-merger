// Avisos por gusto (src/taste.ts y notifyTaste en src/push.ts). El servicio de push es simulado: no sale ninguna
// notificación real.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { tasteGenres } from '../../core/src/taste.ts';
import { scheduleFile } from '../src/again.ts';
import { channelAlias } from '../../core/src/alias.ts';
import { b64urlEncode } from '../src/crypto.ts';
import { addSub, getTaste, notifyTaste, setTaste, visibleGuideChannels, type PushSub } from '../src/push.ts';
import {
  allowedGenres, emptyTaste, hasQuota, inWindow, localHm, localParts, parseTaste, pickProgram, type TasteChannel, type TasteSent, type TasteState,
} from '../src/taste.ts';
import { makeEnv } from './helpers.ts';

let restore = () => {};
afterEach(() => restore());

const BA = 'America/Argentina/Buenos_Aires';
// 19:00 en Buenos Aires (UTC-3), 00:00 en Madrid (UTC+2 en octubre).
const NOW = Date.parse('2026-10-12T22:00:00Z');
const nowS = NOW / 1000;
const iso = (offsetH: number) => new Date(NOW + offsetH * 3_600_000).toISOString();

test('la hora y el día salen de la zona de la persona; con una zona inválida, Buenos Aires', () => {
  assert.deepEqual(localParts(NOW, BA), { hour: 19, minute: 0, day: '2026-10-12' });
  assert.deepEqual(localParts(NOW, 'Europe/Madrid'), { hour: 0, minute: 0, day: '2026-10-13' });
  assert.deepEqual(localParts(NOW, 'no/existe'), { hour: 19, minute: 0, day: '2026-10-12' });
  assert.equal(localHm(NOW + 90 * 60_000, BA), '20:30');
});

test('ventana de envío: tarde 18 a 20, noche 20 a 22; nunca de noche ni de madrugada, en cualquier zona', () => {
  const t = { ...emptyTaste(BA), on: true };
  assert.equal(inWindow(NOW, t), true); // 19:00
  assert.equal(inWindow(NOW + 60 * 60_000, t), false); // 20:00 es de la noche
  assert.equal(inWindow(NOW + 60 * 60_000, { ...t, when: 'noche' }), true);
  assert.equal(inWindow(NOW + 3 * 3_600_000, { ...t, when: 'noche' }), false); // 22:00
  // Todas las horas del día, en zonas muy distintas: solo entre las 18 y las 22 locales.
  for (const tz of [BA, 'Europe/Madrid', 'Asia/Tokyo', 'America/Mexico_City', 'Pacific/Auckland']) {
    for (const when of ['tarde', 'noche'] as const) {
      for (let h = 0; h < 24; h++) {
        const ms = NOW + h * 3_600_000;
        if (inWindow(ms, { ...t, tz, when })) {
          const hour = localParts(ms, tz).hour;
          assert.ok(hour >= 18 && hour < 22, `${tz} ${when} ${hour}`);
        }
      }
    }
  }
});

test('cupo: uno por día y, con «3 por semana», tres en siete días', () => {
  const sent = (daysAgo: number): TasteSent => ({ title: `P${daysAgo}`, genre: 'Documental', at: new Date(NOW - daysAgo * 86_400_000).toISOString(), epg: 'g1', name: 'C', start: 1 });
  const t: TasteState = { ...emptyTaste(BA), on: true };
  assert.equal(hasQuota(t, NOW), true);
  assert.equal(hasQuota({ ...t, sent: [sent(0)] }, NOW), false); // ya hubo uno hoy
  assert.equal(hasQuota({ ...t, sent: [sent(1), sent(2)] }, NOW), true);
  assert.equal(hasQuota({ ...t, sent: [sent(1), sent(2), sent(3)] }, NOW), false); // tres esta semana
  assert.equal(hasQuota({ ...t, per: 'dia', sent: [sent(1), sent(2), sent(3)] }, NOW), true); // «1 por día»
  assert.equal(hasQuota({ ...t, sent: [sent(2), sent(3), sent(8)] }, NOW), true); // el de hace 8 días ya no cuenta
  // «Hoy» es el día de la persona: 22:30 UTC del 12 sigue siendo hoy en BA, y 03:00 UTC del 13 también.
  assert.equal(hasQuota({ ...t, sent: [{ ...sent(0), at: '2026-10-13T02:30:00Z' }] }, NOW), false);
  assert.equal(hasQuota({ ...t, sent: [{ ...sent(0), at: '2026-10-13T04:00:00Z' }] }, NOW), true); // 01:00 del 13 en BA
});

test('el gusto: el género con peso en los últimos 30 días o un «Más como esto»; nunca publicidad, noticias ni otro', () => {
  const t = (n: number, g: string, at = iso(-24)) => ({ n, g, at, title: '' });
  const h = {
    ch: {}, no: {}, more: {}, mg: {},
    t: { a: t(4, 'Documental'), b: t(1, 'Serie'), c: t(9, 'Noticias'), d: t(9, 'Publicidad'), e: t(9, 'Otro'), f: t(5, 'Deportes', iso(-24 * 40)) },
  };
  assert.deepEqual(tasteGenres(h, NOW), ['Documental']);
  // 3 de 12 = 25 %: entra; 2 de 12 no.
  assert.deepEqual(tasteGenres({ ...h, t: { a: t(3, 'Película'), b: t(9, 'Serie') } }, NOW), ['Película', 'Serie']);
  assert.deepEqual(tasteGenres({ ...h, t: { a: t(2, 'Película'), b: t(9, 'Serie') } }, NOW), ['Serie']);
  // «Más como esto» vigente suma su género; uno ya quitado no.
  assert.deepEqual(tasteGenres({ ...h, more: { x: iso(-1) }, mg: { x: 'Infantil' } }, NOW), ['Documental', 'Infantil']);
  assert.deepEqual(tasteGenres({ ...h, more: {}, mg: { x: 'Infantil' } }, NOW), ['Documental']);
  assert.deepEqual(allowedGenres(h, { ...emptyTaste(), off: ['Documental'] }, NOW), []);
});

const ch1: TasteChannel = { epg: 'g1', name: 'Canal Uno', cat: 'Cultura' };
const ch2: TasteChannel = { epg: 'g2', name: 'Canal Dos', cat: 'Cine' };
const prog = (title: string, startH: number, lenMin: number, genre: string): [number, number, string, string?, string?] =>
  [nowS + startH * 3600, nowS + startH * 3600 + lenMin * 60, title, undefined, genre];
const baseHabits = () => ({ ch: {}, t: { 'otro que vi': { n: 4, g: 'Documental', at: iso(-24) } } as Record<string, { n: number; g?: string; at?: string }>, no: {}, more: {}, mg: {} });
const ctx = (over: Partial<Parameters<typeof pickProgram>[1]> = {}) => ({
  habits: baseHabits(), marks: new Set<string>(), genres: ['Documental'], sent: [] as TasteSent[], nowMs: NOW,
  schedules: new Map<string, ReturnType<typeof prog>[] | null>(), ...over,
});

test('qué programa: empieza entre 30 min y 4 h, dura 40 min o más, es del gusto y no se repite ni se vio', () => {
  const sch = (...list: ReturnType<typeof prog>[]) => new Map([['g1', list]]);
  const pick = (c: ReturnType<typeof ctx>) => pickProgram([ch1], c)?.entry[2] ?? null;
  const good = prog('Planeta Tierra', 2, 90, 'Documental');
  assert.equal(pick(ctx({ schedules: sch(good) })), 'Planeta Tierra');
  // Fuera de hora, muy corto, otro género, o sin género.
  assert.equal(pick(ctx({ schedules: sch(prog('Antes', 0.25, 90, 'Documental'), prog('Lejos', 5, 90, 'Documental'), prog('Corto', 2, 30, 'Documental'), prog('Serie', 2, 90, 'Serie')) })), null);
  assert.equal(pick(ctx({ schedules: sch([nowS + 7200, nowS + 12000, 'Sin género']) })), null);
  // Repetición, ya visto, ya con campana, ya avisado hace menos de 14 días (sí si fue hace más).
  assert.equal(pick(ctx({ schedules: sch(prog('Planeta Tierra (R)', 2, 90, 'Documental')) })), null);
  assert.equal(pick(ctx({ schedules: sch(prog('Otro que vi', 2, 90, 'Documental')) })), null);
  assert.equal(pick(ctx({ schedules: sch(good), marks: new Set([`g1|${good[0]}`]) })), null);
  const sent = (days: number): TasteSent => ({ title: 'planeta  tierra', genre: 'Documental', at: iso(-24 * days), epg: 'g1', name: 'x', start: 1 });
  assert.equal(pick(ctx({ schedules: sch(good), sent: [sent(3)] })), null);
  assert.equal(pick(ctx({ schedules: sch(good), sent: [sent(15)] })), 'Planeta Tierra');
  // «No me interesa» lo saca; sin géneros permitidos, nada.
  assert.equal(pick(ctx({ schedules: sch(good), habits: { ...baseHabits(), no: { 'planeta tierra': iso(-1) } } })), null);
  assert.equal(pick(ctx({ schedules: sch(good), genres: [] })), null);
  // Noticias y publicidad nunca, aunque estén en la lista de géneros.
  assert.equal(pick(ctx({ schedules: sch(prog('Telenoche', 2, 90, 'Noticias')), genres: ['Noticias'] })), null);
});

test('qué programa: el mejor por puntaje de hábitos, y sin uno bueno no hay nada', () => {
  const habits = { ...baseHabits(), ch: { g2: { n: 6, h: Array(24).fill(0).map((_, i) => (i === 22 ? 6 : 0)) } } };
  const sch = new Map([['g1', [prog('Documental largo', 2, 120, 'Documental')]], ['g2', [prog('Documental del canal de siempre', 2, 120, 'Documental')]]]);
  assert.equal(pickProgram([ch1, ch2], ctx({ habits, schedules: sch }))?.ch.name, 'Canal Dos');
  // Con poco peso (un resumen de 45 minutos, de un género que se mira poco) no alcanza para molestar.
  const weak = { ...baseHabits(), t: { a: { n: 3, g: 'Documental', at: iso(-24) }, b: { n: 9, g: 'Serie', at: iso(-24) } } };
  assert.equal(pickProgram([ch1], ctx({ habits: weak, schedules: new Map([['g1', [prog('Resumen de la semana', 2, 45, 'Documental')]]]) })), null);
});

test('lo guardado se lee con cuidado', () => {
  assert.equal(parseTaste(null), undefined);
  const t = parseTaste({ on: 'sí', off: ['Serie', 3], tz: 'xx', when: 'madrugada', per: 'dia', sent: [{ title: 1 }] })!;
  assert.deepEqual(t, { on: false, off: ['Serie'], tz: BA, when: 'tarde', per: 'dia', sent: [] });
});

// ---- notifyTaste con el servicio de push simulado
async function world(opts: { tz?: string } = {}) {
  const t = makeEnv();
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  t.env.VAPID_PUBLIC_KEY = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)));
  t.env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const sub: PushSub = {
    endpoint: 'https://push.example/s/taste', created: '2026-10-01T00:00:00Z',
    keys: { p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) },
  };
  const pushed: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith('https://push.example/')) { pushed.push(String(input)); return new Response(null, { status: 201 }); }
    throw new Error(`fetch inesperado: ${String(input)}`); // ninguna red real
  }) as typeof fetch;
  restore = () => void (globalThis.fetch = real);
  const cfgId = 'cfg-taste';
  const bucket = t.env.BUCKET;
  await bucket.put(`list/${cfgId}.json`, JSON.stringify({ channels: [{ name: 'Canal Uno', category: 'Cultura' }, { name: 'Oculto', category: 'Cultura' }] }));
  await bucket.put(`cfg/${cfgId}.json`, JSON.stringify({ channels: { 'Canal Uno': { epg: 'g1' }, Oculto: { epg: 'g2', hidden: true } } }));
  await bucket.put(`habits/${cfgId}.json`, JSON.stringify({ '': { ch: {}, no: {}, more: {}, mg: {}, t: baseHabits().t }, kids: { ch: {}, no: {}, more: {}, mg: {}, t: {} } }));
  const entries = [prog('Planeta Tierra', 2, 90, 'Documental'), prog('Telenoche', 2, 60, 'Noticias')];
  await bucket.put(`ui/schedule/${await scheduleFile(channelAlias('g1'))}.json`, JSON.stringify(entries));
  await bucket.put(`ui/schedule/${await scheduleFile(channelAlias('g2'))}.json`, JSON.stringify([prog('Del oculto', 2, 120, 'Documental')]));
  await addSub(bucket, cfgId, sub);
  if (opts.tz) await setTaste(bucket, cfgId, { tz: opts.tz });
  return { ...t, cfgId, bucket, pushed };
}

test('los canales ocultos o sin guía no cuentan', () => {
  const list = { channels: [{ name: 'A', category: 'X' }, { name: 'B', category: 'X' }, { name: 'C', category: 'Y' }] };
  const cfg = { channels: { A: { epg: 'g1' }, B: { epg: 'g2', hidden: true }, C: {} }, groups: { hidden: [] } };
  assert.deepEqual(visibleGuideChannels(list, cfg).map((c) => c.name), ['A']);
});

test('notifyTaste: apagado por defecto; prendido manda uno y el cupo del día lo frena', async () => {
  const w = await world();
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW)), 0); // apagado
  const view = await setTaste(w.bucket, w.cfgId, { on: true, tz: BA });
  assert.deepEqual(view?.genres, [{ name: 'Documental', on: true }]);
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW - 3 * 3_600_000)), 0); // 16:00: fuera de la ventana
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW)), 1);
  assert.equal(w.pushed.length, 1);
  const after = await getTaste(w.bucket, w.cfgId);
  assert.equal(after.sent.length, 1);
  assert.equal(after.sent[0].title, 'Planeta Tierra');
  // El mismo día no vuelve a mandar; ni tampoco el mismo título dentro de los 14 días.
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW + 30 * 60_000)), 0);
  assert.equal(w.pushed.length, 1);
});

test('notifyTaste: un género apagado no se avisa, y volver a prenderlo sí', async () => {
  const w = await world();
  await setTaste(w.bucket, w.cfgId, { on: true });
  const off = await setTaste(w.bucket, w.cfgId, { genre: 'Documental', genreOn: false });
  assert.deepEqual(off?.genres, [{ name: 'Documental', on: false }]);
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW)), 0);
  await setTaste(w.bucket, w.cfgId, { genre: 'Documental', genreOn: true });
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW)), 1);
});

test('notifyTaste: usa la zona del dispositivo (a las 19:00 de Buenos Aires, en Madrid es de noche)', async () => {
  const w = await world({ tz: 'Europe/Madrid' });
  await setTaste(w.bucket, w.cfgId, { on: true });
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW)), 0); // 00:00 en Madrid
  assert.equal(w.pushed.length, 0);
  await setTaste(w.bucket, w.cfgId, { tz: BA });
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW)), 1);
});

test('avisos por gusto: hace falta un dispositivo suscrito, y apagar los avisos los apaga todos', async () => {
  const t = makeEnv();
  assert.equal(await setTaste(t.env.BUCKET, 'sin-subs', { on: true }), null);
  const w = await world();
  await setTaste(w.bucket, w.cfgId, { on: true, when: 'noche', per: 'dia' });
  const v = await getTaste(w.bucket, w.cfgId);
  assert.deepEqual([v.on, v.when, v.per], [true, 'noche', 'dia']);
  // Sin dispositivos no se manda nada, aunque haya quedado prendido.
  const st = JSON.parse(await (await w.bucket.get(`push/${w.cfgId}.json`))!.text());
  await w.bucket.put(`push/${w.cfgId}.json`, JSON.stringify({ ...st, subs: [] }));
  assert.equal(await notifyTaste(w.env, w.cfgId, new Date(NOW + 3_600_000)), 0);
});
