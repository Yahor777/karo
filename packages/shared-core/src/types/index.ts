/**
 * Barrel for shared-core domain types (task 2.1).
 *
 * Each module is small and aligned with a section of design.md so that later
 * tasks (validation schemas, state machines, contracts) can extend specific
 * areas without touching this barrel.
 */

export * from "./agent";
export * from "./provider";
export * from "./runtime";
export * from "./scope";
export * from "./session";
export * from "./task";
