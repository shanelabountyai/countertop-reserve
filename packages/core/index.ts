// The domain engine: pure functions, no database, no clock (CLAUDE.md).
//
//   V-002  floor plan model + the availability engine
//   V-004  the ONE reservation lifecycle state machine every reader
//          derives its status lists from
//   V-006  message templating (rendered bodies, snapshot-safe)
export * from './floor-plan';
export * from './availability';
export * from './time';
export * from './lifecycle';
export * from './booking';
export * from './messages';
