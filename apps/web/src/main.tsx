import './zod-config.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SetupPage } from './routes/setup/SetupPage.js';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// The server sends every page to /setup until setup is done (PLAN-001 S2). The router arrives
// with the app shell (PLAN-005 S4), which takes this over as its setup route.
const page =
  window.location.pathname === '/setup' ? (
    <SetupPage token={new URLSearchParams(window.location.search).get('token')} />
  ) : (
    <App />
  );

createRoot(root).render(<StrictMode>{page}</StrictMode>);
