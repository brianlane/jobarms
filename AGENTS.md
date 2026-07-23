# Agent rules for this repository

- **Never use the em dash character (U+2014), in any context.** Not in code,
  comments, docs, commit messages, UI copy, or generated text. Use a comma,
  colon, period, or plain hyphen instead. CI fails the build if one appears
  anywhere in a tracked file (see the "No em dashes" step in
  `.github/workflows/ci.yml`). Product-side Gemini prompts carry the same
  instruction so model output stays clean at the source.
- Work flow: branch, PR, babysit CI to green, merge (see README).
- `.env` holds live secrets and is never committed. `.env.example` documents
  the shape.
- The full phased build plan and open items live in `todo.md`.
