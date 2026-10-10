"""Resolución real de un canal: el ancho y el alto del video que manda el proveedor.

Para el relay (relay/server.py), una vez por semana por canal. Sin ffprobe: se lee el comienzo del stream (MPEG-TS, o el
primer segmento si es HLS), se busca el SPS del video (H.264 o HEVC) y de ahí salen las medidas. Si el playlist HLS es
uno maestro con RESOLUTION=, alcanza con eso. Lee como mucho MAX_BYTES y corta apenas encuentra el SPS.
"""
import re
import time
from urllib.parse import urljoin

MAX_BYTES = 1024 * 1024
DEADLINE_S = 8
TIMEOUT = (8, 8)
TS_PACKET = 188
_RESOLUTION_RE = re.compile(rb'RESOLUTION=(\d{2,5})x(\d{2,5})')


class _Bits:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def u(self, n):
        v = 0
        for _ in range(n):
            byte = self.data[self.pos >> 3] if (self.pos >> 3) < len(self.data) else 0
            v = (v << 1) | ((byte >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        if self.pos > len(self.data) * 8:
            raise ValueError('SPS corto')
        return v

    def ue(self):
        zeros = 0
        while self.u(1) == 0:
            zeros += 1
            if zeros > 31:
                raise ValueError('exp-golomb inválido')
        return (1 << zeros) - 1 + self.u(zeros)

    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def _rbsp(nal):
    """Saca los bytes de prevención de emulación (00 00 03)."""
    return re.sub(b'\x00\x00\x03', b'\x00\x00', nal)


def _crop_units(chroma, frame_mbs_only=1):
    sub_w, sub_h = {0: (1, 1), 1: (2, 2), 2: (2, 1), 3: (1, 1)}.get(chroma, (2, 2))
    return sub_w, sub_h * (2 - frame_mbs_only)


def parse_h264_sps(nal):
    """(ancho, alto) de un SPS H.264 (con el byte de cabecera del NAL)."""
    b = _Bits(_rbsp(nal[1:]))
    profile = b.u(8)
    b.u(16)  # restricciones y nivel
    b.ue()
    chroma = 1
    if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        chroma = b.ue()
        if chroma == 3:
            b.u(1)
        b.ue(); b.ue(); b.u(1)  # profundidad de color, qpprime
        if b.u(1):  # matrices de cuantización: se recorren para saltarlas
            for i in range(8 if chroma != 3 else 12):
                if b.u(1):
                    last = nxt = 8
                    for _ in range(16 if i < 6 else 64):
                        if nxt:
                            nxt = (last + b.se()) % 256
                        last = nxt or last
    b.ue()  # log2_max_frame_num
    poc = b.ue()
    if poc == 0:
        b.ue()
    elif poc == 1:
        b.u(1); b.se(); b.se()
        for _ in range(b.ue()):
            b.se()
    b.ue(); b.u(1)  # cuadros de referencia
    w_mbs, h_units = b.ue() + 1, b.ue() + 1
    frame_mbs_only = b.u(1)
    if not frame_mbs_only:
        b.u(1)
    b.u(1)
    width, height = w_mbs * 16, (2 - frame_mbs_only) * h_units * 16
    if b.u(1):
        cx, cy = _crop_units(chroma, frame_mbs_only)
        left, right, top, bottom = b.ue(), b.ue(), b.ue(), b.ue()
        width -= cx * (left + right)
        height -= cy * (top + bottom)
    return width, height


def parse_hevc_sps(nal):
    """(ancho, alto) de un SPS HEVC (con los dos bytes de cabecera del NAL)."""
    b = _Bits(_rbsp(nal[2:]))
    b.u(4)
    sub_layers = b.u(3)
    b.u(1)
    b.u(88); b.u(8)  # perfil general y nivel
    flags = [(b.u(1), b.u(1)) for _ in range(sub_layers)]
    if sub_layers:
        for _ in range(sub_layers, 8):
            b.u(2)
    for prof, level in flags:
        if prof:
            b.u(88)
        if level:
            b.u(8)
    b.ue()
    chroma = b.ue()
    if chroma == 3:
        b.u(1)
    width, height = b.ue(), b.ue()
    if b.u(1):
        cx, cy = _crop_units(chroma)
        left, right, top, bottom = b.ue(), b.ue(), b.ue(), b.ue()
        width -= cx * (left + right)
        height -= cy * (top + bottom)
    return width, height


def _sane(wh):
    w, h = wh
    return (w, h) if 64 <= w <= 8192 and 64 <= h <= 8192 else None


def find_sps(es, codec):
    """Busca el primer SPS del video en el flujo elemental y devuelve (ancho, alto), o None."""
    i = 0
    while True:
        i = es.find(b'\x00\x00\x01', i)
        if i < 0 or i + 4 >= len(es):
            return None
        head = es[i + 3]
        is_sps = (head & 0x1F) == 7 if codec == 'h264' else ((head >> 1) & 0x3F) == 33
        if is_sps:
            end = es.find(b'\x00\x00\x01', i + 3)
            if end < 0:
                if len(es) - i < 64:
                    return None  # el SPS sigue en lo que todavía no llegó
                end = len(es)
            try:
                wh = _sane((parse_h264_sps if codec == 'h264' else parse_hevc_sps)(es[i + 3:end]))
            except (ValueError, IndexError):
                wh = None
            if wh:
                return wh
        i += 3


class TsDemuxer:
    """Junta el contenido del PID de video de un MPEG-TS (PAT → PMT → video) a medida que llegan los bytes."""

    def __init__(self):
        self.buf = b''
        self.pmt_pids = set()
        self.video_pid = None
        self.codec = None
        self.es = bytearray()

    def feed(self, data):
        self.buf += data
        start = self.buf.find(b'\x47')
        while start >= 0 and start + TS_PACKET <= len(self.buf):
            if self.buf[start] != 0x47:
                start = self.buf.find(b'\x47', start + 1)
                continue
            self._packet(self.buf[start:start + TS_PACKET])
            start += TS_PACKET
        self.buf = self.buf[start:] if start >= 0 else b''

    def _packet(self, pkt):
        pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
        pusi = pkt[1] & 0x40
        afc = (pkt[3] >> 4) & 3
        off = 4
        if afc in (2, 3):
            off += 1 + pkt[4]
        if afc == 2 or off >= TS_PACKET:
            return
        payload = pkt[off:]
        if pid == 0 and pusi:
            self._pat(payload)
        elif pid in self.pmt_pids and pusi and self.video_pid is None:
            self._pmt(payload)
        elif pid == self.video_pid:
            self.es += payload

    @staticmethod
    def _section(payload):
        p = payload[0] + 1
        sec = payload[p:]
        length = ((sec[1] & 0x0F) << 8) | sec[2] if len(sec) > 3 else 0
        return sec[:3 + length]

    def _pat(self, payload):
        sec = self._section(payload)
        for k in range(8, len(sec) - 4, 4):
            prog = (sec[k] << 8) | sec[k + 1]
            if prog:
                self.pmt_pids.add(((sec[k + 2] & 0x1F) << 8) | sec[k + 3])

    def _pmt(self, payload):
        sec = self._section(payload)
        if len(sec) < 12:
            return
        k = 12 + (((sec[10] & 0x0F) << 8) | sec[11])
        while k + 5 <= len(sec) - 4:
            stype, pid = sec[k], ((sec[k + 1] & 0x1F) << 8) | sec[k + 2]
            if stype in (0x1B, 0x24):
                self.video_pid, self.codec = pid, 'h264' if stype == 0x1B else 'hevc'
                return
            k += 5 + (((sec[k + 3] & 0x0F) << 8) | sec[k + 4])

    def result(self):
        return find_sps(bytes(self.es), self.codec) if self.codec and self.es else None


def _read_ts(response, clock, deadline):
    demux, read = TsDemuxer(), 0
    for chunk in response.iter_content(16 * 1024):
        demux.feed(chunk)
        read += len(chunk)
        found = demux.result()
        if found or read >= MAX_BYTES or clock() > deadline:
            return found
    return demux.result()


def _first_segment(text, base):
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            return urljoin(base, line)
    return None


def measure(session, url, clock=time.monotonic):
    """(ancho, alto) del video del canal, o None si no se pudo saber (caído, otro códec, sin SPS en lo leído)."""
    deadline = clock() + DEADLINE_S
    try:
        for _ in range(3):  # stream → playlist (maestro o de medios) → segmento
            with session.get(url, stream=True, timeout=TIMEOUT, allow_redirects=True) as r:
                if r.status_code != 200:
                    return None
                head = next(r.iter_content(4096), b'')
                if head[:1] == b'\x47':
                    demux = TsDemuxer()
                    demux.feed(head)
                    found = demux.result()
                    return found or _read_ts(r, clock, deadline)
                if b'#EXTM3U' not in head:
                    return None
                text = head + b''.join(r.iter_content(16 * 1024)) if len(head) == 4096 else head
                text = text[:256 * 1024]
                sizes = [(int(w), int(h)) for w, h in _RESOLUTION_RE.findall(text)]
                if sizes:
                    return max(sizes, key=lambda wh: wh[1])
                url = _first_segment(text.decode('utf-8', 'replace'), r.url)
                if not url or clock() > deadline:
                    return None
        return None
    except Exception:  # noqa: BLE001 — cualquier cosa rara del proveedor: no se sabe
        return None

