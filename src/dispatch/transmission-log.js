export function sanitizeTransmissionLog(input) {
  return {
    ...input,
    classificationReason: clip(input.classificationReason, 500),
    facts: input.facts?.map((value) => clip(value, 160)),
    existingCallCandidates: input.existingCallCandidates?.map((candidate) => ({
      ...candidate,
      reason: clip(candidate.reason, 250),
    })),
    actionResults: input.actionResults?.map((result) => ({
      ...result,
      action: clip(result.action, 100),
      detail: clip(result.detail, 500),
    })),
    boloChanges: input.boloChanges?.map((value) => clip(value, 500)),
    vehicleObservation: input.vehicleObservation
      ? { ...input.vehicleObservation, rawTranscript: clip(input.vehicleObservation.rawTranscript, 1000) }
      : input.vehicleObservation,
    boloMatches: input.boloMatches?.map((match) => ({
      ...match,
      reasons: match.reasons.map((reason) => clip(reason, 120)),
    })),
    warrantChanges: input.warrantChanges?.map((value) => clip(value, 500)),
    failedActions: input.failedActions?.map((failure) => ({
      ...failure,
      action: clip(failure.action, 100),
      reason: clip(failure.reason, 500),
    })),
  };
}

function clip(value, maximum) {
  return value === undefined ? undefined : String(value).slice(0, maximum);
}
