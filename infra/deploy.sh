#!/usr/bin/env bash
set -Eeuo pipefail

# Creator Duty Google Cloud deployment. This script is intentionally explicit,
# idempotent for named resources, and non-destructive. It never deletes data or
# prints secret values.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPOSITORY_ROOT}"

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to a billing-enabled Google Cloud project.}"
REGION="${REGION:-us-central1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-${REGION}}"
SERVICE_NAME="${SERVICE_NAME:-creator-duty}"
TOPIC_NAME="${TOPIC_NAME:-creator-duty-events}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-creator-duty-push}"
RUNTIME_SERVICE_ACCOUNT_NAME="${RUNTIME_SERVICE_ACCOUNT_NAME:-creator-duty-runtime}"
PUSH_SERVICE_ACCOUNT_NAME="${PUSH_SERVICE_ACCOUNT_NAME:-creator-duty-push}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-creator-duty}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-${PROJECT_ID}-creator-duty-artifacts}"
DEMO_SECRET_NAME="${DEMO_SECRET_NAME:-creator-duty-demo-key}"
FIRESTORE_DATABASE_ID="${FIRESTORE_DATABASE_ID:-(default)}"
PUBSUB_PUSH_PATH="/events/pubsub"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
CONCURRENCY="${CONCURRENCY:-4}"
MAX_MODEL_SPEND_USD="${MAX_MODEL_SPEND_USD:-5}"
DEMO_DAILY_START_LIMIT="${DEMO_DAILY_START_LIMIT:-12}"
DEMO_START_COOLDOWN_SECONDS="${DEMO_START_COOLDOWN_SECONDS:-15}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
ROTATE_DEMO_KEY="${ROTATE_DEMO_KEY:-false}"

main() {
required_command gcloud
required_command openssl
required_command awk
validate_inputs

RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PUSH_SERVICE_ACCOUNT="${PUSH_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${SERVICE_NAME}:${IMAGE_TAG}"

echo "Validating Google Cloud project ${PROJECT_ID}."
gcloud projects describe "${PROJECT_ID}" --project="${PROJECT_ID}" --format='value(projectId)' >/dev/null

echo "Enabling required Google Cloud APIs."
gcloud services enable \
  aiplatform.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  iamcredentials.googleapis.com \
  pubsub.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --project="${PROJECT_ID}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --project="${PROJECT_ID}" --format='value(projectNumber)')"
PUBSUB_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

ensure_service_account \
  "${RUNTIME_SERVICE_ACCOUNT_NAME}" \
  "Creator Duty runtime identity"
ensure_service_account \
  "${PUSH_SERVICE_ACCOUNT_NAME}" \
  "Creator Duty authenticated Pub/Sub push identity"

ensure_service_account_role \
  "${PUSH_SERVICE_ACCOUNT}" \
  "serviceAccount:${PUBSUB_SERVICE_AGENT}" \
  "roles/iam.serviceAccountTokenCreator"

echo "Granting bounded project-level runtime roles."
ensure_project_role "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" "roles/datastore.user"
ensure_project_role "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" "roles/aiplatform.user"

echo "Ensuring Firestore Native database ${FIRESTORE_DATABASE_ID}."
if ! gcloud firestore databases describe \
  --database="${FIRESTORE_DATABASE_ID}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud firestore databases create \
    --database="${FIRESTORE_DATABASE_ID}" \
    --location="${FIRESTORE_LOCATION}" \
    --type=firestore-native \
    --delete-protection \
    --project="${PROJECT_ID}"
fi

echo "Ensuring private artifact bucket gs://${ARTIFACT_BUCKET}."
if ! gcloud storage buckets describe "gs://${ARTIFACT_BUCKET}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${ARTIFACT_BUCKET}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --project="${PROJECT_ID}"
fi
gcloud storage buckets update "gs://${ARTIFACT_BUCKET}" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --lifecycle-file="${SCRIPT_DIR}/artifact-lifecycle.json" \
  --project="${PROJECT_ID}" >/dev/null
ensure_bucket_role \
  "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  "roles/storage.objectUser"

echo "Ensuring Secret Manager demo key."
if ! gcloud secrets describe "${DEMO_SECRET_NAME}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud secrets create "${DEMO_SECRET_NAME}" \
    --replication-policy=automatic \
    --project="${PROJECT_ID}"
fi

ENABLED_SECRET_VERSION="$(gcloud secrets versions list "${DEMO_SECRET_NAME}" \
  --filter='state=ENABLED' \
  --limit=1 \
  --format='value(name)' \
  --project="${PROJECT_ID}")"
if [[ -z "${ENABLED_SECRET_VERSION}" || "${ROTATE_DEMO_KEY}" == "true" ]]; then
  # Generate directly into gcloud stdin. Do not assign the key to a shell
  # variable or print it.
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "${DEMO_SECRET_NAME}" \
    --data-file=- \
    --project="${PROJECT_ID}" >/dev/null
fi
ensure_secret_role \
  "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  "roles/secretmanager.secretAccessor"

echo "Ensuring Pub/Sub topic ${TOPIC_NAME}."
if ! gcloud pubsub topics describe "${TOPIC_NAME}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud pubsub topics create "${TOPIC_NAME}" --project="${PROJECT_ID}"
fi
ensure_topic_role \
  "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  "roles/pubsub.publisher"

echo "Ensuring Artifact Registry repository ${ARTIFACT_REPOSITORY}."
if ! gcloud artifacts repositories describe "${ARTIFACT_REPOSITORY}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${ARTIFACT_REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Creator Duty immutable deployment images" \
    --project="${PROJECT_ID}"
fi

BUILD_SERVICE_ACCOUNT="$(gcloud builds get-default-service-account \
  --project="${PROJECT_ID}" \
  --format='value(serviceAccountEmail)')"
if [[ -z "${BUILD_SERVICE_ACCOUNT}" ]]; then
  echo "Unable to resolve the Cloud Build service account." >&2
  exit 1
fi
ensure_repository_role \
  "serviceAccount:${BUILD_SERVICE_ACCOUNT}" \
  "roles/artifactregistry.writer"

echo "Building immutable image ${IMAGE_URI}."
gcloud builds submit \
  --tag="${IMAGE_URI}" \
  --project="${PROJECT_ID}" \
  .

echo "Deploying bounded Cloud Run service ${SERVICE_NAME}."
RUNTIME_ENVIRONMENT="^|^NODE_ENV=production|STORE_PROVIDER=firestore|MODEL_PROVIDER=vertex_ai|MEDIA_PROVIDER=deterministic|PUBLISH_PROVIDER=deterministic|GOOGLE_CLOUD_PROJECT=${PROJECT_ID}|GOOGLE_CLOUD_LOCATION=global|GEMINI_MODEL=gemini-3.7-flash|FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID}|PUBSUB_TOPIC=${TOPIC_NAME}|PUBSUB_AUDIENCE=urn:creator-duty:bootstrap|PUBSUB_SERVICE_ACCOUNT_EMAIL=${PUSH_SERVICE_ACCOUNT}|ALLOW_UNAUTHENTICATED_PUBSUB=false|ALLOW_DEMO_TRIGGER=true|DEMO_CREATOR_ID=demo_creator|DEMO_DAILY_START_LIMIT=${DEMO_DAILY_START_LIMIT}|DEMO_START_COOLDOWN_SECONDS=${DEMO_START_COOLDOWN_SECONDS}|MAX_MODEL_SPEND_USD=${MAX_MODEL_SPEND_USD}|ENABLE_VEO=false|VEO_MODEL=veo-3.1-generate-preview|ENABLE_LYRIA=false|LYRIA_MODEL=lyria-3-clip-preview|ENABLE_GEMMA=false|ARTIFACT_BUCKET=${ARTIFACT_BUCKET}"
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE_URI}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --ingress=all \
  --min=0 \
  --min-instances=0 \
  --max="${MAX_INSTANCES}" \
  --max-instances="${MAX_INSTANCES}" \
  --concurrency="${CONCURRENCY}" \
  --cpu=1 \
  --memory=1Gi \
  --timeout=300 \
  --set-env-vars="${RUNTIME_ENVIRONMENT}" \
  --set-secrets="DEMO_API_KEY=${DEMO_SECRET_NAME}:latest" \
  --labels="application=creator-duty,competition=all-things-agentic-2026" \
  --project="${PROJECT_ID}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --format='value(status.url)' \
  --project="${PROJECT_ID}")"
if [[ ! "${SERVICE_URL}" =~ ^https:// ]]; then
  echo "Cloud Run did not return an HTTPS service URL." >&2
  exit 1
fi

echo "Binding the exact service URL as application base URL and OIDC audience."
FINAL_ENVIRONMENT="^|^APP_BASE_URL=${SERVICE_URL}|PUBSUB_AUDIENCE=${SERVICE_URL}"
gcloud run services update "${SERVICE_NAME}" \
  --region="${REGION}" \
  --update-env-vars="${FINAL_ENVIRONMENT}" \
  --project="${PROJECT_ID}" >/dev/null

echo "Granting the push identity access to only this Cloud Run service."
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --region="${REGION}" \
  --member="serviceAccount:${PUSH_SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" \
  --project="${PROJECT_ID}" >/dev/null

PUSH_ENDPOINT="${SERVICE_URL}${PUBSUB_PUSH_PATH}"
echo "Ensuring authenticated Pub/Sub push subscription ${SUBSCRIPTION_NAME}."
if gcloud pubsub subscriptions describe "${SUBSCRIPTION_NAME}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  EXISTING_TOPIC="$(gcloud pubsub subscriptions describe "${SUBSCRIPTION_NAME}" \
    --format='value(topic)' \
    --project="${PROJECT_ID}")"
  if [[ "${EXISTING_TOPIC##*/}" != "${TOPIC_NAME}" ]]; then
    echo "Existing subscription ${SUBSCRIPTION_NAME} targets a different topic; refusing to replace it." >&2
    exit 1
  fi
  gcloud pubsub subscriptions update "${SUBSCRIPTION_NAME}" \
    --push-endpoint="${PUSH_ENDPOINT}" \
    --push-auth-service-account="${PUSH_SERVICE_ACCOUNT}" \
    --push-auth-token-audience="${SERVICE_URL}" \
    --ack-deadline=300 \
    --min-retry-delay=10s \
    --max-retry-delay=60s \
    --message-retention-duration=1d \
    --project="${PROJECT_ID}"
else
  gcloud pubsub subscriptions create "${SUBSCRIPTION_NAME}" \
    --topic="${TOPIC_NAME}" \
    --push-endpoint="${PUSH_ENDPOINT}" \
    --push-auth-service-account="${PUSH_SERVICE_ACCOUNT}" \
    --push-auth-token-audience="${SERVICE_URL}" \
    --ack-deadline=300 \
    --min-retry-delay=10s \
    --max-retry-delay=60s \
    --message-retention-duration=1d \
    --project="${PROJECT_ID}"
fi

echo
echo "Creator Duty deployment completed."
echo "Service URL: ${SERVICE_URL}"
echo "Pub/Sub topic: ${TOPIC_NAME}"
echo "Push endpoint: ${PUSH_ENDPOINT}"
echo "Firestore database: ${FIRESTORE_DATABASE_ID}"
echo "Artifact bucket: gs://${ARTIFACT_BUCKET}"
echo "Image: ${IMAGE_URI}"
echo "Demo key secret: ${DEMO_SECRET_NAME} (value intentionally not printed)"
}

required_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

validate_inputs() {
  [[ "${PROJECT_ID}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || {
    echo "PROJECT_ID is not a valid Google Cloud project ID." >&2
    exit 1
  }
  [[ "${REGION}" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || {
    echo "REGION must be a concrete Google Cloud region." >&2
    exit 1
  }
  [[ "${FIRESTORE_LOCATION}" =~ ^[a-z0-9-]+$ ]] || {
    echo "FIRESTORE_LOCATION contains unsupported characters." >&2
    exit 1
  }
  if [[ "${FIRESTORE_DATABASE_ID}" != "(default)" ]] && \
    [[ ! "${FIRESTORE_DATABASE_ID}" =~ ^[a-z][a-z0-9-]{2,61}[a-z0-9]$ ]]; then
    echo "FIRESTORE_DATABASE_ID is not a supported Firestore database ID." >&2
    exit 1
  fi
  for resource_name in \
    "${SERVICE_NAME}" \
    "${TOPIC_NAME}" \
    "${SUBSCRIPTION_NAME}" \
    "${RUNTIME_SERVICE_ACCOUNT_NAME}" \
    "${PUSH_SERVICE_ACCOUNT_NAME}" \
    "${ARTIFACT_REPOSITORY}" \
    "${DEMO_SECRET_NAME}"; do
    [[ "${resource_name}" =~ ^[a-z][a-z0-9-]{2,62}$ ]] || {
      echo "Invalid resource name: ${resource_name}" >&2
      exit 1
    }
  done
  [[ "${ARTIFACT_BUCKET}" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || {
    echo "ARTIFACT_BUCKET is not a valid Cloud Storage bucket name." >&2
    exit 1
  }
  [[ "${IMAGE_TAG}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || {
    echo "IMAGE_TAG is not a valid container tag." >&2
    exit 1
  }
  if [[ ! "${MAX_INSTANCES}" =~ ^[0-9]+$ ]] || (( MAX_INSTANCES < 1 || MAX_INSTANCES > 10 )); then
    echo "MAX_INSTANCES must be between 1 and 10." >&2
    exit 1
  fi
  if [[ ! "${CONCURRENCY}" =~ ^[0-9]+$ ]] || (( CONCURRENCY < 1 || CONCURRENCY > 20 )); then
    echo "CONCURRENCY must be between 1 and 20." >&2
    exit 1
  fi
  if [[ ! "${MAX_MODEL_SPEND_USD}" =~ ^[0-9]+([.][0-9]+)?$ ]] || \
    ! awk -v spend="${MAX_MODEL_SPEND_USD}" 'BEGIN { exit !(spend > 0 && spend <= 100) }'; then
    echo "MAX_MODEL_SPEND_USD must be greater than 0 and at most 100." >&2
    exit 1
  fi
  if [[ ! "${DEMO_DAILY_START_LIMIT}" =~ ^[0-9]+$ ]] || \
    (( DEMO_DAILY_START_LIMIT < 1 || DEMO_DAILY_START_LIMIT > 100 )); then
    echo "DEMO_DAILY_START_LIMIT must be between 1 and 100." >&2
    exit 1
  fi
  if [[ ! "${DEMO_START_COOLDOWN_SECONDS}" =~ ^[0-9]+$ ]] || \
    (( DEMO_START_COOLDOWN_SECONDS > 3600 )); then
    echo "DEMO_START_COOLDOWN_SECONDS must be between 0 and 3600." >&2
    exit 1
  fi
  [[ "${ROTATE_DEMO_KEY}" == "true" || "${ROTATE_DEMO_KEY}" == "false" ]] || {
    echo "ROTATE_DEMO_KEY must be true or false." >&2
    exit 1
  }
}

ensure_service_account() {
  local account_name="$1"
  local display_name="$2"
  if ! gcloud iam service-accounts describe \
    "${account_name}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${account_name}" \
      --display-name="${display_name}" \
      --project="${PROJECT_ID}"
  fi
}

ensure_service_account_role() {
  local service_account="$1"
  local member="$2"
  local role="$3"
  gcloud iam service-accounts add-iam-policy-binding "${service_account}" \
    --member="${member}" \
    --role="${role}" \
    --condition=None \
    --project="${PROJECT_ID}" >/dev/null
}

ensure_project_role() {
  local member="$1"
  local role="$2"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="${member}" \
    --role="${role}" \
    --condition=None \
    --project="${PROJECT_ID}" >/dev/null
}

ensure_bucket_role() {
  local member="$1"
  local role="$2"
  gcloud storage buckets add-iam-policy-binding "gs://${ARTIFACT_BUCKET}" \
    --member="${member}" \
    --role="${role}" \
    --project="${PROJECT_ID}" >/dev/null
}

ensure_secret_role() {
  local member="$1"
  local role="$2"
  gcloud secrets add-iam-policy-binding "${DEMO_SECRET_NAME}" \
    --member="${member}" \
    --role="${role}" \
    --project="${PROJECT_ID}" >/dev/null
}

ensure_topic_role() {
  local member="$1"
  local role="$2"
  gcloud pubsub topics add-iam-policy-binding "${TOPIC_NAME}" \
    --member="${member}" \
    --role="${role}" \
    --project="${PROJECT_ID}" >/dev/null
}

ensure_repository_role() {
  local member="$1"
  local role="$2"
  gcloud artifacts repositories add-iam-policy-binding "${ARTIFACT_REPOSITORY}" \
    --location="${REGION}" \
    --member="${member}" \
    --role="${role}" \
    --project="${PROJECT_ID}" >/dev/null
}

main "$@"
