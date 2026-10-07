# Q3 — Pushing back on a Product/Design requirement (performance / accessibility)

> **Category:** Values, Leadership & Culture / Technical judgment
>
> **Question:** *Tell me about a time you had to push back on a Product or Design
> requirement because it compromised system performance or accessibility. How did
> you reach a compromise?*

**Scenario status:** 🔮 **Future scope** — the premium **"See everyone who liked
you"** screen is a realistic next feature for devTinder (we already have the
`like` model, payments, an S3/MinIO image store, and a `thumbnailQueue`), but the
screen itself isn't built yet. The story is framed as a **spec/design review**
disagreement, which is the most honest way to use a not-yet-shipped feature: if
probed, the truthful line is *"this was the design decision we reached before
building it."*

---

## The tension (Product goal vs. system reality)

**Product's requirement:** "The premium *See who liked you* screen should load
**everyone** at once — all their photos, full-resolution, no pagination, no
'load more' button. Paying users should feel like they instantly get *everything*.
Pagination feels cheap and un-premium."

**Why that compromises performance (the engineering reality):**
- A popular user could have **thousands** of likers → one unbounded DB query.
- Each row gets `populate`d into a full profile → classic **N+1 / huge payload**.
- Full-resolution images for hundreds of profiles = **massive bandwidth** and a
  slow, janky first paint — ironically the *opposite* of feeling premium.
- It also puts avoidable read load on the DB right behind our paywall, where
  reliability matters most.

The trap: the requirement and the performance fix *sound* opposed, but they're
not — the thing that actually makes it "feel premium" is **instant feedback and
a smooth scroll**, not literally shipping 2,000 full-res images in one response.

---

## STAR answer (this is what you say out loud)

**Situation**
> "We were speccing the premium *See who liked you* screen on devTinder — a paid
> feature. Product was firm that it should load every liker at once, full
> photos, no pagination, because pagination felt 'un-premium' for a paid tier."

**Task**
> "I agreed with the *goal* — paying users should feel they're getting full value
> instantly. But the literal implementation would have been slow and expensive
> exactly where it mattered most: behind our paywall. My job was to protect
> performance without killing the premium feel, and to not come across as the
> engineer who just says 'no' to Product."

**Action**
> "Instead of arguing in the abstract, I built a quick proof. I seeded a user
> with a couple thousand likes and measured the naive version: the unbounded
> query plus full-profile populate plus full-res images gave a multi-second load
> and a huge payload — it actively felt *worse*, not more premium.
>
> Then I reframed the conversation around the real goal. I asked, 'What makes
> this feel premium?' and we agreed it was (1) seeing the big number instantly
> and (2) a smooth, uninterrupted experience. So I proposed:
> - Show the **aggregate count immediately** — '147 people liked you' — which is
>   the emotional hit, and it's a cheap single query.
> - **Cursor-based pagination with infinite scroll**, not a 'Load more' button —
>   so it still *feels* like one continuous list, no page breaks, but we only
>   fetch ~20 profiles at a time.
> - Serve **thumbnails first**, full-res on tap — which reused our existing
>   `thumbnailQueue` and S3 setup, so it was cheap to build.
>
> I framed it to Product as 'same feeling, but it stays fast under our heaviest
> users' and showed the before/after load times side by side."

**Result**
> "Product signed off because I protected what they actually cared about — the
> instant big number and a seamless scroll — while I protected the system. We
> avoided shipping a paywalled feature that would've been slow for our most
> engaged users. And because the fix leaned on infra we already had, it didn't
> add real cost to the estimate.
>
> The broader win: Product learned that 'pagination' wasn't the enemy — a
> *visible* page break was — and I learned to push back by **reframing around
> their goal** instead of citing Big-O. After that they started pulling
> engineering into design reviews earlier."

---

## 60-second spoken version (when they want it tight)

> "We were speccing devTinder's premium *See who liked you* screen. Product
> wanted it to load every liker at once — full photos, no pagination — because
> pagination felt un-premium for a paid tier.
>
> I agreed with the goal but not the implementation, so instead of arguing I
> built a quick proof: I seeded a user with a couple thousand likes, and the
> naive version was a multi-second load with a massive payload — it actually felt
> *worse*, not premium. Then I reframed it: what makes this feel premium is
> seeing the big number instantly and scrolling smoothly, not literally shipping
> 2,000 full-res images.
>
> So I proposed showing the aggregate count immediately — '147 people liked you' —
> plus cursor-based infinite scroll instead of a 'Load more' button, and
> thumbnails first with full-res on tap, which reused our existing thumbnail
> queue and S3 setup. Same premium feeling, but fast under our heaviest users.
>
> Product signed off, we avoided shipping a slow paywalled feature, and the real
> lesson was that pagination wasn't the enemy — a *visible* page break was. I
> learned to push back by reframing around their goal instead of quoting Big-O."

*(~200 words ≈ 55–60 seconds.)*

---

## Why this answer works (the signals being tested)

1. **Backbone *and* collaboration.** The question is really asking: can you
   disagree with Product without being obstructive? The answer shows a firm push
   back that still *protects Product's actual goal* — that's senior behavior.
2. **You reframed, you didn't just refuse.** The pivot — "what actually makes
   this feel premium?" — turns a no into a shared problem. Interviewers love the
   move from *position* ("no pagination") to *interest* ("instant, seamless").
3. **You brought evidence, not opinion.** A measured before/after beats "trust
   me, it'll be slow." Data defuses the politics.
4. **The compromise was real.** Both sides gave something: Product gave up
   literal "load everything," you delivered infinite scroll + instant count so it
   still felt premium. Name the trade explicitly.
5. **Reused existing infra** (`thumbnailQueue`, S3) → shows you weigh cost, not
   just correctness.

### Delivery tips
- Say the reframing line out loud: *"I asked what actually makes this feel
  premium."* That one sentence is the whole answer in miniature.
- Stress that you **agreed with the goal** up front — it signals you're not
  anti-Product, you're anti-*slow*.
- End on what changed between the teams (earlier eng involvement), not just the
  feature.

---

## Accessibility variant (if the interviewer steers toward a11y instead)

Same question, accessibility angle — keep this ready as an alternate STAR:

> **Situation / Task:** Design wanted devTinder's core profile browsing to be
> **swipe-only** — Tinder-style card gestures, no visible buttons — because it
> looked clean. I flagged that swipe-only is a serious accessibility failure:
> it's unusable with a keyboard, with a screen reader, or for users with motor
> impairments, and it's not even discoverable for some users.
>
> **Action:** Rather than demanding we drop the gesture, I proposed keeping the
> swipe as a *delight* layer for touch users **and** adding explicit, accessible
> Like / Pass buttons with proper ARIA labels and full keyboard support (Tab to
> focus, Enter/arrow keys to act). I showed it failing a screen-reader pass, then
> passing after the buttons were added, and pointed out the buttons also help
> power users and desktop users — so it wasn't "accessibility tax," it was better
> for everyone.
>
> **Result:** We shipped both — swipe for those who want it, accessible controls
> as the real interaction contract underneath. Design kept their clean look, the
> feature became WCAG-compliant and keyboard-navigable, and "does it work without
> a mouse and with a screen reader?" became part of our design-review checklist.

**Key a11y talking points if probed:**
- Gestures must have a **non-gesture equivalent** (WCAG 2.5.1 Pointer Gestures).
- Interactive controls need **accessible names** (ARIA labels) and a **visible
  focus state**; action must be reachable by keyboard.
- **Color contrast** (WCAG AA: 4.5:1 for text) — a common Design-vs-a11y clash
  when a designer wants light-grey text on white for aesthetics.
- Frame a11y as **"better for everyone"** (curb-cut effect), not a compliance
  chore — that's how you get Design to say yes.

---

## Reusable pattern for *any* "push back on Product" question

1. **Agree with the goal first** — disarms the "difficult engineer" read.
2. **Bring evidence** — a quick measurement/proof beats assertion.
3. **Reframe position → interest** — attack the requirement's *intent*, find a
   cheaper way to satisfy it.
4. **Offer a concrete compromise** where both sides give something.
5. **Close with the relationship/process change**, not just the feature outcome.
