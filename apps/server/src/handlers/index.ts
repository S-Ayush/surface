import type { Handler } from '../executor/context.js';
import debugEcho from './debug/echo.js';
import debugTouch from './debug/touch.js';

/** Every server handler, one per operation in the registry (checked at executor creation). */
export const HANDLERS: readonly Handler[] = [debugEcho, debugTouch];
