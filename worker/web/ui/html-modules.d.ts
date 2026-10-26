// Los .html de ui/ se importan como texto (build.mjs, loader «text»).
declare module '*.html' {
  const html: string;
  export default html;
}
