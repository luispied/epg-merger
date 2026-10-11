// Las iniciales de un canal sin logo: las mismas en la lista, la hoja del canal, la Guía y el modo ver.

/** Primera letra de las dos primeras palabras («Fox Sports» → FS), o las dos primeras de una sola («ESPN» → ES). */
export function initials(label: string): string {
  const words = label.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  return (words[0][0] + (words.length > 1 ? words[1][0] : (words[0][1] ?? ''))).toUpperCase();
}
