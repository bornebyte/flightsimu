const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const STATUS = Object.freeze({
  ON_TIME: "ON_TIME",
  DELAYED: "DELAYED",
  CANCELLED: "CANCELLED",
  AIRPORT_CLOSED: "AIRPORT_CLOSED",
  AIRCRAFT_DELAYED: "AIRCRAFT_DELAYED",
  CREW_CONSTRAINT: "CREW_CONSTRAINT",
  CONNECTION_IMPACT: "CONNECTION_IMPACT"
});

export function parseTime(value, label = "time") {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid 24-hour time (HH:MM).`);
  }
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function formatTime(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const day = Math.floor(minutes / 1440);
  const inDay = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(inDay / 60)).padStart(2, "0");
  const mm = String(inDay % 60).padStart(2, "0");
  return day ? `${hh}:${mm} +${day}d` : `${hh}:${mm}`;
}

function validateInput(dataset, airportId, closureStart, closureDurationMinutes) {
  if (!dataset || !Array.isArray(dataset.airports) || !Array.isArray(dataset.flights)) {
    throw new Error("A valid flight network dataset is required.");
  }
  if (!dataset.airports.some((airport) => airport.id === airportId)) {
    throw new Error(`Unknown airport: ${String(airportId)}.`);
  }
  const start = parseTime(closureStart, "Closure start");
  if (!Number.isInteger(closureDurationMinutes) || closureDurationMinutes < 1 || closureDurationMinutes > 1440) {
    throw new Error("Closure duration must be a whole number from 1 to 1,440 minutes.");
  }
  return { start, end: start + closureDurationMinutes };
}

function normalizeAction(dataset, action) {
  if (!action) return null;
  if (typeof action !== "object" || Array.isArray(action)) throw new Error("Recovery action must be an object.");
  const type = action.type || action.action;
  if (type === "CANCEL_FLIGHT") {
    const flightId = action.flightId || action.target_flight_id;
    if (!dataset.flights.some((flight) => flight.flight_id === flightId)) {
      throw new Error(`Unknown flight: ${String(flightId)}.`);
    }
    return { type, flightId };
  }
  if (type === "SWAP_SPARE_AIRCRAFT") {
    const flightId = action.flightId || action.targetFlightId || action.target_flight_id;
    const spareId = action.spareAircraftId || action.spare_aircraft_id;
    const target = dataset.flights.find((flight) => flight.flight_id === flightId);
    const spare = dataset.spare_aircraft.find((aircraft) => aircraft.tail_id === spareId);
    if (!target) throw new Error(`Unknown flight: ${String(flightId)}.`);
    if (!spare) throw new Error(`Spare aircraft ${String(spareId)} is unavailable.`);
    if (spare.base !== target.origin) {
      throw new Error(`${spare.tail_id} is based at ${spare.base}; ${flightId} departs ${target.origin}.`);
    }
    if (parseTime(spare.available_from, `${spare.tail_id} availability`) > parseTime(target.dep, `${flightId} departure`)) {
      throw new Error(`${spare.tail_id} is not available before ${flightId} is scheduled to depart.`);
    }
    return { type, flightId, spareAircraftId: spareId };
  }
  throw new Error(`Unsupported recovery action: ${String(type)}.`);
}

function withinWindow(minute, start, end) {
  return minute >= start && minute < end;
}

function unique(values) {
  return [...new Set(values)];
}

function makeFlight(flight, assignedTailId) {
  const scheduledDeparture = parseTime(flight.dep, `${flight.flight_id} departure`);
  const scheduledArrival = parseTime(flight.arr, `${flight.flight_id} arrival`);
  return {
    flightId: flight.flight_id,
    originalTailId: flight.tail_id,
    tailId: assignedTailId,
    legOrder: flight.leg_order,
    origin: flight.origin,
    destination: flight.destination,
    scheduledDeparture,
    scheduledArrival,
    blockMinutes: flight.block_minutes,
    passengers: flight.pax,
    turnaroundMinutes: flight.turnaround_before_min ?? 30,
    actualDeparture: null,
    actualArrival: null,
    departureDelay: 0,
    arrivalDelay: 0,
    status: STATUS.ON_TIME,
    delayReasons: [],
    cascadePath: [],
    rootCause: null,
    closureAffected: false,
    aircraftDelay: false,
    crewConstraint: false,
    connectionImpact: false,
    cancelled: false,
    previousFlightId: null
  };
}

function addReason(flight, code, message, sourceFlightId = null) {
  flight.delayReasons.push({ code, message, sourceFlightId });
}

function cancelFlight(flight, message, actionCancellation = false) {
  flight.cancelled = true;
  flight.status = STATUS.CANCELLED;
  flight.actualDeparture = null;
  flight.actualArrival = null;
  addReason(flight, actionCancellation ? "RECOVERY_ACTION" : "AIRCRAFT_POSITION", message);
}

function calculateMetrics(dataset, flights, crews, connections, closureDurationMinutes) {
  const affected = flights.filter((flight) => flight.status !== STATUS.ON_TIME);
  const delayed = flights.filter((flight) => !flight.cancelled && (flight.departureDelay > 0 || flight.arrivalDelay > 0));
  const cancelled = flights.filter((flight) => flight.cancelled);
  const activeTails = unique(flights.filter((flight) => !flight.cancelled).map((flight) => flight.tailId));
  const affectedTails = unique(affected.map((flight) => flight.tailId));
  const affectedFlightIds = new Set(affected.map((flight) => flight.flightId));
  const affectedCrewIds = new Set();
  for (const crew of crews) {
    if (crew.violation || crew.flightIds.some((id) => affectedFlightIds.has(id))) affectedCrewIds.add(crew.crewId);
  }
  const brokenConnections = connections.filter((connection) => connection.status === "BROKEN");
  const operatedFlights = flights.length - cancelled.length;
  const totalDelayMinutes = delayed.reduce((sum, flight) => sum + flight.arrivalDelay, 0);
  return {
    totalFlights: dataset.flights.length,
    operatedFlights,
    affectedFlights: affected.length,
    delayedFlights: delayed.length,
    cancelledFlights: cancelled.length,
    totalDelayMinutes,
    averageDelayMinutes: delayed.length ? Math.round(totalDelayMinutes / delayed.length) : 0,
    maximumDelayMinutes: delayed.reduce((max, flight) => Math.max(max, flight.arrivalDelay), 0),
    strandedPassengers: brokenConnections.reduce((sum, connection) => sum + connection.passengers, 0),
    brokenConnections: brokenConnections.length,
    monitoredConnections: dataset.connections.length,
    passengersOnAffectedFlights: affected.reduce((sum, flight) => sum + flight.passengers, 0),
    cancelledPassengers: cancelled.reduce((sum, flight) => sum + flight.passengers, 0),
    totalPassengerDelayImpact: delayed.reduce((sum, flight) => sum + flight.passengers * flight.arrivalDelay, 0),
    affectedAircraft: affectedTails.length,
    affectedCrews: affectedCrewIds.size,
    crewDutyViolations: crews.filter((crew) => crew.violation).length,
    activeAircraft: activeTails.length,
    aircraftUtilization: activeTails.length ? Number((operatedFlights / activeTails.length).toFixed(2)) : 0,
    airportClosureDurationMinutes: closureDurationMinutes
  };
}

/** Deterministic, single-day flight-network simulation. The dataset remains the source of all schedule data. */
export function simulateScenario({ dataset, airportId, closureStart, closureDurationMinutes, recoveryAction = null }) {
  const closure = validateInput(dataset, airportId, closureStart, closureDurationMinutes);
  const action = normalizeAction(dataset, recoveryAction);
  const spareById = new Map(dataset.spare_aircraft.map((aircraft) => [aircraft.tail_id, aircraft]));
  const rawById = new Map(dataset.flights.map((flight) => [flight.flight_id, flight]));
  const targetRaw = action?.type === "SWAP_SPARE_AIRCRAFT" ? rawById.get(action.flightId) : null;
  const movedTail = targetRaw?.tail_id;
  const targetLegOrder = targetRaw?.leg_order;
  const assignedTail = (rawFlight) => {
    if (action?.type === "SWAP_SPARE_AIRCRAFT" && rawFlight.tail_id === movedTail && rawFlight.leg_order >= targetLegOrder) {
      return action.spareAircraftId;
    }
    return rawFlight.tail_id;
  };
  const flights = dataset.flights.map((rawFlight) => makeFlight(rawFlight, assignedTail(rawFlight)));
  const byFlightId = new Map(flights.map((flight) => [flight.flightId, flight]));
  const rotationMap = new Map();
  for (const flight of flights) {
    if (!rotationMap.has(flight.tailId)) rotationMap.set(flight.tailId, []);
    rotationMap.get(flight.tailId).push(flight);
  }

  for (const [tailId, rotation] of rotationMap) {
    rotation.sort((a, b) => a.legOrder - b.legOrder);
    const spare = spareById.get(tailId);
    let location = spare?.base ?? null;
    let lastOperatedFlight = null;
    let aircraftAvailable = spare ? parseTime(spare.available_from, `${tailId} availability`) : 0;

    for (const flight of rotation) {
      const raw = rawById.get(flight.flightId);
      if (action?.type === "CANCEL_FLIGHT" && flight.flightId === action.flightId) {
        cancelFlight(flight, `Dispatch cancelled ${flight.flightId}. Aircraft remains at ${flight.origin}.`, true);
        location ??= flight.origin;
        continue;
      }
      location ??= flight.origin;
      flight.previousFlightId = lastOperatedFlight?.flightId ?? null;
      if (location !== flight.origin) {
        cancelFlight(flight, `Aircraft ${tailId} is at ${location}; ${flight.flightId} requires an aircraft at ${flight.origin}.`);
        continue;
      }

      let earliestDeparture = Math.max(flight.scheduledDeparture, aircraftAvailable);
      if (lastOperatedFlight) {
        const readyTime = lastOperatedFlight.actualArrival + flight.turnaroundMinutes;
        if (readyTime > earliestDeparture) earliestDeparture = readyTime;
        if (readyTime > flight.scheduledDeparture) {
          flight.aircraftDelay = true;
          const lateBy = Math.max(0, lastOperatedFlight.actualArrival - lastOperatedFlight.scheduledArrival);
          addReason(
            flight,
            "AIRCRAFT_DELAY",
            `${lastOperatedFlight.flightId} arrived ${lateBy} min late at ${flight.origin}; ${flight.turnaroundMinutes} min turnaround sets earliest departure to ${formatTime(readyTime)}.`,
            lastOperatedFlight.flightId
          );
        }
      }

      let departure = earliestDeparture;
      if (withinWindow(departure, closure.start, closure.end) && flight.origin === airportId) {
        departure = closure.end;
        flight.closureAffected = true;
        addReason(flight, "AIRPORT_CLOSURE", `${airportId} is closed; departure held until ${formatTime(closure.end)}.`);
      }

      let arrival = departure + flight.blockMinutes;
      if (flight.destination === airportId && withinWindow(arrival, closure.start, closure.end)) {
        const scheduledArrivalDuringClosure = withinWindow(flight.scheduledArrival, closure.start, closure.end);
        arrival = closure.end;
        flight.closureAffected = true;
        addReason(flight, "AIRPORT_CLOSURE", `Arrival at ${airportId} held until ${formatTime(closure.end)}${scheduledArrivalDuringClosure ? `; scheduled arrival was ${formatTime(flight.scheduledArrival)}` : ""}.`);
      }

      flight.actualDeparture = departure;
      flight.actualArrival = arrival;
      flight.departureDelay = Math.max(0, departure - flight.scheduledDeparture);
      flight.arrivalDelay = Math.max(0, arrival - flight.scheduledArrival);
      const inheritedPath = flight.aircraftDelay && lastOperatedFlight ? lastOperatedFlight.cascadePath : [];
      flight.cascadePath = unique([...(inheritedPath ?? []), ...(flight.closureAffected ? [flight.flightId] : []), ...(flight.arrivalDelay > 0 || flight.departureDelay > 0 ? [flight.flightId] : [])]);
      if (flight.closureAffected) flight.rootCause = `Airport closure at ${airportId}`;
      else if (flight.cascadePath.length) flight.rootCause = lastOperatedFlight?.rootCause || `Airport closure at ${airportId}`;
      if (flight.delayReasons.some((reason) => reason.code === "AIRCRAFT_DELAY") && !flight.closureAffected && lastOperatedFlight?.cascadePath?.length) {
        flight.cascadePath = unique([...lastOperatedFlight.cascadePath, flight.flightId]);
        flight.rootCause = lastOperatedFlight.rootCause;
      }
      if (action?.type === "SWAP_SPARE_AIRCRAFT" && flight.tailId === action.spareAircraftId && raw.tail_id === movedTail) {
        addReason(flight, "RECOVERY_ACTION", `${action.spareAircraftId} substituted for ${movedTail} from ${action.flightId}.`);
      }
      if (flight.arrivalDelay > 0 && flight.delayReasons.length === 0) {
        addReason(flight, "SCHEDULE_DELAY", `Arrival is ${flight.arrivalDelay} min behind schedule.`);
      }
      flight.status = flight.closureAffected
        ? STATUS.AIRPORT_CLOSED
        : flight.aircraftDelay && flight.departureDelay > 0
          ? STATUS.AIRCRAFT_DELAYED
          : flight.arrivalDelay > 0 || flight.departureDelay > 0
            ? STATUS.DELAYED
            : STATUS.ON_TIME;
      if (flight.cascadePath.length && flight.rootCause === null) flight.rootCause = `Airport closure at ${airportId}`;
      location = flight.destination;
      // The next leg carries its own turnaround requirement, so retain the actual
      // arrival here and apply the next leg's turnaround when that leg is evaluated.
      aircraftAvailable = arrival;
      lastOperatedFlight = flight;
    }
  }

  const crews = dataset.crews.map((crew) => {
    const assigned = crew.flight_ids.map((id) => byFlightId.get(id)).filter(Boolean);
    const operated = assigned.filter((flight) => !flight.cancelled && flight.actualArrival !== null);
    const finalFlight = operated.at(-1) ?? null;
    const dutyStart = parseTime(crew.duty_start, `${crew.crew_id} duty start`);
    const projectedEnd = finalFlight?.actualArrival ?? null;
    const projectedDutyMinutes = projectedEnd === null ? 0 : Math.max(0, projectedEnd - dutyStart);
    const violation = projectedDutyMinutes > crew.max_duty_mins;
    const dutyLimitAt = dutyStart + crew.max_duty_mins;
    const issue = violation ? {
      excessMinutes: projectedDutyMinutes - crew.max_duty_mins,
      message: `${crew.crew_id} projects ${projectedDutyMinutes} min of duty against a ${crew.max_duty_mins} min limit.`
    } : null;
    if (violation) {
      for (const flight of operated) {
        if (flight.actualArrival > dutyLimitAt) {
          flight.crewConstraint = true;
          addReason(flight, "CREW_CONSTRAINT", `${crew.crew_id} exceeds its duty limit by ${projectedDutyMinutes - crew.max_duty_mins} min on this rotation.`);
          if (flight.status === STATUS.ON_TIME || flight.status === STATUS.DELAYED || flight.status === STATUS.AIRCRAFT_DELAYED) {
            flight.status = STATUS.CREW_CONSTRAINT;
          }
        }
      }
    }
    return {
      crewId: crew.crew_id,
      tailId: crew.tail_id,
      base: crew.base,
      dutyStart,
      maxDutyMinutes: crew.max_duty_mins,
      dutyLimitAt,
      flightIds: crew.flight_ids,
      scheduledEnd: assigned.filter((flight) => !flight.cancelled).at(-1)?.scheduledArrival ?? null,
      projectedEnd,
      projectedDutyMinutes,
      violation,
      issue
    };
  });

  const connections = dataset.connections.map((connection) => {
    const incoming = byFlightId.get(connection.from_flight);
    const outgoing = byFlightId.get(connection.to_flight);
    const availableMinutes = incoming?.actualArrival !== null && incoming?.actualArrival !== undefined && outgoing?.actualDeparture !== null && outgoing?.actualDeparture !== undefined
      ? outgoing.actualDeparture - incoming.actualArrival
      : null;
    const connected = availableMinutes !== null && availableMinutes >= connection.min_connect_minutes;
    const reason = connected
      ? "Connection remains feasible."
      : !incoming || incoming.cancelled
        ? `${connection.from_flight} was cancelled; passengers cannot reach the connection.`
        : !outgoing || outgoing.cancelled
          ? `${connection.to_flight} was cancelled; passengers have no onward flight.`
          : `Only ${availableMinutes} min available; ${connection.min_connect_minutes} min required.`;
    if (!connected && outgoing && !outgoing.cancelled) {
      outgoing.connectionImpact = true;
      addReason(outgoing, "CONNECTION_IMPACT", `${connection.connection_id}: ${reason}`);
      if (outgoing.status === STATUS.ON_TIME) outgoing.status = STATUS.CONNECTION_IMPACT;
    }
    return {
      connectionId: connection.connection_id,
      airport: connection.airport,
      fromFlightId: connection.from_flight,
      toFlightId: connection.to_flight,
      passengers: connection.passengers,
      minConnectMinutes: connection.min_connect_minutes,
      availableMinutes,
      status: connected ? "PROTECTED" : "BROKEN",
      reason
    };
  });

  // Add root cause metadata after each rotation has been propagated.
  const cascade = flights
    .filter((flight) => flight.status !== STATUS.ON_TIME)
    .sort((a, b) => (a.actualDeparture ?? a.scheduledDeparture) - (b.actualDeparture ?? b.scheduledDeparture))
    .map((flight) => ({
      flightId: flight.flightId,
      tailId: flight.tailId,
      origin: flight.origin,
      destination: flight.destination,
      eventTime: flight.actualDeparture ?? flight.scheduledDeparture,
      arrivalTime: flight.actualArrival,
      delayMinutes: flight.arrivalDelay,
      status: flight.status,
      reason: flight.delayReasons[0]?.message ?? "Operational impact recorded.",
      reasonCode: flight.delayReasons[0]?.code ?? "OPERATIONAL_IMPACT",
      cascadePath: flight.cascadePath,
      rootCause: flight.rootCause
    }));

  const aircraft = [...new Set([...dataset.flights.map((flight) => flight.tail_id), ...dataset.spare_aircraft.map((spare) => spare.tail_id)])].map((tailId) => {
    const assigned = flights.filter((flight) => flight.tailId === tailId);
    return {
      tailId,
      base: spareById.get(tailId)?.base ?? dataset.crews.find((crew) => crew.tail_id === tailId)?.base ?? null,
      spare: spareById.has(tailId),
      flightIds: assigned.sort((a, b) => a.legOrder - b.legOrder).map((flight) => flight.flightId),
      operatedFlights: assigned.filter((flight) => !flight.cancelled).length,
      delayedFlights: assigned.filter((flight) => flight.arrivalDelay > 0).length,
      cancelledFlights: assigned.filter((flight) => flight.cancelled).length,
      affected: assigned.some((flight) => flight.status !== STATUS.ON_TIME)
    };
  });

  const metrics = calculateMetrics(dataset, flights, crews, connections, closureDurationMinutes);
  return {
    incident: {
      airportId,
      closureStart: closure.start,
      closureEnd: closure.end,
      closureDurationMinutes
    },
    recoveryAction: action,
    flights,
    aircraft,
    crews,
    connections,
    cascade,
    metrics
  };
}

export function applyRecoveryAction({ dataset, incident, action }) {
  if (!incident || typeof incident !== "object") throw new Error("The incident must be rerun to apply a recovery action.");
  return simulateScenario({
    dataset,
    airportId: incident.airportId,
    closureStart: formatTime(incident.closureStart).replace(/ \+\d+d$/, ""),
    closureDurationMinutes: incident.closureDurationMinutes,
    recoveryAction: action
  });
}

export function generateRecoveryCandidates({ dataset, incident, baseline }) {
  const impacted = baseline.flights.filter((flight) => !flight.cancelled && (
    flight.departureDelay > 0 || flight.arrivalDelay > 0 || flight.status === STATUS.CONNECTION_IMPACT || flight.status === STATUS.CREW_CONSTRAINT
  ));
  const candidates = [];
  const evaluate = (id, action, label) => {
    try {
      const result = simulateScenario({
        dataset,
        airportId: incident.airportId,
        closureStart: formatTime(incident.closureStart).replace(/ \+\d+d$/, ""),
        closureDurationMinutes: incident.closureDurationMinutes,
        recoveryAction: action
      });
      candidates.push({ id, action, label, result });
    } catch {
      // Invalid candidate actions are excluded; the engine remains the validator.
    }
  };
  for (const flight of impacted) {
    evaluate(`cancel:${flight.flightId}`, { type: "CANCEL_FLIGHT", flightId: flight.flightId }, `Cancel ${flight.flightId}`);
    for (const spare of dataset.spare_aircraft) {
      if (spare.base !== flight.origin) continue;
      evaluate(
        `spare:${spare.tail_id}:${flight.flightId}`,
        { type: "SWAP_SPARE_AIRCRAFT", spareAircraftId: spare.tail_id, flightId: flight.flightId },
        `Deploy ${spare.tail_id} on ${flight.flightId}`
      );
    }
  }
  return candidates;
}

export { STATUS as FLIGHT_STATUS };
