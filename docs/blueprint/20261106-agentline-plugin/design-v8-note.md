I've written `design-v8-contract.md`. It only replaces or adds the sections needed for review-v7's three blocking items and four Minor items. I haven't touched product code. The GPT-6 Astra review has **not run yet**: the PowerShell tool couldn't parse the command, and running it through Bash needed your approval, which I don't have here. To start it, run:

```
node docs/blueprint/20261106-agentline-plugin/run-review-v8.mjs
```

It works the same way as the v7 run (codex exec, `gpt-6-astra`, read-only). The verdict goes to `review-v8.md` and the raw output to `review-v8.raw.txt`. The prompt is in `review-prompt-v8.md` and says this is the last round.

## The three blocking fixes

**B7-1 hidepid visibility (§1)**
- Whether enumeration can see every process now depends on the actual hidepid mode on `/proc`:
  - `off`: everything visible.
  - `invisible` or `noaccess`: the `gid=` group exemption is allowed, but only when the caller is in the initial user namespace.
  - `ptraceable`: always `unknown(enum_visibility)`, whatever the group membership, and even for root.
- The rule "ENOENT means the process exited" now only applies when visibility is proven.
- Drain source (f) uses the same rule.
- Counterexample: `ptraceable,gid=agl`, the caller is in `agl`, and M is hidden. v7 gave `proven_dead`; v8 gives `unknown(enum_visibility)`, and (f) is not 0. Covered by A1-14a/b.

**B7-2 time base (§2)**
- Every persisted process identity now records `boot_id`, `btime`, the native start value (Linux starttime ticks) and the absolute start time.
- Same boot: layers 1 and 2 compare ticks only, and layer 3 never releases.
- Different boot: layer 3 releases only if `btime > start_abs`.
- Any missing field gives `unknown`.
- Sources (h) and (i) are now tied to a boot as well.
- Acceptance: A1-15a/b show a same-boot case (including a forward clock jump) staying `unknown`; A1-15c shows `proven_dead` after a reboot.

**B7-3 corrupt input lock (§3)**
- The lock holder is now identified from the filename of the `t-*` file that shares the lock's inode, not from the lock's contents.
- If the contents are corrupt but the holder is alive, nothing is deleted.
- Takeover only happens once the holder is dead, and it re-checks the inode first, so a concurrent recovery can't delete a newly taken lock even if the inode number gets reused.
- If the holder can't be identified, the result is `E_INPUT_LOCK_CORRUPT` and the lock stays until a reboot. Lock directories are split by boot, so it clears itself after the reboot.
- Counterexample "lock corrupt, original holder still alive": A1-13g (rewritten).

## Minor items, kept to what was needed
- **Zero-count fixture:** a test-only cgroup (Linux) or Job (Windows) now limits the tested target's candidates. I also added a rule that the scanning process excludes only itself.
  - Without that rule, a `recover sweep` started from the user's shell would always be a candidate.
- **Input-lock boundary for current-core `run`/`flow`:** the lock key is now `(git common dir, taskId)`, which covers the first worktree creation, and the doc spells out signal handling with synchronous release.
- **State-correction timing:** at `stepend`, `inputs_consumed` is written before entries are reset to pending. A1-13h is split into a `stepend` variant and a `precall` variant.
- **Merge draft:** v8 items are added to the grep checklist.

## One new question for you (§6.2, U-W1)
Windows process creation times use wall-clock time. If the system clock is set back while a task is running, Windows layer 2 could miss a descendant process. This wasn't raised in review-v7 and I left it out of this round.
- **A (my recommendation):** treat "clock not set back" as a stated trust boundary, and detect lasting clock steps, which return `unknown`.
- **B:** make Windows layer 2 always `unknown`, like macOS. Recovering from a crash without a guard process would then always need a reboot.
