# Judge guide

Creator Duty should be understandable in under four minutes and reproducible in
about five minutes locally.

## What to remember

**Stay live. Creator Duty handles the campaign.**

The agent starts from a livestream event and completes a bounded operational
workflow while the creator remains live. The proof is not caption quality alone;
it is durable ownership, policy before side effects, target-specific recovery,
verified receipts, and zero duplicate posts after replay.

## Fast local evaluation

```bash
npm ci
npm test
npm run demo
```

No credentials or network services are needed. All fixture identities are
synthetic and every sandbox destination is labeled.

To exercise the same workflow through the local judging panel:

```bash
ALLOW_DEMO_TRIGGER=true npm run demo:server
```

Open `http://localhost:8080`. Production uses the same routes but additionally
requires the Secret Manager demo key for mutations.

The compact HTTP surface is:

| Route | Authority | Purpose |
| --- | --- | --- |
| `GET /health` | public | Liveness without secret or campaign data |
| `GET /api/system` | public | Runtime/provider labels for the judging panel |
| `GET /api/campaigns/latest` | public | Latest synthetic campaign evidence |
| `POST /events/pubsub` | Pub/Sub OIDC | Decode and process the authenticated push envelope |
| `POST /api/demo/start` | explicit local gate; production demo key | Dispatch the synthetic live-start fixture |
| `POST /api/demo/replay` | explicit local gate; production demo key | Dispatch the byte-equivalent start event again |
| `POST /api/demo/end` | explicit local gate; production demo key | Dispatch live-ended for the existing stream campaign |

The final demo output should expose one correlation set:

- event ID;
- campaign ID;
- run ID and trace ID;
- exact model/provider label;
- immutable artifact IDs and SHA-256 values;
- validation ID and release hash;
- receipt IDs, attempts, and provider post IDs;
- injected failed target and recovery duration; and
- replay disposition.

## Assertions to verify

| Assertion | Expected proof |
| --- | --- |
| Event-driven | Workflow begins on fixture delivery, without a planning prompt or mid-run approval |
| One campaign | Concurrent or repeated delivery resolves to one campaign ID |
| Real model in cloud | Trace records requested and resolved `gemini-3.7-flash`, response ID, SDK, and token evidence |
| Typed decisions | Plan and channel variants pass strict schemas and source-bound validation |
| Real artifact | Playable 9:16 promo plus immutable artifact hash |
| Policy authority | Passed validation and release hash exist before any publication receipt |
| Channel-native output | At least three distinct variants use the exact allowed channels and CTA |
| Failure recovery | One target fails; successful targets retain attempt one; only failure retries |
| Provider idempotency | One provider post identity exists per channel/idempotency key |
| Replay protection | Same event returns `duplicate_ignored` with zero new posts |
| Durable state | Firestore shows event claim, campaign checkpoints, stream index, and publication ledger |
| Post-live continuity | Live-ended event updates the existing campaign and produces the recap |

## Cloud evaluation

Open the public Cloud Run service URL and keep one campaign/run ID visible while
moving between:

1. the judging panel;
2. the Pub/Sub message or subscription metrics;
3. the structured Cloud Logging trace;
4. the Firestore campaign and event claim;
5. the private artifact metadata; and
6. the receipt/replay result.

The Google model trace—not an environment variable or slide—is the model proof.
The Cloud Run URL/dashboard and matching log trace are the deployment proof.

From the repository root, publish the exact synthetic start fixture with:

```bash
: "${PROJECT_ID:?Set PROJECT_ID to the deployed Google Cloud project}"
creator_event_payload="$(jq -c . fixtures/live-started.json)"
gcloud pubsub topics publish creator-duty-events \
  --project="${PROJECT_ID}" \
  --message="${creator_event_payload}" \
  --attribute=source=judge-cloud-e2e
```

The returned message ID is transport evidence. The resulting campaign, model
invocations, artifacts, validation, and receipts are outcome evidence. Publish
the identical `creator_event_payload` a second time to exercise replay safety;
then compact and publish `fixtures/live-ended.json` for post-live continuity.

An operator with Vertex AI Application Default Credentials can run a model-only
smoke before deployment:

```bash
export GOOGLE_CLOUD_PROJECT="${PROJECT_ID}"
export GOOGLE_CLOUD_LOCATION=global
export GEMINI_MODEL=gemini-3.7-flash
npm run smoke:gemini
```

## Failure and replay sequence

The strongest demo uses one continuous run:

1. Deliver `fixtures/live-started.json` through Pub/Sub.
2. Watch `received → planning → producing → validating → publishing`.
3. Inspect the generated promo and per-channel variants.
4. Confirm deterministic validation passes.
5. Watch three targets commit and one target fail before commit.
6. Watch only the failed target retry.
7. Confirm all receipts are verified.
8. Deliver the exact start event again.
9. Confirm `duplicate_ignored` and no additional provider post identity.
10. Deliver `fixtures/live-ended.json` and inspect recap/question clusters on
    the same campaign.

## Truth labels

- **Deterministic model** means local reproducibility, not Gemini evidence.
- **Sandbox publication** means a durable simulated destination, not a public
  social-network post.
- **Scoped Sigmora provider** means a call to the disclosed pre-existing service
  through a narrow interface.
- **Optional model configured** does not mean optional model exercised.
- **Cloud deployed** requires a visible Cloud Run service and matching live log,
  not a Dockerfile alone.

## Repository review order

1. `README.md`
2. `docs/new-work-disclosure.md`
3. `docs/architecture.md`
4. `src/orchestration`
5. `src/storage`
6. `src/providers/publisher.ts`
7. `src/tools/policy.ts`
8. tests
9. `infra/deploy.sh`
10. `docs/evidence-checklist.md`

## Submission-video rejection gate

Do not use a recording unless all answers are yes:

- Is the functioning product visible in the first 12 seconds?
- Is the triggering event visible?
- Does the run continue autonomously after that event?
- Is the exact requested and resolved model visible?
- Is a real artifact visible?
- Are distinct channel variants readable?
- Does policy visibly precede publishing?
- Is one failure and target-only recovery understandable?
- Is replay rejection visible?
- Are Cloud Run and a matching trace visible?
- Are sandbox/generated elements labeled?
- Is the video public, English, and under four minutes?
