/**
 * Config is read once at import (see src/config.ts), so the values every test
 * runs against are pinned here, BEFORE any module loads.
 *
 * A bearer is set deliberately: leaving it unset would silently disable the auth
 * middleware and let an unauthenticated-access regression pass the suite.
 */
process.env.RENDER_TOKEN = "test-render-token";
process.env.RENDER_STATE_DIR = "/tmp/jobarms-render-test-state";
// Small but > 1 so the concurrency gate's queueing path is exercised.
process.env.RENDER_MAX_CONCURRENCY = "2";
process.env.RENDER_MAX_WIZARD_PAGES = "4";
// The captcha callback is configured so httpSolver() builds a real solver and
// its request shape can be asserted; fetch is mocked per-test.
process.env.RENDER_SOLVER_URL = "https://arm.jobarms.com/internal/solve-captcha";
process.env.RENDER_SOLVER_TOKEN = "solver-token";
