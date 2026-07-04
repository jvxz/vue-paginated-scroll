# Layered loop prevention (defense in depth)

**Context.** The defining stability failure of a bidirectional paginated scroller is the _pagination loop_: a trim exposes the opposite edge close to its trigger, which re-fires pagination, which trims again. Any single guard against this has a failure mode — pure geometry can be momentarily violated by a burst of fetches or a mid-scroll resize; a latch alone doesn't stop a fresh approach; direction logic alone doesn't stop same-direction over-fetch.

**Decision.** Prevent accidental pagination with three cooperating layers rather than one clever mechanism:

1. **Geometric coupling** — the default buffer is sized as _trigger distance + margin_, so a naive consumer gets loop-safe values without tuning.
2. **Re-arm latching (hysteresis)** — a fired trigger is disarmed until the user scrolls fully out of its zone and back in, making loop-prevention independent of geometry.
3. **Direction gating** — only the trigger matching the current scroll direction is armed; the opposite trigger is inert, so a trim can never fire the opposite side.

The trigger mechanism is **pure scroll-position math** (a continuous distance-to-edge scalar), chosen partly because latching and direction-gating are far easier to reason about against a continuous scalar than against binary `IntersectionObserver` visibility events.

**Consequences.** The loop is prevented by construction, not by luck. Cost is modest: all three are scalar computations on scroll events, which are debounced/rAF-batched regardless. The redundancy is deliberate — the goal is zero accidental paginations under any edge case.
