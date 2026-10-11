import type {
  ActionableItem,
  ConstraintValue,
  InboundMessage,
  OutboundMessage,
  ParseResult,
  TripAction,
  TripCommand,
  TripConversationContext,
} from './contracts-local.js';
import { extractWithCoverage, HEDGE, TRIVIAL, type Extracted } from './constraints.js';
import { assertTimeZone, formatWindow, toIntervalWindows } from './dates.js';
import { guestProviderUserId, isGuest, parseJoinCode } from './join.js';
import { validateIntent } from './intent.js';
import { formatCents } from './money.js';
import type { ConversationDependencies } from './types.js';

const APPROVE_REACTIONS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '❤️', '❤', '✅', '✔️', 'like', 'love', 'thumbsup', '+1']);
const YES = /^(?:(?:yes|yep|yeah|yup|sure)(?:[ ,]+(?:it is|that is|that'?s right|that'?s it|correct|exactly|please|firm))?|ok|okay|accept|accepted|i accept|i'?m in|count me in|sounds good|works for me|let'?s do it|do it|confirm|confirmed|correct|that'?s right|exactly)[.!]*$/i;
const NO = /^(no|nope|nah|decline|i decline|not for me|not now|no thanks|pass)[.!]*$/i;
/** Explicitly says what we just recorded is wrong (as opposed to a bare "no", which is ambiguous after "tell me if I got anything wrong"). */
const WRONG = /^(?:(?:no|nope|nah)[ ,]+)?(?:that'?s|that is|it'?s|it is|this is)?\s*(?:not right|not correct|wrong|incorrect|not what i (?:said|meant))[.!]*$/i;
const ID = '([A-Za-z0-9][\\w:.\\-]*)';
const REQUEST_PLANS = /^(?:(?:please|pls|ok|okay|alright|so)[,\s]+)?(?:(?:can|could) you\s+)?(?:(?:show|give|get|send)\s+(?:me\s+|us\s+)?(?:the\s+|some\s+|a few\s+|a couple of\s+|a couple\s+)?(?:trip\s+)?(?:options|plans|proposals|itineraries|ideas)|(?:pull|put) together\s+(?:a\s+|some\s+)?(?:(?:few|couple of|couple)\s+)?(?:trip\s+)?(?:options|plans|ideas)(?:\s+for us)?|(?:plan|research)\s+(?:it|this|the trip|our trip)|find\s+(?:us\s+)?(?:trip\s+)?options|what are (?:our|the) options|(?:(?:let'?s|lets|can we|could we|we should|i want to|we want to|i'?d like to)\s+)?(?:start|begin|get started)(?:\s+(?:on\s+)?(?:planning|plan))?(?:\s+(?:a|the|our|this))?(?:\s+(?:road\s+)?trip)?|(?:let'?s|lets|can we|could we|we should|i want to|we want to|i'?d like to)\s+plan(?:\s+(?:a|the|our|this))?(?:\s+(?:road\s+)?trip)?(?:\s+together)?)$/i;
const GREETING = /^(?:hi|hey|hello|yo|hiya|good (?:morning|afternoon|evening))\b[,!.\s]*/i;
const REQUEST_FUNDING = /^(?:request|start|set up|send)\s+(?:the\s+)?(?:contributions?|funding|contribution requests)$/i;
const GUIDE = /^(?:guide|ask guide|\/guide)\s*[:\-]?\s+(.{3,500})$/is;
const SELECT = new RegExp(`^(?:pick|choose|select|go with|vote(?: for)?|i vote(?: for)?)\\s+(?:option\\s+|plan\\s+)?${ID}(?:\\s+v(\\d+))?$`, 'i');
const ACCEPT = new RegExp(`^accept\\s+${ID}\\s+v(\\d+)$`, 'i');

const HELP = "Sorry, I didn't catch that one. I can note your budget, free dates and what you're into, show trip options, or answer trip questions. Try \"my max is $200\" or \"free Oct 17-19\", or say \"let's plan a trip\" to get started.";

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** One friendly clause per recorded fact. Only used in private chats, so echoing the sender's own budget is fine. */
function ackPart(v: ConstraintValue, tentative: boolean): string {
  switch (v.field) {
    case 'budget': return `your max is ${money(v.value)} (just between us)`;
    case 'availability': return `you're free ${v.value.filter((w): w is { start: string; end: string } => 'start' in w).map(formatWindow).join(' or ')}`;
    case 'duration': return `${v.value} night${v.value === 1 ? '' : 's'}`;
    case 'origin': return `leaving from ${v.value}`;
    case 'region': return v.value;
    case 'transport': return v.vehicleAvailable === true ? "there's a car" : v.vehicleAvailable === false ? 'no car for you' : `transport: ${v.value}`;
    case 'preferences': return v.value.includes('no preference') ? 'no strong preferences' : `you ${tentative ? 'might be' : "'re"} into ${list(v.value)}`.replace("you 're", "you're");
    case 'must_dos': return v.value.length ? `must-haves: ${list(v.value)}` : 'no must-haves';
  }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createParser(deps: ConversationDependencies) {
  const { trip } = deps;
  assertTimeZone(trip.timezone);

  const reply = (msg: InboundMessage, text: string, tag: string, forcePrivate = false): ParseResult => ({
    kind: 'reply',
    message: replyMessage(msg, text, tag, forcePrivate),
  });

  function replyMessage(msg: InboundMessage, text: string, tag: string, forcePrivate = false): OutboundMessage {
    const priv = forcePrivate || msg.visibility === 'private' || trip.mode === 'direct';
    return {
      deliveryId: `reply:${msg.eventId}:${tag}`,
      audience: priv ? { kind: 'private', memberId: msg.senderId } : { kind: 'group', spaceId: trip.groupSpaceId },
      text,
    };
  }

  function command(msg: InboundMessage, ctx: TripConversationContext, action: TripAction, suffix = ''): TripCommand {
    return {
      commandId: `${ctx.tripId}:${msg.eventId}:${action.kind}${suffix}`,
      eventId: msg.eventId,
      actorId: msg.senderId,
      tripId: ctx.tripId,
      action,
    };
  }

  const one = (msg: InboundMessage, ctx: TripConversationContext, action: TripAction): ParseResult => ({ kind: 'command', command: command(msg, ctx, action) });

  /** Availability leaves this module as real intervals in the trip timezone; everything else is unchanged. */
  function normalize(v: ConstraintValue): ConstraintValue {
    if (v.field !== 'availability') return v;
    return { field: 'availability', value: toIntervalWindows(v.value.filter((w): w is { start: string; end: string } => 'start' in w), trip.timezone) };
  }

  function updateCommand(msg: InboundMessage, ctx: TripConversationContext, v: ConstraintValue, hedged: boolean): TripCommand {
    return command(msg, ctx, {
      kind: 'update_constraint',
      update: { ...normalize(v), memberId: msg.senderId, sourceMessageId: msg.messageId, certainty: hedged ? 'tentative' : 'confirmed' } as never,
    }, `:${v.field}`);
  }

  // ----- constraints -----

  const GROUP_WORDS = /\b(?:everyone|everybody|everyone's|everybody's|each of us|all of us|the whole group|the group's|the team's|their|his|her)\b/i;
  function mentionsOtherMember(text: string, senderId: string): boolean {
    if (GROUP_WORDS.test(text)) return true;
    return trip.members
      .filter((m) => m.userId !== senderId)
      .some((m) => new RegExp(`\\b${escapeRe(m.displayName)}(?:'s)?\\b`, 'i').test(text));
  }

  function fromConstraints(msg: InboundMessage, ctx: TripConversationContext, text: string, items: Extracted[], extra: TripAction[] = []): ParseResult {
    const commands: TripCommand[] = [];
    const asks: string[] = [];
    let private_ = false;
    let hedgedBudget: number | undefined;
    const acks: string[] = [];

    for (const item of items) {
      const v = item.value;
      if (v.field === 'budget' && mentionsOtherMember(text, msg.senderId)) {
        // Nobody can set another member's budget, and a message that names someone else is ambiguous.
        asks.push("I can only take a budget from the person it's for, so I haven't noted that one. Ask them to text me their own, or tell me yours with \"my max is $X\".");
        private_ = true;
        continue;
      }
      if (v.field === 'availability' && item.negative) {
        asks.push('Got it, those dates are out. Which dates are you free? Something like "free Oct 24-26" works.');
        continue;
      }
      // Budgets and dates commit people to something, so tentative wording is a question, not a record.
      if ((v.field === 'budget' || v.field === 'availability') && item.hedged) {
        if (v.field === 'budget') {
          asks.push(`Just so I get it right: is ${formatCents(v.value).replace(/\.00$/, '')} your firm max for the whole trip, including food and travel? Say "yes" or "my max is $X" and I'll lock it in.`);
          private_ = true;
          hedgedBudget = v.value;
        } else {
          asks.push('I want to get the dates right. Which ones can you actually do? Something like "free Oct 17-19" works.');
        }
        continue;
      }
      commands.push(updateCommand(msg, ctx, v, item.hedged));
      acks.push(ackPart(v, item.hedged));
    }
    for (const action of extra) commands.push(command(msg, ctx, action));
    // In a one-on-one chat, silence feels like being ignored: say what we noted. Groups stay quiet.
    const talkative = msg.visibility === 'private' || trip.mode === 'direct';
    let acknowledgement: OutboundMessage | undefined;
    if (talkative && acks.length) {
      if (asks.length === 0) acknowledgement = replyMessage(msg, `Got it: ${list(acks)}. Tell me if I got anything wrong.`, 'ack', true);
      else { asks.unshift(`Got it: ${list(acks)}.`); private_ = true; } // a real question is coming, so say both in one message
    }

    const clarification = asks.length ? replyMessage(msg, asks.join('\n'), 'clarify', private_) : undefined;
    const expects = hedgedBudget !== undefined ? { expects: { field: 'budget' as const, valueCents: hedgedBudget } } : {};
    if (commands.length === 0) return clarification ? { kind: 'reply', message: clarification, ...expects } : { kind: 'ignored', reason: 'nothing to record' };
    if (commands.length === 1 && !clarification && !acknowledgement) return { kind: 'command', command: commands[0]! };
    return { kind: 'commands', commands, ...(clarification ? { clarification } : {}), ...(acknowledgement ? { acknowledgement } : {}), ...expects };
  }

  // ----- plan selection / acceptance -----

  function actionable(ctx: TripConversationContext, kind: ActionableItem['kind']) {
    return ctx.actionable.filter((a) => a.kind === kind);
  }

  function bindPlan(msg: InboundMessage, ctx: TripConversationContext, kind: ActionableItem['kind'], token: string, revision: number | undefined): ParseResult {
    const pool = actionable(ctx, kind);
    const lower = token.toLowerCase();
    let match = pool.find((a) => a.candidateId.toLowerCase() === lower);
    if (!match && /^\d{1,2}$/.test(token)) match = pool[Number(token) - 1];
    const verb = kind === 'accept' ? 'accept' : 'pick';
    if (!match) {
      return reply(msg, `Hmm, I don't see "${token}" waiting on you to ${verb}. ${pool.length ? `Here's what's open: ${pool.map((a, i) => `${i + 1}. ${a.description}`).join('; ')}.` : "Nothing's waiting on you right now."}`, 'noplan');
    }
    if (revision !== undefined && revision !== match.revision) {
      return reply(msg, `That's an older version (v${revision}), sorry! The latest is v${match.revision}. Take a look and reply "${kind === 'accept' ? 'accept' : 'pick'} ${match.candidateId} v${match.revision}" when you're ready.`, 'stale');
    }
    return one(msg, ctx, kind === 'accept'
      ? { kind: 'accept_candidate', candidateId: match.candidateId, revision: match.revision }
      : { kind: 'select_candidate', candidateId: match.candidateId, revision: match.revision });
  }

  function resolveAnswer(msg: InboundMessage, ctx: TripConversationContext, yes: boolean): ParseResult {
    const pending = ctx.pendingConfirmation;
    if (pending && ctx.actionable.length > 0) {
      // A bare yes/no could answer either question. Never guess: a plan acceptance is a financial commitment.
      return reply(msg, `Quick check, I've got two things open: is ${formatCents(pending.valueCents).replace(/\.00$/, '')} your firm max, and the plan waiting on you? Say "my max is $X" for the budget, or "accept <id> v<n>" / "pick <id>" for the plan.`, 'which2', true);
    }
    if (pending) {
      if (!yes) return reply(msg, "No problem! What's your firm max for the whole trip, including food and travel?", 'budget-no', true);
      // They confirmed the exact amount we asked about, so it is recorded as confirmed (it is still their own budget).
      const locked = updateCommand(msg, ctx, { field: 'budget', value: pending.valueCents }, false);
      return { kind: 'commands', commands: [locked], acknowledgement: replyMessage(msg, `Locked in, your max is ${money(pending.valueCents)}. Thanks, and that stays between us.`, 'locked', true) };
    }
    const list = ctx.actionable;
    if (list.length === 0) {
      // Nothing is waiting on an answer, so this is probably a reply to our "Got it ... tell me if I got anything wrong".
      // In a one-on-one chat never go silent; in a group, stay out of it.
      if (msg.visibility !== 'private' && trip.mode !== 'direct') return { kind: 'ignored', reason: 'nothing to answer' };
      return yes
        ? reply(msg, `Great! Anything else to add? When you're ready, say "show us some options".`, 'thanks')
        : reply(msg, `No worries! If anything's off, just tell me the right detail, like "my max is $300" or "free Nov 21-23". Otherwise say "show us some options" when you're ready.`, 'neutral-no');
    }
    if (!yes) {
      return reply(msg, "No worries, I haven't recorded an acceptance. What would you want to change: the dates, the budget, or the activities?", 'no');
    }
    if (list.length > 1) {
      const lines = list.map((a, i) => `${i + 1}. ${a.description} (${a.candidateId} v${a.revision})`);
      return reply(msg, `I've got more than one thing waiting on you:\n${lines.join('\n')}\nWhich one do you mean? Reply "accept <id> v<version>" or "pick <id>".`, 'which');
    }
    const only = list[0]!;
    return one(msg, ctx, only.kind === 'accept'
      ? { kind: 'accept_candidate', candidateId: only.candidateId, revision: only.revision }
      : { kind: 'select_candidate', candidateId: only.candidateId, revision: only.revision });
  }

  // ----- entry points -----

  async function parseReaction(msg: InboundMessage, override?: TripConversationContext): Promise<ParseResult> {
    const { targetMessageId, emoji } = msg.reaction!;
    if (!APPROVE_REACTIONS.has(emoji)) return { kind: 'ignored', reason: 'only positive reactions are recorded' };
    const ctx = override ?? (await deps.getConversationContext(msg.senderId, msg.spaceId, targetMessageId));
    const t = ctx.targetProposal;
    if (!t) return { kind: 'ignored', reason: 'reaction target is not a proposal' };
    // Defence in depth: the target must be one this member can act on, at exactly that kind and revision.
    const ok = ctx.actionable.some((a) => a.kind === t.kind && a.candidateId === t.candidateId && a.revision === t.revision);
    if (!ok) return { kind: 'ignored', reason: 'reaction target is stale or not actionable by this member' };
    return one(msg, ctx, t.kind === 'accept'
      ? { kind: 'accept_candidate', candidateId: t.candidateId, revision: t.revision }
      : { kind: 'select_candidate', candidateId: t.candidateId, revision: t.revision });
  }

  function explicit(msg: InboundMessage, ctx: TripConversationContext, text: string): ParseResult | null {
    const plain = text.replace(GREETING, '').replace(/[?!.\s]+$/, '');
    let m: RegExpExecArray | null;
    if (REQUEST_PLANS.test(plain)) return one(msg, ctx, { kind: 'request_plans' });
    if (REQUEST_FUNDING.test(plain)) return one(msg, ctx, { kind: 'request_funding' });
    if ((m = GUIDE.exec(text.trim()))) return one(msg, ctx, { kind: 'ask_guide', question: m[1]!.trim() });
    if ((m = ACCEPT.exec(plain))) return bindPlan(msg, ctx, 'accept', m[1]!, Number(m[2]));
    if ((m = SELECT.exec(plain))) return bindPlan(msg, ctx, 'select', m[1]!, m[2] ? Number(m[2]) : undefined);
    return null;
  }

  async function parseText(msg: InboundMessage, override?: TripConversationContext): Promise<ParseResult> {
    // iMessage types curly apostrophes and quotes; our rules expect plain ones.
    const text = (msg.text ?? '').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
    if (!text) return { kind: 'ignored', reason: 'empty message' };
    const ctx = override ?? (await deps.getConversationContext(msg.senderId, msg.spaceId));

    const ex = explicit(msg, ctx, text);
    if (ex) return ex;
    const plain = text.replace(/[?!.\s]+$/, '');
    if (WRONG.test(plain)) {
      if (ctx.actionable.length || ctx.pendingConfirmation) return resolveAnswer(msg, ctx, false);
      return msg.visibility === 'private' || trip.mode === 'direct'
        ? reply(msg, `Sorry about that! What should I fix? Tell me the right detail, like "my max is $300", "free Nov 21-23" or "leaving from Raleigh".`, 'sorry')
        : { kind: 'ignored', reason: 'nothing to correct' };
    }
    if (YES.test(text) || YES.test(plain)) return resolveAnswer(msg, ctx, true);
    if (NO.test(text) || NO.test(plain)) return resolveAnswer(msg, ctx, false);

    // Rules first (fast, exact). Anything the rules did not recognize is handed to the language model automatically,
    // and its (validated) answer is merged with what the rules found.
    const { items: extracted, unmatched } = extractWithCoverage(text, msg.occurredAt, ctx.pendingQuestion?.field);
    const talkative = msg.visibility === 'private' || trip.mode === 'direct';
    if (!extracted.length && TRIVIAL.test(text)) {
      // Small talk needs no model. In a one-on-one chat answer it warmly; in a group stay out of it.
      if (!talkative) return { kind: 'ignored', reason: 'small talk' };
      if (/^(?:thanks?|thank you|thx|ty|appreciate)/i.test(text)) return reply(msg, 'Anytime! Tell me if you want to change anything, or say "show us some options" when you\'re ready.', 'welcome');
      if (/^(?:hi|hey|hello|yo|hiya|good )/i.test(text)) return reply(msg, 'Hey! Want to plan a trip? Say "let\'s plan a trip" to get started.', 'greeting');
      return reply(msg, 'Sounds good. I\'m here whenever you want to add something or see options.', 'smalltalk');
    }
    // A request tucked into a longer message ("..., can you show us some options?") is understood by rule, not sent away.
    const requested: TripAction[] = [];
    for (let i = unmatched.length - 1; i >= 0; i--) {
      const clause = unmatched[i]!.replace(GREETING, '').replace(/^(?:(?:and|also|so|then|ok|okay)\s+)+/i, '').replace(/[?!.\s]+$/, '');
      if (extracted.length && REQUEST_PLANS.test(clause)) { requested.push({ kind: 'request_plans' }); unmatched.splice(i, 1); }
    }
    if (extracted.length && unmatched.length === 0) return fromConstraints(msg, ctx, text, extracted, requested);
    const handoffText = extracted.length ? unmatched.join(' ') : text;

    const raw = await deps.intentModel.interpret({
      text: handoffText,
      occurredAt: msg.occurredAt,
      ...(extracted.length ? { alreadyKnown: extracted.map((e) => e.value.field) } : {}),
      visibility: msg.visibility,
      timezone: trip.timezone,
      memberNames: trip.members.map((m) => m.displayName),
      ...(ctx.pendingQuestion ? { pendingField: ctx.pendingQuestion.field } : {}),
      hasActionable: ctx.actionable.length > 0,
    });
    const intent = validateIntent(raw);
    const hedged = HEDGE.test(handoffText);
    if (extracted.length) {
      // Partly understood by rules, the rest by the model: keep the rules' answers, add anything new the model found.
      const items = [...extracted];
      const extra: TripAction[] = [...requested];
      if (intent.intent === 'constraints') {
        for (const value of intent.items) if (!items.some((i) => i.value.field === value.field)) items.push({ value, hedged });
      } else if (intent.intent === 'request_plans') extra.push({ kind: 'request_plans' });
      else if (intent.intent === 'ask_guide') extra.push({ kind: 'ask_guide', question: intent.question });
      else if (intent.intent === 'request_funding' && !hedged) extra.push({ kind: 'request_funding' });
      return fromConstraints(msg, ctx, text, items, extra);
    }
    switch (intent.intent) {
      case 'none':
        // In a group, ordinary chat between friends is none of our business. In a one-on-one DM every message
        // is addressed to us, so staying silent just looks broken.
        return msg.visibility === 'private' || trip.mode === 'direct'
          ? reply(msg, HELP, 'help')
          : { kind: 'ignored', reason: 'not addressed to the assistant' };
      case 'clarify':
        // In a group, an unclear message is usually just friends talking: stay quiet there.
        return msg.visibility === 'private' || trip.mode === 'direct'
          ? reply(msg, HELP, 'help')
          : { kind: 'ignored', reason: 'unclear group message' };
      case 'constraints':
        return fromConstraints(msg, ctx, text, intent.items.map((value) => ({ value, hedged })));
      case 'request_plans':
        return one(msg, ctx, { kind: 'request_plans' });
      case 'ask_guide':
        return one(msg, ctx, { kind: 'ask_guide', question: intent.question });
      case 'request_funding':
        return hedged ? reply(msg, 'Happy to set up contribution requests. Just say "request contributions" so I know you mean it.', 'hedge') : one(msg, ctx, { kind: 'request_funding' });
      case 'yes':
        if (hedged) return reply(msg, 'Just to be sure: are you good with this plan? Reply "yes" to accept or "no" if not.', 'hedge');
        return resolveAnswer(msg, ctx, true);
      case 'no':
        return resolveAnswer(msg, ctx, false);
    }
  }

  /**
   * A join attempt. The shared contracts have no `join_trip` action yet, so this is emitted only when the app opts
   * in with `joinCodes: true` (see docs/conversation.md); the app must validate the code and record consent.
   */
  function joinCommand(msg: InboundMessage, code: string, providerUserId: string): ParseResult {
    const command = {
      commandId: `${trip.tripId}:${msg.eventId}:join_trip`,
      eventId: msg.eventId,
      actorId: msg.senderId,
      tripId: trip.tripId,
      action: { kind: 'join_trip', code, providerUserId },
    } as unknown as TripCommand;
    return { kind: 'command', command };
  }

  async function parse(msg: InboundMessage, context?: TripConversationContext): Promise<ParseResult> {
    if (isGuest(msg.senderId)) {
      const code = deps.joinCodes && msg.visibility === 'private' && !msg.reaction ? parseJoinCode(msg.text ?? '') : null;
      return code ? joinCommand(msg, code, guestProviderUserId(msg.senderId)) : { kind: 'ignored', reason: 'sender is not enrolled' };
    }
    if (deps.joinCodes && msg.text && !msg.reaction && trip.members.some((m) => m.userId === msg.senderId) && parseJoinCode(msg.text)) {
      return reply(msg, "You're already on this trip, so you're all set! Just tell me your budget, dates and what you're into.", 'already-joined', true);
    }
    if (!trip.members.some((m) => m.userId === msg.senderId)) return { kind: 'ignored', reason: 'sender is not enrolled' };
    if (msg.visibility === 'group' && (trip.mode !== 'group' || msg.spaceId !== trip.groupSpaceId)) return { kind: 'ignored', reason: 'unrelated group' };
    if (msg.reaction) return parseReaction(msg, context);
    return parseText(msg, context);
  }

  return { parse };
}
