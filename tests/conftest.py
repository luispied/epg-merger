"""Los tests del pipeline están escritos para las reglas del proveedor de este repo
(provider_rules.json: separadores ▆▆▆, secciones, etc.): se cargan siempre desde la raíz del
repo aunque cada test corra en su propio directorio temporal."""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import generate_playlist  # noqa: E402


@pytest.fixture(autouse=True)
def reglas_del_proveedor(monkeypatch):
    monkeypatch.setattr(generate_playlist, 'PROVIDER_RULES_PATH', os.path.join(ROOT, 'provider_rules.json'))
    generate_playlist.set_provider_rules(generate_playlist.load_provider_rules())
