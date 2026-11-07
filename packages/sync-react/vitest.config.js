import { surfaceVitest } from '@surface/config/vitest';

// Node only: hooks and the panel are tested as server-rendered markup (ADR-0017).
export default surfaceVitest();
