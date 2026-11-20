import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateScenario, generateRecoveryCandidates } from "../lib/simulation-engine.js";

const dataset = JSON.parse(readFileSync(new URL("../flight_network.json", import.meta.url), "utf8"));
const mumbaiIncident = { airportId: "BOM", closureStart: "10:00", closureDurationMinutes: 90 };

function flight(result, flightId) {
  return result.flights.find((item) => item.flightId === flightId);
}

test("an airport closure delays an operation that arrives during the closure", () => {
  const result = simulateScenario({ dataset, ...mumbaiIncident });
  assert.equal(flight(result, "DS0402").status, "AIRPORT_CLOSED");
  assert.equal(flight(result, "DS0402").actualArrival, 11 * 60 + 30);
  assert.equal(flight(result, "DS0402").arrivalDelay, 65);
});

test("aircraft arrival and turnaround constraints propagate delays through a tail rotation", () => {
  const result = simulateScenario({ dataset, ...mumbaiIncident });
  const next = flight(result, "DS0403");
  assert.equal(next.previousFlightId, "DS0402");
  assert.equal(next.actualDeparture, 12 * 60 + 40);
  assert.equal(next.departureDelay, 65);
  assert.equal(flight(result, "DS0404").arrivalDelay, 65);
  assert.equal(flight(result, "DS0405").arrivalDelay, 65);
  assert.deepEqual(next.cascadePath, ["DS0402", "DS0403"]);
});

test("connections break when the remaining transfer time is below the minimum", () => {
  const result = simulateScenario({ dataset, airportId: "BLR", closureStart: "12:00", closureDurationMinutes: 60 });
  const cx07 = result.connections.find((item) => item.connectionId === "CX07");
  assert.equal(cx07.status, "BROKEN");
  assert.equal(cx07.availableMinutes, 30);
  assert.equal(cx07.minConnectMinutes, 45);
  assert.equal(cx07.passengers, 25);
  assert.equal(result.metrics.strandedPassengers >= 25, true);
});

test("crew duty violations are surfaced when the final rotation exceeds its duty limit", () => {
  const result = simulateScenario({ dataset, airportId: "DEL", closureStart: "08:00", closureDurationMinutes: 300 });
  const crew = result.crews.find((item) => item.crewId === "CR01");
  assert.equal(crew.violation, true);
  assert.ok(crew.projectedDutyMinutes > crew.maxDutyMinutes);
  assert.ok(result.metrics.crewDutyViolations > 0);
  assert.ok(flight(result, "DS0105").delayReasons.some((reason) => reason.code === "CREW_CONSTRAINT"));
});

test("cancelling a flight recalculates the aircraft position and downstream schedule", () => {
  const result = simulateScenario({
    dataset,
    ...mumbaiIncident,
    recoveryAction: { type: "CANCEL_FLIGHT", flightId: "DS0403" }
  });
  assert.equal(flight(result, "DS0403").status, "CANCELLED");
  assert.equal(flight(result, "DS0404").status, "CANCELLED");
  assert.ok(flight(result, "DS0404").delayReasons[0].message.includes("requires an aircraft at PNQ"));
  assert.equal(flight(result, "DS0405").status, "ON_TIME");
});

test("a spare aircraft can take a feasible leg and an incompatible base is rejected", () => {
  const scenario = { dataset, airportId: "BLR", closureStart: "12:00", closureDurationMinutes: 60 };
  const baseline = simulateScenario(scenario);
  const recovered = simulateScenario({
    ...scenario,
    recoveryAction: { type: "SWAP_SPARE_AIRCRAFT", spareAircraftId: "VT-DS17", targetFlightId: "DS0605" }
  });
  assert.equal(flight(recovered, "DS0605").tailId, "VT-DS17");
  assert.ok(flight(recovered, "DS0605").arrivalDelay < flight(baseline, "DS0605").arrivalDelay);
  assert.throws(() => simulateScenario({
    dataset,
    ...mumbaiIncident,
    recoveryAction: { type: "SWAP_SPARE_AIRCRAFT", spareAircraftId: "VT-DS17", targetFlightId: "DS0403" }
  }), /based at BLR/);
  assert.throws(() => simulateScenario({
    dataset,
    ...scenario,
    recoveryAction: { type: "SWAP_SPARE_AIRCRAFT", spareAircraftId: "VT-UNKNOWN", targetFlightId: "DS0605" }
  }), /unavailable/);
});

test("candidate generation evaluates recovery actions using the engine", () => {
  const incident = { airportId: "BLR", closureStart: "12:00", closureDurationMinutes: 60 };
  const baseline = simulateScenario({ dataset, ...incident });
  const candidates = generateRecoveryCandidates({ dataset, incident: baseline.incident, baseline });
  const spareCandidate = candidates.find((candidate) => candidate.id === "spare:VT-DS17:DS0605");
  assert.ok(spareCandidate);
  assert.equal(flight(spareCandidate.result, "DS0605").tailId, "VT-DS17");
});

test("identical inputs produce byte-for-byte stable JSON output", () => {
  const first = simulateScenario({ dataset, ...mumbaiIncident });
  const second = simulateScenario({ dataset, ...mumbaiIncident });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("invalid airport, duration, and flight identifiers are rejected", () => {
  assert.throws(() => simulateScenario({ dataset, airportId: "XXX", closureStart: "10:00", closureDurationMinutes: 60 }), /Unknown airport/);
  assert.throws(() => simulateScenario({ dataset, ...mumbaiIncident, closureDurationMinutes: 0 }), /duration/);
  assert.throws(() => simulateScenario({ dataset, ...mumbaiIncident, recoveryAction: { type: "CANCEL_FLIGHT", flightId: "NOPE" } }), /Unknown flight/);
});
