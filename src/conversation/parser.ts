import type { Command, CommandPayload, InboundMessage, OutboundMessage, ParseResult } from '../contracts/index.js';
import { validateIntent, type ValidIntent } from './intent.js';
import { parseDueDate } from './dates.js';
import { formatCents, parseDollarsToCents } from './money.js';
import type { ConversationDependencies, ParserContext } from './types.js';

const APPROVE_REACTIONS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '❤️', '❤', '✅', '✔️', 'like', 'love', 'thumbsup', '+1']);
const DECLINE_REACTIONS = new Set(['👎', '👎🏻', '👎🏼', '👎🏽', '👎🏾', '👎🏿', '❌', 'dislike', 'thumbsdown', '-1']);
const YES = /^(yes|yep|yeah|yup|sure|ok|okay|approve|approved|i approve|sounds good|do it|confirm|confirmed)[.!]*$/i;
const NO = /^(no|nope|nah|decline|declined|i decline|don'?t|not now|no thanks)[.!]*$/i;
/** Tentative language never becomes approval, coverage or payment. */
const HEDGE = /\b(maybe|might|perhaps|possibly|probably|not sure|i guess|i think|could i|can i|should i|what if|if i|if we|would)\b|\?/i;
const MONEYISH = /\b(cover|covering|pay|paying|approve|share|owe|split|send)\b|\$/i;
const ID = '([A-Za-z0-9][A-Za-z0-9_:.\\-]*)';
const AMT = '\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)';

type Candidate =
  | { kind: 'proposal'; proposalId: string; proposalVersion: number; description: string }
  | { kind: 'private_request'; requestId: string };

export function createParser(deps: ConversationDependencies) {
  const { household } = deps;

  const commandId = (householdId: string, eventId: string, kind: string) => `${householdId}:${eventId}:${kind}`;

  function reply(msg: InboundMessage, householdId: string, text: string, tag: string): ParseResult {
    const message: OutboundMessage = {
      deliveryId: `reply:${msg.eventId}:${tag}`,
      householdId,
      audience: msg.visibility === 'private' ? { kind: 'private', userId: msg.senderId } : { kind: 'group', spaceId: household.groupSpaceId },
      text,
    };
    return { kind: 'reply', message };
  }

  function command(msg: InboundMessage, ctx: ParserContext, payload: CommandPayload): ParseResult {
    const c: Command = {
      commandId: commandId(ctx.householdId, msg.eventId, payload.kind),
      actorId: msg.senderId,
      householdId: ctx.householdId,
      sourceEventId: msg.eventId,
      payload,
    };
    return { kind: 'command', command: c };
  }

  function resolveRecipient(title: string): string | null {
    const t = title.trim().toLowerCase();
    if (!t) return null;
    const alias = deps.recipientAliases?.[t];
    if (alias && household.recipients.some((r) => r.recipientId === alias)) return alias;
    const hits = household.recipients.filter((r) => {
      const id = r.recipientId.toLowerCase();
      const name = r.displayName.toLowerCase();
      return id.includes(t) || name.includes(t) || t.includes(id);
    });
    return hits.length === 1 ? hits[0]!.recipientId : null;
  }

  function recipientHelp(title: string): string {
    const names = household.recipients.map((r) => r.displayName).join(', ');
    return `I don't have a payee set up for "${title}". I can only pay: ${names}. Which one is it?`;
  }

  function candidates(msg: InboundMessage, ctx: ParserContext): Candidate[] {
    const list: Candidate[] = ctx.actionableProposals.map((p) => ({ kind: 'proposal', ...p }));
    // A group message can never answer a private consent question.
    if (msg.visibility === 'private' && ctx.privateCoverageRequestId) {
      list.push({ kind: 'private_request', requestId: ctx.privateCoverageRequestId });
    }
    return list;
  }

  function resolveAnswer(msg: InboundMessage, ctx: ParserContext, yes: boolean): ParseResult {
    const list = candidates(msg, ctx);
    if (list.length === 0) return { kind: 'ignored', reason: 'nothing to answer' };
    if (list.length > 1) {
      const lines = list.map((c, i) =>
        c.kind === 'proposal' ? `${i + 1}. ${c.description} (${c.proposalId} v${c.proposalVersion})` : `${i + 1}. Your private coverage request`,
      );
      const verb = yes ? 'approve' : 'decline';
      return reply(msg, ctx.householdId, `I have more than one thing waiting on you:\n${lines.join('\n')}\nWhich one should I ${verb}? Reply "${verb} <id> v<version>".`, 'which');
    }
    const only = list[0]!;
    if (only.kind === 'private_request') {
      return command(msg, ctx, { kind: 'share_coverage_request', requestId: only.requestId, consent: yes });
    }
    return command(msg, ctx, yes
      ? { kind: 'approve', proposalId: only.proposalId, proposalVersion: only.proposalVersion }
      : { kind: 'decline', proposalId: only.proposalId, proposalVersion: only.proposalVersion });
  }

  function pickBill(msg: InboundMessage, ctx: ParserContext, text: string, verb: string): { billId: string } | ParseResult {
    if (ctx.openBills.length === 0) return reply(msg, ctx.householdId, `There's no open bill to ${verb} right now.`, 'nobill');
    const lower = text.toLowerCase();
    const named = ctx.openBills.filter((b) => lower.includes(b.title.toLowerCase()));
    const pool = named.length ? named : ctx.openBills;
    if (pool.length === 1) return { billId: pool[0]!.billId };
    return reply(msg, ctx.householdId, `Which bill? ${ctx.openBills.map((b) => b.title).join(', ')}.`, 'whichbill');
  }

  function handleOffer(msg: InboundMessage, ctx: ParserContext, requestId: string | undefined, amountCents: number | undefined): ParseResult {
    let id = requestId;
    let cents = amountCents;
    const open = ctx.openCoverageRequests ?? [];
    if (!id) {
      if (open.length === 1) id = open[0]!.requestId;
      else {
        return reply(msg, ctx.householdId, 'Which coverage request? Reply "cover <request-id> $<amount>" using the id from the request message.', 'whichreq');
      }
    }
    if (cents === undefined) cents = open.find((r) => r.requestId === id)?.amountCents;
    if (cents === undefined) {
      return reply(msg, ctx.householdId, 'How much would you like to cover? Reply "cover <request-id> $<amount>".', 'amt');
    }
    return command(msg, ctx, { kind: 'offer_coverage', requestId: id, amountCents: cents });
  }

  async function parseReaction(msg: InboundMessage): Promise<ParseResult> {
    const { targetMessageId, emoji } = msg.reaction!;
    const approve = APPROVE_REACTIONS.has(emoji);
    const decline = DECLINE_REACTIONS.has(emoji);
    if (!approve && !decline) return { kind: 'ignored', reason: 'reaction is not an approval or decline' };
    const ctx = await deps.getConversationContext(msg.senderId, msg.spaceId, targetMessageId);
    const t = ctx.targetProposal;
    if (!t) return { kind: 'ignored', reason: 'reaction target is not a proposal' };
    // Defence in depth: the target must be one this actor may act on, at that exact version.
    const allowed = ctx.actionableProposals.some((p) => p.proposalId === t.proposalId && p.proposalVersion === t.proposalVersion);
    if (!allowed) return { kind: 'ignored', reason: 'reaction target is not actionable by this member' };
    return command(msg, ctx, approve
      ? { kind: 'approve', proposalId: t.proposalId, proposalVersion: t.proposalVersion }
      : { kind: 'decline', proposalId: t.proposalId, proposalVersion: t.proposalVersion });
  }

  function fallback(msg: InboundMessage, ctx: ParserContext, text: string): ParseResult | null {
    let m: RegExpExecArray | null;
    if (/^(summary|status)\b/i.test(text) || /^what (do i|does everyone) owe\b/i.test(text)) {
      return command(msg, ctx, { kind: 'get_summary', cycleId: ctx.cycleId });
    }
    if ((m = new RegExp(`^(approve|decline)\\s+${ID}\\s+v(\\d+)$`, 'i').exec(text))) {
      const kind = m[1]!.toLowerCase() as 'approve' | 'decline';
      return command(msg, ctx, { kind, proposalId: m[2]!, proposalVersion: Number(m[3]) });
    }
    if ((m = new RegExp(`^cover\\s+${ID}\\s+${AMT}$`, 'i').exec(text))) {
      const cents = parseDollarsToCents(m[2]!);
      if (cents === null) return reply(msg, ctx.householdId, "I couldn't read that amount. Use dollars like $48 or $48.00.", 'badamt');
      return command(msg, ctx, { kind: 'offer_coverage', requestId: m[1]!, amountCents: cents });
    }
    if ((m = new RegExp(`^(add|correct)\\s+(.+?)\\s+${AMT}\\s+due\\s+(.+)$`, 'i').exec(text))) {
      return billCommand(msg, ctx, m[1]!.toLowerCase() as 'add' | 'correct', m[2]!, m[3]!, m[4]!);
    }
    if (/^(add|correct)\b/i.test(text) && !HEDGE.test(text)) {
      return reply(msg, ctx.householdId, 'To add a bill, say e.g. "add electricity $144 due Oct 15".', 'addhelp');
    }
    return null;
  }

  function billCommand(msg: InboundMessage, ctx: ParserContext, mode: 'add' | 'correct', titleIn: string, amount: string | number, dueDateIn: string): ParseResult {
    const cents = parseDollarsToCents(amount);
    if (cents === null) return reply(msg, ctx.householdId, "I couldn't read that amount. Use dollars like $144 or $144.00.", 'badamt');
    const due = parseDueDate(dueDateIn, msg.occurredAt);
    if (!due) return reply(msg, ctx.householdId, 'What is the due date? For example "Oct 15" or 2026-10-15.', 'baddate');
    const title = titleIn.trim();
    if (mode === 'add') {
      const recipientId = resolveRecipient(title);
      if (!recipientId) return reply(msg, ctx.householdId, recipientHelp(title), 'recipient');
      return command(msg, ctx, { kind: 'add_bill', amountCents: cents, title, dueDate: due, recipientId, cycleId: ctx.cycleId });
    }
    // correct: title or id must match exactly one open bill.
    const bill = ctx.openBills.filter((b) => b.title.toLowerCase() === title.toLowerCase() || b.billId === title);
    if (bill.length !== 1) return reply(msg, ctx.householdId, `Which bill should I correct? ${ctx.openBills.map((b) => b.title).join(', ') || 'No open bills.'}`, 'whichbill');
    const recipientId = resolveRecipient(bill[0]!.title);
    if (!recipientId) return reply(msg, ctx.householdId, recipientHelp(bill[0]!.title), 'recipient');
    return command(msg, ctx, { kind: 'correct_bill', billId: bill[0]!.billId, amountCents: cents, title: bill[0]!.title, dueDate: due, recipientId });
  }

  function mapIntent(msg: InboundMessage, ctx: ParserContext, text: string, intent: ValidIntent): ParseResult {
    const hedged = HEDGE.test(text);
    switch (intent.intent) {
      case 'none':
        return { kind: 'ignored', reason: 'not addressed to the assistant' };
      case 'clarify':
        return reply(msg, ctx.householdId,
          intent.reason === 'unclear_amount' ? "I couldn't tell the amount. How much is it, in dollars?"
          : intent.reason === 'missing_field' ? 'I need the bill name, amount and due date, e.g. "add electricity $144 due 2026-10-15".'
          : "I'm not sure what you'd like me to do. I can add a bill, show a summary, or help with coverage.", 'clarify');
      case 'summary':
        return command(msg, ctx, { kind: 'get_summary', cycleId: ctx.cycleId });
      case 'add_bill':
      case 'correct_bill':
        if (hedged) return reply(msg, ctx.householdId, 'Just to confirm: should I add that bill? Say it plainly, e.g. "add electricity $144 due 2026-10-15".', 'hedge');
        return billCommand(msg, ctx, intent.intent === 'add_bill' ? 'add' : 'correct', intent.title, (intent.amountCents / 100).toFixed(2), intent.dueDate);
      case 'request_coverage': {
        const bill = pickBill(msg, ctx, text, 'ask for help with');
        if ('kind' in bill) return bill;
        return command(msg, ctx, { kind: 'request_coverage', billId: bill.billId });
      }
      case 'offer_coverage':
        if (hedged) return reply(msg, ctx.householdId, 'Thanks for considering it. To offer coverage, say it plainly, e.g. "cover <request-id> $48".', 'hedge');
        return handleOffer(msg, ctx, undefined, intent.amountCents);
      case 'approve':
      case 'consent_yes':
        if (hedged) return reply(msg, ctx.householdId, 'Just to be sure: do you approve? Reply "yes" to confirm or "no" to decline.', 'hedge');
        return resolveAnswer(msg, ctx, true);
      case 'decline':
      case 'consent_no':
        return resolveAnswer(msg, ctx, false);
    }
  }

  async function parseText(msg: InboundMessage): Promise<ParseResult> {
    const text = (msg.text ?? '').trim();
    if (!text) return { kind: 'ignored', reason: 'empty message' };
    const ctx = await deps.getConversationContext(msg.senderId, msg.spaceId);

    const fb = fallback(msg, ctx, text);
    if (fb) return fb;
    if (YES.test(text)) return resolveAnswer(msg, ctx, true);
    if (NO.test(text)) return resolveAnswer(msg, ctx, false);

    if (HEDGE.test(text) && MONEYISH.test(text) && !/\b(owe|summary|status)\b/i.test(text)) {
      // Questions and tentative offers: clarify, never act. (Intent model may still know "what do I owe".)
      const asksOwe = /\bwhat\b.*\bowe\b/i.test(text);
      if (!asksOwe) {
        return reply(msg, ctx.householdId, "I'll only act on a clear request. When you're ready, say e.g. \"cover <request-id> $48\" or \"approve <id> v1\" - or ask for a \"summary\".", 'hedge');
      }
    }

    const raw = await deps.intentModel.interpret({
      text,
      occurredAt: msg.occurredAt,
      visibility: msg.visibility,
      cycleId: ctx.cycleId,
      openBills: ctx.openBills,
      recipientNames: household.recipients.map((r) => r.displayName),
      hasActionableProposals: ctx.actionableProposals.length > 0,
      hasPrivateCoverageQuestion: msg.visibility === 'private' && !!ctx.privateCoverageRequestId,
    });
    return mapIntent(msg, ctx, text, validateIntent(raw));
  }

  async function parse(msg: InboundMessage): Promise<ParseResult> {
    const member = household.members.find((m) => m.userId === msg.senderId);
    if (!member) return { kind: 'ignored', reason: 'sender is not enrolled' };
    if (msg.visibility === 'group' && msg.spaceId !== household.groupSpaceId) return { kind: 'ignored', reason: 'unrelated group' };
    if (msg.reaction) return parseReaction(msg);
    return parseText(msg);
  }

  return { parse, formatCents };
}
