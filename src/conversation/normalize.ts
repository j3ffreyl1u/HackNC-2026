import type { InboundMessage, TripConfig } from './contracts-local.js';
import { guestId, parseJoinCode } from './join.js';
import type { RawProviderEvent } from './types.js';

/**
 * Maps a provider event to an InboundMessage, or null when it must be dropped: our own outgoing messages,
 * removed reactions, unknown users, and (in `direct` mode, or for an unrelated group) anything that is not a
 * DM from an enrolled member. Actor identity comes only from the enrolled providerUserId. Event ids derive
 * from provider ids so retries of the same event dedupe.
 */
export function normalizeEvent(raw: RawProviderEvent, trip: TripConfig, options: { joinCodes?: boolean } = {}): InboundMessage | null {
  if (raw.fromSelf) return null;
  if (raw.reaction?.removed) return null;
  const member = trip.members.find((m) => m.providerUserId === raw.providerUserId);
  if (!member) {
    // Strangers are dropped, except (when enabled) a one-on-one DM that is exactly a join-code request.
    if (options.joinCodes && raw.isDirect && !raw.reaction && raw.text && parseJoinCode(raw.text)) {
      return { eventId: raw.eventId ?? `message:${raw.messageId}`, messageId: raw.messageId, senderId: guestId(raw.providerUserId), spaceId: raw.spaceId, visibility: 'private', occurredAt: raw.occurredAt, text: raw.text };
    }
    return null;
  }
  if (!raw.isDirect && !(trip.mode === 'group' && raw.spaceId === trip.groupSpaceId)) return null;

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
  if (raw.reaction) out.reaction = { targetMessageId: raw.reaction.targetMessageId, emoji: raw.reaction.emoji };
  return out;
}
