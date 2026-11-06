// CSS Modules (ADR-0004): Vite and Storybook compile *.module.css; this types the class map.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

// Global stylesheets imported for their side effects (Storybook preview, apps).
declare module '*.css';
