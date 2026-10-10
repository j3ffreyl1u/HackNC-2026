import type { HouseholdConfig, InboundMessage } from '../contracts/index.js';
import type { RawProviderEvent } from './types.js';

/**
 * Maps a provider event to the shared InboundMessage, or null when it must be dropped:
 * our own outgoing messages, removed reactions, unknown users, unrelated groups.
 * Actor identity comes only from the enrolled providerUserId. Event ids are derived
 * from provider ids so retries of the same event dedupe.
 */
export function normalizeEvent(raw: RawProviderEvent, household: HouseholdConfig): InboundMessage | null {
  if (raw.fromSelf) return null;
  if (raw.reaction?.removed) return null;
  const member = household.members.find((m) => m.providerUserId === raw.providerUserId);
  if (!member) return null;
  if (!raw.isDirect && raw.spaceId !== household.groupSpaceId) return null;

  const eventId =
    raw.eventId ??
    (raw.reaction
      ? `reaction:${raw.reaction.targetMessageId}:${raw.providerUserId}:${raw.reaction.emoji}`
      : `message:${raw.messageId}`);

  const out: InboundMessage = {
    eventId,
    messageId: raw.messageId,
    senderId: member.userId,
    spaceId: raw.spaceId,
    visibility: raw.isDirect ? 'private' : 'group',
    occurredAt: raw.occurredAt,
  };
  if (raw.text !== undefined) out.text = raw.text;
  if (raw.imageUrls?.length) out.imageUrls = raw.imageUrls;
  if (raw.reaction) out.reaction = { targetMessageId: raw.reaction.targetMessageId, emoji: raw.reaction.emoji };
  return out;
}
