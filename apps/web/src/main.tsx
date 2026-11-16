import './zod-config.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppModel } from './app/AppModel.js';
import { AuthState, browserStartMemory, httpAuthClient } from './app/auth.js';
import { browserReplicaDeleteMarks, retryReplicaDeletes } from './app/replica-deletes.js';
import { registerAppCache } from './offline/register.js';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// A replica delete that failed after a logout is retried first, before any store opens it.
const deletes = browserReplicaDeleteMarks(() => window.localStorage);
void retryReplicaDeletes(deletes);

const app = new AppModel(
  new AuthState(
    httpAuthClient(
      (url, init) => window.fetch(url, init),
      () => document.cookie,
    ),
    // A reload without the server opens this device's last session (ADR-0018).
    { memory: browserStartMemory(() => window.localStorage) },
  ),
  { deletes },
);

createRoot(root).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);

// After the page's own loads, so caching the build doesn't compete with them (ADR-0019).
window.addEventListener(
  'load',
  () => {
    void registerAppCache({ production: import.meta.env.PROD, host: navigator });
  },
  { once: true },
);
