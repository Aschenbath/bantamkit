# Shiftwork carries the #310 repair and re-review hints (design, #324)

Status: **frozen**, 2026-11-14 (owner approved). Issue:
[#324](https://github.com/Ink01101011/bantamkit/issues/324), milestone 0.40.0.
The owner made two picks on 2026-11-14:
- Approach A: advisory hints, with no change to the checkpoint schema.
- A1: the review hint's `changed` follows ledger order, and the runtime reads no
  files.

## Why

#310 measured two host practices that cut tokens and held every quality gate
(see `docs/shiftwork.md`, *Host practices measured in the #310 follow-ons*):

- **Patch repair.** A delegated one-file finding is repaired by one tools-free
  call answering `{"files": [{"path", "content"}]}`. The host writes it and runs
  the fast check. Repair uncached input + output fell 45%.
- **Reviewer thread resume (RR).** A re-review resumes the same reviewer's own
  thread with a delta turn. Re-review uncached input + output fell 52–67%.

Both live only in `docs/shiftwork.md`, which is not in the npm package. A host
that drives Shiftwork through the MCP tools alone never learns either exists. The
goal is that `shiftwork_clock_in` tells the host, at the moment it matters, that a
lever applies and hands it the data the lever needs, and that `shiftwork_clock_out`
records which path ran, so the saving can be measured from real use.

## Goals

1. A repair unit's brief says when patch mode applies, and carries the contract
   for the call, the write and the one fallback.
2. A re-review brief carries what a resume needs: the reviewer's previous thread
   id, how many times that thread was already resumed, and the delta since the
   thread last looked (per member: changed flag, revision, fast check, and the
   paths that changed).
3. The accounting line can say which path ran: `patch`, `fallback`, `resume` or
   `fresh`.
4. Both runtimes, same output byte for byte, gated by conformance cases.

## Non-goals

- The runtime does not enforce either lever. It refuses nothing new on the
  levers' account: a host that ignores a hint, resumes a third time, or patches a
  two-file unit is not stopped. (Approach B, rejected below.)
- The runtime does not read file contents, run git, or run the fast check. Hints
  carry paths and commands; the host reads and runs.
- Batched author, author-thread resume for repair, Codex home stabilisation (the
  issue's out-of-scope list).
- No checkpoint schema change. `version` stays 1, and every existing checkpoint
  validates and briefs exactly as before apart from the new `hints` key.

## Anti-goals

- **A hint that claims a saving the host's setup cannot get.** The #310 numbers
  are from Codex grouped review only, n = 2 per mode, never from a Claude Code
  host. Hint text states the conditions and never a percentage.
- **A hint that is wrong about the graph.** If the runtime cannot establish a
  condition from the checkpoint and the ledger, the hint is `null`, not a guess.
- **Two runtimes that disagree on whether a hint is present.** Every
  eligibility rule below is computed from the checkpoint and the ledger only, so
  both sides can compute it identically.

## Constraints

- CLAUDE.md: a feature lands in both `runtime-py/` and `runtime-ts/` in the same
  job, with conformance cases in `node tools/conformance/run.mjs --suite shiftwork`.
- The ledger is best effort (`_record_event` swallows `OSError`). A hint that
  depends on the ledger must degrade to the safe answer when a line is missing:
  no thread id means no resume hint, never a resume hint with a guessed id.
- `uncommitted` ledger lines (job65/#162) cancel the accounting line before them.
  Every ledger read here reuses the same rule `_briefed` uses.
- `clock_in` still writes nothing but its brief line.

## Approaches

- **A. Advisory hints in the brief (picked).** `clock_in` adds `hints`, computed
  from data the runtime already has: the graph (`reviews`, `depends_on`,
  `touches`, `verify`, `attempts`) and the ledger (`agent_id` from #266, and the
  new `path` key). `clock_out` accepts `accounting.path`. No checkpoint field.
  Trade-off: a host can overrun the resume cap and nothing stops it, but the
  ledger shows that it did.
- **B. Enforce.** `clock_out` refuses a third resume or a resume after an
  invalid answer. Rejected: new refusal sentences in both runtimes, plus the
  CLAUDE.md cost of proving each refusal, to guard a saving measured at n = 2 on
  another host. Can be revisited once `path` data from real use exists.
- **C. Checkpoint field** (`plan.units[].resume` holding thread id and seen
  revisions). Rejected: a closed object grows a field, old readers refuse every
  checkpoint that carries it, and the ledger already holds the same facts.

## Design

### 1. The brief gains `hints`

`clock_in`'s `result: brief` payload gains one key, always present:

```json
"hints": {"repair": null, "review": null}
```

Each member is `null` or an object, described below. Key order and value order
are fixed so the two runtimes serialise identically. The tool asset
`assets/tools/shiftwork_clock_in.json` documents `hints` in `output_schema` and
in its `description`.

### 2. Definitions the hints share

All read the checkpoint as `clock_in` validated it, and the ledger
`<checkpoint>.log.jsonl` through the existing `_ledger` reader, skipping any
accounting line an `uncommitted` line cancels.

- **Reviewer of U.** A unit R with U in `R.reviews`.
- **Rejecting review.** A reviewer R whose newest attempt has `status` other
  than `done` and `dropped`. (`done` is the only approval, per #309.) In the
  measured flow the reviewer clocks out `blocked` on a rejection, and the planner
  then sets R back to `todo` and adds repair units. A reviewer that clocked out
  `blocked` because its call failed also counts as rejecting. Because the hint
  is advisory, that only offers a patch hint the host's findings will not
  support, and the host then skips it. (Builder check, item 4: my call.)
- **Repair unit.** A unit U with role `implementer` that has a reviewer R
  which is rejecting at the moment U is briefed. This covers both shapes a
  planner uses: a new repair unit added to `R.reviews` (the #310 harness), and
  the original unit reworked under the same reviewer (U clocked out `todo`).
- **Clock-out line.** Any ledger line with no `event` key that an `uncommitted`
  line does not cancel. This is `_briefed`'s rule. A line written with
  `accounting: null` counts, and so does a line clocked out `in_progress`. The
  cancellation walk is a new shared helper in each runtime, because `_briefed`
  inlines it for one unit. (Builder check, item 6: my call.)
- **Reviewer's thread.** The top-level `agent_id` on R's newest clock-out line.
  `agent_id` is a `clock_out` argument the runtime writes beside the accounting
  keys, and it is not itself an accounting key. If it is absent, or there is no
  such line, there is no thread. A host whose thread id does not fit the
  `agent_id` pattern (1–64 letters, digits, `-`, `_`) cannot record it, and so
  it gets `resume_allowed: false`.
- **Consecutive resumes of R.** Walk R's clock-out lines newest first. Count
  the lines with `accounting.path == "resume"`. Stop at the first line whose
  `path` is anything else or is absent. A failed resume is still a resume
  attempt: it is logged `path: resume`, usually at `in_progress`, and it
  counts. The fresh review that follows it is logged `fresh`, which resets the
  count. This matches the measured "at most twice per thread". (Builder check,
  item 3: my call.)

### 3. `hints.repair`

Present when, and only when, all hold:

1. the briefed unit is a **repair unit** (above);
2. it has a non-empty `touches`. The patch write rule needs an owned-path
   list, so a unit with no `touches` gets no hint.

The measured contract sends the full text of **every** owned file, and the
#310 harness gave each repair unit the base unit's whole file list. The
one-file condition is on the **finding**, not on the unit, and only the host can
read the findings. So the hint names the condition in `use_when`, and the
runtime does not narrow it with a `touches` count. A one-`touches` proxy was
considered and dropped, because it would hide the hint in the very case that
was measured. (Builder check, item 5: my call.)

Shape:

```json
{
  "lever": "patch",
  "owned": ["src/a.py"],
  "fast_check": "<unit.verify>",
  "use_when": "Every finding against this unit names one file, and that file is in owned.",
  "call": "One call with no tools. Send the unit's brief, the reviewer's findings verbatim, and the full current text of every owned path. It answers {\"files\": [{\"path\", \"content\"}]}.",
  "write": "Write only owned paths. A path that is a symlink, or that resolves outside the workspace, makes the answer invalid. Then run fast_check.",
  "fallback": "If the answer is invalid or fast_check fails, run exactly one ordinary repair with tools, then clock out with accounting.path = fallback.",
  "skip_when": "The repair would continue a session that already holds this work in its cache (the parent session authored it). There the fresh patch call cost more uncached input + output in #310.",
  "log": "Clock out with accounting.path = patch when the patch answer was written and fast_check passed."
}
```

The prose fields are fixed English sentences, identical in both runtimes,
pinned by the conformance case. `skip_when` is advisory because the runtime cannot
see the host's execution mode.

### 4. `hints.review`

Present when the briefed unit has `reviews` and at least one committed
accounting line of its own in the ledger (it has reviewed before, so this is a
re-review). Otherwise `null`.

```json
{
  "lever": "resume",
  "thread": "a1b2c3",
  "resumes_so_far": 1,
  "resume_allowed": true,
  "members": [
    {"unit": "A2-r1", "changed": true, "revision": "3f9c…", "fast_check": "python checks/check_A.py", "paths": ["src/a.py"]},
    {"unit": "C",     "changed": false, "revision": null,   "fast_check": "python checks/check_C.py", "paths": ["src/c.py"]}
  ],
  "turn": "Resume thread with a delta turn only: a new reviewer context id, every member's revision, fast check and changed flag, and the full current text of every path of a changed member. changed is a superset: a member flagged changed may be identical, and the host may compare content to send less. Acceptance still binds every member and criterion to the current revision.",
  "fresh_when": "resume_allowed is false, the thread cannot be resumed, or the resumed answer is invalid: run one fresh full review and clock out with accounting.path = fresh.",
  "log": "Clock out with accounting.path = resume when the resumed answer was used, and pass the thread as clock_out's agent_id argument again."
}
```

- `thread`: the reviewer's thread (§2), or `null`.
- `resumes_so_far`: consecutive resumes of R (§2).
- `resume_allowed`: `thread != null` and `resumes_so_far < 2`. The cap of 2 is
  the measured setup's. It is advice: nothing refuses a third.
- `members`: one per `reviews` id, in `reviews` order.
  - `changed`: the member has a committed accounting line **after** R's newest
    committed accounting line in ledger order, or the member was added to
    `R.reviews` after it (it has no line before R's). A member with no ledger
    line at all is `changed: true`, because the runtime cannot show it is
    unchanged.
    **This is a superset (owner ruling 2026-11-14, A1).** A member that clocked
    out again with identical content is still `changed: true`. The runtime
    reads no files to rule that out, so the host may resend a member that did
    not really change, which costs some of the saving but never weakens the
    review. #310's harness compared content snapshots instead. A runtime-side
    content hash (A2) was considered and rejected: it would make both runtimes
    read files, with CRLF, symlink and missing-file cases on every OS. Upstream
    context files that changed under an unchanged member are not tracked. The
    host adds them if its review needs them.
  - `revision`: the `ref` of the newest `produced` item of kind `commit` in the
    member's newest attempt, else `null`. The runtime runs no git. In the
    measured flow, units rarely report a commit, so expect `null` most of the
    time. When it is `null`, the host computes its own revision (for example, a
    content hash) if it wants one.
  - `fast_check`: the member's `verify`.
  - `paths`: the member's `touches`, or `[]`.

When `thread` is `null`, the hint is still present with `resume_allowed: false`:
the delta (which members changed) is useful to a fresh review too.

### 5. `accounting.path`

`assets/tools/shiftwork_clock_out.json` adds an optional named key to the
accounting object:

```json
"path": {"type": "string", "enum": ["patch", "fallback", "resume", "fresh"],
         "description": "Which #310 path this unit ran, when it followed a hint: ..."}
```

A value outside the enum is refused by the **existing** accounting-shape check
(`unit <id> in role <role> reported an accounting line the schema refuses: …`),
so no new sentence is added. This is a log-shape check, not lever enforcement:
the measurement is worthless if the key is spelled four ways (the J50-7 lesson).
Absent `path` means the host did not say, and is treated as "not resume" when
counting consecutive resumes.

`fresh` is also the right value for a first review the host deliberately made
resumable, so the next re-review's count starts at 0.

### 6. Measurement

No new tool. The ledger now holds `path`, `tokens`, `cache_read_tokens` and
`role` per line, so cost by path is one group-by. `docs/shiftwork.md` gains the
recipe (a `jq` one-liner). A status or ledger aggregate can follow once there is
data worth aggregating.

### 7. Docs

- `docs/shiftwork.md`: the *Host practices measured in the #310 follow-ons*
  section says the runtime now carries both hints, links this spec, and
  documents `hints` under the brief fields and `path` under accounting.
- The two tool assets carry the field descriptions (they ship in the package,
  which is the point of the issue).

## Conformance cases (suite `shiftwork`)

Each runs on both sides and compares the full brief or refusal. Each must be
shown red against a mutation before it counts (the project's prove-it-red rule).

1. No reviewer anywhere: `hints` is `{"repair": null, "review": null}`.
2. Repair hint present: an implementer with two `touches` (both are listed in
   `owned`) under a reviewer whose newest attempt is `blocked`.
3. No repair hint: the same unit with no `touches`. Also no hint when the
   reviewer's newest attempt is `done`.
4. Review hint, first review: reviewer with no ledger line gets `review: null`.
5. Review hint, re-review with `agent_id` on its last line: `thread` set,
   `resumes_so_far` 0, `resume_allowed` true, changed flags right for one
   changed and one unchanged member.
6. Resume cap: two consecutive `path: resume` lines give `resumes_so_far` 2,
   `resume_allowed` false; a `fresh` line in between resets the count.
7. No thread: last line has no `agent_id`: `thread` null, `resume_allowed` false.
8. `uncommitted` line cancels the reviewer's newest accounting line: hint is
   computed from the line before it.
9. `accounting.path: "patched"` is refused with the shape sentence, nothing
   written; `path: "patch"` is accepted and written verbatim.
10. A member added to `reviews` after the reviewer's last line is `changed: true`.

## Left to the builder

- Function names and where in each runtime the hint builder lives (a helper
  beside `_upstream` is the natural spot).
- The exact wording of the `description` strings in the tool assets, within the
  facts above.
- Unit tests per runtime beyond the conformance cases.
- The `jq` recipe in the docs.

## Calls made in this draft (owner to check)

- Repair eligibility does not check the one-file condition, because the runtime
  cannot see the findings. The hint states the condition in `use_when` instead.
- "Repair unit" means an implementer reviewed by a reviewer that is currently
  rejecting it. A reviewer whose call failed counts as rejecting.
- Clock-out lines with null accounting and `in_progress` lines both count. A
  failed resume counts toward the cap of 2.
- An out-of-enum `accounting.path` is refused by the existing shape check.
- `hints` is always present, with `null` members, like `upstream` and
  `agreements`.
