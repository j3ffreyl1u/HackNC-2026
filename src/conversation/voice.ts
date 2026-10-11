import { extractText } from './gemini.js';

/**
 * The "voice" of the organizer: takes a message the bot already decided to send and rewords it so it reads like a
 * friend texting, not a form. It never decides anything. A message with a dollar amount is never sent to it: a private
 * "your max is $250" confirmation is exactly the kind of limit that must not leave the planner for a third party.
 * Its answer is checked against the original, and if anything looks off, the original text is sent unchanged.
 */
export interface Voice {
  polish(text: string): Promise<string>;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const STYLE = [
  'You are the friend who organizes a group trip over text messages. Reword the message below so it sounds like a warm, relaxed person texting, not a form and not an AI.',
  'Rules:',
  '- Keep every name, date, number, place and quoted phrase exactly as written. Do not add facts, promises, advice or emojis.',
  '- If the message asks a question, ask that same single question. If it is not a question, do not turn it into one.',
  '- One to three short sentences, no longer than the original. Plain everyday words. Contractions are fine.',
  '- No em dashes. At most one exclamation mark. No ceremonial openings or closings ("Certainly", "I\'d be happy to", "Let me know if you have any questions", "Great question").',
  '- Do not start with "Got it" every time; vary how you open. If the message ends by inviting a correction ("Tell me if I got anything wrong"), usually drop it, or say it a different short way, such as "shout if that\'s off". Do not mention being an AI or a bot.',
  'Return only the rewritten message text.',
].join('\n');

/** Messages with links, tokens, lists, several lines or any dollar amount are never reworded (a private limit stays out of the model's hands). */
export function shouldPolish(text: string): boolean {
  if (text.length < 8 || text.length > 260) return false;
  if (/https?:|\{\{|•|\n|\$/.test(text)) return false;
  return true;
}

/** The pieces of the original that must survive a rewrite untouched. */
function mustKeep(original: string): string[] {
  const numbers = original.match(/\d+/g) ?? [];
  const quoted = original.match(/"[^"]+"/g) ?? [];
  const money = original.match(/\$\s?\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];
  // Capitalized words in the middle of a sentence are names and places.
  const names = (original.match(/(?<=[a-z,] )[A-Z][A-Za-z.']+/g) ?? []).map((n) => n.replace(/[.']+$/, ''));
  return [...new Set([...numbers, ...quoted, ...money, ...names])];
}

/** The rewrite if it is safe to send, otherwise undefined. */
export function acceptPolished(original: string, candidate: string | undefined | null): string | undefined {
  if (!candidate) return undefined;
  const text = candidate.trim().replace(/^["']|["']$/g, '').trim();
  if (text === '' || text === original) return undefined;
  if (text.length > Math.min(320, Math.round(original.length * 1.4) + 30)) return undefined;
  if (/[—–]/.test(text) || (text.match(/!/g) ?? []).length > 1) return undefined;
  if (/https?:|\{\{/.test(text)) return undefined;
  // Dollar amounts: only the ones in the original, written exactly the same way.
  const moneyIn = new Set(original.match(/\$\s?\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []);
  if ((text.match(/\$\s?\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).some((m) => !moneyIn.has(m)) || (text.includes('$') && moneyIn.size === 0)) return undefined;
  if (/\n\s*\n/.test(text)) return undefined;
  if (!/[.?!)"']$/.test(text)) return undefined; // a message that stops mid-sentence is a cut-off one
  const asks = (s: string) => s.trim().endsWith('?');
  if (asks(original) !== asks(text)) return undefined;
  if (mustKeep(original).some((piece) => !text.includes(piece))) return undefined;
  // No numbers that were not in the original (no invented dates or amounts).
  const known = new Set(original.match(/\d+/g) ?? []);
  if ((text.match(/\d+/g) ?? []).some((n) => !known.has(n))) return undefined;
  return text;
}

export interface GeminiVoiceOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

export function createGeminiVoice(opts: GeminiVoiceOptions): Voice {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async polish(text: string): Promise<string> {
      if (!shouldPolish(text)) return text;
      try {
        const res = await doFetch(`${BASE}/${encodeURIComponent(opts.model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${STYLE}\n\nMessage: ${JSON.stringify(text)}` }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 600, thinkingConfig: { thinkingLevel: 'low' } },
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        const body = await res.json();
        // A reply the model did not finish (cut off by its token limit, blocked, etc.) is never used.
        const finish = (body as { candidates?: Array<{ finishReason?: string }> })?.candidates?.[0]?.finishReason;
        if (finish !== undefined && finish !== 'STOP') return text;
        return acceptPolished(text, extractText(body)) ?? text;
      } catch (err) {
        opts.onError?.(err); // never includes the key or the message text
        return text;
      }
    },
  };
}
