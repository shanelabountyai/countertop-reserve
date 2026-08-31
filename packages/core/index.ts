// The domain engine: pure functions, no database, no clock (CLAUDE.md).
//
// What lands here, and in which session:
//   V-002  floor plan model + the availability engine
//   V-004  the ONE reservation lifecycle state machine every reader
//          derives its status lists from
//   V-006  message templating (rendered bodies, snapshot-safe)
//
// Nothing is exported yet. V-001 is the scaffold only.
export {};
