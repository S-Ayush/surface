import type { Handler } from '../executor/context.js';
import debugCreate from './debug/create.js';
import debugDelete from './debug/delete.js';
import debugEcho from './debug/echo.js';
import debugListItems from './debug/list-items.js';
import debugRename from './debug/rename.js';
import debugTouch from './debug/touch.js';

/** Every server handler, one per operation in the registry (checked at executor creation). */
export const HANDLERS: readonly Handler[] = [
  debugEcho,
  debugTouch,
  debugListItems,
  debugCreate,
  debugRename,
  debugDelete,
];
