// Test stub for the virtual "cloudflare:workers" module. The real base class
// stores env/ctx; our stub mirrors that so ApplyRunWorkflow can run under node.
export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  env: Env;
  ctx: unknown;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export type WorkflowEvent<T> = { payload: T };
export type WorkflowStep = unknown;
