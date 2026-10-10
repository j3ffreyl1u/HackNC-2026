import { createHash } from 'node:crypto';
import type { Command, ConversationService, FinanceService, InboundMessage } from '../contracts/index.js';
import { UnknownActorError } from '../finance/index.js';

/** Serializes inbound events for this single-household demo; Finance also enforces durable uniqueness. */
export function createEventHandler(conversation: ConversationService, finance: FinanceService, householdId?: string) {
  let tail: Promise<void> = Promise.resolve();
  return (message: InboundMessage): Promise<void> => {
    const current = tail.then(() => processInbound(message, conversation, finance, householdId));
    tail = current.catch(() => undefined);
    return current;
  };
}

/** Stable across event retries, even when the language parser is invoked again. */
export function deterministicCommandId(command: Pick<Command, 'householdId' | 'payload'>, sourceEventId: string): string {
  const identity = JSON.stringify([command.householdId, sourceEventId, command.payload.kind]);
  return `cmd-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function deterministicDeliveryId(householdId: string, sourceEventId: string, action: string): string {
  const identity = JSON.stringify([householdId, sourceEventId, action]);
  return `delivery-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

async function processInbound(message: InboundMessage, conversation: ConversationService, finance: FinanceService, expectedHouseholdId?: string): Promise<void> {
  if (!(await finance.claimInbound(message.eventId))) return;
  let result: Awaited<ReturnType<ConversationService['parseInbound']>>;
  try {
    result = await conversation.parseInbound(message);
  } catch (error) {
    if (!(error instanceof UnknownActorError)) throw error;
    await finance.completeInbound(message.eventId);
    return;
  }
  if (result.kind === 'command') {
    if (expectedHouseholdId && result.command.householdId !== expectedHouseholdId) {
      await finance.completeInbound(message.eventId);
      return;
    }
    const command: Command = {
      ...result.command,
      commandId: deterministicCommandId(result.command, message.eventId),
      actorId: message.senderId,
      sourceEventId: message.eventId,
    };
    let execution;
    try {
      execution = await finance.execute(command);
    } catch (error) {
      if (!(error instanceof UnknownActorError)) throw error;
      await finance.completeInbound(message.eventId);
      return;
    }
    if (execution.kind === 'rejected' && execution.code === 'UNAUTHORIZED_ACTOR') {
      await finance.completeInbound(message.eventId);
      return;
    }
    if (execution.kind === 'rejected') {
      await finance.enqueueMessage({
        deliveryId: deterministicDeliveryId(command.householdId, message.eventId, `rejection:${command.payload.kind}`),
        householdId: command.householdId,
        audience: { kind: 'private', userId: message.senderId },
        text: execution.userMessage,
      });
    }
    await drainOutbox(conversation, finance);
  } else if (result.kind === 'reply') {
    await finance.enqueueMessage(result.message);
    await drainOutbox(conversation, finance);
  }
  await finance.completeInbound(message.eventId);
}

// Avoid an in-process resend even if the durable uncertainty update itself errors.
const blockedDeliveries = new Set<string>();

/** Sends persisted messages in order and never automatically retries an uncertain outcome. */
export async function drainOutbox(conversation: ConversationService, finance: FinanceService): Promise<void> {
  if (!finance.markDeliveryUncertain) {
    throw new Error('Outbox delivery is disabled until Finance exposes durable markDeliveryUncertain().');
  }
  for (const message of await finance.pendingMessages()) {
    if (blockedDeliveries.has(message.deliveryId)) return;
    try {
      const { providerMessageId } = await conversation.sendMessage(message);
      await finance.recordDelivery(message.deliveryId, providerMessageId);
    } catch (error) {
      blockedDeliveries.add(message.deliveryId);
      await finance.markDeliveryUncertain(message.deliveryId);
      throw error;
    }
  }
}
