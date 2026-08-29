# Competition new-work disclosure

## Plain-language disclosure

Creator Duty was started on **August 29, 2026** for the **All Things Agentic
Hackathon**. Sigmora is a pre-existing proprietary creator platform with media
generation, rendering, and publishing capabilities.

The competition-created work in this repository includes:

- the `creator.live.started` and `creator.live.ended` event contracts;
- Pub/Sub event intake and authenticated Cloud Run deployment;
- the Creator Duty state machine and orchestration;
- official Google GenAI SDK calls to `gemini-3.7-flash`;
- strict structured-output and model-evidence handling;
- Firestore campaign, event-claim, stream-index, and publication ledgers;
- narrow source, render, policy, publishing, verification, and recap tools;
- deterministic local model, media, publisher, failure, and replay fixtures;
- scoped interfaces for optional calls to the pre-existing Sigmora service;
- the judging panel, tests, architecture, setup, security, and evidence guides;
  and
- Google Cloud deployment and CI/release controls.

## Pre-existing dependency

Sigmora existed before the competition. Its private generation engines,
publishing implementations, account connections, infrastructure, credentials,
data model, customer data, brand system, and unrelated product functionality are
not part of this repository and are not relicensed by it.

Creator Duty can call Sigmora only through narrow HTTPS provider interfaces. The
model never receives the Sigmora credential and cannot select an arbitrary
endpoint. A full deterministic provider is included so judges can reproduce the
workflow without private access.

## Claims discipline

- Synthetic event, transcript, account, and sandbox publishing data are labeled.
- Deterministic output is not represented as a live external social post.
- A model is named in submission evidence only when the trace records its exact
  requested and resolved model IDs and response ID.
- Optional Veo, Lyria, or Gemma configuration is not called an integration or
  bonus contribution until a completed run and artifact/operation receipt exist.
- Time saved, reliability, reach, and conversion claims are published only from
  measured final runs; no forecast is presented as a fact.
- Google is described as the technology provider, never as a sponsor,
  endorser, judge selection, or award.
- Creator Duty is not described as award-winning before results are public.

## License boundary

Apache-2.0 applies to the competition-created work intentionally included in
this repository. It does not grant rights to Sigmora's pre-existing proprietary
service, private source, credentials, customer data, trademarks, or brand
assets. Dependency on a hosted proprietary service does not place that service
under this repository's license.
