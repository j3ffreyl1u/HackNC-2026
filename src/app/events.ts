import type { ConversationService, FinanceService, InboundMessage } from '../contracts/index.js';

/** Serializes inbound events for this single-household demo; Finance also enforces durable uniqueness. */
export function createEventHandler(conversation: ConversationService, finance: FinanceService) {
  let tail: Promise<void> = Promise.resolve();
  return (message: InboundMessage): Promise<void> => {
    const current = tail.then(() => processInbound(message, conversation, finance));
    tail = current.catch(() => undefined);
    return current;
  };
}

async function processInbound(message: InboundMessage, conversation: ConversationService, finance: FinanceService): Promise<void> {
  if (!(await finance.claimInbound(message.eventId))) return;
  const result = await conversation.parseInbound(message);
  if (result.kind === 'command') await finance.execute(result.command);
  if (result.kind === 'reply') await finance.enqueueMessage(result.message);
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
