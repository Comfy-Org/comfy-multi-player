import { filterOptions, filterSteps, loadTrace, targetLabel } from "./loader.mjs";

const state = { trace: null, steps: [], index: 0 };
const $ = (selector) => document.querySelector(selector);

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function optionList(select, values) {
  select.innerHTML = `<option value="">All</option>${values.map((value) => `<option>${escape(value)}</option>`).join("")}`;
}

function graph(projection) {
  const nodes = projection.nodes.map((node) => `<article class="node"><strong>${escape(node.type ?? "node")}</strong><span>#${escape(node.id)}</span><small>${escape(JSON.stringify(node.widgets_values ?? []))}</small></article>`).join("");
  const links = projection.links.map((link) => `<li>${escape(JSON.stringify(link))}</li>`).join("");
  return `<div class="nodes">${nodes || '<p class="empty">No nodes</p>'}</div><details><summary>${projection.links.length} link(s)</summary><ul>${links}</ul></details>`;
}

function render() {
  const step = state.steps[state.index];
  $("#count").textContent = `${state.steps.length ? state.index + 1 : 0} / ${state.steps.length}`;
  $("#scrubber").max = Math.max(0, state.steps.length - 1);
  $("#scrubber").value = state.index;
  if (!step) {
    $("#step").innerHTML = '<p class="empty">No steps match these filters.</p>';
    $("#before").innerHTML = $("#after").innerHTML = "";
    return;
  }
  if (step.kind !== "semantic-op") {
    $("#step").innerHTML = `<h2>${escape(step.kind)}</h2><p>Captured lifecycle fact at arrival ${step.arrival_index}.</p>`;
    $("#before").innerHTML = $("#after").innerHTML = '<p class="empty">Projection snapshots are not part of this lifecycle step.</p>';
    return;
  }
  const evidence = step.decision_evidence.kind === "lww-comparison"
    ? `winner ${JSON.stringify(step.decision_evidence.winning_stamp)} over ${JSON.stringify(step.decision_evidence.losing_stamp)}`
    : step.decision_evidence.kind;
  $("#step").innerHTML = `<div><span class="outcome ${escape(step.outcome)}">${escape(step.outcome)}</span><h2>${escape(step.verb)}</h2></div><dl><dt>Actor</dt><dd>${escape(step.actor)}</dd><dt>Target</dt><dd>${step.targets.map(targetLabel).map(escape).join(", ")}</dd><dt>Stamp</dt><dd>${escape(JSON.stringify(step.stamp))}</dd><dt>Base</dt><dd>${step.base_version}</dd><dt>Arrival</dt><dd>${step.arrival_index}</dd><dt>Reason</dt><dd>${escape(step.reason_code)}; ${escape(evidence)}</dd><dt>Op ID</dt><dd><code>${escape(step.op_id)}</code></dd></dl>`;
  $("#before").innerHTML = graph(step.before_projection);
  $("#after").innerHTML = graph(step.after_projection);
}

function applyFilters() {
  state.steps = filterSteps(state.trace, { actors: [$("#actor").value].filter(Boolean), outcomes: [$("#outcome").value].filter(Boolean), targets: [$("#target").value].filter(Boolean) });
  state.index = 0;
  render();
}

function setTrace(raw) {
  state.trace = loadTrace(raw);
  const options = filterOptions(state.trace);
  optionList($("#actor"), options.actors); optionList($("#outcome"), options.outcomes); optionList($("#target"), options.targets);
  $("#title").textContent = state.trace.run.test;
  $("#source").textContent = `${state.trace.run.source.cmp_sha.slice(0, 12)} · seed ${state.trace.run.seed}`;
  applyFilters();
}

for (const id of ["actor", "outcome", "target"]) $(`#${id}`).addEventListener("change", applyFilters);
$("#scrubber").addEventListener("input", (event) => { state.index = Number(event.target.value); render(); });
$("#prev").addEventListener("click", () => { state.index = Math.max(0, state.index - 1); render(); });
$("#next").addEventListener("click", () => { state.index = Math.min(state.steps.length - 1, state.index + 1); render(); });
$("#file").addEventListener("change", async (event) => { try { setTrace(await event.target.files[0].text()); } catch (error) { alert(error.message); } });

fetch("./fixtures/lww-evidence.json").then((response) => response.text()).then(setTrace).catch((error) => { $("#step").textContent = error.message; });
