// Sync wire types and codecs: the contract between sync-client and the server
// (SPEC-002, docs/04-architecture/sync-protocol.md). Any change here updates
// sync-protocol.md in the same change. Also the server's own paths
// (`server-paths.ts`, no wire change), re-exported here for the server and
// exported alone as `@surface/sync-protocol/server-paths` for the offline worker.
export * from './scalars.js';
export * from './errors.js';
export * from './bootstrap.js';
export * from './content.js';
export * from './socket.js';
export * from './mutate.js';
export * from './csrf.js';
export * from './ndjson.js';
export * from './schema-hash.js';
export * from './server-paths.js';
