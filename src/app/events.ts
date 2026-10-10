import type { ConversationService, FinanceService, InboundMessage } from '../contracts/index.js';

/** Connects normalized provider events to finance with durable inbound deduplication. */
export function createEventHandler(conversation: ConversationService, finance: FinanceService) {
  return async (message: InboundMessage): Promise<void> => {
    if (!(await finance.claimInbound(message.eventId))) return;
    try {
      const result = await conversation.parseInbound(message);
      if (result.kind === 'command') await finance.execute(result.command);
      if (result.kind === 'reply') await finance.enqueueMessage(result.message);
      await finance.completeInbound(message.eventId);
    } catch (error) {
      // Keep the claim incomplete so durable recovery can retry after the issue is resolved.
      throw error;
    }
  };
}

export async function drainOutbox(conversation: ConversationService, finance: FinanceService): Promise<void> {
  for (const message of await finance.pendingMessages()) {
    const { providerMessageId } = await conversation.sendMessage(message);
    await finance.recordDelivery(message.deliveryId, providerMessageId);
  }
}
