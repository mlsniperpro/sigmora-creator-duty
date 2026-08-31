---
format: 1920x1080
duration: 90s
message: "A livestream event can autonomously become a safe, recoverable campaign while the creator stays live."
arc: Demo Loop → product intro → deterministic policy → scoped publish → recovery → recap → CTA
audience: All Things Agentic Hackathon judges and technical reviewers
mode: autonomous
music: none
---

## Video direction

Use the adopted Code Editorial frame system: ink text on the remixed dark Sigmora
ground, cream/tile surfaces for cards, JetBrains Mono for technical labels, and
one mint-coral voltage moment per frame. Keep captured judging-panel screenshots
as the visual source of truth; crop away browser chrome and let the page surface
carry the proof. Motion is seek-safe, smooth, and VO-paced: reveal each card,
stage, receipt, or policy as the narration names it, then hold the resolved read.
Frames 2 and 5 are deliberate breathers for comprehension; frames 4 and 7 are
the strongest proof and closing holds. Never use front-loaded slideshow motion,
independent screensaver drift, fake social-network posting, or unlabelled
production claims. Keep the bottom caption band clear.

## Frame 1 — Stay live

- type: hook
- persuasion: outcome promise
- scene: The creator stays with the audience while Creator Duty takes the campaign handoff.
- duration: 12s
- poster: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- voiceover: "Creators should stay with their audience, not tab-switch through a launch checklist. Creator Duty turns one livestream event into a campaign that can run itself."
- blueprint: titlecard-reveal (Adapt)
- focal: assets/scroll-000.png
- roles: assets/scroll-000.png = background · brand name and hero promise = cutout
- asset_candidates: assets/scroll-000.png — top viewport with the Creator Duty hero, event controls, system pills, metrics, and workflow strip

Scene 1 (0.0–3.2s): deep tile ground and a cropped top-viewport screenshot sit in a layered-depth editorial frame; the kicker and “Stay live.” enter as a quiet titlecard reveal.
Scene 2 (3.2–8.4s): the screenshot settles into a rule-of-thirds window while “Creator Duty handles the campaign.” types on in the upper third; the camera makes one restrained push-through toward the hero.
Scene 3 (8.4–12.0s): the screenshot and promise hold as a clean read; a single mint voltage rule lands under the event-to-campaign claim.

## Frame 2 — The event becomes a plan

- type: product_intro
- persuasion: mechanism introduction
- scene: A bounded synthetic event is claimed, then Gemini supplies a structured campaign plan.
- duration: 14.12s
- poster: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/02-plan.html
- voiceover: "The event arrives as a narrow preauthorization: one creator, four sandbox destinations, one video, and a model-budget limit. Gemini then proposes the angle and tone."
- blueprint: cursor-ui-demo (Adapt)
- focal: assets/scroll-037.png
- roles: assets/scroll-037.png = background · event and Gemini plan panels = cutout
- asset_candidates: assets/scroll-037.png — upper-middle viewport with the synthetic event, Gemini plan, vertical promo, policy checks, and destination receipts

Scene 1 (0.0–4.2s): asymmetric 60/40 layout opens on the event panel only; the synthetic badge and preauthorization fields reveal one at a time with a gentle vertical lift.
Scene 2 (4.2–8.8s): the Gemini plan panel slides into the dominant right column as the angle quote resolves on its spoken cue; the screenshot remains readable beneath a hairline frame.
Scene 3 (8.8–13.0s): the angle, tone, and moment fields settle into a calm held read; a thin mint connector visually joins event to plan.

## Frame 3 — Typed code decides

- type: feature_showcase
- persuasion: deterministic safety
- scene: Gemini proposes, while typed policy checks decide whether side effects are allowed.
- duration: 13.28s
- poster: 8s
- transition_in: crossfade
- status: animated
- src: compositions/frames/03-policy.html
- voiceover: "The policy is deterministic. It checks the creator, the profile, the exact channel set, the vertical format, the spend cap, the copy limits, and the allowed link."
- blueprint: grid-card-assemble (Adapt)
- focal: assets/scroll-037.png
- roles: assets/scroll-037.png = background · release-policy panel = cutout
- asset_candidates: assets/scroll-037.png — upper-middle viewport with the release-policy checks and the Gemini proposal beside the immutable promo

Scene 1 (0.0–3.0s): a dark editorial title strip introduces “Typed code decides” above a dimmed policy crop; only the first authorization check is visible.
Scene 2 (3.0–9.6s): the release-policy checklist assembles in a dense 3×3 grid, revealing creator, profile, channels, format, spend, copy, and link checks in the order named by the VO.
Scene 3 (9.6–13.0s): the full checklist reaches PASSED and holds; the adjacent immutable 9:16 artifact remains a supporting depth layer, never a fake live post.

## Frame 4 — Four receipts, one release

- type: benefit_highlight
- persuasion: proof of bounded publish
- scene: One immutable promo is distributed to four sandbox destinations with individual verification receipts.
- duration: 14s
- poster: 8s
- transition_in: wipe
- status: animated
- src: compositions/frames/04-receipts.html
- voiceover: "Once approved, one immutable promo becomes four platform-native variants. Each destination gets a scoped post, a receipt, and a verification step."
- blueprint: cursor-ui-demo (Adapt)
- focal: assets/scroll-037.png
- roles: assets/scroll-037.png = background · destination receipts = cutout
- asset_candidates: assets/scroll-037.png — upper-middle viewport with the immutable vertical promo, passed release policy, and four verified destination receipts

Scene 1 (0.0–4.0s): the immutable 9:16 artifact anchors the left third; its artifact id and dimensions appear with a precise scale-in.
Scene 2 (4.0–9.8s): the four destination receipts reveal one by one across the right two-thirds, each checking in with a short horizontal tick as the VO names scoped post, receipt, and verification.
Scene 3 (9.8–14.0s): “4 VERIFIED” becomes the single mint voltage moment and holds beside the complete receipt stack.

## Frame 5 — Recover one target

- type: feature_showcase
- persuasion: trust through recovery
- scene: A failed receipt is retried only for its target and cannot create a duplicate replay.
- duration: 13s
- poster: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/05-recovery.html
- voiceover: "If one receipt fails, Creator Duty retries only that target. A correlated trace makes the recovery visible, while idempotency prevents a duplicate replay."
- blueprint: spatial-pan-stations (Adapt)
- focal: assets/scroll-074.png
- roles: assets/scroll-074.png = background · correlated agent trace = cutout
- asset_candidates: assets/scroll-074.png — lower-middle viewport with policy detail, correlated agent activity, one retry, and channel variants

Scene 1 (0.0–3.8s): the activity trace enters as a quiet mono station strip; the single RETRY badge is isolated in the upper third.
Scene 2 (3.8–9.5s): the crop pans across the trace from attempt 1 to attempt 2, with the target-only handoff highlighted as the VO names it; no other receipt moves.
Scene 3 (9.5–13.0s): the duplicate guard and succeeded retry hold in a centered layered card; the breath is intentional so judges can read the evidence.

## Frame 6 — Native variants, automatically

- type: feature_showcase
- persuasion: operational continuity
- scene: Each channel receives distinct native copy while the creator remains in the stream.
- duration: 12s
- poster: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/06-variants.html
- voiceover: "The livestream does not stop at publishing. LinkedIn, YouTube Shorts, Instagram, and the remaining channel each receive copy shaped for its surface."
- blueprint: comparison-split (Adapt)
- focal: assets/scroll-100.png
- roles: assets/scroll-100.png = background · channel-variant cards = cutout
- asset_candidates: assets/scroll-100.png — closing viewport with channel-native copy, four variants, and post-live continuation

Scene 1 (0.0–3.0s): a full-width “PLATFORM-NATIVE COPY” kicker and the first channel card enter from opposite wings in a split-screen layout.
Scene 2 (3.0–8.8s): the remaining channel cards cascade into a balanced triptych, each exposing its own character count and copy block on the spoken channel cue.
Scene 3 (8.8–12.0s): the four-variant count locks at the top of the grid and holds; the screenshot remains clearly marked as synthetic sandbox evidence.

## Frame 7 — Close with a recap

- type: cta
- persuasion: adoption invitation
- scene: The duty closes with a post-live recap, architecture proof, and an auditable outcome.
- duration: 13s
- poster: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/07-recap.html
- voiceover: "When the stream ends, the duty closes with a recap and questions. That is the point: a safe, recoverable campaign, while the creator stays live."
- blueprint: titlecard-reveal (Adapt)
- focal: assets/scroll-100.png
- roles: assets/scroll-100.png = background · recap heading and architecture line = cutout
- asset_candidates: assets/scroll-100.png — closing viewport with campaign-closed recap, audience questions, architecture summary, and disclosure footer

Scene 1 (0.0–3.4s): the campaign-closed badge and recap heading rise into a centered statement frame over the closing viewport.
Scene 2 (3.4–8.8s): the architecture line and audience-question clusters reveal in two editorial columns, with a small mint rule tying the live event to the closed duty.
Scene 3 (8.8–13.0s): “Creator Duty by Sigmora” and the synthetic/deterministic/sandbox disclosure hold as the final CTA; no extra claims or production-posting implication appears.
