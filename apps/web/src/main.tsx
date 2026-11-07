import './zod-config.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppModel } from './app/AppModel.js';
import { AuthState, preAuthClient } from './app/auth.js';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// Until PLAN-001 S3 adds sessions, nobody is signed in; setup state is real (app/auth.ts).
const app = new AppModel(new AuthState(preAuthClient((url, init) => window.fetch(url, init))));

createRoot(root).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);
