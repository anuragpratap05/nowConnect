# Q4 — Code reviews & mentoring without becoming a bottleneck

> **Category:** Values, Leadership & Culture / Collaboration
>
> **Question:** *How do you approach code reviews and mentoring junior engineers
> to improve overall team quality without becoming a bottleneck?*

**Answer shape:** This is a **philosophy / "how do you approach" question**, not a
"tell me about a time." So the answer is a **framework with concrete practices**,
not a single STAR story. Lead with a one-line thesis, give the system, then make
it concrete.

**devTinder honesty note:** devTinder is mostly a solo project, so I don't claim a
big team here. Where I reference it, it's as *where I practice these habits on
myself* — ESLint, a code-review pass, and a living `ISSUES.md` / `docs/` so
standards live in the repo, not in my head. That repo-as-source-of-truth is
exactly the surface I'd mentor a junior against. Keep devTinder as a light
illustration; the answer itself is the framework.

---

## The thesis (open with this)

> "My goal in a review isn't to personally catch every bug — it's to make the
> team need me *less* over time. I optimize for **raising the floor, not being
> the ceiling**. The moment I'm the single gate everything waits on, I've made
> quality *and* velocity worse."

That one line answers the whole question: quality through *the system and the
people*, not through me being a human gate.

---

## The framework — three layers that keep me off the critical path

**Layer 1 — Automate everything a human shouldn't be reviewing.**
- Linting + formatting (ESLint/Prettier), type checks, tests, and CI gates catch
  style, formatting, and obvious breakage *before* a human looks.
- Rule: **no human ever leaves a comment about formatting or style.** If we're
  arguing about it, it belongs in a config, not a review thread.
- This reserves scarce human attention for what machines can't judge: design,
  logic, edge cases, security, naming, and "is this the right thing to build."

**Layer 2 — Push quality *left*, before the PR exists.**
- **Small PRs.** A 100-line PR gets a real review in 10 minutes; a 2,000-line PR
  gets a rubber stamp. Small diffs are the single biggest anti-bottleneck lever.
- **Align on design before the code.** 10 minutes agreeing on an approach up
  front saves three review round-trips later — especially with juniors.
- **A PR template / checklist** (what changed, how tested, screenshots) so the
  author does the first review pass themselves.

**Layer 3 — Distribute review authority; don't hoard it.**
- I am deliberately **not the single required approver.** I grow other reviewers,
  rotate review duty, and let mid-levels approve while I spot-check.
- A reviewer with a bus-factor of one *is* the bottleneck. The health check:
  **if the team stalls when I'm on leave, I've failed at this.**

---

## How I actually review (the craft)

- **Review promptly and timebox it.** A fast "good enough" review today beats a
  perfect one in two days. Latency on review is a velocity tax people forget to
  measure.
- **Separate blocking from non-blocking.** I label comments: `must-fix`,
  `nit:`, `optional:`, `question:`. I never hold a PR hostage over a preference.
- **Explain the *why*, link a principle.** "Change this" teaches nothing;
  "this re-queries inside the loop — here's the N+1 pattern and the fix" teaches
  a lesson they'll apply next time without me.
- **Ask questions instead of dictating.** "What happens if this user has zero
  connections?" grows their judgment better than me just writing the fix.
- **Praise the good parts too.** Reviews that are only criticism train people to
  fear reviews and hide work.
- **Approve-with-comments for low-risk changes** instead of another round-trip —
  trust + a nudge scales; gatekeeping doesn't.

---

## Mentoring juniors specifically

- **Stretch, with a safety net.** Give them problems slightly above their current
  level plus support — not just grunt work. Growth happens at the edge.
- **Pair on the first instance of a pattern, then let them run solo.** Teach the
  pattern once; don't re-explain it in five separate PRs.
- **Make review a two-way teaching tool.** I explain the why; I also ask about
  their context, because they often know the feature better than I do.
- **Measure success by their growing independence.** Fewer review cycles per PR
  over time = the mentoring is working. The goal is to make myself unnecessary on
  the things I've already taught, so I can move to teaching the next thing.

---

## Spoken answer (~90 seconds)

> "My core belief is that a reviewer's job isn't to personally catch every bug —
> it's to make the team need you less over time. I try to raise the floor, not be
> the ceiling. If I'm the single gate everything waits on, I've hurt both quality
> and speed.
>
> So I keep myself off the critical path in three ways. First, automate anything a
> human shouldn't review — lint, formatting, tests, CI. Nobody should ever leave a
> comment about style; that belongs in a config. That frees human review for the
> things machines can't judge: design, logic, edge cases, security.
>
> Second, I push quality left — before the PR. Small PRs are the biggest lever; a
> hundred-line diff gets a real review, a two-thousand-line one gets a rubber
> stamp. And ten minutes aligning on the approach up front, especially with a
> junior, saves three review round-trips later.
>
> Third, I deliberately don't make myself the only approver — I grow other
> reviewers and spot-check, because a reviewer with a bus-factor of one *is* the
> bottleneck. My health check is: if the team stalls when I'm on leave, I've
> failed.
>
> On mentoring specifically, in reviews I always explain the *why* and ask
> questions rather than dictate — 'what happens if this user has zero
> connections?' teaches judgment that sticks. I pair on the first instance of a
> pattern, then let them run. And I measure success by their growing
> independence — fewer review cycles over time means it's working."

## 60-second version (tight)

> "A reviewer's job isn't to catch every bug personally — it's to make the team
> need you less over time. Raise the floor, don't be the ceiling.
>
> I stay off the critical path three ways. One: automate what humans shouldn't
> review — lint, format, tests, CI — so nobody comments on style and human review
> is saved for design, logic, and edge cases. Two: push quality left — small PRs
> and a quick design alignment up front, which kills most review round-trips
> before they happen. Three: I'm never the single required approver — I grow other
> reviewers and spot-check, because a bus-factor-of-one reviewer *is* the
> bottleneck.
>
> When I review, I explain the *why* and ask questions instead of dictating, so
> juniors build judgment that carries to the next PR. I measure mentoring by their
> growing independence — fewer cycles per PR over time. The test I hold myself to:
> if the team stalls when I'm out, I've done it wrong."

*(~150 words ≈ 55–60 seconds.)*

---

## Why this answer works (the signals being tested)

1. **It directly resolves the trap — "without becoming a bottleneck."** Weak
   answers describe thorough reviewing and accidentally describe *being* the
   bottleneck. This answer names the anti-bottleneck mechanisms explicitly:
   automation, small PRs, distributed approval, timeboxing.
2. **Quality through the system, not heroics.** Senior signal: you scale yourself
   via standards and people, not by reviewing harder.
3. **Mentoring = growing independence, not fixing code.** The "measure success by
   fewer review cycles over time" line shows you understand mentoring's actual
   goal.
4. **Concrete, not platitudes.** `nit:` labels, small-PR reasoning, "comment the
   why," "bus-factor of one" — specifics prove you've actually done it.
5. **A memorable test to close on:** *"if the team stalls when I'm on leave, I've
   failed."* Give the interviewer one crisp line to remember you by.

### Delivery tips
- Open with the **thesis line** and let it frame everything.
- Use the **"raise the floor, not be the ceiling"** phrasing — it's sticky.
- If time is short, drop the mentoring section detail but *keep* the three
  anti-bottleneck layers — that's what the question is actually asking.

---

## Follow-up probes (be ready for these)

**Q: What if a junior keeps making the same mistake after you've flagged it?**
> Move it out of review: pair on it once properly, write it into a checklist or a
> lint rule if it's mechanizable, or recognize the review comment wasn't teaching
> the underlying concept. Repeated same-comment review is a signal the *system*
> failed, not just the person.

**Q: How do you handle disagreement in a review?**
> Separate preference from correctness. If it's correctness, I bring evidence. If
> it's preference, I defer or we codify a team standard so we never argue it
> again. I don't win reviews by rank.

**Q: A critical PR is blocked only on your review and you're slammed — what do you do?**
> That's the bottleneck made literal, which is why I avoid being the sole
> approver. Short term: timebox a focused review now or explicitly delegate to
> another qualified reviewer. I don't let a PR rot in my queue — review latency is
> a real cost to the whole team.

**Q: How do you review without demoralizing a junior?**
> Praise real wins, label nits as nits so they don't read every comment as a
> failure, ask questions instead of issuing orders, and make clear the code is
> being reviewed, not them. Tone in review *is* culture.

**Q: How do you balance review thoroughness with shipping speed?**
> Risk-tier it. A migration or auth change gets deep scrutiny; a copy tweak gets
> approve-with-comments. Spending equal review effort on every PR is itself a
> failure to prioritize.
