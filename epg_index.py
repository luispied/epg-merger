#!/usr/bin/env python3
"""Índice de canales del EPG mergeado y puntaje de coincidencia.

El matching anterior era una cascada de "primero que pegue gana" sobre nombres normalizados
que tenían que quedar **idénticos**. Acá se puntúa cada candidato por solapamiento de tokens
pesado por IDF, y las demás señales (fuente preferida, país, región) ajustan ese puntaje. Dos
consecuencias prácticas:

- Las alternativas que se ofrecen en la guía quedan ordenadas por confianza real, no por
  orden de inserción en el índice.
- El IDF reemplaza a la lista manual de sufijos a ignorar: "tv", "channel" o "hd" aparecen en
  miles de canales y pesan casi nada por su propia estadística, mientras que "warner" o "laff"
  pesan mucho. No hay que mantener una lista de palabras a descartar.
"""
import math
import re
from collections import namedtuple

from channel_names import detect_country, parse_channel_name, rules as default_rules

Candidate = namedtuple('Candidate', 'channel_id score name_score reason')

# El channel_id de las fuentes EPG casi siempre termina en el código de país: "Canal.5.mx".
CHANNEL_ID_SUFFIX_RE = re.compile(r'\.([a-z]{2})$')

# Cuánto pesa cubrir el nombre buscado (recall) frente a no traer tokens de más (precision).
# El recall manda —el candidato tiene que explicar el nombre que buscamos— pero la precisión
# desempata: para "Laff", el canal "Laff" gana sobre "Laff (WUOA) Birmingham, AL", que también
# lo cubre entero pero agrega un montón de tokens ajenos.
RECALL_WEIGHT = 0.75
PRECISION_WEIGHT = 0.25

PREFER_SOURCE_BOOST = 1.6   # la sección declaró preferir esta fuente EPG
COUNTRY_MATCH_BOOST = 1.25
COUNTRY_MISMATCH_PENALTY = 0.35   # ej. no confundir "Canal 26" de Argentina con el de Chile
LANGUAGE_HINT_BOOST = 1.15   # "TBS -EN" no dice el país, pero el idioma apunta a EE.UU./UK/CA
REGION_MATCH_BOOST = 1.15
REGION_MISMATCH_PENALTY = 0.8

# Puntaje mínimo para aceptar una coincidencia automática.
MIN_SCORE = 0.45
# Umbral (más laxo) para creerle al "epg_channel_id" que trae Xtream: no se le exige ser el
# mejor candidato, solo que el canal apuntado tenga algo que ver con el nombre real.
PLAUSIBLE_MIN = 0.30

# Tope de candidatos a puntuar por canal. Los postings del token más raro del nombre suelen
# ser pocos; este tope solo entra en juego con nombres compuestos únicamente de tokens
# comunísimos, donde igual ninguno iba a superar MIN_SCORE.
CANDIDATE_CAP = 3000
# Cuántos de los tokens más raros del nombre se usan para traer candidatos.
CANDIDATE_TOKENS = 3


def pick_display_name(display_names):
    """El display-name más descriptivo, para usar como desambiguador legible en vez del
    channel_id crudo. Muchas fuentes listan variantes con el número de canal como prefijo
    ("Laff", "247 Laff", "247"); se descartan antes de elegir la más larga."""
    real_names = [t.strip() for t in display_names if t and not t.strip().isdigit()]
    if not real_names:
        return None
    clean = [
        name for name in real_names
        if not (m := re.match(r'^\d+\s+(.+)$', name)) or m.group(1) not in real_names
    ]
    return max(clean or real_names, key=len)


class EpgIndex:
    """Índice invertido token -> canales, más los metadatos de cada canal."""

    def __init__(self, epg_root, sources=None, r=None):
        """`sources`: {source_id: {'country': ..., 'priority': ...}}, tal como los declara
        epg_urls.json. Sirve para deducir el país de un canal cuyo id no lo dice y para
        desempatar candidatos por prioridad de fuente."""
        self.rules = r or default_rules()
        sources = sources or {}
        self._source_priority = {sid: s.get('priority', 0) for sid, s in sources.items()}

        self.icon = {}
        self.source = {}
        self.country = {}
        self.region = {}
        self.display_name = {}
        self.parsed = {}        # channel_id -> [ParsedName, ...] (una por display-name)
        self.postings = {}      # token -> [channel_id, ...] en orden de aparición
        self._idf = {}
        self._order = {}        # channel_id -> orden de aparición, desempate estable

        for position, channel in enumerate(epg_root.findall('channel')):
            channel_id = channel.get('id')
            if not channel_id:
                continue

            icon_elem = channel.find('icon')
            self.icon[channel_id] = icon_elem.get('src') if icon_elem is not None else ''
            source_id = channel.get('source')
            self.source[channel_id] = source_id
            self._order[channel_id] = position

            display_names = [dn.text for dn in channel.findall('display-name') if dn.text]
            pick = pick_display_name(display_names)
            if pick:
                self.display_name[channel_id] = pick

            parsed_names = [parse_channel_name(name, self.rules) for name in display_names]
            self.parsed[channel_id] = parsed_names

            # El sufijo del channel_id manda; si no lo trae, el país que diga el nombre; y como
            # último recurso el país que cubre la fuente de la que salió el canal (dato que
            # antes se perdía en el merge y había que adivinar desde el propio channel_id).
            suffix = CHANNEL_ID_SUFFIX_RE.search(channel_id)
            country = suffix.group(1) if suffix else None
            if not country:
                country = next((p.country for p in parsed_names if p.country), None)
            if not country:
                country = (sources.get(source_id) or {}).get('country')
            self.country[channel_id] = country

            self.region[channel_id] = (
                next((p.region for p in parsed_names if p.region), None)
                or parse_channel_name(channel_id, self.rules).region
            )

            for parsed in parsed_names:
                for token in set(parsed.core):
                    ids = self.postings.setdefault(token, [])
                    if not ids or ids[-1] != channel_id:
                        ids.append(channel_id)

        total = max(len(self.parsed), 1)
        for token, ids in self.postings.items():
            self._idf[token] = math.log(1 + total / len(ids))

    def __contains__(self, channel_id):
        return channel_id in self.parsed

    def idf(self, token):
        # Un token que no está en el índice es máximamente raro; se le da el peso del más raro
        # visto, para no premiar el ruido pero tampoco ignorarlo.
        return self._idf.get(token, math.log(1 + max(len(self.parsed), 1)))

    def _weight(self, tokens):
        return sum(self.idf(t) for t in tokens)

    def _score(self, q_tokens, q_weight, target):
        t = set(target.core)
        if not t:
            return 0.0
        shared = self._weight(q_tokens & t)
        if not shared:
            return 0.0
        recall = shared / q_weight
        precision = shared / self._weight(t)
        return recall * (RECALL_WEIGHT + PRECISION_WEIGHT * precision)

    def name_score(self, query, target):
        """Solapamiento de tokens pesado por IDF entre dos nombres ya parseados, en [0, 1]."""
        q_tokens = set(query.core)
        q_weight = self._weight(q_tokens)
        if not q_weight:
            return 0.0
        return self._score(q_tokens, q_weight, target)

    def best_name_score(self, query, channel_id, q_tokens=None, q_weight=None):
        """Mejor puntaje entre todas las variantes de display-name del canal."""
        if q_tokens is None:
            q_tokens = set(query.core)
            q_weight = self._weight(q_tokens)
        if not q_weight:
            return 0.0
        return max(
            (self._score(q_tokens, q_weight, target) for target in self.parsed.get(channel_id, ())),
            default=0.0,
        )

    def _candidate_ids(self, query):
        tokens = sorted(set(query.core), key=self.idf, reverse=True)[:CANDIDATE_TOKENS]
        ids, seen = [], set()
        for token in tokens:
            for channel_id in self.postings.get(token, ()):
                if channel_id not in seen:
                    seen.add(channel_id)
                    ids.append(channel_id)
            if len(ids) >= CANDIDATE_CAP:
                break
        return ids

    def rank(self, query, prefer_sources=(), country=None, region=None):
        """Candidatos ordenados por confianza. `query` es un ParsedName."""
        prefer_sources = set(prefer_sources or ())
        country = country or query.country
        hint_countries = set(self.rules.countries_for_language(query.language)) if query.language else set()
        region = region or query.region

        q_tokens = set(query.core)
        q_weight = self._weight(q_tokens)
        if not q_weight:
            return []

        ranked = []
        for channel_id in self._candidate_ids(query):
            base = self.best_name_score(query, channel_id, q_tokens, q_weight)
            if not base:
                continue

            score = base
            reason = 'name'

            if self.source.get(channel_id) in prefer_sources:
                score *= PREFER_SOURCE_BOOST
                reason = 'prefer_source'

            cand_country = self.country.get(channel_id)
            if country and cand_country:
                if cand_country == country:
                    score *= COUNTRY_MATCH_BOOST
                    if reason == 'name':
                        reason = 'country'
                else:
                    score *= COUNTRY_MISMATCH_PENALTY
            elif hint_countries and cand_country in hint_countries:
                score *= LANGUAGE_HINT_BOOST
                if reason == 'name':
                    reason = 'language'

            cand_region = self.region.get(channel_id)
            if region and cand_region:
                score *= REGION_MATCH_BOOST if cand_region == region else REGION_MISMATCH_PENALTY

            ranked.append(Candidate(channel_id, score, base, reason))

        # Desempates: primero la fuente más prioritaria, después el orden de aparición
        # (estable, para que dos corridas idénticas den el mismo resultado).
        ranked.sort(key=lambda c: (
            -c.score,
            self._source_priority.get(self.source.get(c.channel_id), 10 ** 6),
            self._order.get(c.channel_id, 0),
        ))
        return ranked
