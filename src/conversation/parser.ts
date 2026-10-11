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
import { localReference } from './dates.js';
import { extractWithCoverage, GROUP_BUDGET, HEDGE, TRIVIAL, type Extracted } from './constraints.js';
import { assertTimeZone, formatWindow, toIntervalWindows } from './dates.js';
import { guestProviderUserId, isGuest, parseJoinCode } from './join.js';
import { safeChatAnswer, validateIntent } from './intent.js';
import { formatCents } from './money.js';
import type { ConversationDependencies } from './types.js';

const APPROVE_REACTIONS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '❤️', '❤', '✅', '✔️', 'like', 'love', 'thumbsup', '+1']);
const YES = /^(?:(?:yes|yep|yeah|yup|sure)(?:[ ,]+(?:it is|that is|that'?s right|that'?s it|correct|exactly|please|firm))?|ok|okay|accept|accepted|i accept|i'?m in(?:\s+too)?|me too|i'?m down|count me in|sounds good|works for me|let'?s do it|do it|confirm|confirmed|correct|that'?s right|exactly)[.!]*$/i;
/** "yes that works", "sounds good to me", "all good": agreement, as long as nothing in it asks for a change. */
const AGREES_START = /^(?:yes|yeah|yep|yup|yea|sure|ok|okay|absolutely|definitely|totally|sounds|that works|that'?ll work|works|all good|fine|good|perfect|great|i'?m (?:good|fine|down|in)|let'?s do it|love it|looks good)\b/i;
const CHANGE_WORDS = /\b(?:but|actually|instead|rather|except|though|however|no|not|don'?t|doesn'?t|can'?t|wait|hold on|change)\b/i;
const BASICS_OK = { test: (t: string) => AGREES_START.test(t) && !CHANGE_WORDS.test(t) };
const BARE_PLACE = /^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}[.!]*$/;
/** Capitalized by the phone's keyboard but not a place: a command word, a day or month, a hedge, or a greeting plus a name for the bot. */
const NOT_A_WORD_PLACE = /^(?:help|cancel|wait|maybe|stop|skip|menu|options?|later|sorry|huh|what|why|how|hmm|ok|okay|sure|yes|no|nope|saturday|sunday|monday|tuesday|wednesday|thursday|friday|today|tomorrow|tonight|weekend|january|february|march|april|may|june|july|august|september|october|november|december|(?:hi|hey|hello|yo)\s+(?:bot|there|everyone|all|guys|team)|happy\s+\w+|merry\s+\w+)[.!?]*$/i;
const NO = /^(no|nope|nah|decline|i decline|not for me|not now|no thanks|pass)[.!]*$/i;
/** Explicitly says what we just recorded is wrong (as opposed to a bare "no", which is ambiguous after "tell me if I got anything wrong"). */
const WRONG = /^(?:(?:no|nope|nah)[ ,]+)?(?:that'?s|that is|it'?s|it is|this is)?\s*(?:not right|not correct|wrong|incorrect|not what i (?:said|meant))[.!]*$/i;
const ID = '([A-Za-z0-9][\\w:.\\-]*)';
const REQUEST_PLANS = /^(?:(?:please|pls|ok|okay|alright|so)[,\s]+)?(?:(?:can|could) you\s+)?(?:(?:show|give|get|send)\s+(?:me\s+|us\s+)?(?:the\s+|some\s+|a few\s+|a couple of\s+|a couple\s+)?(?:trip\s+)?(?:options|plans|proposals|itineraries|ideas)|(?:pull|put) together\s+(?:a\s+|some\s+)?(?:(?:few|couple of|couple)\s+)?(?:trip\s+)?(?:options|plans|ideas)(?:\s+for us)?|(?:plan|research)\s+(?:it|this|the trip|our trip)|find\s+(?:us\s+)?(?:trip\s+)?options|what are (?:our|the) options|(?:(?:let'?s|lets|can we|could we|we should|i want to|we want to|i'?d like to)\s+)?(?:start|begin|get started)(?:\s+(?:on\s+)?(?:planning|plan))?(?:\s+(?:a|the|our|this))?(?:\s+(?:road\s+)?trip)?|(?:let'?s|lets|can we|could we|we should|i want to|we want to|i'?d like to)\s+plan(?:\s+(?:a|the|our|this))?(?:\s+(?:road\s+)?trip)?(?:\s+together)?)$/i;
const STATUS = /^(?:(?:so\s+)?(?:what'?s|whats|how'?s|hows)\s+(?:the\s+)?(?:status|progress|plan|it going)(?:\s+(?:so far|looking|going))?|where (?:are we|do we stand)(?:\s+(?:at|on this))?|what do you have(?:\s+so far)?|any (?:updates?|news|progress)|status(?: update)?)$/i;
const ABOUT_SOMEONE = /^(?:so\s+)?(?:what(?:'s|s| did| has| does| is)\s+(\w+)\s+(?:say|said|tell you|told you|put|give you|gave you|send|sent|want|think|thinking|saying)|(?:did|has)\s+(\w+)\s+(?:answer|reply|respond|text|say anything|send anything|tell you anything)|(?:any word from|have you heard from|heard from|anything from)\s+(\w+)|how(?:'s| is)\s+(\w+)\s+doing|how(?:'s| is)\s+(\w+?)(?:'s|s)?\s+(?:planning|progress)(?:\s+going)?|(?:is|has|did)\s+(\w+)\s+(?:still\s+)?(?:planning|done|finished|finish|ready|all set|set|in|on board|there|responded|replied)(?:\s+(?:planning|yet|so far))?)(?:\s+(?:yet|so far))?$/i;
const GREETING = /^(?:hi|hey|hello|yo|hiya|good (?:morning|afternoon|evening))\b[,!.\s]*/i;
const REQUEST_FUNDING = /^(?:request|start|set up|send)\s+(?:the\s+)?(?:contributions?|funding|contribution requests)$/i;
const FUND_STATUS = /^(?:so\s+)?(?:how(?:'s| is)\s+(?:the\s+)?(?:trip\s+)?(?:fund|pot|money)(?:\s+(?:looking|going|doing|so far))?|(?:what'?s|what is|how much is)\s+(?:in\s+)?(?:the\s+)?(?:trip\s+)?(?:fund|pot)(?:\s+(?:at|now|status))?|who(?:'s| is)?\s*(?:still\s+)?owes?(?:\s+(?:money|anything|us|the fund))?|who\s+(?:still\s+)?(?:needs to pay|hasn'?t\s+(?:paid|chipped in|sent(?: their share)?))(?:\s+yet)?|(?:trip\s+)?fund\s+status|who(?:'s|s| has| have)?\s+(?:paid|chipped in|sent (?:their|the) (?:share|money))(?:\s+(?:yet|so far))?|(?:has|did|have)\s+(?:everyone|everybody|anyone|anybody|we all)\s+(?:paid|chipped in|sent (?:their|the) (?:share|money))(?:\s+(?:yet|so far))?|how much\s+(?:money\s+)?(?:do|have)\s+(?:we|we've)\s+(?:have|got|raised|collected|put in)(?:\s+(?:so far|in the (?:fund|pot)|yet|total))?|how much\s+(?:money\s+)?(?:do we have|is there)(?:\s+(?:in the (?:fund|pot)|so far|left))?)[?!.]*$/i;
const FUND_REMIND = /^(?:(?:please|pls|can you|could you)\s+)*(?:(?:remind|nudge|ping)\s+(?:everyone|everybody|them|the others|the rest|whoever(?:'s| is)?\s+(?:left|missing|late))(?:\s+(?:to pay|about (?:the\s+)?(?:fund|money|it)|to chip in|to send (?:their|the) (?:share|money)))?|send (?:out )?(?:payment )?reminders?)$/i;
const FUND_WRAP = /^(?:(?:please|pls|can you|could you)\s+)*(?:wrap\s*-?\s*up|settle\s+up|close\s+out)(?:\s+(?:the\s+)?(?:trip|fund|money|pot|trip fund))?$|^(?:who gets what back|how much (?:do (?:i|we) get|(?:will|would) (?:i|we) get) back|what do we get back)$/i;
const GUIDE = /^(?:guide|ask guide|\/guide)\s*[:\-]?\s+(.{3,500})$/is;
const SELECT = new RegExp(`^(?:pick|choose|select|go with|vote(?: for)?|i vote(?: for)?)\\s+(?:option\\s+|plan\\s+)?${ID}(?:\\s+v(\\d+))?$`, 'i');
/**
 * Picking by words: "option 1", "the first one", "1", "let's do option 2", "I'll take the second one", "I like option 2 better".
 * Only ever a pick (a preference); agreeing to pay is a separate, explicit step.
 */
const CHOICE = '(first|1st|second|2nd|third|3rd|fourth|4th|one|two|three|four|[1-9])';
const PICK_WORDS = new RegExp(
  `^(?:(?:ok(?:ay)?|yeah|yes|so|alright)[,\\s]+)?` +
  `(?:(?:let'?s|lets)\\s+(?:do|go with|take|pick|choose)\\s+|(?:i|we)(?:'ll|'d| will| would)?\\s+(?:do|go with|take|pick|choose|want|like|prefer|vote(?: for)?|say)\\s+|(?:i|we)\\s+(?:vote|say)\\s+|(?:go with|take|pick|choose|vote(?: for)?)\\s+)?` +
  `(?:the\\s+)?(?:option\\s+|plan\\s+|trip\\s+|number\\s+|no\\.?\\s*|#\\s*)?${CHOICE}(?:\\s+(?:one|option|plan|trip))?(?:\\s+(?:please|for me|for us|then|better|i think|sounds good|looks good))*$`,
  'i',
);
const CHOICE_NUMBER: Record<string, number> = { first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2, third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4 };
const BARE_CHOICE = /^(?:[1-9]|one|two|three|four)$/i;
/** iMessage on Android and SMS show a tapback as text: Liked "…". Only the positive ones count. */
const TEXT_TAPBACK = /^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned)\s+["“](.*)["”]$/s;
const THUMBS = /^(?:👍[\u{1F3FB}-\u{1F3FF}]?|❤️?|✅|\+1|:\+1:|:thumbsup:|:thumbs_up:|:heart:|:white_check_mark:)$/iu;
const ACCEPT = new RegExp(`^accept\\s+${ID}\\s+v(\\d+)$`, 'i');

const UNAVAILABLE = "Sorry, my language helper isn't answering right now, so I couldn't read that one. Try again in a minute, or use plain phrases like \"my max is $200\" or \"free Oct 17-19\".";
const HELP = "Hmm, I didn't quite catch that. Could you say it another way? I can take your budget, free dates and what you're into, show trip options, or answer trip questions, like \"my max is $200\" or \"free Oct 17-19\".";

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** One friendly clause per recorded fact. Only used in private chats, so echoing the sender's own budget is fine. */
function ackPart(v: ConstraintValue, tentative: boolean): string {
  switch (v.field) {
    case 'budget': return `your max is ${money(v.value)} (just between us)`;
    case 'availability': return `you're free ${v.value.filter((w): w is { start: string; end: string } => 'start' in w).map(formatWindow).join(' or ')}`;
    case 'duration': return `${v.value} night${v.value === 1 ? '' : 's'}`;
    case 'origin': return `leaving from ${titleCase(v.value)}`;
    case 'region': return /^(?:within|any)\b/.test(v.value) ? v.value : /\b(?:beach(?:es)?|coast|mountains?|lakes?|shore|countryside)\b/i.test(v.value) ? (/^the\b/i.test(v.value) ? v.value : `the ${v.value}`) : titleCase(v.value);
    case 'transport': return v.vehicleAvailable === true ? "there's a car" : v.vehicleAvailable === false ? 'no car for you' : `transport: ${v.value}`;
    case 'preferences': return v.value.includes('no preference') ? 'no strong preferences' : `you ${tentative ? 'might be' : "'re"} into ${list(v.value)}`.replace("you 're", "you're");
    case 'must_dos': return v.value.length ? `must-haves: ${list(v.value)}` : 'no must-haves';
  }
}
/** "chapel hill" -> "Chapel Hill": only words typed in lower case, so "NC" and "DC" stay as written. */
const titleCase = (text: string) => text.replace(/\b([a-z])([a-z.']*)/g, (word, first: string, rest: string) => (['of', 'the', 'and', 'in', 'on', 'by'].includes(word) ? word : first.toUpperCase() + rest));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Plain facts the model may use to answer a casual question. Only what is already fine to repeat: never a budget amount. */
function chatFacts(ctx: TripConversationContext): string[] {
  const word: Record<string, string> = { availability: 'free dates', budget: 'a maximum budget', preferences: 'what they like', origin: 'the starting city', region: 'where to go', duration: 'how many nights', transport: 'a car', must_dos: 'must-haves' };
  const facts: string[] = [];
  const status = { gathering: 'still gathering everyone\'s details', researching: 'looking up trip options right now', proposed: 'options have been sent and are waiting for picks', awaiting_acceptance: 'a plan was picked and is waiting for everyone\'s OK', approved: 'the plan is approved' }[ctx.status ?? 'gathering'];
  facts.push(`Trip status: ${status}.`);
  for (const o of ctx.others ?? []) {
    const missing = o.missing.map((m) => word[m] ?? m);
    facts.push(`${o.name} has said: ${o.shared.length ? o.shared.join(' and ') : 'nothing yet'}. ${o.name} ${missing.length ? `has not given: ${missing.join(', ')}` : 'has given everything needed (the budget stays private)'}.`);
  }
  const needed = [...new Set([...(ctx.pendingQuestion ? [ctx.pendingQuestion.field] : []), ...(ctx.openFields ?? [])].map((f) => word[f] ?? f))];
  facts.push(needed.length ? `Still needed from the person asking: ${needed.join(', ')}.` : 'Nothing else is needed from the person asking right now.');
  if (ctx.actionable.length) facts.push('There are options waiting for the person asking to pick or approve.');
  if (ctx.optionFacts?.length) facts.push(`${ctx.status === 'approved' ? 'The approved plan' : 'Options on offer'}: ${ctx.optionFacts.join(' | ')}.`);
  if (ctx.approval) facts.push(`The picked plan is ${ctx.approval.title}. Said "I'm in": ${ctx.approval.youIn ? 'the person asking' : 'not the person asking'}${ctx.approval.inNames.length ? ` (people in: ${ctx.approval.inNames.join(', ')})` : ''}. Still waiting on: ${[...(ctx.approval.youIn ? [] : ['the person asking']), ...ctx.approval.waitingNames].join(', ') || 'nobody'}.`);
  facts.push('How plans change: when anyone changes the dates, the number of nights, the place, the starting city, the car, or their own maximum budget, the old options are dropped and a fresh search starts. Budgets are private, so never say whose budget changed or by how much; say only that someone changed a detail or a limit.');
  return facts;
}

export function createParser(deps: ConversationDependencies) {
  const { trip } = deps;
  assertTimeZone(trip.timezone);

  const noteMiss = (kind: 'help' | 'unavailable' | 'unclear', msg: InboundMessage, ctx?: TripConversationContext) => {
    try { deps.onMiss?.({ kind, text: (msg.text ?? '').slice(0, 300), senderId: msg.senderId, ...(ctx?.status ? { status: ctx.status } : {}) }); } catch { /* never break the chat */ }
  };
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
      .some((m) => new RegExp(`(?<!\\b(?:my|your|our|the|a|his|her|their|no|any|new|top)\\s)\\b${escapeRe(m.displayName)}(?:'s)?\\b`, 'i').test(text));
  }

  function fromConstraints(msg: InboundMessage, ctx: TripConversationContext, text: string, items: Extracted[], extra: TripAction[] = []): ParseResult {
    const commands: TripCommand[] = [];
    const asks: string[] = [];
    let private_ = false;
    let hedgedBudget: number | undefined;
    const acks: string[] = [];

    for (const item of items) {
      const v = item.value;
      if (v.field === 'budget' && GROUP_BUDGET.test(text)) {
        asks.push('I keep each person\'s max separate, so I can\'t take one number for the whole group. Tell me yours with "my max is $X" and ask the others to do the same.');
        private_ = true;
        continue;
      }
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
          const heard = v.field === 'availability' ? v.value.filter((w): w is { start: string; end: string } => 'start' in w).map(formatWindow).join(' or ') : '';
          asks.push(`I want to get the dates right. ${heard ? `Can you actually do ${heard}? Say "free ${heard}" and I'll lock it in, or tell me which dates you can do.` : 'Which ones can you actually do? Something like "free Oct 17-19" works.'}`);
        }
        continue;
      }
      // Money and dates commit people, so a hedge there stays tentative. "Probably leaving from Durham" about the basics is fine as said.
      const firm = item.hedged && (v.field === 'budget' || v.field === 'availability' || v.field === 'preferences' || v.field === 'must_dos');
      commands.push(updateCommand(msg, ctx, v, firm));
      acks.push(ackPart(v, firm));
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
    if (!match && kind === 'select' && pool.length === 0 && ctx.status === 'awaiting_acceptance') return alreadyPicked(msg, ctx);
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
      if (yes && ctx.approval?.youIn) return reply(msg, ctx.approval.waitingNames.length ? `You're already in on ${ctx.approval.title}. Still waiting on ${ctx.approval.waitingNames.join(" and ")}.` : `You're in, and so is everyone else. ${ctx.approval.title} is approved.`, 'already-in', true);
      if (ctx.status === 'approved') return reply(msg, yes ? 'Sounds good! The trip is all set. Ask me anything about it, or tell me if a detail changes.' : 'No worries. The trip is locked in. Tell me if a detail changes and I will look again.', yes ? 'approved-ok' : 'approved-no', true);
      return yes
        ? reply(msg, `Great! Anything else to add? When you're ready, say "show us some options".`, 'thanks')
        : reply(msg, `No worries! If anything's off, just tell me the right detail, like "my max is $300" or "free Nov 21-23". Otherwise say "show us some options" when you're ready.`, 'neutral-no');
    }
    if (!yes) {
      return reply(msg, "No worries, I haven't recorded an acceptance. What would you want to change: the dates, the budget, or the activities?", 'no');
    }
    if (list.length > 1) {
      const lines = list.map((a, i) => `${i + 1}. ${a.description}`);
      const allPicks = list.every((a) => a.kind === 'select');
      return reply(msg, allPicks
        ? `I've got more than one plan waiting on you:\n${lines.join('\n')}\nWhich one do you mean? Say ${list.map((_, i) => `"option ${i + 1}"`).join(' or ')}.`
        : `I've got more than one thing waiting on you:\n${lines.join('\n')}\nWhich one do you mean? Tell me the number and whether you're picking it or saying you're in.`, 'which');
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
    // "What did Mason say?": the bot is the go-between, so it repeats what is fine to repeat (never a budget).
    const about = ABOUT_SOMEONE.exec(plain);
    const aboutName = about ? (about[1] ?? about[2] ?? about[3] ?? about[4] ?? about[5] ?? about[6])?.toLowerCase() : undefined;
    // While a plan waits on people to say "I'm in", "is Mason in?" or "has he finished?" is about that, and is answered below.
    const aboutApproval = Boolean(ctx.approval) && (about?.[5] !== undefined || about?.[6] !== undefined);
    const person = aboutName && !aboutApproval ? ctx.others?.find((o) => o.name.toLowerCase() === aboutName || o.name.toLowerCase().startsWith(`${aboutName} `)) : undefined;
    if (person) {
      const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]!;
      if (about?.[5] !== undefined || about?.[6] !== undefined) {
        // "Is Mason planning?": a plain yes or no first, then what they have given and what is still open.
        const done = person.missing.length === 0;
        const said = person.shared.length > 0 ? ` ${person.name} ${person.shared.join(' and ')}.` : '';
        const open = done ? ` I have ${person.name}'s budget too, but I keep that one private.` : ` ${person.shared.length > 0 ? 'However, I' : 'I'}'m still waiting on ${person.name}'s ${list(person.missing)}.`;
        // The yes or no has to answer the question that was asked: "is Mason still planning?" is yes while they are, "did Mason finish?" is yes once they have.
        const asksStillPlanning = /^(?:is|has|did)\s+\w+\s+(?:still\s+)?planning\b/i.test(plain);
        const asksHowItsGoing = about?.[5] !== undefined;
        const working = person.shared.length > 0 ? `${person.name} is still planning.` : `${person.name} hasn't told me anything.`;
        const nothing = person.shared.length === 0 && !done;
        const lead = nothing ? (asksHowItsGoing ? working : `Not yet, ${working}`) : asksHowItsGoing ? (done ? `${person.name} has finished.` : working)
          : asksStillPlanning ? (done ? `No, ${person.name} is done planning.` : `Yes, ${working}`)
          : done ? `Yes, ${person.name} has finished.` : `Not yet, ${working}`;
        return reply(msg, `${lead}${said}${open}`, 'about-someone', true);
      }
      const said = person.shared.length > 0 ? `${person.name} ${person.shared.join(' and ')}.` : `${person.name} hasn't told me anything yet.`;
      const left = person.missing.length > 0 ? ` Still waiting on ${person.name}'s ${list(person.missing)}. Say "show us options" and I'll nudge for it.` : ' I have everything I need from them.';
      return reply(msg, `${said}${left}`, 'about-someone', true);
    }
    if (/^(?:cancel|never ?mind|nvm|forget it|ignore that|scratch that|stop)$/i.test(plain)) {
      return reply(msg, 'No worries! Tell me whenever you want to pick it back up, or anything you want to change.', 'never-mind', true);
    }
    // "start over": nothing can be wiped yet, so say so and point at what can be changed.
    if (/^(?:please\s+)?(?:start over|restart|reset|begin again|start again|from scratch)(?:\s+please)?$/i.test(plain)) {
      return reply(msg, 'I can\'t clear a trip yet, but you can change anything by telling me, like "leaving from Raleigh", "3 nights" or "my max is $300".', 'start-over', true);
    }
    const talkative = msg.visibility === 'private' || trip.mode === 'direct';
    // "actually pick the other one": the option that is not already the pick; with nothing picked yet, ask which.
    if (/^(?:actually\s+|no\s+|wait\s+)?(?:pick|choose|select|go\s+with|switch\s+to|take|change\s+(?:it\s+|my\s+pick\s+)?to)\s+(?:the\s+)?(?:other|another|different)(?:\s+(?:one|option|plan))?$/i.test(plain) && (msg.visibility === 'private' || trip.mode === 'direct')) {
      const choices = ctx.actionable.filter((a) => a.kind === 'select');
      // A pick is already made and waiting on everyone: the plan can't be swapped for the other option mid-way, but a changed detail brings fresh options.
      if (ctx.approval && choices.length === 0) return reply(msg, `${ctx.approval.title} is already picked and waiting on everyone's OK. If you want to go a different way, change a detail like your dates, the nights or your max, and I'll bring fresh options.`, 'pick-locked', true);
      if (choices.length === 1) return one(msg, ctx, { kind: 'select_candidate', candidateId: choices[0]!.candidateId, revision: choices[0]!.revision });
      if (choices.length > 1) return reply(msg, `Which one do you mean? ${choices.map((c, i) => `option ${i + 1}`).join(' or ')}?`, 'pick-which', true);
    }
    // What this person has told the bot about themselves: their own budget, dates and likes are theirs to hear back.
    if (ctx.own !== undefined || /^(?:what|whats)/i.test(plain)) {
      const own = ctx.own ?? {};
      const mine = /^(?:what(?:'s|s| is| was| are| were)|what\s+did\s+i\s+(?:say|tell\s+you|give\s+you)|remind\s+me|show\s+me|tell\s+me)\s+(?:about\s+)?(?:my|the)\s+(max(?:imum)?|budget|limit|cap|dates?|availability|preferences?|likes?|interests?)\b/i.exec(plain)
        ?? /^how\s+much\s+(?:is|was)\s+my\s+(budget|max)/i.exec(plain);
      const askDates = /^what\s+(?:dates|days)\s+(?:did\s+i|have\s+i|do\s+you\s+have\s+for\s+me)\b|^when\s+(?:am\s+i|did\s+i\s+say\s+i\s+was)\s+free/i.test(plain);
      const askLikes = /^what\s+(?:do\s+i|did\s+i\s+say\s+i|am\s+i|are\s+my)\s+(?:like|into|want|prefer\w*|interests?)\b/i.test(plain) || /^what\s+(?:do\s+i\s+want\s+to\s+do|are\s+my\s+(?:preferences|likes|interests))\b/i.test(plain);
      const askAll = /^what\s+(?:do\s+you\s+(?:have|know)\s+(?:for|about)\s+me|did\s+i\s+tell\s+you|have\s+i\s+(?:told|given)\s+you)\b|^(?:recap|summari[sz]e)\s+(?:my|what\s+i)/i.test(plain);
      const topic = mine ? (/budget|max|limit|cap/i.test(mine[1]!) ? 'budget' : /date|avail/i.test(mine[1]!) ? 'dates' : 'likes') : askDates ? 'dates' : askLikes ? 'likes' : askAll ? 'all' : undefined;
      if (topic && talkative) {
        const lines: string[] = [];
        if ((topic === 'budget' || topic === 'all') && own.budgetDollars !== undefined) lines.push(`your max is $${own.budgetDollars.toLocaleString('en-US')} (just between us)`);
        if ((topic === 'dates' || topic === 'all') && own.dates) lines.push(`you're free ${own.dates}`);
        if ((topic === 'likes' || topic === 'all') && own.likes?.length) lines.push(`you're into ${list(own.likes)}`);
        if (lines.length > 0) return reply(msg, `${topic === 'all' ? 'So far I have that ' : 'I have that '}${list(lines)}.`, 'own-info', true);
        const missing = topic === 'budget' ? "You haven't given me a max yet. What's the most you'd want to spend on the trip, including food and travel?" : topic === 'dates' ? "You haven't told me your free dates yet. Which dates could you do?" : topic === 'likes' ? "You haven't told me what you like yet. What would you like out of this trip?" : "You haven't told me anything yet. Where are you leaving from?";
        return reply(msg, missing, 'own-info', true);
      }
    }
    // Changing their mind is fine: say what can be changed, based on where things are.
    if (/^(?:i\s+)?(?:changed|change)\s+(?:my|our)\s+mind\b/i.test(plain) && talkative) {
      if (ctx.approval) return reply(msg, `No problem! ${ctx.approval.title} is picked and waiting on everyone's OK. To go a different way, change a detail like your dates, the number of nights, or your max, and I'll bring fresh options. What would you like to change?`, 'changed-mind', true);
      const choose = ctx.actionable.some((a) => a.kind === 'select') ? ' You can pick a different option (say "option 1" or "option 2").' : '';
      return reply(msg, `No problem!${choose} You can also change a detail like your dates, the number of nights, or your max, and I'll update the plan. What would you like to change?`, 'changed-mind', true);
    }
    // Leading filler ("yes ask if...", "ok and tell him...") does not change what is being asked.
    const lean = plain.replace(/^(?:(?:yes|yeah|yep|yup|ok(?:ay)?|sure|please|pls|also|and|so|then|now|well|hey|actually)[,.!]?\s+)+/i, '');
    const talkativeChat = msg.visibility === 'private' || trip.mode === 'direct';
    const everyoneElse = ctx.others ?? [];
    const personFor = (word: string) => {
      const w = word.toLowerCase();
      return everyoneElse.find((o) => o.name.toLowerCase() === w) ?? (/^(?:he|she|they|him|her|them)$/.test(w) && everyoneElse.length === 1 ? everyoneElse[0] : undefined);
    };
    const joinNames = (names: string[]) => list(names);
    // Exact answers about who has said "I'm in" on the picked plan.
    // "did he answer?" after the bot asked someone something: that is about the question, not about "I'm in".
    if (talkativeChat && ctx.relays?.length) {
      const answered = /^(?:has|have|did|is|was)\s+(\w+)\s+(?:already\s+|yet\s+|also\s+)?(?:answer(?:ed)?|respond(?:ed)?|repl(?:y|ied)(?:\s+back)?|(?:get|got)\s+back(?:\s+to\s+(?:us|me))?|say\s+anything|said\s+anything)$/i.exec(lean);
      const who = answered ? personFor(answered[1]!) : undefined;
      const asks = who ? ctx.relays.filter((r) => r.withName === who.name && r.byMe && r.kind === 'ask') : [];
      if (who && asks.length > 0) {
        const lastAskAt = ctx.relays.lastIndexOf(asks[asks.length - 1]!);
        const back = ctx.relays.slice(lastAskAt + 1).filter((r) => r.withName === who.name && !r.byMe);
        if (back.length > 0) return reply(msg, `Yes, ${who.name} said: "${back[back.length - 1]!.text}"`, 'relay-answer', true);
        return reply(msg, `Not yet. I asked ${who.name}, and I'll tell you as soon as they answer.`, 'relay-answer', true);
      }
    }
    if (ctx.approval && talkativeChat) {
      const ap = ctx.approval;
      const V = String.raw`(?:say|said|confirm(?:ed)?|approve(?:d)?|accept(?:ed)?|agree(?:d)?|lock(?:ed)?(?:\s+it)?(?:\s+in)?|done(?:\s+it)?|finish(?:ed)?|ok(?:ay)?|okayed|gone\s+for\s+it|go\s+for\s+it|answer(?:ed)?|respond(?:ed)?|repl(?:y|ied)|decid(?:e|ed)|signed\s+off|do(?:ne)?\s+it)`;
      const gap = String.raw`(?:already\s+|yet\s+|also\s+|actually\s+|really\s+)?`;
      const otherQ = new RegExp(String.raw`^(?:has|have|did|is|was)\s+(\w+)\s+${gap}(?:(?:been|got)\s+)?${V}\b`, 'i').exec(lean)
        ?? new RegExp(String.raw`^(?:(?:can|could|would)\s+you\s+)?(?:ask|check|see|find\s+out|tell\s+me|let\s+me\s+know)\s+(?:if|whether)\s+(\w+)(?:'s|\s+(?:has|have|had|is|was|did))\s+${gap}(?:(?:has|have|had|is|was|did|been)\s+)?${V}\b`, 'i').exec(lean)
        ?? /^(?:is|are)\s+(\w+)\s+(?:in|done|ready|locked\s+in|on\s+board)\b/i.exec(lean);
      const who = otherQ ? personFor(otherQ[1]!) : undefined;
      if (otherQ && who) {
        if (ap.waitingNames.includes(who.name)) return reply(msg, `Not yet, ${who.name} hasn't said "I'm in" on ${ap.title}. Want me to remind them? Just say "remind ${who.name}".`, 'approval-other', true);
        const left = [...ap.waitingNames.filter((n) => n !== who.name), ...(ap.youIn ? [] : ['you'])];
        return reply(msg, left.length === 0 ? `Yes, ${who.name} is in, and so is everyone else. ${ap.title} is approved.` : `Yes, ${who.name} is in. Still waiting on ${joinNames(left)}.`, 'approval-other', true);
      }
      if (new RegExp(String.raw`^(?:did|have)\s+i\s+${gap}${V}\b`, 'i').test(lean) || /^am\s+i\s+(?:in|locked\s+in|done|confirmed|good)\b/i.test(lean)) {
        return reply(msg, ap.youIn
          ? (ap.waitingNames.length ? `Yes, you're in on ${ap.title}. Still waiting on ${joinNames(ap.waitingNames)}.` : `Yes, you're in, and so is everyone else. ${ap.title} is approved.`)
          : `Not yet. Say "I'm in" to lock in ${ap.title}.`, 'approval-me', true);
      }
      if (/^(?:who(?:'s|\s+is)?\s+(?:still\s+)?(?:left|waiting|missing|needs?\s+to\s+(?:confirm|say\s+ok|approve|accept))|are\s+we\s+(?:done|locked\s+in|all\s+in|good|set|approved)|is\s+(?:it|the\s+(?:trip|plan))\s+(?:approved|confirmed|locked\s+in|done|set))\b/i.test(lean)) {
        const waitingAll = [...(ap.youIn ? [] : ['you']), ...ap.waitingNames];
        return reply(msg, waitingAll.length === 0 ? `Yes, everyone is in, so ${ap.title} is approved.` : `Not yet. ${ap.title} is picked, and I'm still waiting on ${joinNames(waitingAll)}.`, 'approval-all', true);
      }
      // "remind Mason": the plan is waiting on them, so ask for the "I'm in".
      const nudgeOnly = /^(?:please\s+)?(?:remind|nudge|ping)\s+(\w+)$/i.exec(lean);
      const nudged = nudgeOnly ? personFor(nudgeOnly[1]!) : undefined;
      if (nudged && ap.waitingNames.includes(nudged.name)) return one(msg, ctx, { kind: 'relay', to: nudged.name, mode: 'request', text: "lock it in" });
    }
    // What the bot has already passed on: "did you tell Mason that I have a car?", "what did you tell Mason?", "did Mason get my message?".
    if (talkativeChat && (ctx.relays?.length || everyoneElse.length)) {
      const sent = (ctx.relays ?? []).filter((r) => r.byMe);
      const sayIt = (r: { withName: string; kind: string; text: string }) => r.kind === 'tell' ? `told ${r.withName}: "${r.text}"` : r.kind === 'ask' ? `asked ${r.withName}: "${r.text}"` : r.kind === 'request' ? `asked ${r.withName} to ${r.text}` : `messaged ${r.withName} to get them started`;
      const didYou = /^(?:did|have)\s+you\s+(?:already\s+|actually\s+|really\s+|even\s+|just\s+)?(?:tell|told|ask|asked|message|messaged|text|texted|dm|let|send|sent|pass|passed|remind|reminded|invite|invited|notify|notified|contact|contacted|reach|reached)\b(?:\s+out)?(?:\s+to)?\s*(\w+)?(?:\s+(.*))?$/i.exec(lean);
      const whatDid = /^what\s+(?:did|have)\s+you\s+(?:tell|told|ask|asked|say|said\s+to|send|sent(?:\s+to)?|message|messaged|text|texted)\s+(\w+)$/i.exec(lean);
      const gotIt = /^(?:did|has)\s+(\w+)\s+(?:get|got|receive|received|see|seen|read)\s+(?:my|the|that|our)\s+(?:message|text|note|msg)$/i.exec(lean);
      const about = (didYou ?? whatDid ?? gotIt)?.[1];
      const target = about ? personFor(about) ?? (everyoneElse.length === 1 && /^(?:if|whether|about|that|him|her|them)$/i.test(about) ? everyoneElse[0] : undefined) : (everyoneElse.length === 1 ? everyoneElse[0] : undefined);
      if (target && (didYou || whatDid || gotIt)) {
        const mine = sent.filter((r) => r.withName === target.name);
        if (whatDid || (gotIt && !didYou)) {
          return reply(msg, mine.length === 0 ? `I haven't sent ${target.name} anything yet.` : `So far I ${mine.slice(-3).map(sayIt).join('; and ')}.${gotIt ? " I can't see whether they've read it, but I'll tell you when they answer." : ''}`, 'relay-history', true);
        }
        const claim = (didYou![2] ?? '').toLowerCase().replace(/^(?:that|about|if|whether)\s+/, '');
        const words = claim.match(/[a-z']{3,}/g)?.filter((w) => !['that', 'have', 'has', 'about', 'the', 'with', 'and', 'for', 'you', 'him', 'her', 'them', 'was', 'were', 'his', 'she', 'they', 'anything', 'something', 'everything', 'any', 'yet', 'already', 'ever', target.name.toLowerCase()].includes(w)) ?? [];
        const hit = mine.filter((r) => words.length === 0 || words.some((w) => r.text.toLowerCase().includes(w)));
        return reply(msg, hit.length > 0
          ? `Yes, I ${sayIt(hit[hit.length - 1]!)}.`
          : `No, I haven't sent ${target.name} anything${words.length ? ' about that' : ''} yet. Say "tell ${target.name} ..." with what you want them to know and I'll send it.`, 'relay-history', true);
      }
      // "pass it to Mason and ask": the rest of the message never came.
      const passTo = /^(?:pass|send|forward|relay)\s+(?:this\s+|that\s+|it\s+|the\s+message\s+)?(?:on\s+)?to\s+(\w+)(?:\s+and\s+(ask|tell|say))?$/i.exec(lean);
      const passPerson = passTo ? personFor(passTo[1]!) : undefined;
      if (passTo && passPerson) return reply(msg, `What would you like me to ${(passTo[2] ?? 'tell').toLowerCase() === 'ask' ? 'ask' : 'tell'} ${passPerson.name}?`, 'relay-what', true);
    }
    // The bot speaks for everyone: "ask Mason if he has a car", "tell Mason I have a car", "message Mason to start planning it",
    // "text Mason that we leave at 8", "have Mason join", "invite Mason", "send Mason a message saying hi".
    const relayRaw = /^(?:(?:please|can you|could you|would you|pls)\s+)*(ask|tell|let|message|text|dm|notify|remind|have|get|invite|bring|add|send)\s+(\w+)(?:\s*[:,]\s*|\s+)?(.*)$/i.exec(lean);
    // "ask if he's done it" has no name: with one other person it can only mean them, and "ask if Mason has..." names them later on.
    const STOP = /^(?:if|whether|about|what|when|where|how|why|who|which|to|for|that|him|her|them|he|she|they)$/i;
    const relay = relayRaw && STOP.test(relayRaw[2]!) && talkativeChat
      ? (() => {
          const pronoun = /^(?:him|her|them)$/i.test(relayRaw[2]!);
          const text = pronoun ? (relayRaw[3] ?? '').trim() : `${relayRaw[2]} ${relayRaw[3] ?? ''}`.trim();
          const named = everyoneElse.find((o) => new RegExp(`\\b${o.name}\\b`, 'i').test(text)) ?? (everyoneElse.length === 1 ? everyoneElse[0] : undefined);
          return named ? ([relayRaw[0], relayRaw[1], named.name, text] as unknown as RegExpExecArray) : relayRaw;
        })()
      : relayRaw;
    const relayTo = relay ? ctx.others?.find((o) => o.name.toLowerCase() === relay[2]!.toLowerCase()) : undefined;
    if (relay && !relayTo && talkativeChat && ctx.others?.length && /^(?:ask|tell|message|text|dm|notify|invite)$/i.test(relay[1]!) && !/^(?:me|us|everyone|everybody|them|him|her|the|a|an|my|our|you|it|this|that|all)$/i.test(relay[2]!)) {
      return reply(msg, `I'm not sure who ${relay[2]} is. I can pass things to ${list(ctx.others.map((o) => o.name))}.`, 'relay-unknown', true);
    }
    if (relay && relayTo && talkativeChat) {
      let verb = relay[1]!.toLowerCase();
      let rest = (relay[3] ?? '').trim().replace(/[.!\s]+$/, '');
      const invite = { kind: 'relay' as const, to: relayTo.name, mode: 'invite' as const, text: 'join the planning' };
      const inviteWords = /\b(?:start|begin|join|get started|jump in|come on board|help)\b|\bplan(?:ning)?\b/i;
      // Asking someone to hurry or reply is a nudge, not a message to pass on.
      if (/^(?:to\s+)?(?:hurry|reply|respond|answer|check|get back|text me|message me|finish|speed)\b|\bhurry up\b/i.test(rest)) {
        // Once a plan is picked, a nudge asks for the "I'm in". It must never start a new search and throw the pick away.
        if (ctx.approval) {
          return ctx.approval.waitingNames.includes(relayTo.name)
            ? one(msg, ctx, { kind: 'relay', to: relayTo.name, mode: 'request', text: 'lock it in' })
            : reply(msg, `${relayTo.name} is already in on ${ctx.approval.title}.`, 'approval-other', true);
        }
        return one(msg, ctx, { kind: 'request_plans' });
      }
      if (/^(?:invite|bring|add)$/.test(verb)) {
        if (rest === '' || /^(?:in|to (?:the )?(?:trip|planning|plan|chat|group)|along|on board)$/i.test(rest)) return one(msg, ctx, invite);
      } else if (verb === 'send') {
        const sent = /^an?\s+(?:message|text|note|dm)\s*(?:saying|that|to say|:)?\s*(.*)$/i.exec(rest);
        if (sent) { verb = 'tell'; rest = (sent[1] ?? '').trim(); } else verb = '';
      } else if (/^(?:have|get|remind)$/.test(verb)) {
        if (verb !== 'remind' && inviteWords.test(rest) && !/^to\s+\S/i.test(rest)) return one(msg, ctx, invite);   // "have Mason start planning"
        if (!/^to\s+\S/i.test(rest)) verb = '';
      }
      if (verb === 'let') { if (!/^know\b/i.test(rest)) return reply(msg, `I can pass things to ${relayTo.name}. Try "tell ${relayTo.name} I have a car" or "ask ${relayTo.name} if they have a car".`, 'relay-help', true); rest = rest.replace(/^know\s+/i, ''); }
      if (verb) {
        // "message Mason and ask if he has a car" is a question.
        const andAsk = /^and\s+ask\s+(?:him|her|them)?\s*(.*)$/i.exec(rest);
        if (andAsk) { verb = 'ask'; rest = andAsk[1]!.trim(); }
        // "message Mason and tell him to start planning" / "text Mason and let him know I have a car"
        const andTell = /^and\s+(?:tell|let|say to)\s+(?:him|her|them)\s*(?:know\s+)?(.*)$/i.exec(rest);
        if (andTell) { verb = 'tell'; rest = andTell[1]!.trim(); }
        rest = rest.replace(/^(?:and\s+)?(?:say(?:ing)?|that|:)\s*/i, '').replace(/^that\s+/i, '');
        // "message Mason to start planning it": a request to them, or an invitation to join in.
        const requested = /^to\s+(\S.*)$/i.exec(rest);
        if (requested && verb !== 'ask' && verb !== 'tell') {
          const action = requested[1]!.trim();
          if (inviteWords.test(action)) return one(msg, ctx, invite);
          rest = action; verb = 'request';
        } else if (requested && (verb === 'ask' || verb === 'tell') && inviteWords.test(requested[1]!)) {
          return one(msg, ctx, invite);
        } else if (requested && verb === 'tell') { rest = requested[1]!.trim(); verb = 'request'; }
        else if (/^(?:message|text|dm|notify)$/.test(verb)) verb = rest ? 'tell' : '';
      }
      // Budgets stay between each person and the bot, so they are never asked for or passed along.
      if (verb && /\$\s*\d|\bbudgets?\b|\bmax(?:imum)?\b|\bafford|\bspend(?:ing)?\b|\bdollars?\b|\bbucks\b/i.test(rest)) return reply(msg, 'Budgets stay private between each person and me, so I can\'t ask for or pass one along.', 'relay-money', true);
      if (verb && rest.length >= 2) {
        const mode: 'ask' | 'tell' | 'request' = verb === 'ask' ? 'ask' : verb === 'request' ? 'request' : 'tell';
        const fieldOf = (text: string): string | undefined =>
          /\b(?:car|vehicle|ride|truck|drive)\b/i.test(text) || (/\b(?:has|have|got)\s+(?:one|it)\b/i.test(text) && (ctx.pendingQuestion?.field === 'transport' || ctx.openFields?.includes('transport'))) ? 'transport'
          : /\b(?:dates?|free|available|availability|when)\b/i.test(text) ? 'availability'
          : /\b(?:likes?|prefer\w*|into|wants? to do|interests?)\b/i.test(text) ? 'preferences'
          : /\b(?:nights?|how long|how many days)\b/i.test(text) ? 'duration'
          : /\b(?:leav\w*|start\w* from|depart\w*)\b/i.test(text) ? 'origin'
          : /\b(?:where|destination|place|go to)\b/i.test(text) ? 'region'
          : undefined;
        const field = mode === 'ask' ? fieldOf(rest) : undefined;
        const action = { kind: 'relay' as const, to: relayTo.name, mode, text: rest, ...(field ? { field } : {}) };
        // What the sender says about themselves while telling ("I have a car") also counts for them.
        const own = mode === 'tell' ? extractWithCoverage(rest, localReference(msg.occurredAt, trip.timezone)).items : [];
        return own.length ? fromConstraints(msg, ctx, rest, own, [action]) : one(msg, ctx, action);
      }
      if (/^(?:ask|tell|message|text|dm|notify)$/.test(relay[1]!.toLowerCase()) && rest === '') return reply(msg, `What would you like me to ${/^ask$/i.test(relay[1]!) ? 'ask' : 'tell'} ${relayTo.name}?`, 'relay-what', true);
    }
    // "nudge Mason", "ping Mason": the same as asking for options, which nudges whoever is still missing and tells the asker.
    const nudge = /^(?:(?:please|can you|could you|pls)\s+)*(?:nudge|ping|poke|text|message)\s+(\w+)\b/i.exec(plain);
    if (nudge && ctx.others?.some((o) => o.name.toLowerCase() === nudge[1]!.toLowerCase())) {
      if (ctx.approval) return ctx.approval.waitingNames.includes(nudge[1]!) || ctx.approval.waitingNames.some((n) => n.toLowerCase() === nudge[1]!.toLowerCase()) ? one(msg, ctx, { kind: 'relay', to: ctx.others!.find((o) => o.name.toLowerCase() === nudge[1]!.toLowerCase())!.name, mode: 'request', text: 'lock it in' }) : reply(msg, `${nudge[1]} is already in on ${ctx.approval.title}.`, 'approval-other', true);
      return one(msg, ctx, { kind: 'request_plans' });
    }
    // Spending from the simulated fund: "I spent $60 on gas", "we paid 300 for the hotel", "bought food for $40", "log $20 for parking". The app asks for a yes first.
    const spendCategory = (thing: string): string | undefined => {
      const w = thing.toLowerCase();
      if (/\b(?:hotel|motel|lodging|cabin|airbnb|room|rental|stay|accommodation|inn|lodge|campsite|camping)\b/.test(w)) return 'accommodation';
      if (/\b(?:gas|gasoline|fuel|parking|toll|tolls|charging|uber|lyft|taxi)\b/.test(w)) return 'fuel_parking_tolls';
      if (/\b(?:food|dinner|lunch|breakfast|brunch|groceries|grocery|restaurant|meal|meals|snacks?|coffee|drinks?|pizza|burgers?|eats|bbq|takeout)\b/.test(w)) return 'food';
      if (/\b(?:tickets?|admission|entry|activities|activity|museum|tour|tours|park|hike|hiking|rental|zoo|show|concert|passes?)\b/.test(w)) return 'activities';
      if (/\b(?:fees?|taxes|tax|tips?|resort fee)\b/.test(w)) return 'taxes_fees';
      return undefined;
    };
    const amountOf = (text: string) => { const m = /\$\s*([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b|\b(\d{1,6})\b/i.exec(text); const raw = m?.[1] ?? m?.[2] ?? m?.[3]; return raw ? Math.ceil(Number(raw.replace(/,/g, ''))) : undefined; };
    const spendFormA = /^(?:(?:please|pls|ok(?:ay)?)\s+)*(?:i|we|jeffrey|mason|\w+)?\s*(?:'ve|have|just|already|had to)?\s*(?:spent|paid|put|used|dropped|blew)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks|usd))?\s+(?:on|for|at|towards?)\s+(?:the\s+|a\s+|an\s+|our\s+|some\s+)?(.+)$/i.exec(lean)
      ?? /^(?:(?:please|pls|ok(?:ay)?)\s+)*(?:log|record|add|enter|put\s+down|note|track)\s+(?:a\s+|an\s+|the\s+)?(?:purchase|expense|spend(?:ing)?|cost|charge)?\s*(?:of\s+)?\$?\s*([\d,]+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks|usd))?\s+(?:on|for|at)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i.exec(lean);
    // The "thing first" forms are only an expense when the thing is one: "my max is $450" must stay a budget.
    const spendFormB = /^(?:(?:please|pls|ok(?:ay)?)\s+)*(?:i|we)?\s*(?:bought|got|grabbed|booked|paid\s+for)\s+(?:the\s+|a\s+|an\s+|some\s+|our\s+)?(.+?)\s+(?:for|at|costing|which\s+cost(?:s)?)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks|usd))?$/i.exec(lean)
      ?? /^(?:the\s+|our\s+)?([a-z][a-z ]{2,30}?)\s+(?:cost|costs|was|came\s+to|ran(?:\s+us)?)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks|usd))?$/i.exec(lean);
    if (talkativeChat && ctx.status !== undefined && (spendFormA || (spendFormB && spendCategory(spendFormB[1]!)))) {
      const thing = spendFormA ? spendFormA[2]! : spendFormB![1]!;
      const amount = spendFormA ? spendFormA[1]! : spendFormB![2]!;
      const dollars = Math.ceil(Number(amount.replace(/,/g, '')));
      const category = spendCategory(thing);
      if (Number.isFinite(dollars) && dollars > 0 && category) return one(msg, ctx, { kind: 'fund_spend', dollars, category });
      if (Number.isFinite(dollars) && dollars > 0 && ctx.status === 'approved') return reply(msg, `What was the $${dollars} for? I can log it as lodging, gas, food, activities or fees. Try "I spent $${dollars} on food".`, 'spend-what', true);
    }
    // "I spent money", "log a purchase": there is no amount or purpose yet, so ask for both.
    if (talkativeChat && ctx.status === 'approved' && /^(?:(?:please|pls|ok(?:ay)?|so)\s+)*(?:(?:i|we)\s+)?(?:(?:'ve|have|just|also)\s+)*(?:spent|paid|bought|purchased)\s+(?:some\s+|a\s+bit\s+of\s+|more\s+)?(?:money|cash|something|stuff|things)(?:\s+(?:on\s+the\s+trip|today|too))?$|^(?:(?:please|pls)\s+)*(?:log|record|add|enter|track)\s+(?:a\s+|an\s+|some\s+)?(?:purchase|expense|spending|spend|cost)$|^(?:i|we)\s+made\s+(?:a\s+)?purchase$|^(?:i|we)\s+need\s+to\s+(?:log|record|add)\s+(?:a\s+|some\s+)?(?:purchase|expense|spending)$/i.test(lean)) {
      return reply(msg, 'How much was it, and what was it for? Try "I spent $60 on gas", "we paid $297 for the hotel" or "bought food for $40".', 'spend-what', true);
    }
    const spentBare = /^(?:i|we)?\s*(?:'ve|have|just)?\s*(?:spent|paid)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(?:\s*(?:dollars|bucks|usd))?$/i.exec(lean);
    if (spentBare && talkativeChat && ctx.status === 'approved') return reply(msg, `What was the $${amountOf(spentBare[1]!) ?? ''} for? I can log it as lodging, gas, food, activities or fees. Try "I spent $${amountOf(spentBare[1]!) ?? 50} on food".`, 'spend-what', true);
    // Paying into the simulated fund: "pay my share", "let me chip in $50", "cover Mason's share", "put in $60 for Jeffrey". The app asks for a yes before anything is added.
    const lead = "(?:(?:please|pls|ok(?:ay)?|so)\\s+)*(?:(?:can|could|may|should|shall|would)\\s+(?:i|we)\\s+|let\\s*me\\s+|lemme\\s+|time\\s+to\\s+|(?:i|we)(?:'ll|\\s+will|'d like to|\\s+would like to|\\s+want to|\\s+wanna|\\s+should|\\s+can|\\s+gotta|\\s+need to|\\s+have to)?\\s+)?";
    const tail = "(?:\\s+(?:now|please|pls|today|too|as well|also|real quick|right now))*[?!.]*$";
    const share = "(?:my\\s+(?:share|part|portion|half)|\\$?\\s*(\\d{1,9})(?:\\s*(?:dollars|bucks|usd))?)";
    const fundWord = "(?:\\s+(?:to|into|in)\\s+(?:the\\s+)?(?:fund|pot|trip(?:\\s+fund)?|kitty))?";
    const payOther = new RegExp(`^${lead}(?:pay|cover|chip\\s+in\\s+for|put\\s+in\\s+for|contribute\\s+for)\\s+(?:for\\s+)?(\\w+?)(?:'s|s)?(?:\\s+(?:share|part|portion|half))?${tail}`, 'i').exec(plain);
    const payOtherTo = payOther ? ctx.others?.find((o) => o.name.toLowerCase() === payOther[1]!.toLowerCase()) : undefined;
    if (payOther && payOtherTo) return one(msg, ctx, { kind: 'fund_pay', forName: payOtherTo.name });
    const payAmountFor = new RegExp(`^${lead}(?:pay|put\\s+in|chip\\s+in|send|add|cover|put)\\s+\\$?\\s*(\\d{1,9})(?:\\s*(?:dollars|bucks|usd))?\\s+(?:for|toward|towards)\\s+(\\w+?)(?:'s\\s+share)?${tail}`, 'i').exec(plain);
    const payAmountTo = payAmountFor ? ctx.others?.find((o) => o.name.toLowerCase() === payAmountFor[2]!.toLowerCase()) : undefined;
    if (payAmountFor && payAmountTo) return one(msg, ctx, { kind: 'fund_pay', dollars: Number(payAmountFor[1]), forName: payAmountTo.name });
    const payMine = new RegExp(`^${lead}(?:pay(?:\\s+up)?|chip\\s+in|contribute|put\\s+in|send|add|cover)\\s+${share}${fundWord}${tail}`, 'i').exec(plain);
    if (payMine) return one(msg, ctx, { kind: 'fund_pay', ...(payMine[1] ? { dollars: Number(payMine[1]) } : {}) });
    if (new RegExp(`^${lead}(?:pay(?:\\s+up)?|contribute|chip\\s+in)${tail}`, 'i').test(plain)) return one(msg, ctx, { kind: 'fund_pay' });
    if (/^how\s+(?:do|can|would|should)\s+(?:i|we)\s+(?:pay|chip in|contribute|put (?:money )?in|get my money in)\??$/i.test(plain)) return reply(msg, 'Just say "pay my share" and I\'ll add it to the simulated trip fund. You can also say "chip in $50" or "pay Mason\'s share".', 'how-to-pay', true);
    if (/^(?:i(?:'ve| have)?\s+)?(?:already\s+)?paid(?:\s+(?:my\s+)?(?:share|part|up|already|it))?$/i.test(plain)) return reply(msg, 'I can only count money that goes into the trip fund. Say "pay my share" and I\'ll add it (simulated).', 'paid-elsewhere', true);
    if (FUND_REMIND.test(plain)) return one(msg, ctx, { kind: 'request_funding', topic: 'remind' });
    if (FUND_WRAP.test(plain)) return one(msg, ctx, { kind: 'request_funding', topic: 'wrap_up' });
    if (FUND_STATUS.test(plain)) return one(msg, ctx, { kind: 'request_funding', topic: 'status' });
    if (STATUS.test(plain)) {
      // Where things stand: while still gathering the planner recaps what is missing; after that, say what is happening.
      if (ctx.status === 'researching') return reply(msg, "I'm still looking up options for everyone. Give me a minute and I'll send them over.", 'status-researching', true);
      if (ctx.status === 'proposed' || ctx.status === 'awaiting_acceptance') return reply(msg, ctx.actionable.length ? `The options are above. ${ctx.actionable.map((a, i) => `${i + 1}. ${a.description}`).join('; ')}. Reply "pick 1" or "pick 2" when you've decided.` : "The options are above. Take a look and tell me which one you like.", 'status-proposed', true);
      if (ctx.status === 'approved') return reply(msg, "The plan is approved, so you're all set!", 'status-approved', true);
      // Still gathering: say who is missing, privately. Asking where things stand must not message anyone else.
      const waiting = (ctx.others ?? []).filter((o) => o.missing.length > 0).map((o) => `${o.name}'s ${list(o.missing)}`);
      return reply(msg, waiting.length > 0
        ? `Still waiting on ${list(waiting)}. Say "show us some options" and I'll nudge them and check what else is open.`
        : `I have what I need from the others. Say "show us some options" when you're ready, and I'll check what's still open.`, 'status-gathering', true);
    }
    if (REQUEST_PLANS.test(plain)) return one(msg, ctx, { kind: 'request_plans' });
    if (REQUEST_FUNDING.test(plain)) return one(msg, ctx, { kind: 'request_funding' });
    if ((m = GUIDE.exec(text.trim()))) return one(msg, ctx, { kind: 'ask_guide', question: m[1]!.trim() });
    if ((m = ACCEPT.exec(plain))) return bindPlan(msg, ctx, 'accept', m[1]!, Number(m[2]));
    if ((m = SELECT.exec(plain)) && !(m[1]!.toLowerCase() in CHOICE_NUMBER)) return bindPlan(msg, ctx, 'select', m[1]!, m[2] ? Number(m[2]) : undefined);
    if (actionable(ctx, 'select').length === 0 && ctx.status === 'awaiting_acceptance' && PICK_WORDS.exec(plain) && !(BARE_CHOICE.test(plain) && (ctx.pendingQuestion || ctx.pendingConfirmation))) return alreadyPicked(msg, ctx);
    if (actionable(ctx, 'select').length > 0 && (m = PICK_WORDS.exec(plain))) {
      // A bare "2" while we are waiting on an answer ("how many nights?") is that answer, not a pick.
      if (BARE_CHOICE.test(plain) && (ctx.pendingQuestion || ctx.pendingConfirmation)) return null;
      const word = m[1]!.toLowerCase();
      return bindPlan(msg, ctx, 'select', String(CHOICE_NUMBER[word] ?? Number(word)), undefined);
    }
    return null;
  }

  /** A pick after a plan is already chosen: say which one it is and what is needed, instead of "nothing to pick yet". */
  function alreadyPicked(msg: InboundMessage, ctx: TripConversationContext): ParseResult {
    const mine = actionable(ctx, 'accept')[0];
    return reply(msg, mine
      ? `${mine.description} is already the pick. Say "I'm in" to lock it in.`
      : "A plan is already picked and you've said you're in. I'm waiting on the others.", 'already-picked', true);
  }

  /** Where a conversation stands, as the question to put back to someone who just said hi in the middle of it. */
  const REASK: Partial<Record<string, string>> = {
    origin: 'Where are you all leaving from?',
    region: 'Got a place in mind, or how far are you up for driving?',
    duration: 'How many nights are you thinking?',
    budget: "What's your maximum total for this trip, including food and travel?",
    availability: 'Which dates could you do for the trip?',
    preferences: 'What would you like out of this trip? "No preference" is a fine answer.',
  };

  /** Hellos, thanks and filler. Needs no model: warm in a one-on-one chat, silent in a group. Never a place, a date or a number. */
  function smallTalk(msg: InboundMessage, ctx: TripConversationContext, text: string, talkative: boolean): ParseResult {
    if (!talkative) return { kind: 'ignored', reason: 'small talk' };
    const done = ctx.status === 'approved';
    if (/^(?:thanks?|thank you|thx|ty|appreciate|you'?re (?:awesome|great|the best|amazing|so helpful|helpful|a lifesaver|funny)|great job|good job|nice work|love it|this is (?:great|awesome|amazing|fun|cool))/i.test(text)) return reply(msg, done ? 'Anytime! Have a great trip.' : 'Anytime! Tell me if you want to change anything, or say "show us some options" when you\'re ready.', 'welcome');
    if (/^(?:(?:ok(?:ay)?|cool|nice|great|awesome|sweet|alright|yay)[\s,!.]+)*(?:see (?:you|ya|u)\b|have fun|can'?t wait|so excited|excited)/i.test(text)) return reply(msg, done ? 'See you there! Tell me if a detail changes and I will look again.' : "Sounds fun! Tell me if you want to change anything, or say \"show us some options\" when you're ready.", 'see-you');
    if (/^good ?night\b|^(?:night|nite|gn|bye|goodbye|see ya|later|ttyl|talk later)\b/i.test(text)) return reply(msg, 'Night! I\'ll be here whenever you want to pick this back up.', 'goodnight');
    if (/^(?:(?:hi|hey|hello|yo|hiya|howdy|hola|sup|wassup|what'?s up|whats up|what up|gm)\b|good )/i.test(text)) {
      // Partway through a question: put it back instead of inviting them to start over.
      const open = ctx.pendingQuestion ? REASK[ctx.pendingQuestion.field] : undefined;
      if (open) return reply(msg, `Hey! ${open}`, 'greeting-open');
      // Someone has already started: don't tell this person to start another trip.
      const starters = (ctx.others ?? []).filter((o) => o.shared.length > 0).map((o) => o.name);
      if (starters.length > 0 || ctx.confirmBasics?.length) return reply(msg, `Hey! ${starters.length > 0 ? list(starters) : 'Someone'} already started planning a trip. Tell me your free dates and what you're into, or say "show us some options" when you're ready.`, 'greeting-joined');
      return reply(msg, 'Hey! Want to plan a trip? Say "let\'s plan a trip" to get started.', 'greeting');
    }
    return reply(msg, done ? "Sounds good. The trip is all set. I'm here if anything changes." : "Sounds good. I'm here whenever you want to add something or see options.", 'smalltalk');
  }

  /** "Hi Alex", "hello everyone": a greeting aimed at someone by name is still only a greeting. */
  const isNamedGreeting = (text: string): boolean => {
    const rest = text.replace(GREETING, '').replace(/[?!.\s]+$/, '');
    if (rest === text.replace(/[?!.\s]+$/, '') || rest === '') return false;
    return trip.members.some((m) => m.displayName.toLowerCase() === rest.toLowerCase());
  };

  async function parseText(msg: InboundMessage, override?: TripConversationContext): Promise<ParseResult> {
    // iMessage types curly apostrophes and quotes; our rules expect plain ones.
    const text = (msg.text ?? '').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
    if (!text) return { kind: 'ignored', reason: 'empty message' };
    const ctx = override ?? (await deps.getConversationContext(msg.senderId, msg.spaceId));

    // A tapback shown as text. It points at one of the messages we sent, so it only counts when that message is a plan
    // this person can act on; anything else about it is none of our business and never gets an "I didn't catch that".
    const tap = TEXT_TAPBACK.exec(text);
    if (tap) {
      if (tap[1] !== 'Liked' && tap[1] !== 'Loved') return { kind: 'ignored', reason: 'only positive reactions are recorded' };
      const quote = tap[2]!.toLowerCase();
      const picks = actionable(ctx, 'select');
      // The longest title wins, so "Asheville and Boone" is not mistaken for "Asheville".
      const byName = [...ctx.actionable].sort((a, b) => b.description.length - a.description.length).find((a) => a.description !== '' && quote.includes(a.description.toLowerCase()));
      const numbered = /^option\s+(\d{1,2})\s*:/i.exec(tap[2]!.trim());
      const numberedTarget = numbered ? picks[Number(numbered[1]) - 1] : undefined;
      // "Option 2: …" counts only when what follows is that option (or a cut-off start of it): a made-up title is not a reaction to our message.
      const rest = tap[2]!.trim().replace(/^option\s+\d{1,2}\s*:\s*/i, '').replace(/[….\s]+$/, '').toLowerCase();
      const numberedFits = numberedTarget !== undefined && (rest !== '' && numberedTarget.description.toLowerCase().startsWith(rest));
      const target = byName ?? (numberedFits ? numberedTarget : undefined);
      if (!target) return { kind: 'ignored', reason: 'reaction target is not a proposal' };
      return one(msg, ctx, target.kind === 'accept'
        ? { kind: 'accept_candidate', candidateId: target.candidateId, revision: target.revision }
        : { kind: 'select_candidate', candidateId: target.candidateId, revision: target.revision });
    }
    if (THUMBS.test(text)) {
      // A thumbs-up to "does that work for you?" is a yes to the plan so far, the same as typing "yes".
      if (ctx.confirmBasics?.length && ctx.actionable.length === 0 && !ctx.pendingConfirmation) return fromConstraints(msg, ctx, text, ctx.confirmBasics.map((value) => ({ value, hedged: false })));
      if (ctx.actionable.length === 0 && !ctx.pendingConfirmation) {
        // Nothing waiting for a yes. In a one-on-one chat staying silent looks broken, so answer; in a group it is just a reaction.
        return msg.visibility === 'private' || trip.mode === 'direct'
          ? reply(msg, 'Glad that works! Tell me anything else to add, or say "show us some options" when you\'re ready.', 'thumbs', true)
          : { kind: 'ignored', reason: 'nothing to approve' };
      }
      return resolveAnswer(msg, ctx, true);
    }

    const ex = explicit(msg, ctx, text);
    if (ex) return ex;
    const plain = text.replace(/[?!.\s]+$/, '');
    if (WRONG.test(plain)) {
      if (ctx.actionable.length || ctx.pendingConfirmation) return resolveAnswer(msg, ctx, false);
      return msg.visibility === 'private' || trip.mode === 'direct'
        ? reply(msg, `Sorry about that! What should I fix? Tell me the right detail, like "my max is $300", "free Nov 21-23" or "leaving from Raleigh".`, 'sorry')
        : { kind: 'ignored', reason: 'nothing to correct' };
    }
    // "Does the plan so far work for you?": yes adopts it as their own answer, no asks what they would change.
    if (ctx.confirmBasics?.length && ctx.actionable.length === 0 && !ctx.pendingConfirmation) {
      if (YES.test(text) || YES.test(plain) || BASICS_OK.test(plain)) return fromConstraints(msg, ctx, text, ctx.confirmBasics.map((value) => ({ value, hedged: false })));
      if (NO.test(text) || NO.test(plain)) return reply(msg, `No problem, what would you change? Something like "leaving from Raleigh", "3 nights" or "somewhere closer" works.`, 'basics-no', true);
    }
    // A bare yes/no to "does anyone have a car?" is the answer, not a confirmation of something else.
    const carYes = YES.test(text) || YES.test(plain), carNo = NO.test(text) || NO.test(plain);
    if (ctx.pendingQuestion?.field === 'transport' && !ctx.pendingConfirmation && ctx.actionable.length === 0 && (carYes || carNo)) {
      return fromConstraints(msg, ctx, text, [{ value: { field: 'transport', value: carYes ? 'own_vehicle' : 'no_vehicle', vehicleAvailable: carYes }, hedged: false }]);
    }
    if (carYes) return resolveAnswer(msg, ctx, true);
    if (carNo) return resolveAnswer(msg, ctx, false);

    // A hello, thanks or filler word is never an answer to "where are you leaving from?": it must not reach the place readers.
    if (TRIVIAL.test(text) || isNamedGreeting(text) || !/[\p{L}\p{N}]/u.test(text)) return smallTalk(msg, ctx, text, msg.visibility === 'private' || trip.mode === 'direct');

    // Rules first (fast, exact). Anything the rules did not recognize is handed to the language model automatically,
    // and its (validated) answer is merged with what the rules found.
    let { items: extracted, unmatched } = extractWithCoverage(text, localReference(msg.occurredAt, trip.timezone), ctx.pendingQuestion?.field);
    // Nothing fit the question that was asked? Maybe they answered another open one, or just volunteered something.
    if (!extracted.length) {
      for (const field of ctx.openFields ?? []) {
        if (field === ctx.pendingQuestion?.field) continue;
        const again = extractWithCoverage(text, localReference(msg.occurredAt, trip.timezone), field);
        if (again.items.length) { ({ items: extracted, unmatched } = again); break; }
      }
    }
    if (!extracted.length && (msg.visibility === 'private' || trip.mode === 'direct') && /^(?:where (?:i|we) (?:want|wanna|would like|'d like) to go|where (?:i|we)(?:'m| am|'re| are) (?:leaving|going)(?: from)?|the (?:destination|origin)|(?:to|from) (?:go|there)|going there|leaving from|that'?s (?:where|the place))[.!?]*$/i.test(text)) {
      return reply(msg, 'Which place do you mean? Say it with the city, like "going to Boone" or "leaving from Raleigh".', 'place-which-missing', true);
    }
    if (!extracted.length && (msg.visibility === 'private' || trip.mode === 'direct') && NOT_A_WORD_PLACE.test(text)) return reply(msg, HELP, 'help-word', true);
    if (!extracted.length && (msg.visibility === 'private' || trip.mode === 'direct') && BARE_PLACE.test(text) && !/\b(?:i|we|my|you|yes|no)\b/i.test(text)) {
      const place = text.replace(/[.!]+$/, '').trim();
      return reply(msg, `Is ${place} where you're leaving from, or where you want to go? You can say "leaving from ${place}" or "going to ${place}".`, 'place-which', true);
    }
    const talkative = msg.visibility === 'private' || trip.mode === 'direct';
    if (!extracted.length && TRIVIAL.test(text)) return smallTalk(msg, ctx, text, talkative);
    // A request tucked into a longer message ("..., can you show us some options?") is understood by rule, not sent away.
    const requested: TripAction[] = [];
    for (let i = unmatched.length - 1; i >= 0; i--) {
      const clause = unmatched[i]!.replace(GREETING, '').replace(/^(?:(?:and|also|so|then|ok|okay)\s+)+/i, '').replace(/[?!.\s]+$/, '');
      if (extracted.length && REQUEST_PLANS.test(clause)) { requested.push({ kind: 'request_plans' }); unmatched.splice(i, 1); }
    }
    if (extracted.length && unmatched.length === 0) return fromConstraints(msg, ctx, text, extracted, requested);
    const handoffText = extracted.length ? unmatched.join(' ') : text;

    const facts = chatFacts(ctx);
    const raw = await deps.intentModel.interpret({
      text: handoffText,
      occurredAt: msg.occurredAt,
      ...(extracted.length ? { alreadyKnown: extracted.map((e) => e.value.field) } : {}),
      visibility: msg.visibility,
      timezone: trip.timezone,
      memberNames: trip.members.map((m) => m.displayName),
      ...(ctx.pendingQuestion ? { pendingField: ctx.pendingQuestion.field } : {}),
      hasActionable: ctx.actionable.length > 0,
      facts,
      ...(ctx.recent?.length ? { history: ctx.recent.slice(-6) } : {}),
      ...(actionable(ctx, 'select').length > 0 ? { options: actionable(ctx, 'select').map((a) => a.description) } : {}),
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
        if (msg.visibility === 'private' || trip.mode === 'direct') noteMiss('help', msg, ctx);
        return msg.visibility === 'private' || trip.mode === 'direct'
          ? reply(msg, HELP, 'help')
          : { kind: 'ignored', reason: 'not addressed to the assistant' };
      case 'chat': {
        if (!(msg.visibility === 'private' || trip.mode === 'direct')) return { kind: 'ignored', reason: 'casual chat in a group' };
        const answer = safeChatAnswer(intent.answer, `${facts.join(' ')} ${handoffText}`);
        if (!answer) noteMiss('unclear', msg, ctx);
        return reply(msg, answer ?? HELP, answer ? 'chat' : 'help', true);
      }
      case 'unavailable':
        // Same rule as an unclear message: in a group, friends talking are none of our business even when the service is down.
        if (msg.visibility === 'private' || trip.mode === 'direct') noteMiss('unavailable', msg, ctx);
        return msg.visibility === 'private' || trip.mode === 'direct'
          ? reply(msg, UNAVAILABLE, 'unavailable')
          : { kind: 'ignored', reason: 'language service unavailable, group message' };
      case 'clarify':
        // In a group, an unclear message is usually just friends talking: stay quiet there.
        if (msg.visibility === 'private' || trip.mode === 'direct') noteMiss('help', msg, ctx);
        return msg.visibility === 'private' || trip.mode === 'direct'
          ? reply(msg, HELP, 'help')
          : { kind: 'ignored', reason: 'unclear group message' };
      case 'constraints':
        return fromConstraints(msg, ctx, text, intent.items.map((value) => ({ value, hedged })));
      case 'pick': {
        // The model only says which numbered option was meant; whether that is allowed is decided here.
        if (actionable(ctx, 'select').length === 0) {
          if (ctx.status === 'awaiting_acceptance') return alreadyPicked(msg, ctx);
          return msg.visibility === 'private' || trip.mode === 'direct'
            ? reply(msg, `There's nothing to pick yet. Say "show us some options" when you're ready.`, 'nothing-to-pick')
            : { kind: 'ignored', reason: 'nothing to pick' };
        }
        return bindPlan(msg, ctx, 'select', String(intent.choice), undefined);
      }
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
