// La playlist que sirve el Worker para una configuración, armada con su mismo código
// (worker/src/playlist.ts), a partir de la configuración y la lista guardadas en R2. La usa
// tools/compare_web.py para compararla con la de la corrida de GitHub. Las URLs de stream son
// ficticias (/s/<id>.<ext>): solo importa el id del canal, y así no hay credenciales.
//
// Uso: node tools/web_playlist.ts <cfg.json> <list.json>
import { readFileSync } from 'node:fs';
import type { Config } from '../worker/src/config.ts';
import { buildPlaylist } from '../worker/src/playlist.ts';
import type { Channel } from '../worker/src/provider.ts';

const [cfgPath, listPath] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Config;
const { channels } = JSON.parse(readFileSync(listPath, 'utf-8')) as { channels: Channel[] };
process.stdout.write(buildPlaylist(channels, cfg, {
  epgUrl: '',
  streamUrl: (ch) => `/s/${ch.id}.${ch.ext}`,
}));
