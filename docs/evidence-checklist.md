# Evidence and release checklist

Complete this checklist against one frozen release commit. A checkbox is not
evidence by itself; save the linked screenshot, trace, receipt, or command output
in the private submission ledger, then publish only non-sensitive artifacts.
The current claim/no-claim ledger is [evidence status](evidence-status.md).

## Validity gate

- [x] Public repository opens signed out over anonymous HTTPS.
- [x] Apache-2.0 is detected at the repository root.
- [x] New-work disclosure is visible from the first README screen.
- [x] Personal friction and autonomous event trigger are explained before the
      feature list.
- [x] `npm ci`, `npm test`, `npm run demo`, and `npm run build` pass from a fresh
      checkout.
- [x] `node scripts/scan-release.mjs` passes.
- [x] No credential, private customer data, or live account token is present.
- [ ] Architecture Mermaid renders on the repository host.
- [x] Setup and deployment commands were rehearsed against the isolated cloud project.

## Google model evidence

- [x] Production configuration requests exactly `gemini-3.7-flash`.
- [x] Real trace records provider `vertex_ai`.
- [x] Real trace records SDK `@google/genai` and API surface
      `models.generateContent`.
- [x] Requested and resolved model IDs are present and consistent.
- [x] Response ID and timestamp are present.
- [x] Token counts are present when returned by the service.
- [x] Structured response passes runtime schema and source-bound validation.
- [x] Deterministic local calls are visibly separated from real Google calls.

## Google Cloud evidence

- [x] Cloud Run service URL opens signed out.
- [x] Cloud Run revision uses the dedicated runtime service account.
- [x] Maximum instances, minimum instances, concurrency, timeout, CPU, and memory
      match the reviewed deployment.
- [x] Pub/Sub subscription is push delivery with the dedicated push identity and
      exact service URL audience.
- [x] Firestore contains campaign, event-claim, stream-index, and provider-ledger
      records for the hero run.
- [x] Artifact bucket has uniform access and public-access prevention.
- [x] Secret metadata exists; secret value is absent from every capture.
- [x] Structured log entries share one trace/run/campaign correlation set.

## Hero behavior

- [x] Unique event creates exactly one campaign.
- [x] No prompt, click, or approval occurs after event delivery.
- [x] Gemini plans within the supplied source bounds.
- [x] A playable 9:16 promo and distinct platform variants are created.
- [x] Deterministic validation runs before publishing.
- [x] At least three sandbox destinations create durable publication records.
- [x] One target fails before commit and succeeds on bounded retry.
- [x] Successful targets remain at one provider commit.
- [x] All final receipts verify.
- [x] Exact event replay returns `duplicate_ignored`.
- [x] Replay creates no campaign, artifact, or provider-post duplicate.
- [x] Live-ended event updates the existing campaign and creates recap/question
      clusters.

## Measured claims

- [x] Hero fixture ran at least three times after behavior freeze.
- [x] Median completion time is computed from those runs.
- [x] Recovery time is measured from injected failure to verified receipt.
- [x] Manual handoffs replaced are counted from the documented workflow.
- [x] Human actions after event delivery equal the value shown in the demo.
- [x] Destination count and duplicate count come from receipts/ledger, not a
      slide estimate.
- [x] Public copy distinguishes demo measurements from market-wide claims.

## Optional-model claims

- [ ] Veo is mentioned as integrated only if a completed artifact contains exact
      model, operation, prompt, and output evidence.
- [ ] Lyria is mentioned as integrated only if a completed audio artifact
      contains exact model, operation, prompt, duration, and output evidence.
- [ ] Gemma is mentioned as integrated only if its exact model invocation and
      typed critic result appear in the hero evidence.
- [x] Disabled or fallback-only configuration is not submitted for bonus credit.
- [x] No optional model delayed or destabilized the eligible base run.

## Public submission package

- [ ] Video is public, English, and under four minutes.
- [ ] Working product appears in the first 12 seconds.
- [ ] Cloud deployment and matching trace appear in the video.
- [ ] Repository, demo, architecture, setup, disclosure, and write-up links work
      signed out.
- [ ] Public build content contains the required competition disclosure sentence.
- [ ] Social post uses exactly `#AllThingsAgenticHackathon`.
- [ ] Synthetic data, sandbox publishing, and generated storytelling media are
      labeled.
- [ ] Every public URL was checked after final publication.
- [ ] Submission screenshots and URL ledger are saved privately.
