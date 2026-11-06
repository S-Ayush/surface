import { STATUS_CATEGORIES } from '@surface/domain';

export function App() {
  return (
    <main>
      <h1>Surface</h1>
      <p>Monorepo skeleton (PLAN-004 S1). {STATUS_CATEGORIES.length} status categories loaded.</p>
    </main>
  );
}
