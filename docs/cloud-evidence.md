# Verified cloud evidence

This is a non-secret evidence snapshot captured on August 29, 2026 after the
release behavior was frozen. The synthetic fixture, deterministic media
renderer, and sandbox destinations remain explicitly labeled; no external
social-network publication or optional-model bonus is claimed.

## Live release

- Judging panel: [Creator Duty on Cloud Run](https://creator-duty-ra3flcxmjq-uc.a.run.app)
- Google Cloud project: `sigmora-creator-duty-2026`, region `us-central1`
- Ready revision: `creator-duty-00012-thb`, 100% traffic
- Immutable image: `creator-duty:20260829200422-final`
- Image digest: `sha256:c61464bef0d3a78a02d9bbd19350ca2bad129fbe78785fc955efbdd75a272b2d`
- Runtime identity: `creator-duty-runtime@sigmora-creator-duty-2026.iam.gserviceaccount.com`
- Runtime bounds: 0 minimum, 3 maximum instances, concurrency 4, 1 CPU,
  1 GiB memory, 300-second timeout
- Firestore: Native mode in `us-central1`, deletion protection enabled
- Artifact bucket: uniform access, public-access prevention enforced, 90-day
  lifecycle; artifact bytes are exposed only through the campaign-owned proxy

The Pub/Sub subscription pushes only to
`/events/pubsub`, uses
`creator-duty-push@sigmora-creator-duty-2026.iam.gserviceaccount.com`, and binds
the OIDC audience to the exact Cloud Run service URL. Its acknowledgement
deadline is 300 seconds and retry window is 10–60 seconds.

## Canonical continuous hero trace

| Evidence | Value |
| --- | --- |
| Start message ID | `21108581410233695` |
| Replay message ID | `21401050658878645` |
| Live-ended message ID | `21398379456290074` |
| Start event | `live_evt_cloud_20260829_008` |
| Campaign | `cmp_5dc5f550c5146bebdbc2` |
| Run | `run_d090b95075874ebba9e227fb9798c8c5` |
| Trace | `f1f75688153101beb9b88ba30619b91e` |
| Final stage/outcome | `closed` / `post_live_recap_complete` |
| Release validation | `val_673fcd98d33df1b7aa00`, passed |
| Release hash | `366b5bbcaf9fdc8a8ae3e123dc94b69ae5f9a8f349f39bccd90261f48bb76a16` |

Cloud Logging contains 39 structured application entries on that exact trace.
They show policy before publishing, the injected LinkedIn failure at attempt 1,
LinkedIn success at attempt 2, all other destinations at attempt 1, the exact
replay guard, and the post-live recap. Expected failure injection is the only
warning on the hero trace.

## Real Google model evidence

All three calls use provider `vertex_ai`, SDK `@google/genai`, API surface
`models.generateContent`, requested model `gemini-3.7-flash`, and resolved model
`gemini-3.7-flash`.

| Purpose | Response ID | Input tokens | Output tokens |
| --- | --- | ---: | ---: |
| Plan campaign | `dDyTatD2JvKzgLUPi4fr6Qg` | 927 | 106 |
| Draft channel variants | `iDyTauCiKtyTmecPlfa70Qc` | 1,018 | 206 |
| Prepare recap | `eD2Tar6GC7G75usPq5qIuQw` | 1,378 | 287 |

Model output is draft data. Typed code owns the channel set, safe hashtags,
CTA, source bounds, claim rules, release policy, idempotency, retry, and side
effects.

## Artifact and receipt evidence

The canonical promo is available through the
[campaign-owned artifact proxy](https://creator-duty-ra3flcxmjq-uc.a.run.app/api/campaigns/cmp_5dc5f550c5146bebdbc2/artifacts/art_promo_cf51f0dfb6af795044704bc2b27a7fe7).
Independent byte inspection found:

- H.264 MP4, `yuv420p`, 1080×1920, exactly 12.000 seconds;
- 584,981 bytes;
- SHA-256 `531cdb6e84f9a1aa2d36339e66fb2ccc43ba9654d127684705c8912345cf1e52`;
- the same SHA-256 in the campaign record, GCS custom metadata, and downloaded
  bytes.

Four sandbox receipts are verified: X, YouTube Shorts, and Instagram at attempt
1; LinkedIn at attempt 2. Firestore contains one provider-ledger document for
each of the four receipt post IDs. Exact replay preserved the same four receipt
and provider-post IDs, retained two model invocations, added one
`duplicate_guard`, and left duplicate posts at zero. The matching live-ended
event then added the third model invocation and recap to the same campaign.

Firestore also contains the campaign, 64-character payload fingerprints for
both start and end claims, and a stream index mapping
`stream_cloud_20260829_008` to the same campaign.

## Post-freeze measured outcomes

These are demo measurements, not market-wide performance claims.

| Campaign | Completion | Recovery | Verified destinations | Retries | Duplicates |
| --- | ---: | ---: | ---: | ---: | ---: |
| `cmp_a2178e4fbb483ba5affd` | 32.017 s | 0.987 s | 3 | 1 | 0 |
| `cmp_76661ea033a7951c975a` | 30.467 s | 0.719 s | 4 | 1 | 0 |
| `cmp_5dc5f550c5146bebdbc2` | 29.992 s | 0.775 s | 4 | 1 | 0 |

Median completion was **30.467 seconds** and median targeted recovery was
**0.775 seconds**. All three runs recorded zero human actions after event
delivery, eight manual handoffs replaced, one target-only retry, verified final
receipts, and zero duplicate posts.

## No-claim ledger

- Publishing is a durable deterministic sandbox, not an external social post.
- Media is a real deterministic rendered artifact, not a Veo call.
- Veo, Lyria, and Gemma paths remain disabled and unclaimed.
- The model-authored cost estimate is policy-bounded but is not metered billing.
- The public submission video is available at
  https://www.youtube.com/watch?v=qMmDiSgRm8Q; it is a narrated competition
  walkthrough, not evidence of external social-network publication.
- Bonus content, bonus social posts, and the Devpost submission URL remain
  separate submission items.
