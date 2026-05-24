/**
 * Task identifier type.
 *
 * Source: design.md → "Data Models" → "Task".
 *
 * The fuller `TaskState`, `CreateTaskInput` and related schemas are introduced
 * in subsequent tasks (see tasks.md task 2.2 for validation schemas and
 * task 9.1 for the state machine). This module owns only the identifier
 * alias so that downstream packages can reference `TaskId` without pulling in
 * the full task model.
 */

export type TaskId = string;
