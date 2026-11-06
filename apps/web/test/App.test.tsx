import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { App } from '../src/App.js';

it('renders the hello page with data from @surface/domain', () => {
  const html = renderToString(<App />);
  expect(html).toContain('Surface');
  expect(html).toContain('7<!-- --> status categories');
});
