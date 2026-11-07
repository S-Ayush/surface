import './zod-config.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppModel } from './app/AppModel.js';
import { AuthState, httpAuthClient } from './app/auth.js';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

const app = new AppModel(
  new AuthState(
    httpAuthClient(
      (url, init) => window.fetch(url, init),
      () => document.cookie,
    ),
  ),
);

createRoot(root).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);
