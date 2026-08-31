---
workflow: product-launch-video
flow: automation
storyboard: no
message: "A livestream event can autonomously become a safe, recoverable campaign while the creator stays live."
destination: youtube
aspect: 1920x1080
language: en
audience: All Things Agentic Hackathon judges and technical reviewers
length: 90s
angle: show-it-as-is
narration: yes
tts_provider: vertex_ai
tts_model: gemini-3.1-flash-tts-preview
tts_voice: Kore
---

## Intent

Create a concise, English-captioned product tour for the All Things Agentic
Hackathon submission. Show Creator Duty by Sigmora operating its own live
judging panel: one event starts the duty, typed planning and policy precede
side effects, one sandbox destination recovers on a target-only retry, exact
replay is ignored, and the same campaign closes with a recap.

## Assets

- https://creator-duty-ra3flcxmjq-uc.a.run.app — live Cloud Run judging panel,
  captured as the visual source of truth until the branded hostname is
  certificate-ready.
- https://creator-duty.sigmora.org — intended Sigmora-branded public hostname;
  use it for the final capture after HTTPS is ready.

## Customizations

- Feature the site's own captured screens as the video's assets.
- Keep the product's synthetic-event, deterministic-renderer, and sandbox
  publication labels visible; do not imply real social-network posting.
- Include a short Cloud Run / Vertex AI / Firestore proof card using the public
  README and cloud-evidence links.
- Use a concise English Gemini TTS narration with matching on-screen captions.
- Do not fall back to local Kokoro or another voice provider; a Gemini TTS
  failure blocks the narrated submission render and must be reported.

## Notes

- This is a competition demo, not a production launch claim.
- Preserve the new-work disclosure: Creator Duty is competition-created work;
  Sigmora is a pre-existing proprietary creator platform.
- The deployed service is public read-only for inspection; mutations remain
  guarded by the demo key and the bounded synthetic fixture.
