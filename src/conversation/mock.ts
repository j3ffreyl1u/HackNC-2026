import type { TripConfig } from './contracts-local.js';
import type { IntentInput, IntentModel, Messenger, MessengerAudience, RawIntent, RawProviderEvent } from './types.js';

/** Local messenger with no network. Tests push raw events in and read `sent`. */
export class MockMessenger implements Messenger {
  readonly sent: Array<{ audience: MessengerAudience; text: string; providerMessageId: string }> = [];
  private handler: ((e: RawProviderEvent) => Promise<void>) | null = null;
  private counter = 0;
  stopped = false;

  async subscribe(onEvent: (event: RawProviderEvent) => Promise<void>): Promise<void> {
    this.handler = onEvent;
  }
  async send(audience: MessengerAudience, text: string): Promise<{ providerMessageId: string }> {
    const providerMessageId = `mock-msg-${++this.counter}`;
    this.sent.push({ audience, text, providerMessageId });
    return { providerMessageId };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.handler = null;
  }
  /** Deliver a raw event as the provider would (also used to replay retries). */
  async emit(event: RawProviderEvent): Promise<void> {
    if (!this.handler) throw new Error('MockMessenger is not started');
    await this.handler(event);
  }
}

/** Deterministic stand-in for Gemini: returns scripted intents, else `none`. */
export class MockIntentModel implements IntentModel {
  readonly calls: IntentInput[] = [];
  constructor(private readonly script: (input: IntentInput) => RawIntent = () => ({ intent: 'none' })) {}
  async interpret(input: IntentInput): Promise<RawIntent> {
    this.calls.push(input);
    return this.script(input);
  }
}

export function groupEvent(h: TripConfig, providerUserId: string, messageId: string, text: string, extra: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return { messageId, providerUserId, spaceId: h.groupSpaceId, isDirect: false, fromSelf: false, occurredAt: '2026-10-01T12:00:00Z', text, ...extra };
}
export function dmEvent(providerUserId: string, messageId: string, text: string, extra: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return { messageId, providerUserId, spaceId: `dm-${providerUserId}`, isDirect: true, fromSelf: false, occurredAt: '2026-10-01T12:00:00Z', text, ...extra };
}
