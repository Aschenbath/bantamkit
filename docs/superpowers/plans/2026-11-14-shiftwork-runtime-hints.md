# Shiftwork runtime hints (#324) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo every spawn goes through the shiftwork MCP tools (CLAUDE.md): one unit per task below, `shiftwork_clock_in` → spawn with the returned brief → `shiftwork_clock_out` with accounting.

**Goal:** `shiftwork_clock_in` returns `hints: {repair, review}` and `shiftwork_clock_out` accepts `accounting.path`, identically in `runtime-py` and `runtime-ts`, gated by conformance.

**Architecture:** A pure hint builder per runtime reads the validated checkpoint plus the committed clock-out lines of `<checkpoint>.log.jsonl` and returns two nullable objects. `clock_in` adds them to the brief. The `path` enum lives in the shared tool asset, so the existing accounting-shape check refuses a bad value in both runtimes with no new sentence.

**Tech Stack:** Python 3 (pytest), TypeScript/Node (node:test), `tools/conformance/run.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-14-shiftwork-runtime-hints-design.md` (frozen 2026-11-14; read §2–§5 before any task).

## Global Constraints

- No checkpoint schema change: `assets/schemas/shiftwork-checkpoint.json` is untouched; `version` stays 1.
- No new refusal sentence anywhere. `clock_in` still writes only its brief line.
- The runtime reads no repo files, runs no git, runs no fast check for hints.
- `hints` is always present on `result: brief`, as `{"repair": <obj|null>, "review": <obj|null>}`.
- Prose strings below are fixed English, byte-identical in both runtimes.
- Resume cap is 2 (`resume_allowed = thread is not None and resumes_so_far < 2`).
- `accounting.path` enum: `["patch", "fallback", "resume", "fresh"]`.
- Setup per CLAUDE.md: `.venv` from this tree, `cd runtime-ts && npm ci && npm run build` before any conformance run.

### Fixed strings (copy verbatim; Python constants in `shiftwork.py`, same names in camelCase in `shiftwork.ts`)

```
REPAIR_USE_WHEN  = "Every finding against this unit names one file, and that file is in owned."
REPAIR_CALL      = "One call with no tools. Send the unit's brief, the reviewer's findings verbatim, and the full current text of every owned path. It answers {\"files\": [{\"path\", \"content\"}]}."
REPAIR_WRITE     = "Write only owned paths. A path that is a symlink, or that resolves outside the workspace, makes the answer invalid. Then run fast_check."
REPAIR_FALLBACK  = "If the answer is invalid or fast_check fails, run exactly one ordinary repair with tools, then clock out with accounting.path = fallback."
REPAIR_SKIP_WHEN = "The repair would continue a session that already holds this work in its cache (the parent session authored it). There the fresh patch call cost more uncached input + output in #310."
REPAIR_LOG       = "Clock out with accounting.path = patch when the patch answer was written and fast_check passed."
REVIEW_TURN      = "Resume thread with a delta turn only: a new reviewer context id, every member's revision, fast check and changed flag, and the full current text of every path of a changed member. changed is a superset: a member flagged changed may be identical, and the host may compare content to send less. Acceptance still binds every member and criterion to the current revision."
REVIEW_FRESH_WHEN= "resume_allowed is false, the thread cannot be resumed, or the resumed answer is invalid: run one fresh full review and clock out with accounting.path = fresh."
REVIEW_LOG       = "Clock out with accounting.path = resume when the resumed answer was used, and pass the thread as clock_out's agent_id argument again."
RESUME_CAP = 2
```

## Review Focus

1. **Ledger missing or unreadable** (best-effort log): hints must degrade to `review: null` / `thread: null`, never raise. Test in Task 1 and Task 3.
2. **A cancelled (`uncommitted`) reviewer line**: hint computed from the line before it (spec case 8). Test in Task 1, conformance in Task 4.
3. **A reviewer line written with `accounting: null`** still counts as a clock-out (has reviewed before; thread from its `agent_id`). Test in Task 1.
4. **A reviewed member that never clocked out** (no ledger line): `changed: true`. Test in Task 1.
5. **A non-implementer under a rejecting reviewer** (e.g. a planner unit): `repair: null`. Test in Task 1.

---

### Task 1: Python hint builder and brief wiring

**Files:**
- Modify: `runtime-py/src/bantamkit/shiftwork.py` (new helpers beside `_upstream` ~line 849; `clock_in` return dict ~line 961)
- Test: `runtime-py/tests/test_shiftwork.py`

**Interfaces:**
- Produces: `_clock_out_lines(log_path: Path) -> list[dict]` — every ledger line with no `event` key, in file order, minus any line an `uncommitted` event cancels (the `_briefed` rule, factored out; `_briefed` itself is left as is). Unreadable/missing ledger → `[]`.
- Produces: `_hints(document: dict, unit: dict, lines: list[dict]) -> dict` returning `{"repair": ..., "review": ...}` per spec §3–§4, key order as in the spec.
- `clock_in` adds `"hints": _hints(document, unit, _clock_out_lines(_log_path(Path(checkpoint))))` after `"agreements"`, computed before `_record_brief` so the brief's own line is irrelevant.

Rules to implement (spec §2):
- rejecting reviewer of U: unit R with `U.id in R.reviews` and `R.attempts[-1].status not in {"done","dropped"}` (attempts non-empty).
- repair hint iff `unit.role == "implementer"`, some rejecting reviewer exists, and `unit.touches` non-empty. Object: `lever "patch"`, `owned = touches`, `fast_check = verify`, then `use_when, call, write, fallback, skip_when, log`.
- review hint iff `unit.reviews` non-empty and `lines` has ≥1 line with `unit == unit.id`. `last = index of R's newest line`; `thread = lines[last].get("agent_id")`; `resumes_so_far` = count of R's lines newest-first with `path == "resume"`, stopping at first that is not; members in `reviews` order with `changed = not any(i < last for M's indices) or any(i > last for M's indices)`, `revision` = `ref` of the newest `produced` item of kind `commit` in the member's newest attempt else `None`, `fast_check = verify`, `paths = touches or []`. Object order: `lever "resume", thread, resumes_so_far, resume_allowed, members, turn, fresh_when, log`.

- [ ] **Step 1: Write failing tests** (one per bullet; build documents with the file's existing helpers, plant ledger lines by writing `checkpoint.json.log.jsonl` directly):
  - `test_324_hints_absent_without_reviewers` → `brief["hints"] == {"repair": None, "review": None}`
  - `test_324_repair_hint_under_blocked_reviewer` → implementer `A2` touches `["src/a.py","src/b.py"]`, reviewer `R` reviews `["A2"]` with attempts `[{"status":"blocked","outcome":"rejected"}]` → `hints["repair"]["owned"] == ["src/a.py","src/b.py"]`, `["fast_check"] == A2.verify`, `["use_when"] == REPAIR_USE_WHEN`
  - `test_324_no_repair_hint_without_touches_or_after_approval` → `None` for no touches; `None` when R's newest attempt is `done`; `None` for a planner-role unit under a blocked reviewer
  - `test_324_review_hint_null_on_first_review` → no ledger line for R → `review is None`
  - `test_324_review_hint_thread_and_changed` → ledger: `A` line, `R` line with `agent_id "t1"`, then `A` line again; `C` line before R only → `thread == "t1"`, `resumes_so_far == 0`, `resume_allowed is True`, members `A changed True`, `C changed False`
  - `test_324_resume_cap_and_reset` → R lines `path resume`, `path resume` → `resumes_so_far == 2`, `resume_allowed is False`; with a `path fresh` line between → `1`
  - `test_324_review_hint_no_agent_id` → R line without `agent_id` (also `accounting` null) → `thread is None`, `resume_allowed is False`, hint not None
  - `test_324_uncommitted_cancels_reviewer_line` → R line `agent_id "t2"` followed by `{"event":"uncommitted",...}` after an earlier R line `agent_id "t1"` → `thread == "t1"`
  - `test_324_member_without_ledger_line_is_changed` → `changed is True`
  - `test_324_unreadable_ledger_degrades` → ledger path is a directory → brief issued, `review is None`
  - `test_324_revision_from_commit_produced` → member newest attempt `produced [{"kind":"commit","ref":"abc"}]` → `revision == "abc"`; otherwise `None`

- [ ] **Step 2: Run** `.venv/bin/python -m pytest runtime-py/tests/test_shiftwork.py -q -k 324` — expect FAIL (`KeyError: 'hints'`).
- [ ] **Step 3: Implement** the constants, `_clock_out_lines`, `_hints`, and the `clock_in` key.
- [ ] **Step 4: Run** the `-k 324` tests, then the full `runtime-py/tests -q` and `.venv/bin/ruff check runtime-py tools` — all green.
- [ ] **Step 5: Commit** `feat(shiftwork): clock_in carries patch-repair and reviewer-resume hints (#324, py)`

### Task 2: Tool assets — `hints` output and `accounting.path`

**Files:**
- Modify: `assets/tools/shiftwork_clock_in.json` (`output_schema.properties.hints`, `description` gains one sentence naming `hints`)
- Modify: `assets/tools/shiftwork_clock_out.json` (`accounting.anyOf[0].properties.path`, per spec §5; `description` gains one sentence)
- Test: `runtime-py/tests/test_shiftwork.py`

**Interfaces:**
- Produces: `path` enum `["patch","fallback","resume","fresh"]`, refused through the existing `_accounting_refusal` sentence.

- [ ] **Step 1: Failing tests:** `test_324_accounting_path_enum_refused` → `clock_out(..., accounting={"tokens":1,"duration_ms":1,"path":"patched"})` returns `result == "error"`, reason starts with `"unit N1 in role implementer reported an accounting line the schema refuses: "`, checkpoint bytes and ledger unchanged; `test_324_accounting_path_written_verbatim` → `path: "patch"` accepted and the ledger line has `"path": "patch"`.
- [ ] **Step 2: Run** — first test FAILS (value passes through today).
- [ ] **Step 3: Edit both assets.** Any asset-derived snapshot the repo pins (check `git grep -l shiftwork_clock_out.json runtime-*/tests tools`) is regenerated in this task.
- [ ] **Step 4: Run** full py suite + ruff — green.
- [ ] **Step 5: Commit** `feat(shiftwork): accounting.path names the #310 path a unit ran (#324)`

### Task 3: Node port

**Files:**
- Modify: `runtime-ts/src/shiftwork.ts` (helpers beside `upstreamOf` ~line 872; `clockIn` brief ~line 1002+)
- Test: `runtime-ts/test/shiftwork.test.mjs`

**Interfaces:**
- Consumes: Task 1's rules and constants; Task 2's asset.
- Produces: `clockOutLines(log: string): PyDict[]`, `hints(doc: PyDict, unit: PyDict, lines: PyDict[]): PyDict`; `clockIn` brief gains `hints` in the same position as Python.

- [ ] **Step 1: Failing tests** mirroring Task 1's eleven and Task 2's two, named `#324: …`.
- [ ] **Step 2: Run** `cd runtime-ts && npm run build && node --test test/shiftwork.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full TS test suite — green.
- [ ] **Step 5: Commit** `feat(shiftwork): port #324 hints to runtime-ts`

### Task 4: Conformance cases

**Files:**
- Modify: `tools/conformance/suites/shiftwork.mjs` (new sessions after the `#309` block; a `hintsDocument(...)` builder beside `droppedReviewDocument`, ledger lines via the existing `LEDGER(...)` and checkpoint swaps via `plant`)
- Modify: `tools/conformance/ref/shiftwork_ref.py` only if a call shape needs it (expected: none)

**Interfaces:**
- Consumes: Tasks 1–3.

- [ ] **Step 1: Add sessions covering the spec's ten cases** (split into 13), named `hints/none`, `hints/repair`, `hints/no-repair-no-touches`, `hints/no-repair-approved`, `hints/review-first`, `hints/review-thread-changed`, `hints/resume-cap`, `hints/resume-reset`, `hints/no-thread`, `hints/uncommitted`, `hints/path-refused`, `hints/path-written`, `hints/member-added`. Each is `[plant ledger?, IN(<unit>)]` or an `OUT` with accounting for the path cases.
- [ ] **Step 2: Run** `node tools/conformance/run.mjs --suite shiftwork` — all PASS.
- [ ] **Step 3: Prove red.** On a scratch copy (never the tree a live unit holds), mutate the Node side once per rule: drop the cap check, flip `changed`'s `<`, skip the uncommitted filter, remove the enum. Each mutation must turn at least one `hints/*` case red; record which in the commit body. Revert.
- [ ] **Step 4: Run** `node tools/conformance/run.mjs --all` — PASS, 0 failures; record the case count.
- [ ] **Step 5: Commit** `test(conformance): #324 hints and accounting.path, both runtimes`

### Task 5: Docs

**Files:**
- Modify: `docs/shiftwork.md` (the *Host practices measured in the #310 follow-ons* section; the brief-fields list near `upstream`/`prior_attempts`; the accounting section)

- [ ] **Step 1:** Say the runtime now carries both hints (link the spec), document `hints` fields and `accounting.path`, and add the measurement recipe:
  `jq -s 'map(select(.path)) | group_by(.path) | map({path: .[0].path, n: length, tokens: (map(.tokens // 0) | add)})' .shiftwork/checkpoint.json.log.jsonl`
- [ ] **Step 2: Run** the recipe against a ledger from Task 4's scratch session and confirm it prints one row per path.
- [ ] **Step 3: Commit** `docs(shiftwork): the runtime now carries the #310 hints (#324)`
