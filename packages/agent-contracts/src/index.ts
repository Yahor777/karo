export interface ConsentRequest {
  readonly taskId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly reason: string;
  readonly source: "test-command-autodetect";
  readonly createdAt: string;
}

export type ConsentDecision =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "overrideCommand"; command: string; args: readonly string[] }
  | { kind: "cancel" };

