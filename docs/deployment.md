# Google Cloud deployment

`infra/deploy.sh` is a reviewable, idempotent deployment path for the base
competition stack. It is never invoked by CI and this repository does not deploy
anything automatically.

## What it creates or updates

- required Google Cloud APIs;
- an Artifact Registry Docker repository and immutable image tag;
- one dedicated Cloud Run runtime service account;
- one dedicated Pub/Sub push service account;
- a Firestore Native database with delete protection when first created;
- one private Cloud Storage artifact bucket with uniform access, public-access
  prevention, and a 90-day lifecycle rule;
- one Secret Manager secret containing a generated demo mutation key;
- one Pub/Sub topic and authenticated push subscription; and
- one public Cloud Run service with application-level mutation authentication.

## Prerequisites

- a billing-enabled Google Cloud project;
- `gcloud` authenticated as a deployment operator;
- `openssl` and `awk`;
- permission to enable services, create service accounts, build images, deploy
  Cloud Run, administer the named Pub/Sub resources, create Firestore, create the
  bucket/repository/secret, and bind the documented roles; and
- repository tests passing locally.

The deployer is not the runtime identity. Do not give the runtime service
account project Owner, Editor, Secret Manager Admin, Storage Admin, or Service
Account User.

## Review first

```bash
bash -n infra/deploy.sh
node scripts/scan-release.mjs
npm run check
```

Inspect the defaults at the top of `infra/deploy.sh`. Firestore location is
effectively permanent after database creation. The base deployment uses one
region for Cloud Run, Artifact Registry, Firestore, and the artifact bucket,
while Vertex AI uses the `global` model endpoint.

## Deploy

```bash
gcloud auth login
export PROJECT_ID="$(gcloud config get-value project)"
bash infra/deploy.sh
```

Optional bounded overrides:

```bash
export REGION=us-central1
export FIRESTORE_LOCATION=us-central1
export MAX_INSTANCES=3
export MAX_MODEL_SPEND_USD=5
export IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
bash infra/deploy.sh
```

The script requires `PROJECT_ID`, validates resource names, uses explicit
`--project` flags instead of changing the active gcloud project, and never
deletes resources. Re-running it updates the known service and subscription and
reuses existing identities, database, bucket, repository, and secret.

To rotate the demo key during a deliberate deployment:

```bash
export ROTATE_DEMO_KEY=true
bash infra/deploy.sh
```

The new value is written directly to Secret Manager and is not printed. Do not
place it in shell history, screenshots, logs, or repository files.

## Base production mode

The script deploys these safety-relevant application values:

```text
NODE_ENV=production
STORE_PROVIDER=firestore
MODEL_PROVIDER=vertex_ai
GEMINI_MODEL=gemini-3.7-flash
GOOGLE_CLOUD_LOCATION=global
MEDIA_PROVIDER=deterministic
PUBLISH_PROVIDER=deterministic
ALLOW_DEMO_TRIGGER=true
ALLOW_UNAUTHENTICATED_PUBSUB=false
PUBSUB_SERVICE_ACCOUNT_EMAIL=creator-duty-push@PROJECT_ID.iam.gserviceaccount.com
DEMO_DAILY_START_LIMIT=12
DEMO_START_COOLDOWN_SECONDS=15
ENABLE_VEO=false
ENABLE_LYRIA=false
ENABLE_GEMMA=false
```

`MEDIA_PROVIDER=deterministic` still creates an actual content-addressed promo;
the configured artifact store persists it privately. `PUBLISH_PROVIDER=deterministic`
creates durable sandbox records and receipts, not fake claims of public social
posts. These disclosed providers make the cloud hero run safe and repeatable.

## Public service, protected mutations

Cloud Run allows unauthenticated network access because judges must open the
panel signed out. Route-level controls remain mandatory:

- the Pub/Sub endpoint verifies the Google-signed OIDC token, exact service URL
  audience, verified email claim, and exact push service-account identity at
  `POST /events/pubsub`;
- demo mutation endpoints require the Secret Manager demo key;
- fresh demo starts also pass an atomic Firestore daily quota and cooldown shared
  by every Cloud Run instance;
- production fails closed if the audience or key is missing; and
- read-only views expose synthetic campaign evidence, not credentials.

The push identity receives Cloud Run Invoker on only this service. The Pub/Sub
service agent receives Token Creator on only the push service account so it can
mint the push OIDC token.

Conclusive schema and payload-integrity failures are acknowledged with `204`
and `X-Creator-Duty-Disposition: invalid_event_ignored`; the workflow is never
invoked. This prevents poison messages from consuming the subscription's
redelivery window. Transient workflow failures and active execution leases keep
non-success responses so Pub/Sub can retry them.

## Firestore rules and indexes

The repository's client rules deny every browser/mobile read and write. The
Node.js server SDK bypasses these rules and uses the runtime service identity,
so IAM is authoritative. No composite index is required by the current storage
layout; `firestore.indexes.json` is intentionally empty.

If the project is also managed with Firebase tooling, deploy the root
`firestore.rules` and `firestore.indexes.json` through that project's reviewed
Firebase configuration. Do not weaken the rule to make the judging panel work;
the panel must read through the authenticated server.

## Cost controls

- Cloud Run minimum instances: `0`.
- Cloud Run maximum instances: `3` by default and never above `10` in the script.
- Cloud Run concurrency: `4` by default.
- Request timeout and Pub/Sub acknowledgement deadline: five minutes.
- Pub/Sub retry delay is bounded and message retention is one day.
- Fail-closed plan-estimate limit: USD 5 per preauthorized campaign by default.
- Firestore-backed fresh-start quota: 12 per UTC day with a 15-second global cooldown by default.
- Optional Veo, Lyria, and Gemma paths are off.
- Artifact objects expire after 90 days.
- Runtime can publish only to the named event topic.

The plan estimate is model-authored and is not actual billing telemetry. Also
create a Cloud Billing budget and alerts in the project. The start quota and
service maximum instance count limit fan-out but are not complete spending caps
for Vertex AI, storage, logging, or egress.

## Post-deploy verification

The script prints non-secret resource names and the service URL. Then verify:

```bash
export REGION="${REGION:-us-central1}"
export SERVICE_URL="$(gcloud run services describe creator-duty --region="${REGION}" --format='value(status.url)' --project="${PROJECT_ID}")"
curl --fail --silent --show-error "${SERVICE_URL}/health"
```

Publish the synthetic fixture through the topic only after the service health,
OIDC audience, and Firestore state have been checked. Use the exact command in
the judge guide and keep the returned Pub/Sub message ID as evidence.

Inspect the deployment:

```bash
gcloud run services describe creator-duty --region="${REGION}" --project="${PROJECT_ID}"
gcloud pubsub subscriptions describe creator-duty-push --project="${PROJECT_ID}"
gcloud firestore databases describe --database='(default)' --project="${PROJECT_ID}"
gcloud storage buckets describe "gs://${PROJECT_ID}-creator-duty-artifacts" --project="${PROJECT_ID}"
```

Never paste `gcloud secrets versions access` output into evidence. A screenshot
of secret metadata and IAM binding is enough.

## Rollback

The script assigns a unique image tag. To roll back without deleting evidence,
list Cloud Run revisions and route traffic to the last verified revision. Do not
delete Firestore campaigns, event claims, provider publications, or the artifact
bucket during the judging period.
