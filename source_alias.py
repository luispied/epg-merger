"""Alias opaco de una fuente de EPG para lo que sale del repo (guía de Grilla web y XML de los
reproductores): `s` + 8 caracteres de un hash del id, siempre el mismo. Así no se ve de qué
proveedor sale cada canal. La corrida y el matcher de Python siguen con los ids reales.

La web traduce con la misma fórmula los `prefer_sources` de cada configuración (ver
`sourceAlias` en worker/src/crypto.ts)."""
import hashlib


def source_alias(source_id):
    if not source_id:
        return source_id
    return 's' + hashlib.sha256(f'grilla-fuente\n{source_id}'.encode('utf-8')).hexdigest()[:8]
