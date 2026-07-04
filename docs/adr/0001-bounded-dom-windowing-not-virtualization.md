# Bounded-DOM windowing, not virtualization

**Context.** The library renders a scrolling list of arbitrary consumer components (Matrix events being the first customer) whose heights are wildly variable and impossible to know without mounting them — a one-line "hello" versus a server owner's giant rules list. True virtualization requires height measurement or estimation of off-screen items; with content this unpredictable (images loading late, embeds, edits reflowing), that measurement is unreliable and is the primary source of jank in virtualized chat lists.

**Decision.** The window is **bounded real DOM**: every item in the window is genuinely mounted. The window stays bounded by a target rendered height; paginating past the bound trims the opposite edge out of the DOM. No height estimation, no spacer elements, no recycling.

**Consequences.**

- The _window_ is capped (hundreds–low-thousands of mounted items), though the _source_ behind it can be unbounded.
- Every windowed item pays a real mount cost. This directly motivates the pagination-latency `console.warn`: it is the pressure gauge that tells the developer their window is too heavy (heavy item components × window height) and should be tuned.
- We accept that a very tall window of very heavy components will be slow — that is a tuning signal surfaced to the developer, not something the library hides.
