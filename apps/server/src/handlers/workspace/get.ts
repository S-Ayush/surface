import { workspaceGet } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { theWorkspace, workspaceOutput } from './shared.js';

export default handler(workspaceGet, async (ctx) => workspaceOutput(await theWorkspace(ctx)));
