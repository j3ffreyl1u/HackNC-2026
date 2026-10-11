/**
 * Spectrum (Photon) transport. Verified against spectrum-ts / @spectrum-ts/core /
 * @spectrum-ts/imessage 12.10.1 type definitions and docs.photon.codes pages
 * (messages, spaces-and-users, reactions-and-replies, providers/imessage), 2026-10-10.
 * Exercised on real phones over a live Photon line during the hackathon.
 *
 * The SDK is described by the minimal structural types below, so this module needs no
 * compile-time dependency on spectrum-ts. C adds `spectrum-ts` to package.json; `loadSpectrumApp`
 * imports it lazily and only when CHAT_MODE=photon.
 */
import type { TripConfig } from './contracts-local.js';
import type { Messenger, MessengerAudience, RawProviderEvent } from './types.js';

/** Subset of spectrum-ts `Message`/`Space` we rely on (names taken from the 12.10.1 typings). */
export interface SpectrumSpaceLike {
  readonly id: string;
  /** iMessage spaces expose type: 'dm' | 'group'. Other providers may omit it. */
  readonly type?: 'dm' | 'group';
  send(content: string): Promise<{ id: string } | undefined>;
}
export interface SpectrumMessageLike {
  readonly id: string;
  direction: 'inbound' | 'outbound';
  sender: { readonly id: string } | undefined;
  timestamp: Date;
  content:
    | { type: 'text'; text: string }
    | { type: 'reaction'; emoji: string; target: { readonly id: string } }
    | { type: string; [k: string]: unknown };
}
export interface SpectrumAppLike {
  readonly messages: AsyncIterable<[SpectrumSpaceLike, SpectrumMessageLike]>;
  stop(): Promise<void>;
}
/** Result of `imessage(app)`: user lookup + space get/create, per the spaces-and-users docs. */
export interface SpectrumIMessageLike {
  user(providerUserId: string): Promise<unknown>;
  space: {
    get(spaceId: string): Promise<SpectrumSpaceLike>;
    create(user: unknown): Promise<SpectrumSpaceLike>;
  };
}

/** Pure mapping used by the live loop and by tests with recorded-shape payloads. */
export function mapSpectrumMessage(space: SpectrumSpaceLike, message: SpectrumMessageLike): RawProviderEvent | null {
  const sender = message.sender;
  if (!sender) return null; // group-management events can have no sender
  const base = {
    messageId: message.id,
    providerUserId: sender.id,
    spaceId: space.id,
    isDirect: space.type === 'dm',
    fromSelf: message.direction === 'outbound',
    occurredAt: message.timestamp.toISOString(),
  };
  const c = message.content;
  if (c.type === 'text' && typeof c.text === 'string') return { ...base, text: c.text };
  if (c.type === 'reaction' && typeof c.emoji === 'string') {
    const target = (c as { target?: { id?: string } }).target;
    if (!target?.id) return null;
    // The reaction is its own Message (own id); the target is the message reacted to.
    return { ...base, eventId: `reaction:${message.id}`, reaction: { targetMessageId: target.id, emoji: c.emoji } };
  }
  return null; // attachments, voice, polls, etc. are out of scope for the MVP
}

export interface SpectrumMessengerOptions {
  app: SpectrumAppLike;
  imessage: SpectrumIMessageLike;
  trip: TripConfig;
  onError?: (err: unknown) => void;
}

export function createSpectrumMessenger(opts: SpectrumMessengerOptions): Messenger {
  const { app, imessage, onError } = opts;
  const spaces = new Map<string, SpectrumSpaceLike>();
  const dms = new Map<string, SpectrumSpaceLike>();
  let running: Promise<void> | null = null;
  let stopped = false;

  async function resolveSpace(audience: MessengerAudience): Promise<SpectrumSpaceLike> {
    if (audience.kind === 'group') {
      const cached = spaces.get(audience.spaceId);
      if (cached) return cached;
      const space = await imessage.space.get(audience.spaceId);
      spaces.set(audience.spaceId, space);
      return space;
    }
    const cached = dms.get(audience.providerUserId);
    if (cached) return cached;
    const user = await imessage.user(audience.providerUserId);
    const space = await imessage.space.create(user);
    dms.set(audience.providerUserId, space);
    return space;
  }

  return {
    async subscribe(onEvent) {
      if (running) throw new Error('Spectrum messenger already started');
      running = (async () => {
        for await (const [space, message] of app.messages) {
          if (stopped) break;
          try {
            spaces.set(space.id, space);
            const raw = mapSpectrumMessage(space, message);
            if (raw) await onEvent(raw);
          } catch (err) {
            // One bad event must not kill the subscription. Never log message text.
            onError?.(err);
          }
        }
      })().catch((err) => onError?.(err));
    },
    async send(audience, text) {
      const space = await resolveSpace(audience);
      const sent = await space.send(text);
      if (!sent?.id) {
        // The provider may or may not have delivered it. Surface uncertainty; do not fabricate an id.
        throw new Error('Spectrum send returned no message id; delivery uncertain');
      }
      return { providerMessageId: sent.id };
    },
    async stop() {
      stopped = true;
      await app.stop();
      await running;
    },
  };
}

export interface SpectrumCredentials {
  projectId: string;
  projectSecret: string;
}

/** Lazy live construction. Requires `spectrum-ts` installed by C and real credentials. */
export async function loadSpectrumApp(creds: SpectrumCredentials): Promise<{ app: SpectrumAppLike; imessage: SpectrumIMessageLike }> {
  if (!creds.projectId || !creds.projectSecret) {
    throw new Error('CHAT_MODE=photon requires SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET');
  }
  const core = 'spectrum-ts';
  const prov = 'spectrum-ts/providers/imessage';
  const { Spectrum } = (await import(core)) as { Spectrum: (o: unknown) => Promise<SpectrumAppLike> };
  const { imessage } = (await import(prov)) as {
    imessage: { config(): unknown } & ((app: SpectrumAppLike) => SpectrumIMessageLike);
  };
  const app = await Spectrum({ ...creds, providers: [imessage.config()] });
  return { app, imessage: imessage(app) };
}
