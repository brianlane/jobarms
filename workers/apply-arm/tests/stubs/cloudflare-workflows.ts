// Test stub for the virtual "cloudflare:workflows" module.
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
