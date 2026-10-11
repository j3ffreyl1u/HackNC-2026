/**
 * Join codes: a friend texts the assistant "join 4F7K" to be added to a trip. This module only READS the code;
 * checking it, enrolling the person and recording their consent belong to the app (C). A code must contain a
 * digit so ordinary sentences ("join us", "join now") are never mistaken for one.
 */
const CODE = '([A-Z0-9][A-Z0-9-]{2,15})';
const PATTERNS = [
  new RegExp(`^join[\\s:_-]+(?:code[\\s:_-]*)?${CODE}$`, 'i'),
  new RegExp(`^(?:i(?:'d| would)? (?:like|want) to |please |pls )?join (?:the |this |our )?trip(?: with)?(?: code)?[\\s:_-]*${CODE}$`, 'i'),
  new RegExp(`^(?:use|using) (?:the )?code[\\s:_-]*${CODE} to join(?: the trip)?$`, 'i'),
];

/** The upper-cased join code in `text`, or null if the message is not a join request. */
export function parseJoinCode(text: string): string | null {
  const t = text.replace(/[‘’]/g, "'").trim().replace(/[.!\s]+$/, '');
  for (const re of PATTERNS) {
    const m = re.exec(t);
    if (m && /\d/.test(m[1]!)) return m[1]!.toUpperCase();
  }
  return null;
}

/** Identity for someone who is not enrolled yet. Never used for anything except a join attempt. */
export const GUEST_PREFIX = 'guest:';
export const guestId = (providerUserId: string) => `${GUEST_PREFIX}${providerUserId}`;
export const isGuest = (senderId: string) => senderId.startsWith(GUEST_PREFIX);
export const guestProviderUserId = (senderId: string) => senderId.slice(GUEST_PREFIX.length);
