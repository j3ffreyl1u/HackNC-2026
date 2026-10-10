import type * as C from '../contracts/index.js';
import type * as B from '../planning/types.js';
import { applyCommand, installCandidates } from '../planning/commands.js';
import { planTrip } from '../planning/generate.js';
import { answerGuideQuestion } from '../planning/guide.js';
import { publicFeasibilitySummary, reprice } from '../planning/budget.js';
import type { ResearchProvider } from '../research/types.js';
import type { PlannerAdapter } from './runtime.js';

export function toPlanningState(state: C.TripState): B.TripState {
  const records = state.memberConstraints.map(r => ({ ...toPlanningUpdate(r), recordedAt: r.updatedAt, revision: (r as { revision?: number }).revision ?? state.revision }));
  return {
    ...state,
    roster: state.roster ?? [...new Set(records.map(r => r.memberId))].map(memberId => ({ memberId, displayName: memberId, consented: true })),
    memberConstraints: Object.fromEntries([...new Set(records.map(r => r.memberId))].map(id => [id, records.filter(r => r.memberId === id)])),
    groupConstraints: state.groupConstraints.map(r => ({ ...toPlanningUpdate({ ...r, memberId: (r as { memberId?: string }).memberId ?? state.roster?.[0]?.memberId ?? records[0]?.memberId ?? '' } as C.ConstraintUpdate), recordedAt: (r as { updatedAt?: string }).updatedAt ?? records[0]?.recordedAt ?? '', revision: (r as { revision?: number }).revision ?? state.revision })),
    candidates: state.candidates.map(toPlanningCandidate),
    acceptances: state.acceptances.map(a => ({ memberId: a.actorId, candidateId: a.candidateId, revision: a.revision })),
    pendingQuestions: state.pendingQuestions.map(q => ({ ...q, key: q.questionId.split('|')[0], audience: q.audience === 'group' ? { kind: 'group' } : { kind: 'private', memberId: q.memberId! } })),
  };
}

export function toPlanningUpdate(update: C.ConstraintUpdate): B.ConstraintUpdate {
  let value: unknown;
  switch (update.field) {
    case 'budget': value = { cents: update.value }; break;
    case 'availability': value = { intervals: update.value.map(({ startAt, endAt }) => ({ startAt, endAt })) }; break;
    case 'preferences': case 'must_dos': value = { items: update.value }; break;
    case 'transport': value = { mode: 'car', vehicleAvailable: update.value.hasVehicle }; break;
    case 'region': value = { searchRegion: update.value.label, maxTravelMinutes: update.value.maxTravelMinutes }; break;
    case 'origin': value = { city: update.value.city }; break;
    case 'duration': value = update.value; break;
  }
  return { ...update, value } as B.ConstraintUpdate;
}

function fromUpdate(r: B.ConstraintRecord, timeZone: string): C.MemberConstraintRecord {
  let value: unknown;
  switch (r.field) {
    case 'budget': value = r.value.cents; break;
    case 'availability': value = r.value.intervals.map(w => ({ ...w, timeZone })); break;
    case 'preferences': case 'must_dos': value = r.value.items; break;
    case 'transport': value = { mode: 'road_trip', hasVehicle: r.value.vehicleAvailable }; break;
    case 'region': value = { label: r.value.searchRegion ?? r.value.destination ?? '', maxTravelMinutes: r.value.maxTravelMinutes ?? 240 }; break;
    case 'origin': value = { city: r.value.city, region: '', timeZone }; break;
    case 'duration': value = r.value; break;
  }
  return { ...r, value, updatedAt: r.recordedAt } as C.MemberConstraintRecord;
}

export function toPlanningCandidate(c: C.TripCandidate): B.TripCandidate {
  return { ...c, dataSource: c.dataSource ?? 'fixture',
    costs: c.costs.map(i => ({ ...i, category: i.category === 'transport' ? 'fuel_parking_tolls' : i.category === 'activity' ? 'activities' : i.category })),
    itinerary: c.itinerary.map(i => ({ ...i, label: i.label ?? i.location, tags: i.tags ?? [], travelMinutesFromPrevious: i.travelMinutesEstimate })),
    feasibility: { feasible: c.feasibility.feasible, unknownEssentials: c.feasibility.unknownEssentials,
      violations: c.feasibility.violatedConstraints.map(v => ({ kind: v.constraint as B.ViolationKind, memberId: v.memberId, detail: v.explanation })) },
  };
}

export function fromCandidate(c: B.TripCandidate): C.TripCandidate {
  const missingItinerary = (c as B.TripCandidate & { itineraryConfirmed?: boolean }).itineraryConfirmed === false;
  return { ...c,
    costs: c.costs.map(i => ({ ...i, category: i.category === 'fuel_parking_tolls' ? 'transport' : i.category === 'activities' ? 'activity' : i.category })),
    itinerary: c.itinerary.map(i => ({ ...i, travelMinutesEstimate: i.travelMinutesFromPrevious })),
    feasibility: { feasible: c.feasibility.feasible && !missingItinerary, unknownEssentials: [...new Set([...c.feasibility.unknownEssentials, ...(missingItinerary ? ['Detailed itinerary not confirmed'] : [])])],
      violatedConstraints: c.feasibility.violations.map(v => ({ constraint: v.kind, ...(v.kind !== 'budget' && v.memberId ? { memberId: v.memberId } : {}), explanation: v.kind === 'budget' ? publicFeasibilitySummary({ feasible: false, violations: [v], unknownEssentials: [] }) : v.detail })) },
  };
}

function fromState(b: B.TripState, previous: C.TripState): C.TripState {
  const timeZone = previous.timeZone ?? 'America/New_York';
  return { ...previous, ...b, memberConstraints: Object.values(b.memberConstraints).flat().map(r => fromUpdate(r, timeZone)),
    groupConstraints: b.groupConstraints.map(r => fromUpdate(r, timeZone) as C.GroupConstraintRecord),
    candidates: b.candidates.map(fromCandidate),
    acceptances: b.acceptances.map(a => ({ actorId: a.memberId, candidateId: a.candidateId, revision: a.revision, acceptedAt: previous.acceptances.find(x => x.actorId === a.memberId && x.revision === a.revision)?.acceptedAt ?? new Date().toISOString() })),
    pendingQuestions: b.pendingQuestions.map(q => ({ questionId: `${q.key}|${q.questionId}`, audience: q.audience.kind, memberId: q.audience.kind === 'private' ? q.audience.memberId : undefined, field: q.key.split(':')[0] as C.ConstraintField, text: q.text, askedAt: q.askedAt })),
  };
}

export function createPlannerAdapter(provider: ResearchProvider, spaceId: string): PlannerAdapter {
  const replies = (items: B.TripReply[]): C.OutboundMessage[] => items.map((r, i) => ({ ...r, deliveryId: `planner:${i}`, audience: r.audience.kind === 'group' ? { kind: 'group', spaceId } : r.audience }));
  return {
    applyCommand(state, command, options) {
      const before = toPlanningState(state);
      if (command.action.kind === 'confirm_stop') {
        const a = command.action;
        const reject = (code: string, text: string) => ({ state, rejection: { code, userMessage: text }, researchRequested: false, replies: replies([{ audience: { kind: 'private', memberId: command.actorId }, text }]) });
        if (command.tripId !== state.tripId || !before.roster.some(m => m.memberId === command.actorId && m.consented)) return reject('UNKNOWN_MEMBER', 'Only consenting participants can confirm stops.');
        if (a.revision !== state.revision) return reject('STALE_REVISION', 'Use the current plan revision to confirm a stop.');
        const candidate = before.candidates.find(c => c.candidateId === a.candidateId && c.revision === a.revision);
        const start = Date.parse(a.item.startAt), end = Date.parse(a.item.endAt);
        if (!candidate || !a.sourceMessageId || !a.item.location.trim() || a.item.location.length > 200 || !/T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(a.item.startAt) || !/T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(a.item.endAt) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || start < Date.parse(candidate.startAt) || end > Date.parse(candidate.endAt) || (a.item.tags ?? []).some(t => !t.trim() || t.length > 60)) return reject('INVALID_CONSTRAINT', 'Confirm a named stop with timezone-qualified times inside the agreed trip dates.');
        const existing = (candidate as B.TripCandidate & { itineraryConfirmed?: boolean }).itineraryConfirmed === false ? [] : candidate.itinerary;
        if (existing.some(i => Date.parse(i.startAt) < end && start < Date.parse(i.endAt))) return reject('INVALID_CONSTRAINT', 'That stop overlaps an existing stop. Choose a separate time window.');
        const revision = state.revision + 1;
        const item: B.ItineraryItem = { itemId: a.item.itemId, label: a.item.label ?? a.item.location, location: a.item.location.trim(), startAt: a.item.startAt, endAt: a.item.endAt, tags: a.item.tags ?? [], evidenceIds: [], travelMinutesFromPrevious: a.item.travelMinutesEstimate };
        const edited: B.TripCandidate & { itineraryConfirmed: boolean } = { ...candidate, revision, itineraryConfirmed: true, itinerary: [...existing, item].sort((x, y) => Date.parse(x.startAt) - Date.parse(y.startAt)), costs: candidate.costs.map(c => c.category === 'activities' || c.category === 'fuel_parking_tolls' ? { ...c, priceStatus: 'unknown', evidenceIds: [] } : c) };
        const next: B.TripState = { ...before, revision, status: 'proposed', selectedCandidateId: undefined, acceptances: [], candidates: before.candidates.map(c => reprice({ ...before, revision }, c.candidateId === candidate.candidateId ? edited : { ...c, revision })) };
        return { state: { ...fromState(next, state), itineraryConfirmations: [...state.itineraryConfirmations ?? [], { actorId: command.actorId, candidateId: candidate.candidateId, itemId: item.itemId, revision, sourceMessageId: a.sourceMessageId, confirmedAt: options?.now ?? new Date().toISOString() }] }, researchRequested: false, replies: replies([{ audience: { kind: 'group' }, text: `A stop was confirmed for ${candidate.title}. Review revision ${revision}; earlier acceptances no longer apply. Transport and activity estimates need confirmation for the updated itinerary.`, proposalRef: { candidateId: candidate.candidateId, revision } }]) };
      }
      if (command.action.kind === 'confirm_cost') {
        const a = command.action;
        const reject = (code: string, text: string) => ({ state, rejection: { code, userMessage: text }, researchRequested: false, replies: replies([{ audience: { kind: 'private', memberId: command.actorId }, text }]) });
        if (command.tripId !== state.tripId || !before.roster.some(m => m.memberId === command.actorId && m.consented)) return reject('UNKNOWN_MEMBER', 'Only consenting trip participants can confirm costs.');
        if (a.revision !== state.revision) return reject('STALE_REVISION', 'Use the current plan revision to confirm a cost.');
        const candidate = before.candidates.find(c => c.candidateId === a.candidateId && c.revision === a.revision);
        const cost = candidate?.costs.find(c => c.costId === a.costId);
        if (!candidate || !cost || (cost.allocation === 'personal' && cost.memberId !== command.actorId) || !Number.isSafeInteger(a.lowCents) || !Number.isSafeInteger(a.highCents) || a.lowCents < 0 || a.highCents < a.lowCents || !a.sourceMessageId) return reject('INVALID_CONSTRAINT', 'Confirm an existing cost with a valid nonnegative dollar range; personal costs can only be confirmed by their owner.');
        const revision = state.revision + 1;
        const evidenceId = `manual:${command.commandId}`;
        const priced = reprice({ ...before, revision }, { ...candidate, revision,
          costs: candidate.costs.map(c => c.costId === cost.costId ? { ...c, lowCents: a.lowCents, highCents: a.highCents, priceStatus: 'estimate', evidenceIds: [...c.evidenceIds, evidenceId] } : c),
          evidence: [...candidate.evidence, { evidenceId, url: '', title: 'Participant-confirmed estimate', retrievedAt: options?.now ?? new Date().toISOString(), kind: 'estimate', claim: 'A participant confirmed this cost range in chat.', uncertainty: 'Manual estimate; not independently verified or booked.' }],
        });
        const next = { ...before, revision, status: 'proposed' as const, acceptances: [], candidates: before.candidates.map(c => c.candidateId === candidate.candidateId ? priced : reprice({ ...before, revision }, { ...c, revision })) };
        delete next.selectedCandidateId;
        return { state: { ...fromState(next, state), costConfirmations: [...state.costConfirmations ?? [], { actorId: command.actorId, candidateId: candidate.candidateId, costId: cost.costId, revision, sourceMessageId: a.sourceMessageId, confirmedAt: options?.now ?? new Date().toISOString() }] }, researchRequested: false, replies: replies([{ audience: { kind: 'group' }, text: `A cost estimate was confirmed for ${candidate.title}. Review revision ${revision}; everyone must accept it again. ${publicFeasibilitySummary(priced.feasibility)}`, proposalRef: { candidateId: candidate.candidateId, revision } }]) };
      }
      const action = command.action.kind === 'update_constraint' ? { ...command.action, update: toPlanningUpdate(command.action.update) } : command.action;
      const result = applyCommand(before, { ...command, action }, options);
      return { ...result, state: result.state === before ? state : fromState(result.state, state), replies: replies(result.replies) };
    },
    generateCandidates: async state => (await planTrip(toPlanningState(state), provider, { timeZone: state.timeZone })).candidates.map(fromCandidate),
    async research(state) {
      const result = await planTrip(toPlanningState(state), provider, { timeZone: state.timeZone });
      return { revision: result.revision, candidates: result.candidates.map(fromCandidate), replies: replies(result.replies) };
    },
    install(state, revision, candidates) {
      const before = toPlanningState(state);
      const result = installCandidates(before, revision, candidates.map(toPlanningCandidate));
      return { ...result, state: result.state === before ? state : fromState(result.state, state), replies: replies(result.replies) };
    },
    async guide(state, question, now) {
      const answer = await answerGuideQuestion(toPlanningState(state), question, provider, { now });
      return `${answer.text}\n${answer.evidence.map(e => `${e.title}: ${e.url}`).join('\n')}`;
    },
  };
}
