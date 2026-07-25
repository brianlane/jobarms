import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { detectChallenge, httpSolver, solveChallenge, type AskSolver } from "../src/captcha";
import { CONFIG } from "../src/config";
import { fakePage, loc } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const present = () => loc({ count: vi.fn(async () => 1) });

/** A checkbox control reporting a given aria-checked value. */
const checkbox = (checked: string | null) =>
  loc({ count: vi.fn(async () => 1), getAttribute: vi.fn(async () => checked) });

/** A grid of `n` tiles whose clicks are recorded by index. */
function grid(n: number, clicked: number[]) {
  const tiles = loc({ count: vi.fn(async () => n) });
  tiles.nth = vi.fn((i: number) =>
    loc({
      click: vi.fn(async () => {
        clicked.push(i);
      })
    })
  );
  return tiles;
}

afterEach(() => vi.unstubAllGlobals());

describe("detectChallenge", () => {
  it("detects reCAPTCHA v2 and hCaptcha widgets", async () => {
    expect(
      await detectChallenge(
        asPage(fakePage({ locators: { 'iframe[src*="recaptcha/api2/anchor"]': present() } }))
      )
    ).toBe("recaptcha_v2");
    expect(
      await detectChallenge(asPage(fakePage({ locators: { "hcaptcha.com": present() } })))
    ).toBe("hcaptcha");
  });

  it("reports nothing on a clean page", async () => {
    expect(await detectChallenge(asPage(fakePage()))).toBeNull();
  });

  it("treats an unreadable page as no challenge rather than failing a submit", async () => {
    const page = fakePage();
    page.locator = vi.fn(() => {
      throw new Error("page detached");
    });
    expect(await detectChallenge(asPage(page))).toBeNull();
  });
});

describe("solveChallenge dispatch", () => {
  it("does nothing for a null kind", async () => {
    const ask = vi.fn();
    expect(await solveChallenge(asPage(fakePage()), null, ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("reCAPTCHA v2", () => {
  /** Build a page whose anchor/bframe contents the test controls. */
  function recaptcha(opts: {
    anchorChecked?: (string | null)[];
    instruction?: string | null;
    tileCount?: number;
    clicked?: number[];
    shotThrows?: boolean;
    anchorClickThrows?: boolean;
  }) {
    const checkedStates = opts.anchorChecked ?? ["false"];
    let read = 0;
    const anchor = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async () => checkedStates[Math.min(read++, checkedStates.length - 1)]),
      click: vi.fn(async () => {
        if (opts.anchorClickThrows) throw new Error("no anchor");
      })
    });
    const payload = loc({
      screenshot: vi.fn(async () => {
        if (opts.shotThrows) throw new Error("cannot capture");
        return Buffer.from("grid");
      })
    });
    return fakePage({
      frames: {
        "recaptcha/api2/anchor": { "#recaptcha-anchor": anchor },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({
            textContent: vi.fn(async () => opts.instruction ?? null)
          }),
          "table td[role='button']": grid(opts.tileCount ?? 9, opts.clicked ?? []),
          ".rc-imageselect-payload": payload,
          "#recaptcha-reload-button": loc(),
          "#recaptcha-verify-button": loc()
        }
      }
    });
  }

  it("returns true on a passive pass, without ever asking the solver", async () => {
    const ask = vi.fn();
    const page = recaptcha({ anchorChecked: ["true"] });
    expect(await solveChallenge(asPage(page), "recaptcha_v2", ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("solves a 3x3 grid: asks the edge, clicks the picks, verifies", async () => {
    const clicked: number[] = [];
    // false at first, true once the grid is verified.
    const page = recaptcha({
      anchorChecked: ["false", "true"],
      instruction: "  Select all   crosswalks  ",
      tileCount: 9,
      clicked
    });
    const ask: AskSolver = vi.fn(async () => [0, 4, 8]);

    expect(await solveChallenge(asPage(page), "recaptcha_v2", ask)).toBe(true);

    // Instruction is whitespace-collapsed and the grid size is inferred.
    expect(ask).toHaveBeenCalledWith(
      Buffer.from("grid").toString("base64"),
      "Select all crosswalks",
      3,
      3
    );
    expect(clicked).toEqual([0, 4, 8]);
  });

  it("infers a 4x4 grid from a 16-tile challenge", async () => {
    const page = recaptcha({ anchorChecked: ["false", "true"], instruction: "buses", tileCount: 16 });
    const ask: AskSolver = vi.fn(async () => [1]);
    await solveChallenge(asPage(page), "recaptcha_v2", ask);
    expect(ask).toHaveBeenCalledWith(expect.any(String), "buses", 4, 4);
  });

  it("reloads for a different grid when nothing matched", async () => {
    const page = recaptcha({ anchorChecked: ["false"], instruction: "boats", tileCount: 9 });
    const ask: AskSolver = vi.fn(async () => []);

    expect(await solveChallenge(asPage(page), "recaptcha_v2", ask)).toBe(false);

    // Three rounds of "nothing matched", each asking for a fresh challenge.
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("keeps going when the reload button refuses to be clicked", async () => {
    const page = fakePage({
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => "false")
          })
        },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({ textContent: vi.fn(async () => "x") }),
          "table td[role='button']": loc({ count: vi.fn(async () => 9) }),
          ".rc-imageselect-payload": loc({ screenshot: vi.fn(async () => Buffer.from("g")) }),
          "#recaptcha-reload-button": loc({
            click: vi.fn(async () => {
              throw new Error("intercepted");
            })
          })
        }
      }
    });
    // Nothing matched every round, and even asking for a new grid fails.
    expect(await solveChallenge(asPage(page), "recaptcha_v2", vi.fn(async () => []))).toBe(false);
  });

  it("gives up when the checkbox cannot even be clicked", async () => {
    const ask = vi.fn();
    const page = recaptcha({ anchorClickThrows: true });
    expect(await solveChallenge(asPage(page), "recaptcha_v2", ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("stops when there is no instruction, no tiles, or no screenshot", async () => {
    const ask = vi.fn(async () => [0]);
    expect(
      await solveChallenge(asPage(recaptcha({ instruction: null })), "recaptcha_v2", ask)
    ).toBe(false);
    expect(
      await solveChallenge(
        asPage(recaptcha({ instruction: "x", tileCount: 0 })),
        "recaptcha_v2",
        ask
      )
    ).toBe(false);
    expect(
      await solveChallenge(
        asPage(recaptcha({ instruction: "x", shotThrows: true })),
        "recaptcha_v2",
        ask
      )
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("treats a checkbox read that throws as not solved", async () => {
    const page = fakePage({
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => {
              throw new Error("frame detached");
            })
          })
        },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({ textContent: vi.fn(async () => null) })
        }
      }
    });
    expect(await solveChallenge(asPage(page), "recaptcha_v2", vi.fn())).toBe(false);
  });

  it("treats an instruction read that throws as no challenge to solve", async () => {
    const page = fakePage({
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => "false")
          })
        },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({
            textContent: vi.fn(async () => {
              throw new Error("frame detached");
            })
          })
        }
      }
    });
    expect(await solveChallenge(asPage(page), "recaptcha_v2", vi.fn())).toBe(false);
  });

  it("treats an unreadable checkbox state as not solved", async () => {
    const page = recaptcha({ anchorChecked: [null], instruction: "x" });
    // getAttribute returning null means we cannot confirm a token was minted.
    expect(await solveChallenge(asPage(page), "recaptcha_v2", vi.fn(async () => []))).toBe(false);
  });

  it("survives a solver that throws", async () => {
    const page = recaptcha({ anchorChecked: ["false"], instruction: "x" });
    const ask: AskSolver = vi.fn(async () => {
      throw new Error("edge down");
    });
    expect(await solveChallenge(asPage(page), "recaptcha_v2", ask)).toBe(false);
  });

  it("keeps going when tile clicks, reload, and verify all reject", async () => {
    // Every interaction is best-effort: a widget that refuses clicks must end as
    // an honest "not solved", never as a thrown error out of the submit phase.
    const boom = () => Promise.reject(new Error("intercepted"));
    const tiles = loc({ count: vi.fn(async () => 9) });
    tiles.nth = vi.fn(() => loc({ click: vi.fn(boom) }));
    const page = fakePage({
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => "false")
          })
        },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({ textContent: vi.fn(async () => "x") }),
          "table td[role='button']": tiles,
          ".rc-imageselect-payload": loc({ screenshot: vi.fn(async () => Buffer.from("g")) }),
          "#recaptcha-reload-button": loc({ click: vi.fn(boom) }),
          "#recaptcha-verify-button": loc({ click: vi.fn(boom) })
        }
      }
    });

    expect(await solveChallenge(asPage(page), "recaptcha_v2", vi.fn(async () => [0]))).toBe(false);
  });

  it("treats an unreadable tile count as no grid", async () => {
    const tiles = loc({
      count: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const page = fakePage({
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => "false")
          })
        },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({ textContent: vi.fn(async () => "x") }),
          "table td[role='button']": tiles
        }
      }
    });
    expect(await solveChallenge(asPage(page), "recaptcha_v2", vi.fn(async () => [0]))).toBe(false);
  });

  it("stops at the time budget rather than grinding", async () => {
    const page = recaptcha({ anchorChecked: ["false"], instruction: "x" });
    const ask: AskSolver = vi.fn(async () => []);
    // First now() seeds the deadline; the next read is already past it.
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : CONFIG.challengeBudgetMs + 1);

    expect(await solveChallenge(asPage(page), "recaptcha_v2", ask, now)).toBe(false);

    expect(ask).not.toHaveBeenCalled();
  });
});

describe("hCaptcha", () => {
  function hcaptcha(opts: {
    checked?: string | null;
    instruction?: string | null;
    tileCount?: number;
    clicked?: number[];
    shotThrows?: boolean;
    checkboxClickThrows?: boolean;
    challengeGone?: boolean;
  }) {
    return fakePage({
      locators: {
        'iframe[src*="hcaptcha.com"][title*="challenge" i]': loc({
          count: vi.fn(async () => (opts.challengeGone ? 0 : 1))
        })
      },
      frames: {
        'hcaptcha.com"][title*="checkbox': {
          "#checkbox": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () =>
              opts.checked === undefined ? "false" : opts.checked
            ),
            click: vi.fn(async () => {
              if (opts.checkboxClickThrows) throw new Error("no checkbox");
            })
          })
        },
        'hcaptcha.com"][title*="challenge': {
          ".prompt-text": loc({ textContent: vi.fn(async () => opts.instruction ?? null) }),
          ".task-image": grid(opts.tileCount ?? 9, opts.clicked ?? []),
          body: loc({
            screenshot: vi.fn(async () => {
              if (opts.shotThrows) throw new Error("cannot capture");
              return Buffer.from("hgrid");
            })
          }),
          ".button-submit": loc()
        }
      }
    });
  }

  it("solves a grid and reports the checkbox verdict", async () => {
    const clicked: number[] = [];
    const page = hcaptcha({ checked: "true", instruction: " boats ", tileCount: 9, clicked });
    const ask: AskSolver = vi.fn(async () => [2, 5]);

    expect(await solveChallenge(asPage(page), "hcaptcha", ask)).toBe(true);

    expect(ask).toHaveBeenCalledWith(expect.any(String), "boats", 3, 3);
    expect(clicked).toEqual([2, 5, 2, 5]); // two rounds within the budget
  });

  it("uses a 2-column grid for a small challenge", async () => {
    const page = hcaptcha({ checked: "true", instruction: "x", tileCount: 4 });
    const ask: AskSolver = vi.fn(async () => []);
    await solveChallenge(asPage(page), "hcaptcha", ask);
    expect(ask).toHaveBeenCalledWith(expect.any(String), "x", 2, 2);
  });

  it("reports NOT solved on an explicit false, even if the popup closed", async () => {
    // The popup closing is not proof; an explicit false is.
    const page = hcaptcha({ checked: "false", instruction: "x", challengeGone: true });
    expect(await solveChallenge(asPage(page), "hcaptcha", vi.fn(async () => []))).toBe(false);
  });

  it("falls back to the popup-gone signal only when the state is unreadable", async () => {
    const gone = hcaptcha({ checked: null, instruction: "x", challengeGone: true });
    expect(await solveChallenge(asPage(gone), "hcaptcha", vi.fn(async () => []))).toBe(true);

    const stillThere = hcaptcha({ checked: null, instruction: "x", challengeGone: false });
    expect(await solveChallenge(asPage(stillThere), "hcaptcha", vi.fn(async () => []))).toBe(false);
  });

  it("gives up when the checkbox cannot be clicked", async () => {
    const page = hcaptcha({ checkboxClickThrows: true });
    expect(await solveChallenge(asPage(page), "hcaptcha", vi.fn())).toBe(false);
  });

  it("stops when there is no instruction, no tiles, or no screenshot", async () => {
    const ask = vi.fn(async () => [0]);
    expect(
      await solveChallenge(asPage(hcaptcha({ checked: "false", instruction: null })), "hcaptcha", ask)
    ).toBe(false);
    expect(
      await solveChallenge(
        asPage(hcaptcha({ checked: "false", instruction: "x", tileCount: 0 })),
        "hcaptcha",
        ask
      )
    ).toBe(false);
    expect(
      await solveChallenge(
        asPage(hcaptcha({ checked: "false", instruction: "x", shotThrows: true })),
        "hcaptcha",
        ask
      )
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("survives a solver that throws", async () => {
    const page = hcaptcha({ checked: "false", instruction: "x" });
    const ask: AskSolver = vi.fn(async () => {
      throw new Error("edge down");
    });
    expect(await solveChallenge(asPage(page), "hcaptcha", ask)).toBe(false);
  });

  it("stops at the time budget", async () => {
    const page = hcaptcha({ checked: "false", instruction: "x" });
    const ask = vi.fn(async () => []);
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : CONFIG.challengeBudgetMs + 1);
    await solveChallenge(asPage(page), "hcaptcha", ask, now);
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps going when tile clicks and submit reject, and the state is unreadable", async () => {
    const boom = () => Promise.reject(new Error("intercepted"));
    const tiles = loc({ count: vi.fn(async () => 9) });
    tiles.nth = vi.fn(() => loc({ click: vi.fn(boom) }));
    const page = fakePage({
      locators: {
        'iframe[src*="hcaptcha.com"][title*="challenge" i]': loc({
          count: vi.fn(async () => {
            throw new Error("detached");
          })
        })
      },
      frames: {
        'hcaptcha.com"][title*="checkbox': {
          "#checkbox": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => {
              throw new Error("gone");
            })
          })
        },
        'hcaptcha.com"][title*="challenge': {
          ".prompt-text": loc({ textContent: vi.fn(async () => "x") }),
          ".task-image": tiles,
          body: loc({ screenshot: vi.fn(async () => Buffer.from("g")) }),
          ".button-submit": loc({ click: vi.fn(boom) })
        }
      }
    });

    // Unreadable checkbox AND an unreadable popup count: not solved.
    expect(await solveChallenge(asPage(page), "hcaptcha", vi.fn(async () => [0]))).toBe(false);
  });

  it("treats an instruction read that throws as no challenge to solve", async () => {
    const page = hcaptcha({ checked: "false" });
    const original = page.frameLocator as ReturnType<typeof vi.fn>;
    page.frameLocator = vi.fn((sel: string) => {
      const frame = original(sel) as { locator: (s: string) => unknown };
      if (!sel.includes("challenge")) return frame;
      return {
        locator: vi.fn((s: string) =>
          s.includes("prompt-text")
            ? loc({
                textContent: vi.fn(async () => {
                  throw new Error("frame detached");
                })
              })
            : frame.locator(s)
        )
      };
    });

    expect(await solveChallenge(asPage(page), "hcaptcha", vi.fn())).toBe(false);
  });

  it("treats an unreadable tile count as no grid", async () => {
    const page = hcaptcha({ checked: "false", instruction: "x" });
    const tiles = loc({
      count: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const original = page.frameLocator as ReturnType<typeof vi.fn>;
    page.frameLocator = vi.fn((sel: string) => {
      const frame = original(sel);
      if (!sel.includes("challenge")) return frame;
      return {
        locator: vi.fn((s: string) =>
          s.includes("task-image") ? tiles : (frame as { locator: (s: string) => unknown }).locator(s)
        )
      };
    });

    expect(await solveChallenge(asPage(page), "hcaptcha", vi.fn(async () => [0]))).toBe(false);
  });
});

describe("httpSolver", () => {
  const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it("posts the grid to the configured endpoint with its own bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ tiles: [1, 5] }));
    vi.stubGlobal("fetch", fetchMock);

    const solver = httpSolver({ userId: "u1", runId: "r1" })!;
    expect(await solver("YmFzZTY0", "crosswalks", 3, 3)).toEqual([1, 5]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CONFIG.solverUrl);
    // Its OWN token, not the app-to-worker secret: this box may ask for tile
    // picks and nothing else.
    expect(init.headers.authorization).toBe(`Bearer ${CONFIG.solverToken}`);
    expect(JSON.parse(init.body)).toEqual({
      imageBase64: "YmFzZTY0",
      instruction: "crosswalks",
      rows: 3,
      cols: 3,
      userId: "u1",
      runId: "r1"
    });
  });

  it("omits attribution that was not supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ tiles: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await httpSolver()!("x", "y", 3, 3);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect("userId" in body).toBe(false);
    expect("runId" in body).toBe(false);
  });

  it("drops tile indices that fall outside the grid we asked about", async () => {
    // The indices come back to be clicked, so a bad one would throw in the loop.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ tiles: [0, 9, -1, "3", 8.5, 8] })));
    expect(await httpSolver()!("x", "y", 3, 3)).toEqual([0, 8]);
  });

  it("returns nothing on a non-2xx, a junk body, or a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    expect(await httpSolver()!("x", "y", 3, 3)).toEqual([]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ nope: true })));
    expect(await httpSolver()!("x", "y", 3, 3)).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("not json");
        }
      })
    );
    expect(await httpSolver()!("x", "y", 3, 3)).toEqual([]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("tunnel down")));
    expect(await httpSolver()!("x", "y", 3, 3)).toEqual([]);
  });

  it("is null when the callback is not configured", async () => {
    // An un-wired deployment simply never attempts a solve and reports blocked.
    vi.resetModules();
    vi.doMock("../src/config", async () => {
      const actual = await vi.importActual<typeof import("../src/config")>("../src/config");
      return { ...actual, CONFIG: { ...actual.CONFIG, solverUrl: "", solverToken: "" } };
    });
    const { httpSolver: build } = await import("../src/captcha");
    expect(build()).toBeNull();
    vi.doUnmock("../src/config");
    vi.resetModules();
  });
});
