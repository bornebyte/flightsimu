import { applyRecoveryAction, formatTime, generateRecoveryCandidates, simulateScenario } from "/lib/simulation-engine.js";

const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
const formatter = new Intl.NumberFormat("en-IN");
const PROGRESS_STEPS = ["Airport closure locked", "Aircraft rotations propagated", "Crew duty checked", "Passenger connections checked", "Recovery options evaluated", "Simulation complete"];
const PRESETS = {
  mumbai: { airportId: "BOM", closureStart: "10:00", closureDurationMinutes: 90 },
  bengaluru: { airportId: "BLR", closureStart: "12:00", closureDurationMinutes: 60 },
  delhi: { airportId: "DEL", closureStart: "09:00", closureDurationMinutes: 120 }
};

const state = {
  dataset: null,
  result: null,
  hasRun: false,
  isSimulating: false,
  progressIndex: 0,
  selectedAirport: "BOM",
  closureStart: "10:00",
  closureDurationMinutes: 90,
  selectedFlightId: null,
  filter: "ALL",
  search: "",
  candidates: [],
  recommendation: null,
  isAskingDispatcher: false,
  comparison: null,
  modalOpen: false,
  aiUnavailableMessage: ""
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const number = (value) => formatter.format(value ?? 0);
const delayLabel = (value) => `${value > 0 ? "+" : ""}${number(value)} min`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emptyBaseResult(dataset) {
  return simulateScenario({ dataset, airportId: "BOM", closureStart: "23:59", closureDurationMinutes: 1 });
}

function airportById(id) {
  return state.dataset.airports.find((airport) => airport.id === id);
}

function flightById(id) {
  return state.result?.flights.find((flight) => flight.flightId === id);
}

function statusLabel(status) {
  return ({
    ON_TIME: "On time",
    DELAYED: "Delayed",
    CANCELLED: "Cancelled",
    AIRPORT_CLOSED: "Airport closure",
    AIRCRAFT_DELAYED: "Aircraft delay",
    CREW_CONSTRAINT: "Crew constraint",
    CONNECTION_IMPACT: "Connection impact"
  })[status] || status;
}

function flightRows() {
  if (!state.hasRun) return state.dataset.flights.map((raw) => ({
    flightId: raw.flight_id,
    tailId: raw.tail_id,
    origin: raw.origin,
    destination: raw.destination,
    scheduledDeparture: parseLocal(raw.dep),
    scheduledArrival: parseLocal(raw.arr),
    actualDeparture: parseLocal(raw.dep),
    actualArrival: parseLocal(raw.arr),
    departureDelay: 0,
    arrivalDelay: 0,
    passengers: raw.pax,
    status: "ON_TIME",
    delayReasons: [],
    legOrder: raw.leg_order
  }));
  return state.result.flights;
}

function parseLocal(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function mapSvg() {
  const flights = flightRows();
  const routeMap = new Map();
  for (const flight of flights) {
    const key = `${flight.origin}-${flight.destination}`;
    const severity = flight.status === "CANCELLED" ? 4 : flight.status === "AIRPORT_CLOSED" || flight.status === "CREW_CONSTRAINT" ? 3 : flight.arrivalDelay >= 60 ? 3 : flight.status === "ON_TIME" ? 0 : 2;
    const existing = routeMap.get(key) || { origin: flight.origin, destination: flight.destination, count: 0, severity: 0, flightIds: [] };
    existing.count += 1;
    existing.severity = Math.max(existing.severity, severity);
    existing.flightIds.push(flight.flightId);
    routeMap.set(key, existing);
  }
  const project = (airport) => ({
    x: 46 + ((airport.lng - 68) / 26) * 508,
    y: 488 - ((airport.lat - 7.5) / 25.5) * 438
  });
  const routes = [...routeMap.values()].map((route, index) => {
    const a = project(airportById(route.origin));
    const b = project(airportById(route.destination));
    const curve = ((index % 5) - 2) * 7;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + curve;
    const kind = route.severity >= 4 ? "route-cancelled" : route.severity >= 3 ? "route-critical" : route.severity === 2 ? "route-delayed" : "route-normal";
    const title = `${route.origin} → ${route.destination}: ${route.flightIds.length} scheduled flight${route.flightIds.length === 1 ? "" : "s"}${route.severity ? ", affected" : ""}`;
    return `<g class="route-group ${kind}" aria-label="${esc(title)}"><path d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}"><title>${esc(title)}</title></path><circle class="route-dot" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="2.1" /></g>`;
  }).join("");

  const airports = state.dataset.airports.map((airport) => {
    const point = project(airport);
    const atAirport = flights.filter((flight) => flight.origin === airport.id || flight.destination === airport.id);
    const affected = state.hasRun ? atAirport.filter((flight) => flight.status !== "ON_TIME") : [];
    const isClosed = state.hasRun && state.result.incident.airportId === airport.id;
    const critical = affected.some((flight) => flight.arrivalDelay >= 60) || affected.length >= 4;
    const cls = isClosed ? "airport-closed" : critical ? "airport-critical" : affected.length ? "airport-affected" : "airport-normal";
    const selected = state.selectedAirport === airport.id;
    const radius = airport.tier === "mega_hub" ? 7 : airport.tier === "regional_hub" ? 5.5 : 4.5;
    const labelY = point.y - 12;
    const aria = `${airport.city} ${airport.id}, ${isClosed ? "closed" : affected.length ? `${affected.length} affected flights` : "normal"}. Select airport.`;
    return `<g class="airport-node ${cls} ${selected ? "selected" : ""}" role="button" tabindex="0" data-action="select-airport" data-airport="${esc(airport.id)}" aria-label="${esc(aria)}"><circle class="airport-halo" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius + 7}"/><circle class="airport-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius}"/><text x="${point.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${esc(airport.id)}</text><title>${esc(`${airport.city} · ${airport.id}`)}</title></g>`;
  }).join("");

  return `<svg class="network-svg" viewBox="0 0 600 530" role="img" aria-label="Interactive flight network map of India showing ${state.dataset.airports.length} airports and ${state.dataset.flights.length} scheduled flights"><defs><pattern id="map-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(131,165,190,.08)" stroke-width="1"/></pattern><radialGradient id="map-glow"><stop offset="0" stop-color="#134164" stop-opacity=".3"/><stop offset="1" stop-color="#08111c" stop-opacity="0"/></radialGradient></defs><rect width="600" height="530" fill="url(#map-glow)"/><rect width="600" height="530" fill="url(#map-grid)"/><path class="india-ghost" d="M 190 55 L 230 75 L 244 100 L 267 105 L 276 125 L 300 142 L 282 167 L 298 197 L 277 218 L 283 252 L 263 274 L 267 302 L 251 324 L 240 352 L 222 379 L 206 405 L 194 431 L 182 400 L 168 370 L 156 339 L 145 310 L 128 282 L 119 247 L 110 215 L 119 185 L 135 160 L 143 130 L 164 111 L 173 82 Z"/><path class="north-east-ghost" d="M 380 140 L 414 124 L 457 137 L 482 155 L 461 170 L 425 163 L 400 175 L 380 164 Z"/>${routes}${airports}</svg>`;
}

function metricsMarkup() {
  const m = state.result.metrics;
  const items = [
    { label: "Network flights", value: number(m.totalFlights), suffix: "scheduled", tone: "blue", icon: "✈" },
    { label: "Affected flights", value: number(m.affectedFlights), suffix: `${number(m.cancelledFlights)} cancelled`, tone: m.affectedFlights ? "amber" : "green", icon: "◉" },
    { label: "Arrival delay", value: number(m.totalDelayMinutes), suffix: "minutes total", tone: m.totalDelayMinutes ? "amber" : "green", icon: "◷" },
    { label: "Stranded passengers", value: number(m.strandedPassengers), suffix: `${number(m.brokenConnections)} broken connections`, tone: m.strandedPassengers ? "red" : "green", icon: "↗" },
    { label: "Crew violations", value: number(m.crewDutyViolations), suffix: `${number(m.affectedCrews)} crews monitored`, tone: m.crewDutyViolations ? "red" : "green", icon: "♙" },
    { label: "Aircraft affected", value: number(m.affectedAircraft), suffix: `${number(m.activeAircraft)} tails in service`, tone: m.affectedAircraft ? "amber" : "green", icon: "⌁" }
  ];
  return items.map((item) => `<article class="metric-card tone-${item.tone}"><div class="metric-top"><span>${esc(item.label)}</span><span class="metric-icon" aria-hidden="true">${item.icon}</span></div><strong>${item.value}</strong><small>${esc(item.suffix)}</small></article>`).join("");
}

function airportOptions(selected) {
  return state.dataset.airports.map((airport) => `<option value="${esc(airport.id)}" ${airport.id === selected ? "selected" : ""}>${esc(airport.city)} · ${esc(airport.id)}</option>`).join("");
}

function airportInfoMarkup() {
  const airport = airportById(state.selectedAirport);
  const scheduled = state.dataset.flights.filter((flight) => flight.origin === airport.id || flight.destination === airport.id);
  const affected = state.hasRun ? scheduled.filter((raw) => flightById(raw.flight_id)?.status !== "ON_TIME") : [];
  const incoming = scheduled.filter((flight) => flight.destination === airport.id).length;
  const outgoing = scheduled.filter((flight) => flight.origin === airport.id).length;
  const incidentAirport = state.hasRun && state.result.incident.airportId === airport.id;
  return `<div class="airport-info-head"><div><span class="eyebrow">SELECTED AIRPORT</span><h3>${esc(airport.id)} <span>· ${esc(airport.city)}</span></h3></div><span class="status-pill ${incidentAirport ? "pill-critical" : affected.length ? "pill-warning" : "pill-healthy"}"><i></i>${incidentAirport ? "CLOSED" : affected.length ? "AFFECTED" : "NORMAL"}</span></div><p class="airport-full-name">${esc(airport.name)}</p><div class="airport-stats"><div><b>${airport.capacity_per_hour}</b><span>capacity / hr</span></div><div><b>${incoming}</b><span>inbound</span></div><div><b>${outgoing}</b><span>outbound</span></div></div><div class="airport-impact-line"><span>${affected.length ? `${affected.length} affected flight legs` : "No affected flight legs"}</span><span>${airport.tier.replace("_", " ")}</span></div>`;
}

function candidatesForRun() {
  return state.candidates;
}

function candidateDelta(candidate) {
  const before = state.result.metrics;
  const after = candidate.result.metrics;
  return {
    delay: before.totalDelayMinutes - after.totalDelayMinutes,
    broken: before.brokenConnections - after.brokenConnections,
    stranded: before.strandedPassengers - after.strandedPassengers,
    crew: before.crewDutyViolations - after.crewDutyViolations,
    cancelled: after.cancelledFlights - before.cancelledFlights
  };
}

function chooseDemoRecommendation() {
  const candidates = candidatesForRun();
  if (!candidates.length) {
    return {
      mode: "DEMO MODE",
      assessment: `The ${state.result.incident.airportId} closure was evaluated across the full network. No validated recovery action is available for the affected rotations.`,
      bottlenecks: state.result.cascade.slice(0, 3).map((event) => `${event.flightId} · ${event.reason}`),
      actionId: null,
      reason: "Maintain the current plan and monitor the affected rotation.",
      tradeoffs: ["No spare aircraft is positioned at the disrupted departure airports."]
    };
  }
  const spareCandidates = candidates.filter((candidate) => candidate.action.type === "SWAP_SPARE_AIRCRAFT" && candidateDelta(candidate).delay > 0 && candidateDelta(candidate).cancelled <= 0);
  const ranked = spareCandidates.length ? spareCandidates : candidates.filter((candidate) => candidate.action.type === "CANCEL_FLIGHT").sort((a, b) => {
    const aDelta = candidateDelta(a);
    const bDelta = candidateDelta(b);
    return aDelta.cancelled - bDelta.cancelled || bDelta.delay - aDelta.delay || a.action.flightId.localeCompare(b.action.flightId);
  });
  const pick = ranked[0];
  const deltas = candidateDelta(pick);
  const bottlenecks = state.result.cascade.slice(0, 3).map((event) => {
    const suffix = event.delayMinutes ? ` · ${event.delayMinutes} min arrival delay` : "";
    return `${event.flightId} · ${event.origin} → ${event.destination}${suffix}`;
  });
  const reason = pick.action.type === "SWAP_SPARE_AIRCRAFT"
    ? `${pick.action.spareAircraftId} is based at ${pick.action.flightId ? airportById(pick.result.flights.find((flight) => flight.flightId === pick.action.flightId).origin).id : "its base hub"}; the engine schedules it on ${pick.action.flightId} and replays the remaining rotation.`
    : `Cancel ${pick.action.flightId} to cap delay on this tail. This removes ${number(Math.max(0, deltas.delay))} arrival-delay minutes and adds ${number(deltas.cancelled)} cancellation${deltas.cancelled === 1 ? "" : "s"}; the comparison shows the passenger and service cost.`;
  const tradeoffs = [
    deltas.cancelled ? `${number(deltas.cancelled)} additional flight cancellation${deltas.cancelled === 1 ? "" : "s"} affecting ${number(pick.result.metrics.cancelledPassengers - state.result.metrics.cancelledPassengers)} passengers.` : "The spare aircraft is consumed for the remaining reassigned rotation.",
    deltas.stranded < 0 ? `${number(-deltas.stranded)} additional passengers are stranded.` : deltas.broken < 0 ? `${number(-deltas.broken)} additional connection${deltas.broken === -1 ? "" : "s"} break.` : "Review the downstream connection and crew changes before committing."
  ];
  return {
    mode: "DEMO MODE",
    assessment: `The ${state.result.incident.airportId} closure affects ${number(state.result.metrics.affectedFlights)} flight legs. ${number(state.result.metrics.totalDelayMinutes)} arrival-delay minutes are currently recorded; impacts are calculated from the supplied rotations.`,
    bottlenecks,
    actionId: pick.id,
    reason,
    tradeoffs
  };
}

function dispatcherMarkup() {
  if (!state.hasRun) {
    return `<div class="dispatcher-empty"><div class="ai-orb">✦</div><p>Run a scenario to give the dispatcher an authoritative network state.</p></div>`;
  }
  const recommendation = state.recommendation || chooseDemoRecommendation();
  const candidate = state.candidates.find((item) => item.id === recommendation.actionId);
  const title = candidate?.label || "Monitor current rotation";
  const delta = candidate ? candidateDelta(candidate) : null;
  return `<div class="dispatcher-top"><div class="ai-orb">✦</div><div><span class="eyebrow">${esc(recommendation.mode || "DEMO MODE")}</span><h3>Network assessment</h3></div><span class="live-dot" aria-label="Dispatcher ready"></span></div>${state.aiUnavailableMessage ? `<div class="ai-fallback-note">${esc(state.aiUnavailableMessage)}</div>` : ""}<p class="assessment-copy">${esc(recommendation.assessment)}</p><div class="dispatcher-section"><span class="section-label">BOTTLENECKS</span>${recommendation.bottlenecks?.length ? `<ul class="compact-list">${recommendation.bottlenecks.slice(0, 3).map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : `<p class="muted-copy">No major bottlenecks detected.</p>`}</div><div class="recommendation-box"><div class="recommendation-heading"><span class="section-label">RECOMMENDED ACTION</span><span class="recommendation-index">${candidate ? "ENGINE EVALUATED" : "OBSERVE"}</span></div><h4>${esc(title)}</h4><p>${esc(recommendation.reason)}</p>${candidate ? `<div class="impact-chips"><span class="chip ${delta.delay > 0 ? "chip-good" : "chip-neutral"}">${delta.delay > 0 ? `−${number(delta.delay)} min delay` : `${number(Math.abs(delta.delay))} min delay Δ`}</span><span class="chip ${delta.cancelled > 0 ? "chip-bad" : "chip-good"}">${delta.cancelled > 0 ? `+${number(delta.cancelled)} cancel` : `${number(Math.max(0, -delta.cancelled))} cancel`}</span><span class="chip">${number(candidate.result.metrics.strandedPassengers)} stranded after</span></div>` : ""}<div class="dispatcher-section tradeoff-section"><span class="section-label">TRADE-OFFS</span><ul class="compact-list">${(recommendation.tradeoffs || []).map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>${candidate ? `<button class="button button-primary button-full" data-action="apply-recommendation" ${state.isSimulating || state.comparison ? "disabled" : ""}>${state.comparison ? "ACTION APPLIED" : "APPLY RECOMMENDATION"}<span aria-hidden="true">→</span></button>` : `<button class="button button-secondary button-full" data-action="refresh-recommendation" ${state.isSimulating ? "disabled" : ""}>REFRESH DISPATCHER</button>`}<div class="dispatcher-actions"><button class="text-button" data-action="ask-dispatcher" ${state.isAskingDispatcher || state.isSimulating ? "disabled" : ""}>${state.isAskingDispatcher ? "ANALYZING…" : "ASK DISPATCHER"}</button>${candidate && state.candidates.length > 1 ? `<button class="text-button" data-action="alternative" ${state.comparison ? "disabled" : ""}>SIMULATE ALTERNATIVE</button>` : ""}</div></div>`;
}

function cascadeMarkup() {
  if (!state.hasRun) return `<div class="empty-state"><span class="empty-icon">⌁</span><b>Network is ready</b><p>Choose an airport closure and run the simulator to reveal the domino chain.</p></div>`;
  if (!state.result.cascade.length) return `<div class="empty-state compact-empty"><span class="empty-icon">✓</span><b>No cascading delays</b><p>No scheduled movement overlapped this closure window.</p></div>`;
  return `<ol class="cascade-list">${state.result.cascade.map((event, index) => {
    const mins = event.delayMinutes ? `+${number(event.delayMinutes)}m` : statusLabel(event.status);
    const cause = event.reasonCode === "AIRPORT_CLOSURE" ? "ROOT INCIDENT" : event.reasonCode === "AIRCRAFT_DELAY" ? `TAIL ${event.tailId}` : event.reasonCode;
    const chain = event.cascadePath?.length > 1 ? event.cascadePath.map((id) => `<button data-action="open-flight" data-flight="${esc(id)}">${esc(id)}</button>`).join(`<span aria-hidden="true">›</span>`) : "";
    return `<li class="cascade-event ${index === 0 ? "cascade-root" : ""}"><div class="cascade-marker"><span>${String(index + 1).padStart(2, "0")}</span></div><div class="cascade-content"><div class="cascade-meta"><time>${esc(formatTime(event.eventTime))} IST</time><span class="cascade-kind">${esc(cause)}</span></div><div class="cascade-title"><button data-action="open-flight" data-flight="${esc(event.flightId)}">${esc(event.flightId)}</button><span>${esc(event.origin)} → ${esc(event.destination)}</span><strong class="${event.delayMinutes >= 60 ? "text-red" : event.delayMinutes ? "text-amber" : ""}">${esc(mins)}</strong></div><p>${esc(event.reason)}</p>${chain ? `<div class="cascade-chain" aria-label="Cascade path">${chain}</div>` : ""}</div></li>`;
  }).join("")}</ol>`;
}

function passengerMarkup() {
  const metrics = state.result.metrics;
  const broken = state.result.connections.filter((connection) => connection.status === "BROKEN");
  const highest = [...broken].sort((a, b) => b.passengers - a.passengers)[0];
  return `<div class="passenger-kpi"><div><span class="eyebrow">PASSENGERS ON AFFECTED LEGS</span><b>${number(metrics.passengersOnAffectedFlights)}</b><small>flight segments exposed · may include connecting legs</small></div><span class="passenger-glyph">♙</span></div><div class="passenger-subgrid"><div><span>Broken connections</span><strong>${number(metrics.brokenConnections)} <small>/ ${number(metrics.monitoredConnections)}</small></strong></div><div><span>Stranded passengers</span><strong class="${metrics.strandedPassengers ? "text-red" : "text-green"}">${number(metrics.strandedPassengers)}</strong></div></div>${highest ? `<div class="highest-connection"><span class="section-label">HIGHEST IMPACT</span><b>${esc(highest.connectionId)} · ${number(highest.passengers)} passengers</b><small>${esc(highest.fromFlightId)} → ${esc(highest.toFlightId)} · ${esc(highest.reason)}</small></div>` : `<div class="connection-safe"><span class="safe-check">✓</span><span><b>All listed connections protected</b><small>${number(metrics.monitoredConnections)} transfer windows checked against actual times.</small></span></div>`}<div class="passenger-footnote">Passenger delay impact: <b>${number(metrics.totalPassengerDelayImpact)}</b> passenger-minutes</div>`;
}

function crewMarkup() {
  const crews = state.result.crews;
  const violations = crews.filter((crew) => crew.violation);
  return `<div class="panel-inline-stat ${violations.length ? "stat-danger" : "stat-good"}"><span>${violations.length ? "DUTY VIOLATIONS" : "ALL DUTY LIMITS CLEAR"}</span><b>${number(violations.length)} / ${number(crews.length)}</b></div><div class="crew-table-wrap"><table class="crew-table"><thead><tr><th>Crew / base</th><th>Projected end</th><th>Duty / limit</th><th>Status</th></tr></thead><tbody>${crews.map((crew) => `<tr class="${crew.violation ? "crew-violation" : ""}"><td><b>${esc(crew.crewId)}</b><small>${esc(crew.base)} · ${esc(crew.tailId)}</small></td><td>${esc(formatTime(crew.projectedEnd))}</td><td><span>${number(crew.projectedDutyMinutes)} / ${number(crew.maxDutyMinutes)}m</span><div class="duty-track"><i style="width:${Math.min(100, crew.projectedDutyMinutes / crew.maxDutyMinutes * 100)}%"></i></div></td><td><span class="status-pill ${crew.violation ? "pill-critical" : "pill-healthy"}"><i></i>${crew.violation ? "VIOLATION" : "CLEAR"}</span></td></tr>`).join("")}</tbody></table></div>`;
}

function flightTableMarkup() {
  const filtered = flightRows().filter((flight) => {
    const searchMatch = !state.search || `${flight.flightId} ${flight.tailId} ${flight.origin} ${flight.destination}`.toLowerCase().includes(state.search.toLowerCase());
    const statusMatch = state.filter === "ALL" || state.filter === "DELAYED" && (flight.arrivalDelay > 0 || flight.departureDelay > 0) || state.filter === "CANCELLED" && flight.status === "CANCELLED" || state.filter === "AFFECTED" && flight.status !== "ON_TIME" || state.filter === "ON_TIME" && flight.status === "ON_TIME";
    return searchMatch && statusMatch;
  });
  const filters = ["ALL", "DELAYED", "CANCELLED", "AFFECTED", "ON_TIME"];
  return `<div class="table-toolbar"><div class="filter-row" role="group" aria-label="Filter flights">${filters.map((filter) => `<button class="filter-chip ${state.filter === filter ? "active" : ""}" data-action="filter" data-filter="${filter}" aria-pressed="${state.filter === filter}">${filter.replace("_", " ")}</button>`).join("")}</div><label class="search-field"><span aria-hidden="true">⌕</span><span class="sr-only">Search flights</span><input type="search" data-field="search" value="${esc(state.search)}" placeholder="Flight, tail or airport" /></label></div><div class="flight-table-wrap"><table class="flight-table"><thead><tr><th>Flight</th><th>Aircraft</th><th>Route</th><th>Sched. dep</th><th>Actual dep</th><th>Arrival delay</th><th>Sched. arr</th><th>Actual arr</th><th>Pax</th><th>Status / reason</th></tr></thead><tbody>${filtered.length ? filtered.map((flight) => {
    const reason = flight.delayReasons?.[0]?.message || (flight.status === "ON_TIME" ? "Rotation on schedule" : statusLabel(flight.status));
    return `<tr tabindex="0" role="button" aria-label="Open ${esc(flight.flightId)} flight details" data-action="open-flight" data-flight="${esc(flight.flightId)}" class="flight-row ${flight.status !== "ON_TIME" ? "row-affected" : ""}"><td><b>${esc(flight.flightId)}</b><small>Leg ${number(flight.legOrder)}</small></td><td>${esc(flight.tailId)}</td><td><span class="route-code">${esc(flight.origin)} <i>→</i> ${esc(flight.destination)}</span></td><td>${esc(formatTime(flight.scheduledDeparture))}</td><td>${esc(formatTime(flight.actualDeparture))}</td><td><b class="delay-cell ${flight.arrivalDelay >= 60 ? "text-red" : flight.arrivalDelay ? "text-amber" : "text-green"}">${flight.status === "CANCELLED" ? "—" : `${flight.arrivalDelay ? "+" : ""}${number(flight.arrivalDelay)}m`}</b></td><td>${esc(formatTime(flight.scheduledArrival))}</td><td>${esc(formatTime(flight.actualArrival))}</td><td>${number(flight.passengers)}</td><td><span class="status-pill ${flight.status === "ON_TIME" ? "pill-healthy" : flight.status === "CANCELLED" || flight.status === "CREW_CONSTRAINT" ? "pill-critical" : "pill-warning"}"><i></i>${esc(statusLabel(flight.status))}</span><small class="reason-preview">${esc(reason)}</small></td></tr>`;
  }).join("") : `<tr><td colspan="10"><div class="table-empty">No flights match this filter.</div></td></tr>`}</tbody></table></div><div class="table-footer"><span>Showing ${number(filtered.length)} of ${number(state.dataset.flights.length)} scheduled flights</span><span>Click a row to inspect its operational chain</span></div>`;
}

function flightDrawerMarkup() {
  const flight = flightById(state.selectedFlightId);
  if (!flight) return "";
  const raw = state.dataset.flights.find((item) => item.flight_id === flight.flightId);
  const previous = flight.previousFlightId ? flightById(flight.previousFlightId) : null;
  const crew = state.dataset.crews.find((item) => item.flight_ids.includes(flight.flightId));
  const flightConnections = state.result.connections.filter((item) => item.fromFlightId === flight.flightId || item.toFlightId === flight.flightId);
  const cascadeButtons = flight.cascadePath?.length ? flight.cascadePath.map((id) => `<button data-action="open-flight" data-flight="${esc(id)}" ${id === flight.flightId ? "disabled" : ""}>${esc(id)}</button>`).join(`<span aria-hidden="true">→</span>`) : `<span class="muted-copy">No upstream cascade</span>`;
  return `<div class="drawer-backdrop" data-action="close-drawer"><aside class="flight-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1"><div class="drawer-top"><div><span class="eyebrow">FLIGHT OPERATIONS DETAIL</span><h2 id="drawer-title">${esc(flight.flightId)}</h2></div><button class="icon-button" data-action="close-drawer" aria-label="Close flight detail">×</button></div><div class="drawer-route"><div><b>${esc(flight.origin)}</b><small>${esc(airportById(flight.origin).city)}</small></div><span>→</span><div><b>${esc(flight.destination)}</b><small>${esc(airportById(flight.destination).city)}</small></div></div><div class="drawer-status-line"><span class="status-pill ${flight.status === "ON_TIME" ? "pill-healthy" : flight.status === "CANCELLED" || flight.status === "CREW_CONSTRAINT" ? "pill-critical" : "pill-warning"}"><i></i>${esc(statusLabel(flight.status))}</span><strong class="${flight.arrivalDelay >= 60 ? "text-red" : flight.arrivalDelay ? "text-amber" : "text-green"}">${flight.status === "CANCELLED" ? "CANCELLED" : delayLabel(flight.arrivalDelay)}</strong></div><div class="drawer-time-grid"><div><span>Scheduled departure</span><b>${esc(formatTime(flight.scheduledDeparture))}</b></div><div><span>Actual departure</span><b>${esc(formatTime(flight.actualDeparture))}</b></div><div><span>Scheduled arrival</span><b>${esc(formatTime(flight.scheduledArrival))}</b></div><div><span>Actual arrival</span><b>${esc(formatTime(flight.actualArrival))}</b></div></div><div class="drawer-detail-row"><span>Aircraft</span><b>${esc(flight.tailId)} <small>· leg ${number(flight.legOrder)}</small></b></div><div class="drawer-detail-row"><span>Passengers</span><b>${number(flight.passengers)}</b></div><div class="drawer-detail-row"><span>Crew</span><b>${esc(crew?.crew_id || "—")} <small>· ${crew ? esc(crew.base) : ""}</small></b></div><div class="drawer-section"><span class="section-label">ROTATION CONSTRAINT</span><div class="rotation-box">${previous ? `<div><span>Previous flight</span><button data-action="open-flight" data-flight="${esc(previous.flightId)}">${esc(previous.flightId)} · ${esc(previous.origin)} → ${esc(previous.destination)}</button></div><div><span>Previous actual arrival</span><b>${esc(formatTime(previous.actualArrival))}</b></div>` : `<div><span>Previous flight</span><b>First scheduled leg on this tail</b></div>`}<div><span>Required turnaround</span><b>${number(raw.turnaround_before_min ?? state.dataset.meta.min_turnaround_minutes)} min</b></div></div></div><div class="drawer-section"><span class="section-label">ROOT CAUSE & REASONS</span><p class="root-cause">${esc(flight.rootCause || (flight.status === "ON_TIME" ? "No disruption cause" : statusLabel(flight.status)))}</p>${flight.delayReasons.length ? `<ul class="reason-list">${flight.delayReasons.map((reason) => `<li><span class="reason-bullet">•</span><span>${esc(reason.message)}</span></li>`).join("")}</ul>` : `<p class="muted-copy">No delay reasons recorded for this flight.</p>`}</div><div class="drawer-section"><span class="section-label">CASCADE PATH</span><div class="cascade-chain drawer-chain">${cascadeButtons}</div></div>${flightConnections.length ? `<div class="drawer-section"><span class="section-label">PASSENGER CONNECTIONS</span><ul class="connection-list">${flightConnections.map((connection) => `<li class="${connection.status === "BROKEN" ? "connection-broken" : ""}"><b>${esc(connection.connectionId)}</b><span>${esc(connection.fromFlightId)} → ${esc(connection.toFlightId)}</span><strong>${connection.availableMinutes === null ? "—" : `${number(connection.availableMinutes)}m`} / ${number(connection.minConnectMinutes)}m</strong><small>${esc(connection.reason)} · ${number(connection.passengers)} passengers</small></li>`).join("")}</ul></div>` : ""}<div class="drawer-footer-note">Times are local IST · values from deterministic simulation</div></aside></div>`;
}

function comparisonMarkup() {
  if (!state.modalOpen || !state.comparison) return "";
  const { before, after, action } = state.comparison;
  const rows = [
    ["Affected flights", "affectedFlights", false],
    ["Arrival delay", "totalDelayMinutes", false, " min"],
    ["Broken connections", "brokenConnections", false],
    ["Stranded passengers", "strandedPassengers", false],
    ["Crew duty violations", "crewDutyViolations", false],
    ["Cancelled flights", "cancelledFlights", false],
    ["Flights operated", "operatedFlights", true],
    ["Avg legs / active aircraft", "aircraftUtilization", null]
  ];
  return `<div class="modal-backdrop" data-action="close-comparison"><section class="comparison-modal" role="dialog" aria-modal="true" aria-labelledby="comparison-title" tabindex="-1"><div class="modal-top"><div><span class="eyebrow">RECOVERY IMPACT · DETERMINISTIC REPLAY</span><h2 id="comparison-title">Before & after recovery</h2><p>${esc(action.label)} · all figures recalculated by the simulation engine</p></div><button class="icon-button" data-action="close-comparison" aria-label="Close comparison">×</button></div><div class="comparison-incident"><span class="status-pill pill-critical"><i></i>${esc(after.incident.airportId)} DISRUPTION</span><span>${number(after.incident.closureDurationMinutes)} minute closure · ${esc(formatTime(after.incident.closureStart))}–${esc(formatTime(after.incident.closureEnd))} IST</span></div><div class="comparison-table-wrap"><table class="comparison-table"><thead><tr><th>Network measure</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>${rows.map(([label, key, higherBetter, suffix = ""]) => {
    const beforeValue = before.metrics[key];
    const afterValue = after.metrics[key];
    const difference = Number((afterValue - beforeValue).toFixed(2));
    const good = higherBetter === null ? null : higherBetter ? difference > 0 : difference < 0;
    const change = difference === 0 ? "—" : `${difference > 0 ? "+" : ""}${number(difference)}${suffix}`;
    return `<tr><td>${esc(label)}</td><td>${number(beforeValue)}${suffix}</td><td><b>${number(afterValue)}${suffix}</b></td><td><span class="change-pill ${good === null ? "change-neutral" : good ? "change-good" : "change-bad"}">${esc(change)}</span></td></tr>`;
  }).join("")}</tbody></table></div><div class="comparison-side-effect"><span class="side-effect-icon">!</span><div><b>Operational trade-off</b><p>${after.metrics.cancelledFlights - before.metrics.cancelledFlights > 0 ? `${number(after.metrics.cancelledFlights - before.metrics.cancelledFlights)} more flight(s) cancelled; ${number(after.metrics.cancelledPassengers - before.metrics.cancelledPassengers)} passengers were on the cancelled leg(s).` : "No additional flight cancellations were introduced."} Review the flight and connection tables for the full downstream change.</p></div></div><div class="modal-actions"><button class="button button-secondary" data-action="close-comparison">RETURN TO NETWORK</button><button class="button button-primary" data-action="reset">RESET SIMULATION</button></div></section></div>`;
}

function scenarioControlMarkup() {
  return `<section class="panel control-panel"><div class="panel-heading"><div><span class="eyebrow">SCENARIO DESIGNER</span><h2>Simulate disruption</h2></div><span class="control-step">01 / 03</span></div><form id="scenario-form"><label class="field-label" for="airport-select">Closed airport</label><select id="airport-select" name="airportId" data-field="airport">${airportOptions(state.selectedAirport)}</select><div class="field-grid"><label><span class="field-label">Closure starts · IST</span><input type="time" name="closureStart" value="${esc(state.closureStart)}" required /></label><label><span class="field-label">Duration</span><span class="duration-input"><input type="number" name="closureDurationMinutes" value="${esc(state.closureDurationMinutes)}" min="1" max="1440" required /><span>min</span></span></label></div><div class="scenario-presets"><span class="section-label">DEMO PRESETS</span><div class="preset-buttons"><button type="button" data-action="preset" data-preset="mumbai" class="preset-button ${state.selectedAirport === "BOM" ? "selected" : ""}"><span class="preset-dot dot-red"></span>Mumbai storm</button><button type="button" data-action="preset" data-preset="bengaluru" class="preset-button ${state.selectedAirport === "BLR" ? "selected" : ""}"><span class="preset-dot dot-amber"></span>Bengaluru</button><button type="button" data-action="preset" data-preset="delhi" class="preset-button ${state.selectedAirport === "DEL" ? "selected" : ""}"><span class="preset-dot dot-blue"></span>Delhi</button></div></div><button class="button button-primary button-run" type="submit" ${state.isSimulating ? "disabled" : ""}><span>${state.isSimulating ? "SIMULATING NETWORK" : "RUN SIMULATION"}</span><span aria-hidden="true">${state.isSimulating ? "◌" : "→"}</span></button><p class="control-note"><span class="lock-mark">◈</span> Deterministic engine · no AI in calculations</p></form>${state.isSimulating ? `<div class="progress-panel" role="status"><div class="progress-header"><span>PROPAGATING NETWORK</span><b>${Math.min(100, Math.round((state.progressIndex + 1) / PROGRESS_STEPS.length * 100))}%</b></div><div class="progress-track"><i style="width:${Math.min(100, Math.round((state.progressIndex + 1) / PROGRESS_STEPS.length * 100))}%"></i></div><ol>${PROGRESS_STEPS.map((step, index) => `<li class="${index < state.progressIndex ? "done" : index === state.progressIndex ? "active" : ""}"><span>${index < state.progressIndex ? "✓" : index === state.progressIndex ? "◌" : "·"}</span>${esc(step)}</li>`).join("")}</ol></div>` : ""}<div class="panel-divider"></div>${airportInfoMarkup()}</section>`;
}

function render() {
  if (!state.dataset) return;
  const incidentTitle = state.hasRun ? `${state.result.incident.airportId} closure · ${formatTime(state.result.incident.closureStart)}–${formatTime(state.result.incident.closureEnd)} IST` : "Network ready · awaiting incident";
  const networkStatus = !state.hasRun || !state.result.metrics.affectedFlights ? "NETWORK STABLE" : state.result.metrics.crewDutyViolations || state.result.metrics.strandedPassengers ? "NETWORK CRITICAL" : "DISRUPTION ACTIVE";
  app.innerHTML = `<div class="shell"><header class="topbar"><a class="brand" href="/" aria-label="Domino Sky home"><span class="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 21.5 16 4l12 17.5-12 6.8L4 21.5Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10 18 6-8 6 8-6 3.5L10 18Z" fill="currentColor" opacity=".75"/></svg></span><span><b>DOMINO<span>SKY</span></b><small>NETWORK OPERATIONS</small></span></a><div class="topbar-center"><span class="live-label"><i></i>${state.isSimulating ? "SIMULATION RUNNING" : "LIVE SIMULATION"}</span><span class="topbar-separator">/</span><span class="topbar-subtitle">Flight disruption cascade & recovery simulator</span></div><div class="topbar-right"><span class="network-health ${state.hasRun && state.result.metrics.affectedFlights ? "health-alert" : ""}"><i></i>${networkStatus}</span><button class="reset-button" data-action="reset" aria-label="Reset simulation">↻ <span>Reset</span></button></div></header><main><section class="incident-banner"><div class="incident-symbol"><span>!</span></div><div><span class="eyebrow">ACTIVE SCENARIO · LOCAL IST</span><h1>${esc(incidentTitle)}</h1></div><div class="incident-banner-meta"><span>OPERATING DAY</span><b>${esc(state.dataset.meta.operating_day.split(",")[0].toUpperCase())}</b><span class="meta-divider"></span><span>MIN TURNAROUND</span><b>${number(state.dataset.meta.min_turnaround_minutes)} MIN</b></div></section><section class="metrics-grid" aria-label="Network impact metrics">${metricsMarkup()}</section><section class="dashboard-grid"><aside class="left-column">${scenarioControlMarkup()}</aside><section class="center-column"><article class="panel map-panel"><div class="panel-heading map-heading"><div><span class="eyebrow">INDIA · FLIGHT NETWORK</span><h2>Operational airspace <span class="airport-count">${state.dataset.airports.length} airports</span></h2></div><span class="map-live-tag"><i></i>${state.hasRun ? "POST-SIMULATION" : "SCHEDULE VIEW"}</span></div><div class="map-frame"><div class="map-rail map-rail-top"><span>NETWORK CONTROL · INDIA FIR</span><span>LOCAL TIME UTC+05:30</span></div>${mapSvg()}<div class="map-scale" aria-hidden="true"><span>WEST</span><i></i><span>EAST</span></div></div><div class="map-legend"><span><i class="legend-dot healthy"></i>Normal</span><span><i class="legend-dot warning"></i>Delayed</span><span><i class="legend-dot critical"></i>Critical / closed</span><span><i class="legend-route"></i>Route</span></div></article><article class="panel cascade-panel"><div class="panel-heading"><div><span class="eyebrow">DOMINO EFFECT</span><h2>Disruption cascade</h2></div><span class="panel-count">${state.hasRun ? `${number(state.result.cascade.length)} events` : "READY"}</span></div>${cascadeMarkup()}</article></section><aside class="right-column"><article class="panel dispatcher-panel"><div class="panel-heading dispatcher-panel-heading"><div><span class="eyebrow">OPERATIONS INTELLIGENCE</span><h2>AI dispatcher</h2></div><span class="demo-badge">${state.recommendation?.mode === "AI" ? "AI" : "DEMO"}</span></div>${dispatcherMarkup()}</article><article class="panel passenger-panel"><div class="panel-heading"><div><span class="eyebrow">CONNECTION CONTROL</span><h2>Passenger impact</h2></div><span class="panel-icon">♙</span></div>${passengerMarkup()}</article></aside></section><section class="lower-grid"><article class="panel crew-panel"><div class="panel-heading"><div><span class="eyebrow">FLIGHT & DUTY LIMITS</span><h2>Crew monitor</h2></div><span class="panel-count">${state.result.crews.length} CREWS</span></div>${crewMarkup()}</article><article class="panel how-panel"><div class="panel-heading"><div><span class="eyebrow">SIMULATION MODEL</span><h2>How Domino Sky works</h2></div><span class="model-badge">ENGINE → DISPATCH</span></div><div class="how-flow">${[["01", "Disruption", "Airport closure"], ["02", "Propagation", "Aircraft turns"], ["03", "Network impact", "Crews + connections"], ["04", "Recovery", "Engine replay"]].map(([n, title, sub], index) => `<div class="how-step"><span>${n}</span><b>${title}</b><small>${sub}</small>${index < 3 ? `<i aria-hidden="true">→</i>` : ""}</div>`).join("")}</div><p class="how-footnote">Simulation numbers are deterministic. Dispatcher recommendations are validated and replayed by the same engine.</p></article></section><section class="panel flights-panel"><div class="panel-heading flight-panel-heading"><div><span class="eyebrow">SCHEDULE CONTROL</span><h2>Flight operations <span class="table-count">${state.dataset.flights.length} FLIGHTS</span></h2></div><span class="table-zone">IST · OPERATING DAY</span></div>${flightTableMarkup()}</section><footer class="app-footer"><span>DOMINO SKY <i>·</i> FLIGHT DISRUPTION CASCADE & RECOVERY SIMULATOR</span><span>DATA: PROVIDED NETWORK JSON <i>·</i> TIMES LOCAL IST</span></footer></main></div>${flightDrawerMarkup()}${comparisonMarkup()}`;
}

function showToast(message, kind = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

function readScenarioForm() {
  const form = document.querySelector("#scenario-form");
  if (!form) return null;
  const data = new FormData(form);
  return {
    airportId: String(data.get("airportId")),
    closureStart: String(data.get("closureStart")),
    closureDurationMinutes: Number(data.get("closureDurationMinutes"))
  };
}

async function runScenario(incident) {
  if (state.isSimulating) return;
  state.isSimulating = true;
  state.progressIndex = 0;
  state.selectedAirport = incident.airportId;
  state.selectedFlightId = null;
  state.modalOpen = false;
  state.comparison = null;
  state.recommendation = null;
  state.aiUnavailableMessage = "";
  render();
  let computed;
  try {
    const baseline = simulateScenario({ dataset: state.dataset, ...incident });
    const candidates = generateRecoveryCandidates({ dataset: state.dataset, incident: baseline.incident, baseline });
    computed = { baseline, candidates };
  } catch (error) {
    state.isSimulating = false;
    state.hasRun = false;
    render();
    showToast(error.message || "Simulation failed. Check the incident inputs and retry.", "error");
    return;
  }
  for (let index = 0; index < PROGRESS_STEPS.length - 1; index += 1) {
    state.progressIndex = index;
    render();
    await sleep(135);
  }
  state.progressIndex = PROGRESS_STEPS.length - 1;
  state.result = computed.baseline;
  state.candidates = computed.candidates;
  state.hasRun = true;
  state.isSimulating = false;
  state.recommendation = chooseDemoRecommendation();
  render();
  document.querySelector(".metrics-grid")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (computed.baseline.metrics.affectedFlights === 0) showToast("Simulation complete. No scheduled movement overlapped the selected closure.", "success");
  else showToast(`Cascade calculated: ${number(computed.baseline.metrics.affectedFlights)} affected flight legs.`, "success");
}

function dispatcherPayload() {
  const affectedFlights = state.result.flights.filter((flight) => flight.status !== "ON_TIME").map((flight) => ({
    flight_id: flight.flightId,
    tail_id: flight.tailId,
    route: `${flight.origin}-${flight.destination}`,
    scheduled_departure: formatTime(flight.scheduledDeparture),
    actual_departure: formatTime(flight.actualDeparture),
    arrival_delay_minutes: flight.arrivalDelay,
    status: flight.status,
    reasons: flight.delayReasons.map((reason) => reason.message),
    cascade_path: flight.cascadePath
  }));
  return {
    incident: { airport_id: state.result.incident.airportId, closure_start: formatTime(state.result.incident.closureStart), closure_end: formatTime(state.result.incident.closureEnd), closure_duration_minutes: state.result.incident.closureDurationMinutes },
    network_metrics: state.result.metrics,
    affected_flights: affectedFlights,
    broken_connections: state.result.connections.filter((connection) => connection.status === "BROKEN"),
    crew_violations: state.result.crews.filter((crew) => crew.violation),
    available_spare_aircraft: state.dataset.spare_aircraft,
    candidate_recovery_actions: state.candidates.map((candidate) => ({ id: candidate.id, action: candidate.action, label: candidate.label, resulting_metrics: candidate.result.metrics }))
  };
}

async function askDispatcher() {
  if (!state.hasRun || state.isAskingDispatcher) return;
  state.isAskingDispatcher = true;
  render();
  try {
    const response = await fetch("/api/dispatcher", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dispatcherPayload())
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Dispatcher is unavailable.");
    const validAction = body.actionId === null || state.candidates.some((candidate) => candidate.id === body.actionId);
    if (!validAction) throw new Error("Dispatcher action did not match a validated recovery candidate.");
    state.recommendation = body;
    state.aiUnavailableMessage = "";
  } catch (error) {
    state.recommendation = chooseDemoRecommendation();
    state.aiUnavailableMessage = `${error.message} Deterministic demo dispatcher active.`;
  } finally {
    state.isAskingDispatcher = false;
    render();
  }
}

function applyRecommendation() {
  const recommendation = state.recommendation || chooseDemoRecommendation();
  const candidate = state.candidates.find((item) => item.id === recommendation.actionId);
  if (!candidate) {
    showToast("No validated recovery action is available for this incident.", "error");
    return;
  }
  if (state.comparison) {
    showToast("This scenario already has a recovery action. Run a new scenario to start over.", "error");
    return;
  }
  try {
    const after = applyRecoveryAction({ dataset: state.dataset, incident: state.result.incident, action: candidate.action });
    state.comparison = { before: state.result, after, action: candidate };
    state.result = after;
    state.candidates = [];
    state.selectedFlightId = null;
    state.modalOpen = true;
    render();
    document.querySelector(".comparison-modal")?.focus();
  } catch (error) {
    showToast(error.message || "The recovery action could not be applied.", "error");
  }
}

function setPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.selectedAirport = preset.airportId;
  state.closureStart = preset.closureStart;
  state.closureDurationMinutes = preset.closureDurationMinutes;
  render();
}

function selectAlternative() {
  if (!state.candidates.length) return;
  const currentIndex = state.candidates.findIndex((candidate) => candidate.id === state.recommendation?.actionId);
  const candidate = state.candidates[(currentIndex + 1) % state.candidates.length];
  const demo = chooseDemoRecommendation();
  const target = state.candidates.find((item) => item.id === candidate.id);
  state.recommendation = {
    ...demo,
    actionId: target.id,
    reason: target.action.type === "CANCEL_FLIGHT"
      ? `Alternative strategy: cancel ${target.action.flightId}. The deterministic replay below shows all downstream cancellations and delay changes before you apply it.`
      : `Alternative strategy: assign ${target.action.spareAircraftId} to ${target.action.flightId}. The deterministic replay recalculates that aircraft's remaining rotation.`
  };
  render();
}

function closeDrawer() {
  state.selectedFlightId = null;
  render();
}

function resetSimulation() {
  const current = readScenarioForm();
  state.selectedAirport = "BOM";
  state.closureStart = "10:00";
  state.closureDurationMinutes = 90;
  state.selectedFlightId = null;
  state.filter = "ALL";
  state.search = "";
  state.hasRun = false;
  state.isSimulating = false;
  state.candidates = [];
  state.recommendation = null;
  state.comparison = null;
  state.modalOpen = false;
  state.aiUnavailableMessage = "";
  state.result = emptyBaseResult(state.dataset);
  render();
  const form = document.querySelector("#scenario-form");
  if (form) {
    form.elements.airportId.value = "BOM";
    form.elements.closureStart.value = "10:00";
    form.elements.closureDurationMinutes.value = "90";
  }
  if (current && current.airportId !== "BOM") window.scrollTo({ top: 0, behavior: "smooth" });
  showToast("Simulation reset to the Mumbai thunderstorm preset.", "success");
}

app.addEventListener("submit", (event) => {
  if (event.target.id !== "scenario-form") return;
  event.preventDefault();
  const incident = readScenarioForm();
  if (!incident) return;
  if (!Number.isInteger(incident.closureDurationMinutes) || incident.closureDurationMinutes < 1 || incident.closureDurationMinutes > 1440) {
    showToast("Closure duration must be between 1 and 1,440 minutes.", "error");
    return;
  }
  runScenario(incident);
});

app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const { action } = target.dataset;
  if (action === "select-airport") {
    state.selectedAirport = target.dataset.airport;
    render();
  } else if (action === "preset") {
    setPreset(target.dataset.preset);
  } else if (action === "filter") {
    state.filter = target.dataset.filter;
    render();
  } else if (action === "open-flight") {
    state.selectedFlightId = target.dataset.flight;
    render();
    document.querySelector(".flight-drawer")?.focus();
  } else if (action === "close-drawer" && (target.classList.contains("drawer-backdrop") || target.tagName === "BUTTON")) {
    closeDrawer();
  } else if (action === "apply-recommendation") {
    applyRecommendation();
  } else if (action === "ask-dispatcher") {
    askDispatcher();
  } else if (action === "alternative") {
    selectAlternative();
  } else if (action === "refresh-recommendation") {
    state.recommendation = chooseDemoRecommendation();
    render();
  } else if (action === "close-comparison" && (target.classList.contains("modal-backdrop") || target.tagName === "BUTTON")) {
    state.modalOpen = false;
    render();
  } else if (action === "reset") {
    resetSimulation();
  }
});

app.addEventListener("input", (event) => {
  if (event.target.matches('[data-field="search"]')) {
    const caret = event.target.selectionStart;
    state.search = event.target.value;
    const value = event.target.value;
    render();
    const input = document.querySelector('[data-field="search"]');
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
});

app.addEventListener("change", (event) => {
  if (event.target.matches('[data-field="airport"]')) {
    state.selectedAirport = event.target.value;
    render();
    const form = document.querySelector("#scenario-form");
    if (form) form.elements.airportId.value = event.target.value;
  } else if (event.target.name === "closureStart") {
    state.closureStart = event.target.value;
  } else if (event.target.name === "closureDurationMinutes") {
    state.closureDurationMinutes = Number(event.target.value);
  }
});

app.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".airport-node")) {
    event.preventDefault();
    state.selectedAirport = event.target.dataset.airport;
    render();
  }
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".flight-row")) {
    event.preventDefault();
    state.selectedFlightId = event.target.dataset.flight;
    render();
    document.querySelector(".flight-drawer")?.focus();
  }
  if (event.key === "Escape") {
    if (state.modalOpen) {
      state.modalOpen = false;
      render();
    } else if (state.selectedFlightId) closeDrawer();
  }
});

async function boot() {
  try {
    const response = await fetch("/api/network");
    if (!response.ok) throw new Error("Flight network could not be loaded.");
    state.dataset = await response.json();
    state.result = emptyBaseResult(state.dataset);
    render();
  } catch (error) {
    app.innerHTML = `<main class="fatal-error"><div class="error-mark">!</div><span class="eyebrow">NETWORK DATA UNAVAILABLE</span><h1>Domino Sky could not start</h1><p>${esc(error.message)} Check that the local server is running and <code>flight_network.json</code> is present.</p><button class="button button-primary" onclick="location.reload()">RETRY</button></main>`;
  }
}

boot();
