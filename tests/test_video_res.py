import os

import pytest

import video_res

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'video')


def ts(name):
    with open(os.path.join(FIX, f'{name}.ts'), 'rb') as f:
        return f.read()


@pytest.mark.parametrize('name, size', [
    ('h264_1080', (1920, 1080)),  # 1088 codificado, recortado a 1080
    ('h264_720', (1280, 720)),
    ('h264_576i', (720, 576)),  # entrelazado
    ('h264_422', (1440, 1080)),  # 4:2:2, con perfil alto
    ('hevc_2160', (3840, 2160)),
])
def test_saca_la_resolucion_del_sps(name, size):
    demux = video_res.TsDemuxer()
    data = ts(name)
    for k in range(0, len(data), 500):  # llega en pedazos que cortan paquetes
        demux.feed(data[k:k + 500])
    assert demux.result() == size


def test_basura_o_sin_video_no_rompe():
    for data in (b'', b'\x47' * 4000, os.urandom(4000), ts('h264_720')[:400]):
        demux = video_res.TsDemuxer()
        demux.feed(data)
        assert demux.result() is None


class Resp:
    def __init__(self, status, body, url):
        self.status_code, self.body, self.url = status, body, url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_content(self, n):
        for k in range(0, len(self.body), n):
            yield self.body[k:k + n]


class Session:
    def __init__(self, routes):
        self.routes, self.asked = routes, []

    def get(self, url, **kw):
        self.asked.append(url)
        status, body = self.routes.get(url, (404, b''))
        return Resp(status, body, url)


def test_mide_ts_directo_hls_maestro_y_hls_con_segmento():
    assert video_res.measure(Session({'http://p/1.ts': (200, ts('h264_720'))}), 'http://p/1.ts') == (1280, 720)
    master = b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080\nb.m3u8\n'
    assert video_res.measure(Session({'http://p/2.m3u8': (200, master)}), 'http://p/2.m3u8') == (1920, 1080)
    media = b'#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg/1.ts\n'
    s = Session({'http://p/live/3.m3u8': (200, media), 'http://p/live/seg/1.ts': (200, ts('hevc_2160'))})
    assert video_res.measure(s, 'http://p/live/3.m3u8') == (3840, 2160)
    assert s.asked == ['http://p/live/3.m3u8', 'http://p/live/seg/1.ts']


def test_si_no_se_puede_saber_devuelve_none():
    assert video_res.measure(Session({}), 'http://p/x.ts') is None
    assert video_res.measure(Session({'http://p/x.ts': (200, b'<html>')}), 'http://p/x.ts') is None

    class Boom:
        def get(self, *a, **k):
            raise OSError('cortado')
    assert video_res.measure(Boom(), 'http://p/x.ts') is None
