// CSS Modules (ADR-0004), as in packages/ui: Vite compiles *.module.css; this types the class map.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
