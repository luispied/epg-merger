#!/usr/bin/env python3
"""Parseo de nombres de canal: extrae señales y deja el núcleo del nombre.

La estrategia anterior (`normalize_name`) era **borrar** tokens hasta que dos nombres
quedaran idénticos. Eso obligaba a un caso especial por cada excepción ("no borres 'TV' si
no está al final") y tiraba información que en realidad es útil: el sufijo "-EN" que el
proveedor agrega a sus canales en inglés no es ruido, es la pista de que ese canal hay que
buscarlo en fuentes de EE.UU./UK/Canadá.

Acá cada señal (país, idioma, región, calidad) se **saca** del núcleo pero se **conserva**
como dato, para que el matching pueda puntuar con ella.
"""
import json
import os
import re
import unicodedata
from collections import namedtuple

RULES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'matching_rules.json')

ParsedName = namedtuple('ParsedName', 'core country language region quality raw')

# Prefijo de código de país que algunos proveedores anteponen: "PE | ", "CL| ", "B| ".
COUNTRY_PREFIX_RE = re.compile(r'^[A-Za-z]{1,3}\s*\|\s*')


def strip_accents(text):
    text = unicodedata.normalize('NFKD', text)
    return ''.join(c for c in text if not unicodedata.combining(c))


class MatchingRules:
    """Tablas de matching cargadas de matching_rules.json."""

    def __init__(self, data):
        self.country_code_aliases = data.get('country_code_aliases', {})
        self.country_tokens = data.get('country_tokens', {})
        self.language_tokens = data.get('language_tokens', {})
        self.language_countries = data.get('language_countries', {})
        self.quality_tokens = set(data.get('quality_tokens', []))
        self.region_tokens = set(data.get('region_tokens', []))

        # Las entradas de varias palabras ("costa rica") necesitan tolerar cualquier
        # separación en el texto original. El bug que esto arregla: el patrón se armaba con
        # los espacios literales, así que "costa rica" (con espacio) nunca matcheaba la clave
        # "costarica" y ningún canal de Costa Rica llegaba a detectar su país.
        multi = sorted((k for k in self.country_tokens if ' ' in k), key=len, reverse=True)
        self._multi_country_re = (
            re.compile(r'\b(' + '|'.join(re.escape(k).replace(r'\ ', r'\s+') for k in multi) + r')\b')
            if multi else None
        )

    def country_of(self, token):
        return self.country_tokens.get(token)

    def countries_for_language(self, language):
        return self.language_countries.get(language, [])


def load_rules(path=RULES_PATH):
    with open(path, 'r', encoding='utf-8') as f:
        return MatchingRules(json.load(f))


_RULES = None


def rules():
    """Reglas por defecto, cargadas una sola vez."""
    global _RULES
    if _RULES is None:
        _RULES = load_rules()
    return _RULES


def parse_channel_name(raw, r=None):
    """Descompone un nombre de canal en núcleo + señales.

    >>> parse_channel_name("TBS -EN").core, parse_channel_name("TBS -EN").language
    (('tbs',), 'en')
    >>> parse_channel_name("Warner TV Costa Rica").core
    ('warner', 'tv')
    """
    r = r or rules()
    if not raw:
        return ParsedName((), None, None, None, (), raw or '')

    country = None
    language = None
    region = None
    quality = []

    text = strip_accents(raw)

    prefix = COUNTRY_PREFIX_RE.match(text)
    if prefix:
        code = prefix.group(0).strip(' |').lower()
        country = r.country_of(code)
        text = text[prefix.end():]

    text = text.lower()

    # Países de varias palabras primero, para poder sacarlos del texto antes de tokenizar
    # (si no, "costa" y "rica" quedarían como dos tokens sueltos del núcleo).
    if r._multi_country_re:
        m = r._multi_country_re.search(text)
        if m:
            country = country or r.country_of(m.group(1))
            text = text[:m.start()] + ' ' + text[m.end():]

    tokens = [t for t in re.sub(r'[^a-z0-9]+', ' ', text).split() if t]

    # El sufijo de idioma solo se reconoce al final del nombre, que es donde el proveedor lo
    # pone ("TBS -EN"). En cualquier otra posición "en" es una palabra española corriente.
    if tokens and tokens[-1] in r.language_tokens and tokens[-1] not in r.country_tokens:
        language = r.language_tokens[tokens[-1]]
        tokens = tokens[:-1]

    core = []
    for token in tokens:
        if token in r.quality_tokens:
            quality.append(token)
        elif token in r.region_tokens:
            region = region or token
        elif token in r.country_tokens:
            country = country or r.country_of(token)
        else:
            core.append(token)

    return ParsedName(tuple(core), country, language, region, tuple(quality), raw)


def flag_to_country_code(text, r=None):
    """Código de país (alineado con el sufijo de los channel_id) del emoji de bandera."""
    r = r or rules()
    codepoints = [ord(c) for c in text]
    for i in range(len(codepoints) - 1):
        a, b = codepoints[i], codepoints[i + 1]
        if 0x1F1E6 <= a <= 0x1F1FF and 0x1F1E6 <= b <= 0x1F1FF:
            code = chr(a - 0x1F1E6 + ord('a')) + chr(b - 0x1F1E6 + ord('a'))
            return r.country_code_aliases.get(code, code)
    return None


def detect_country(*texts, r=None):
    """Primer país que aparezca en cualquiera de los textos."""
    for text in texts:
        if not text:
            continue
        parsed = parse_channel_name(text, r)
        if parsed.country:
            return parsed.country
    return None


def detect_region(*texts, r=None):
    for text in texts:
        if not text:
            continue
        parsed = parse_channel_name(text, r)
        if parsed.region:
            return parsed.region
    return None
