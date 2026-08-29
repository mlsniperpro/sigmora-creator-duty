const byId = (id) => document.getElementById(id);
const terminalStages = new Set(["complete", "closed", "blocked", "exception"]);
const stageOrder = ["received", "planning", "producing", "validating", "publishing", "verifying", "complete"];
let system = null;
let campaign = null;
let demoKey = sessionStorage.getItem("creatorDutyDemoKey") || "";
let busy = false;

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (demoKey) headers["x-demo-key"] = demoKey;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && path.includes("/api/demo/")) {
    const supplied = window.prompt("Enter the judge demo key for event actions:");
    if (supplied) {
      demoKey = supplied;
      sessionStorage.setItem("creatorDutyDemoKey", supplied);
      return api(path, options);
    }
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.message || error.error || `Request failed: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function loadSystem() {
  try {
    system = await api("/api/system");
    byId("health-dot").classList.add("online");
    byId("health-label").textContent = system.environment === "production" ? "Cloud service ready" : "Local service ready";
    byId("transport-pill").textContent = system.eventTransport;
    byId("model-pill").textContent = system.primaryModel;
    const googleBacked = system.modelProvider === "vertex_ai" || system.modelProvider === "gemini_api";
    byId("planning-provider").textContent = googleBacked ? "Gemini structured choice" : "typed structured choice";
    byId("authority-copy").textContent = `${googleBacked ? "Gemini" : "The configured model"} proposes. Typed code decides whether any side effect is allowed.`;
  } catch (error) {
    byId("health-label").textContent = "Service unavailable";
    setMessage(error.message, true);
  }
}

async function poll() {
  try {
    const payload = await api("/api/campaigns/latest");
    campaign = payload.campaign || null;
    render(campaign);
    if (campaign && terminalStages.has(campaign.stage)) setBusy(false);
  } catch (error) {
    if (!String(error.message).includes("not_found")) setMessage(error.message, true);
  } finally {
    window.setTimeout(poll, campaign && !terminalStages.has(campaign.stage) ? 600 : 1_500);
  }
}

async function action(name) {
  setBusy(true);
  setMessage(`${name === "start" ? "Delivering a fresh live-start event" : name === "replay" ? "Replaying the exact event ID" : "Delivering live-ended event"}…`);
  try {
    const receipt = await api(`/api/demo/${name}`, { method: "POST", body: "{}" });
    setMessage(`${receipt.transport === "pubsub" ? "Published to Pub/Sub" : "Processed locally"}: ${receipt.eventId}`);
    if (receipt.result) renderResult(receipt.result);
  } catch (error) {
    setMessage(error.message, true);
    setBusy(false);
  }
}

function render(value) {
  if (!value) return;
  const receipts = value.receipts || [];
  const verified = receipts.filter((receipt) => receipt.status === "verified");
  const promo = (value.artifacts || []).find((artifact) => artifact.kind === "promo_video");
  const latestStep = [...(value.steps || [])].reverse().find((step) => step.status === "running");

  byId("metric-actions").textContent = String(value.metrics?.humanActions ?? 0);
  byId("metric-stage").textContent = title(value.stage);
  byId("metric-outcome").textContent = value.outcome || latestStep?.tool || "workflow running";
  byId("metric-channels").textContent = `${verified.length} / ${value.plan?.channels?.length || 4}`;
  byId("metric-duplicates").textContent = String(value.metrics?.duplicatePosts ?? 0);
  byId("metric-elapsed").textContent = value.metrics?.elapsedMs ? `${(value.metrics.elapsedMs / 1000).toFixed(1)}s` : "—";
  byId("trace-id").textContent = `trace: ${value.traceId}`;
  byId("event-id").textContent = value.eventId;
  byId("creator-id").textContent = value.creatorId;
  byId("stream-id").textContent = value.streamId;
  byId("claim-status").textContent = value.stage === "received" ? "Claimed" : "Unique + persisted";

  renderWorkflow(value.stage);
  renderPlan(value);
  renderArtifact(value, promo);
  renderPolicy(value.validation);
  renderReceipts(receipts);
  renderSteps(value.steps || []);
  renderVariants(value.variants || []);
  renderRecap(value.recap);
  byId("retry-status").textContent = `${value.metrics?.retryCount || 0} RETR${value.metrics?.retryCount === 1 ? "Y" : "IES"}`;
}

function renderWorkflow(stage) {
  const current = stage === "recapping" || stage === "closed" ? "complete" : stage;
  const currentIndex = stageOrder.indexOf(current);
  document.querySelectorAll("#workflow li").forEach((item, index) => {
    item.classList.toggle("active", index === currentIndex && !terminalStages.has(stage));
    item.classList.toggle("done", index < currentIndex || stage === "complete" || stage === "closed" || stage === "recapping");
  });
}

function renderPlan(value) {
  const plan = value.plan;
  byId("model-evidence").textContent = value.primaryModel || "NO TRACE";
  byId("model-evidence").className = `tag ${value.invocations?.length ? "success" : ""}`;
  byId("model-calls").textContent = String(value.invocations?.length || 0);
  if (!plan) return;
  byId("plan-hook").textContent = `“${plan.hook}”`;
  byId("plan-angle").textContent = plan.angle;
  byId("plan-moment").textContent = `${plan.selectedMoment.startSeconds}s–${plan.selectedMoment.endSeconds}s`;
  byId("plan-tone").textContent = title(plan.tone);
}

function renderArtifact(value, promo) {
  if (!promo) return;
  byId("artifact-status").textContent = "IMMUTABLE";
  byId("artifact-status").className = "tag success";
  byId("artifact-id").textContent = `artifact: ${promo.artifactId}`;
  byId("artifact-duration").textContent = `${promo.width}×${promo.height} · ${promo.durationSeconds}s`;
  const video = byId("promo-video");
  const desired = `/api/campaigns/${encodeURIComponent(value.campaignId)}/artifacts/${encodeURIComponent(promo.artifactId)}`;
  if (video.getAttribute("src") !== desired) video.setAttribute("src", desired);
  video.hidden = false;
  byId("promo-placeholder").hidden = true;
}

function renderPolicy(validation) {
  const container = byId("policy-checks");
  if (!validation) return;
  byId("policy-status").textContent = validation.passed ? "PASSED" : "BLOCKED";
  byId("policy-status").className = `tag ${validation.passed ? "success" : "failure"}`;
  container.replaceChildren(...validation.checks.map((check) => {
    const item = element("div", `check ${check.passed ? "" : "failed"}`);
    item.append(element("i", "", check.passed ? "✓" : "×"));
    const copy = element("span", "", check.code.replaceAll("_", " "));
    copy.append(element("small", "", check.detail));
    item.append(copy);
    return item;
  }));
}

function renderReceipts(receipts) {
  const container = byId("receipts");
  if (!receipts.length) return;
  const verified = receipts.filter((receipt) => receipt.status === "verified").length;
  byId("receipt-status").textContent = `${verified} VERIFIED`;
  byId("receipt-status").className = `tag ${verified === receipts.length ? "success" : "warning"}`;
  container.replaceChildren(...receipts.map((receipt) => {
    const item = element("div", "receipt");
    item.append(element("span", "channel-icon", receipt.channel.slice(0, 2)));
    const copy = element("span", "", title(receipt.channel));
    copy.append(element("small", "", `attempt ${receipt.attempt} · ${receipt.providerPostId || receipt.errorCode || "pending"}`));
    item.append(copy);
    item.append(element("strong", receipt.status, receipt.status));
    return item;
  }));
}

function renderSteps(steps) {
  const container = byId("trace-list");
  if (!steps.length) return;
  container.replaceChildren(...steps.slice(-8).reverse().map((step) => {
    const item = element("div", "trace-step");
    item.append(element("b", "", step.status === "failed" ? "!" : step.status === "running" ? "…" : "✓"));
    const copy = element("span", "", step.tool.replaceAll("_", " "));
    copy.append(element("small", "", `${step.stepId} · attempt ${step.attempt}${step.model ? ` · ${step.model}` : ""}`));
    item.append(copy);
    item.append(element("time", "", step.outcome || step.status));
    return item;
  }));
}

function renderVariants(variants) {
  if (!variants.length) return;
  byId("variant-count").textContent = `${variants.length} VARIANTS`;
  byId("variant-count").className = "tag success";
  byId("variants").replaceChildren(...variants.map((variant) => {
    const item = element("article", "variant");
    const header = document.createElement("header");
    header.append(element("span", "", title(variant.channel)), element("span", "", `${variant.copy.length} chars`));
    item.append(header, element("p", "", variant.copy));
    return item;
  }));
}

function renderRecap(recap) {
  if (!recap) return;
  byId("recap-status").textContent = "CAMPAIGN CLOSED";
  byId("recap-status").className = "tag success";
  byId("recap-headline").textContent = recap.headline;
  byId("recap-summary").textContent = recap.summary;
  byId("clusters").replaceChildren(...recap.questionClusters.map((cluster) => element("span", "cluster", `${cluster.theme} · ${cluster.questions.length}`)));
}

function renderResult(result) {
  if (result.disposition === "duplicate_ignored") {
    setMessage(`duplicate_ignored · ${result.eventId} created no second campaign or posts.`);
    byId("claim-status").textContent = "duplicate_ignored";
  }
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll(".hero-actions button").forEach((button) => { button.disabled = busy; });
}

function setMessage(message, error = false) {
  byId("action-message").textContent = message;
  byId("action-message").style.color = error ? "var(--red)" : "var(--faint)";
}

function title(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

byId("start-button").addEventListener("click", () => action("start"));
byId("replay-button").addEventListener("click", () => action("replay"));
byId("end-button").addEventListener("click", () => action("end"));
loadSystem();
poll();
