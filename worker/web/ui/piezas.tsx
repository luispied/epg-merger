// Piezas chicas del armazón de index.html que cambian con el estado: la barra de estado del alta y de la carga, la
// píldora de «sin conexión», los filtros con su cuenta, los íconos sueltos y el QR. Cada una se dibuja con Preact
// dentro de su elemento de index.html.
import { render } from 'preact';
import { Icon } from './icon.tsx';

/** Barra de estado (alta, carga de la grilla): un ícono según cómo va y el texto; con `retry`, un botón «Reintentar». */
export function renderStatus(el: HTMLElement, text: string, kind: 'busy' | 'ok' | 'bad', retry?: () => void) {
  render(
    <>
      <Icon name={kind === 'busy' ? 'loader-circle' : kind === 'ok' ? 'circle-check' : 'triangle-alert'} class={kind === 'busy' ? 'spin' : ''} />
      <span class="lead">{text}</span>
      {retry && <button type="button" class="btn btn-tonal sm" id="retryOpen" onClick={retry}><Icon name="refresh-cw" />Reintentar</button>}
    </>, el);
}

/** Píldora de arriba: sin conexión o guardando. */
export function renderNetPill(el: HTMLElement, offline: boolean, text: string) {
  render(<><Icon name={offline ? 'cloud-off' : 'loader-circle'} class={offline ? '' : 'spin'} /><span>{text}</span></>, el);
}

/** Un ícono solo, como único contenido de `el` (un botón de ícono, el del campo de un diálogo). */
export function renderIcon(el: HTMLElement, name: string, cls = '') {
  render(<Icon name={name} class={cls} />, el);
}

/** El QR (el SVG que arma la librería qrcode-generator) con su leyenda. */
export function renderQr(el: HTMLElement, svg: string, caption: string) {
  render(<><span class="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} /><small class="help">{caption}</small></>, el);
}
