// Test stub for "@cloudflare/playwright". Individual tests mock `launch` via
// vi.mock; this module just satisfies the import + type surface under node.
export const launch = async (): Promise<unknown> => {
  throw new Error("playwright launch stub: mock this in the test");
};
export type Browser = unknown;
export type Page = unknown;
