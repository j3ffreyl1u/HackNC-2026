import type { ConstraintField, ConstraintValue } from './contracts-local.js';
import { parseDateWindows } from './dates.js';
import { parseDollarsToCents } from './money.js';

/** Tentative language never becomes a locked-in budget or date window. */
export const HEDGE = /\b(maybe|might|perhaps|possibly|probably|not sure|i guess|i think|could|what if|if i|if we|would|ish|depends|hopefully|tentatively)\b|\?/i;

export interface Extracted {
  value: ConstraintValue;
  /** The sentence it came from used tentative or question wording. */
  hedged: boolean;
  /** Availability sentence was negative ("can't do Oct 17"): not a window. Reported so the bot can ask. */
  negative?: boolean;
}

const MONEY = '\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)|([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:dollars|bucks|usd)';
const BUDGET_KEYWORD = '(?:budget|max(?:imum)?|cap|limit|spend|afford|up to|at most|no more than|(?:can|could|may|might|able to) (?:only )?(?:do|pay|swing|spend|afford)|can swing|able to (?:do|pay|spend|afford)|only (?:got|have|has)|all[- ]in)';
const BUDGET_AFTER = new RegExp(`\\b${BUDGET_KEYWORD}\\b[^.!?\\n$\\d]{0,30}?(?:${MONEY})`, 'i');
const BUDGET_BEFORE = new RegExp(`(?:${MONEY})\\s*(?:(?:is|'s)\\s+(?:my|the|our)\\s+(?:(?:firm|hard|absolute|final)\\s+)?)?(?:max|maximum|total|tops|cap|limit|all[- ]in|budget|at most)\\b`, 'i');
const BUDGET_BARE = /\b(?:budget|max(?:imum)?|cap|limit)\b\s*(?:(?:is|of|:|=)\s*)?(?:(?:around|about|roughly|approximately|like|at)\s*)?\$?([\d,]+(?:\.\d{1,2})?)\b(?!\s*[a-z])|\b(?:(?:can|could|only|would)\s+(?:only\s+)?(?:pay|swing)|spend|afford|swing)\s+(?:about\s+|around\s+|up to\s+)?\$?([\d,]+(?:\.\d{1,2})?)(?:\s+(?:in total|total|all in|altogether|tops))?\b(?!\s*[a-z])|\b(?:have|got)\s+\$?([\d,]+(?:\.\d{1,2})?)\s+(?:dollars\s+|bucks\s+)?(?:to|for)\s+(?:spend|the trip|this trip)\b|(?:^|[\s,])\$?([\d,]+(?:\.\d{1,2})?)\s*(?:is|'s)\s+(?:my|the|our)\s+(?:(?:firm|hard|absolute|final)\s+)?(?:max|maximum|budget|cap|limit)\b/i;
const BARE_AMOUNT = /^\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)?[.!]*$/i;
const AVAIL_WORDS = /\b(free|available|availability|open|works?|can (?:do|go|make(?: it)?|leave)|good|window|off|maybe|perhaps|how about|what about|could (?:do|go|make it))\b/i;
const NEGATIVE = /\b(not|n't|busy|can'?t|cannot|unavailable|booked|out of town|bad|no good|conflict|have plans|taken)\b/i;

/** One-way drive limit in minutes from text like "within 3 hours", "1.5 hour drive", "within 90 minutes". */
export function parseMaxTravelMinutes(text: string): number | undefined {
  let m: RegExpExecArray | null;
  let minutes: number | undefined;
  if ((m = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?(?:hours?|hrs?|h)\b/i.exec(text))) minutes = Math.round(Number(m[1]) * 60);
  else if ((m = /\b(\d{2,3})\s*[- ]?(?:minutes?|mins?)\b/i.exec(text))) minutes = Number(m[1]);
  return minutes !== undefined && minutes >= 15 && minutes <= 1440 ? minutes : undefined;
}

/** Short replies that are not a place even when a place was asked for: a change of subject, a date, or a liking. */
const NOT_A_PLACE_ANSWER = /^(?:start over|restart|reset|begin again|cancel|never ?mind|nvm|stop|quit|skip|idk|not sure|no idea|later|nothing|none|n\/a|ok(?:ay)?|sure|thanks|thank you|hello|hi|hey)$|\b(?:weekends?|weeks?|months?|days?|today|tomorrow|tonight|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mostly|mainly|probably|maybe|just|only|really|kind of|whatever|anything|food|foods|nights?|monuments?|museums?|histor(?:y|ical)|hiking|nightlife|sightseeing|restaurants?|breweries|brewery|shopping|nature|outdoors?|relax(?:ing)?|looks?|sounds?|seems?|good|fine|perfect|awesome|lol|lmao|haha|ok(?:ay)?|yes|yeah|yep|thanks|everything|how|what|why|does|this|that)\b/i;
/** "I like the second one better" is about the options, not something the person likes doing. */
const PICK_TALK = /\b(?:the\s+)?(?:first|second|third|1st|2nd|3rd|last|other)\s+(?:one|option|plan)\b|\b(?:option|plan)\s+\d\b|\bone\s+better\b/i;
const NOT_A_PLACE = /\b(i|we|you|he|she|they|has|have|had|is|are|was|am|can|will|would|want|like|need|car|trip|my|our|it|not|but|with|for|please|thanks|yes|no|help|huh|menu|options?|wait|sorry|skip|later|stop|cancel|idk|dunno|what|why|how|nothing|never ?mind)\b/i;
/** "my car is in the shop": the car exists but cannot make the trip. */
const CAR_BROKEN = /\b(?:my|our) (?:car|truck|suv|van)\b[^.!?]{0,30}\b(?:shop|broken|broke|dead|died|mechanic|repair(?:s|ed)?|totaled|totalled|won'?t start|not working|isn'?t working)\b/i;
const THIRD_PERSON_VEHICLE = /\b(?:[Ww]e|[Ss]omeone|[Ss]omebody|[Aa]nyone|[Ee]veryone|(?!(?:Who|Whoever|What|Which|Where|When|Why|How|Does|Do|Did|Has|Have|Is|Are|Can|Could|Would|Should|Will|Nobody|None)\b)[A-Z][a-z]+)\s+(?:has|have|got)\s+(?:a\s+|an\s+|the\s+|two\s+|2\s+|both\s+)?(?:cars?|vehicles?|trucks?|suvs?)\b/;

/** "I don't want to go to Charlotte", "the drive to Asheville is too long": the place is named, but not as where to go. */
const NOT_DESTINATION = /\b(?:don'?t|do not|doesn'?t|not|never|won'?t|no way)\b[^.!?]{0,25}\b(?:go|going|want|wanna|head|travel|drive|driving|like|care|do)\b|\btoo (?:long|far)\b|\b(?:is|are|was|seems?) (?:really |way |so |pretty )?(?:far|long|boring|expensive|crowded|overrated)\b/i;
/** Lower-case words after "let's go to" that are an activity or a thing, not a place. */
const LOWER_NOT_PLACE = /^(?:the\s+)?(?:bed|sleep|work|school|class|town|be|get|see|do|have|try|make|take|visit|say|ask|check|stay|eat|drink|hike|find|look|plan|my|our|your|his|her|that|this|it|them|us|you|one|some|any|every|all|more|just|really|somewhere|anywhere|something|there|here|home|a|an|the)\b/i;
/** "boone" -> "Boone", "washington dc" -> "Washington DC": only text typed in lower case; two-letter words are abbreviations. */
export const properCase = (text: string): string => (text === text.toLowerCase()
  ? text.replace(/\b([a-z])([a-z.'-]*)/g, (w, f: string, r: string) => (['of', 'the', 'and', 'in', 'on', 'by'].includes(w) ? w : r.length === 1 ? w.toUpperCase() : f.toUpperCase() + r))
  : text);
const NOT_ORIGIN = /^(?:there|here|home|it|that|this|them|where|somewhere|anywhere)$/i;
/** A sentence that is a question ("how long is the drive to Asheville") is not a statement of where we are going. */
const QUESTION_START = /^(?:how|what|what's|whats|where|when|which|who|why|is|are|does|do|can|could|will|would|should)\b/i;

const clean = (s: string) => s.trim().replace(/^(?:(?:a bunch of|a lot of|lots of|a few|some|a|an|the)\s+)+/i, '').replace(/[.!,;]+$/, '').trim();
const GENERIC = /^(?:that|it|this|those|these|them|the idea|to|doing)\b/i;

function splitItems(raw: string): string[] {
  const items = raw
    .split(/\s*(?:,|&|\band\b|\bor\b)\s*/i)
    .map(clean)
    .map((s) => s.replace(/^(?:mostly|mainly|especially|really|just|probably|definitely|maybe|some|lots of|a lot of)\s+(?=\S)/i, ''))
    .map((s) => s.replace(/^(?:eat|see|visit|do|try|explore|check out|go to|go)\s+(?=\S)/i, ''))   // "eat yummy food" is about yummy food
    .filter((s) => s.length > 1 && s.length <= 60 && !GENERIC.test(s));
  return [...new Set(items)].slice(0, 10);
}

/** "$1.5k" is $1,500. Only applied where it can only mean money. */
const expandK = (s: string) => s.replace(/(\$\s*)?(\d+(?:\.\d+)?)\s*k\b/gi, (all, dollar: string | undefined, n: string) => (dollar || /\b(?:budget|max|cap|limit|spend|afford)\b/i.test(s) ? `${dollar ?? ''}${Math.round(Number(n) * 1000)}` : all));
/** An amount per night, per day or per meal is not the whole trip's limit. */
const PER_UNIT = /\$?\s*[\d,]+(?:\.\d{1,2})?\s*(?:dollars|bucks)?\s*(?:\/|a |an |per |each |every )\s*(?:night|day|nite|meal|hour|mile|week)\b|\b(?:per|each|every)\s+(?:night|day)\s+(?:is\s+)?\$?\d/i;
/** "I can't afford $300" means under $300, not $300; "can't spend more than $300" is a real cap. */
const CANT_AFFORD = /\b(?:can'?t|cannot|can not|won'?t|don'?t|do not|couldn'?t)\b[^.!?$\d]{0,20}\b(?:afford|spend|pay|do|swing|manage)\b(?![^.!?$\d]{0,12}\b(?:more than|over|above|past|beyond|than)\b)/i;
/** "our budget is $900", "$900 combined": a group amount, not one person's limit. */
export const GROUP_BUDGET = /\bour\s+(?:total\s+|combined\s+|group\s+|whole\s+|trip\s+|shared\s+)?(?:budget|max|maximum|cap|limit|spend)\b|\b(?:combined|altogether|as a group|group total|group budget|between (?:all of )?us)\b/i;

function budgetFrom(sentence: string): number | null {
  sentence = expandK(sentence);
  const m = BUDGET_AFTER.exec(sentence) ?? BUDGET_BEFORE.exec(sentence);
  const bare = m ? null : BUDGET_BARE.exec(sentence);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : (bare?.[1] ?? bare?.[2] ?? bare?.[3] ?? bare?.[4]);
  return raw ? parseDollarsToCents(raw) : null;
}

/** A trailing request or question clause (", can you show us some options?") says nothing about how sure the earlier facts are. */
const TRAILING_REQUEST = /[,;]\s*(?:and\s+|so\s+)?(?:(?:can|could|would|will)\s+you|please|pls|what|how|where|when)\b[^,;]*$/i;

function extractSentence(s: string, reference: string, pending: ConstraintField | undefined, out: Extracted[]): void {
  s = s.replace(/\s*\([^()]*\?\s*\)/g, '');   // a question tucked in brackets is not part of the facts
  const hedged = HEDGE.test(s.replace(TRAILING_REQUEST, ''));
  const budgetUnsure = PER_UNIT.test(s) || CANT_AFFORD.test(s);   // an amount we cannot take as the person's whole limit
  const push = (value: ConstraintValue, extra: Partial<Extracted> = {}) => out.push({ value, hedged, ...extra });
  let m: RegExpExecArray | null;
  let visited: string | undefined;   // a place named as "I'd like to visit Boone": that is where to go, not something they like

  // "$500 for food and $800 for travel": split amounts add up to one total, but they are not a firm answer until the person confirms the sum.
  const split = [...s.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|bucks)?\s+(?:for|on)\s+(?:the\s+)?[a-z]+/gi)].map((x) => parseDollarsToCents(x[1]!));
  if (split.length >= 2 && split.every((c): c is number => c !== null)) push({ field: 'budget', value: split.reduce((a, b) => a + b, 0) }, { hedged: true });
  else {
    const cents = budgetFrom(s);
    // A total for a whole trip under $20 is almost certainly a typo: ask once instead of locking it in.
    if (cents !== null) push({ field: 'budget', value: cents }, budgetUnsure || cents < 2000 ? { hedged: true } : {});
  }

  let windows = parseDateWindows(s, reference);
  // "I can't do Nov 14 but I'm free Nov 21": only the clause that says free gives a window.
  let mixedNegative = false;
  if (windows.length > 1 && NEGATIVE.test(s) && /\b(free|available|can (?:do|go|make))\b/i.test(s.replace(/\b(?:not|n't|never) (?:free|available)/gi, ''))) {
    const clauses = s.split(/\bbut\b|\bhowever\b|\bthough\b|;/i);
    if (clauses.length > 1) {
      const keep = clauses.filter((c) => !NEGATIVE.test(c));
      if (keep.length && keep.length < clauses.length) { windows = parseDateWindows(keep.join(' '), reference); mixedNegative = true; }
    }
  }
  // A message that is only a date range ("11/14-11/16", "Nov 14th - 16th") answers "when are you free?" even without a cue word.
  const dateOnly = s.replace(/(?<=\d)(?:st|nd|rd|th)\b/gi, '').replace(/\b(?:also|plus|or|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|to|through|thru|until|till|and|the|from|st|nd|rd|th)\b/gi, '').replace(/[\d/\-–—.,\s]+/g, '') === '';
  if (windows.length && (AVAIL_WORDS.test(s) || pending === 'availability' || NEGATIVE.test(s) || dateOnly)) {
    if (!mixedNegative && NEGATIVE.test(s) && !/\b(free|available)\b/i.test(s.replace(/\b(not|n't) (free|available)/gi, ''))) push({ field: 'availability', value: windows }, { negative: true });
    else push({ field: 'availability', value: windows });
  }

  // "3 nights is too long for me" objects to the length; it does not say they want 3.
  const objectsToLength = /\btoo\s+(?:long|short|many|much)\b|\b(?:can'?t|cannot|won'?t|don'?t want|do not want)\s+(?:do|make|stay|go for|handle)?\s*(?:\d{1,2}|one|two|three|four|five|six|seven)\s*[- ]?nights?\b/i.test(s);
  if (!objectsToLength && (m = /\b(\d{1,2}|one|two|three|four|five|six|seven)\s*[- ]?nights?\b/i.exec(s))) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'].indexOf(m[1]!.toLowerCase());
    if (n >= 1 && n <= 30) push({ field: 'duration', value: n });
  }
  else if (!s.includes('?') && /\blong weekend\b/i.test(s)) push({ field: 'duration', value: 3 });
  else if (!s.includes('?') && /\b(?:a|quick|short|just a|over a)\s+weekend(?!\s+of\b)|\bweekend\s+(?:trip|getaway)\b/i.test(s) && !windows.length) push({ field: 'duration', value: 2 });
  if ((m = /\b(?:leav(?:e|ing)|depart(?:ing)?|start(?:ing)?|driv(?:e|ing)|coming|going)\s+from\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?=[,.;!?]|\s+(?:and|but|on|at|around|with|to|for|in|if|tomorrow|today|tonight|next|this|after|before|early|late|by|when|then|so|since|because|until|till|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|$)/i.exec(s)) ?? (m = /\b(?:origin|departing city)\s*(?:is|:)\s*([A-Za-z][A-Za-z .'-]{1,40})/i.exec(s))) {
    const place = m![1]!.trim();
    if (!NOT_ORIGIN.test(place)) push({ field: 'origin', value: place });
  }
  if ((m = /\b(?:within|no more than|at most|up to|under|max(?:imum)? of)\s+(?:about\s+|around\s+)?(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?|h)\b(?!\s*of\s+(?:sleep|work))/i.exec(s)) ?? (m = /\b(\d{1,2}(?:\.\d)?)\s*[- ]?(?:hours?|hrs?)\s+(?:drive|away|radius)\b/i.exec(s))) {
    push({ field: 'region', value: `within ${m![1]} hours by car`, maxTravelMinutes: Math.round(Number(m![1]) * 60) });
  } else if ((m = /\b(?:[Gg]o|[Tt]ravel|[Dd]rive|[Hh]ead|going|headed|heading|trip)\s+to\s+(?:the\s+)?((?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,3})/.exec(s)) && !QUESTION_START.test(s) && !NOT_DESTINATION.test(s)) {
    push({ field: 'region', value: clean(m[1]!).replace(/^the\s+/i, '') });
  } else if ((m = /\b(?:go|going|head(?:ing)?|headed|drive|driving|travel(?:ing)?|trip)\s+to\s+(?:the\s+)?((?:[a-z]+\s+){0,2}(?:beach(?:es)?|coast|mountains?|lakes?|shore|countryside|woods))\b/i.exec(s)) && !QUESTION_START.test(s)) {
    push({ field: 'region', value: m[1]!.replace(/^the\s+/i, '') });
  } else if ((m = /\b(?:let'?s|lets|let us|we should|we could|i want to|we want to|i wanna|we wanna|how about|what about|i'?d like to|we'?d like to)\s+(?:go|head|drive|travel)\s+to\s+(?:the\s+)?([a-z][a-z.'-]{2,}(?:\s+[a-z][a-z.'-]{2,}){0,2})(?=[\s,.;!?]|$)/.exec(s)) && !QUESTION_START.test(s) && !NOT_DESTINATION.test(s) && !LOWER_NOT_PLACE.test(m[1]!)) {
    push({ field: 'region', value: properCase(m[1]!) });
  } else if ((m = /\b(?:wanna|want to|lets|let's|we should|we could|i want to|we want to)\s+go\s+(?!(?:to|for|on|out|there|back|with|home|somewhere|anywhere|ahead|now|early|soon|see|eat|get|do|have|try|play|swim|fish|camp|hike|over|up|down|along|together|first|later)\b)([a-z][a-z.'-]{2,}(?:\s+[a-z][a-z.'-]{2,}){0,2})(?=[\s,.;!?]|$)/i.exec(s)) && !/ing$/i.test(m[1]!.split(/\s+/)[0]!) && !QUESTION_START.test(s) && !NOT_DESTINATION.test(s) && !NOT_ORIGIN.test(m[1]!)) {
    push({ field: 'region', value: properCase(m[1]!) });
  } else if ((m = /\b(?:want|wanna|'d like|would like)\s+to\s+(?:visit|see)\s+((?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,3})(?=[\s,.;!?]|$)/.exec(s)) && !QUESTION_START.test(s)) {
    visited = clean(m[1]!);
    push({ field: 'region', value: visited });
  } else if (/\b(?:any|whatever)\s+distance\b|\bdrive\s+(?:anywhere|as far as)\b|\bdon'?t\s+mind\s+(?:driving|how far)\b/i.test(s)) {
    push({ field: 'region', value: 'any distance by car', maxTravelMinutes: 1440 });
  } else if ((m = /\b(?:destination|region|area)\s*(?:is|:)\s*([A-Za-z][A-Za-z ,.'-]{1,40})/i.exec(s))) {
    const value = clean(m[1]!);
    const maxTravelMinutes = parseMaxTravelMinutes(value);
    push({ field: 'region', value, ...(maxTravelMinutes !== undefined ? { maxTravelMinutes } : {}) });
  }
  if (/\bi(?:'ve|\s+have|\s+got)\s+(?:got\s+)?(?:a\s+|my\s+)?(?:own\s+)?(?:car|vehicle|truck|suv)\b|\bi\s+can\s+drive\b|\bi(?:'ll| will)\s+drive\b|\b(?:we|i)(?:'ll| will| can| could)?\s+(?:take|use|bring|drive)\s+(?:my|our|the)\s+(?:own\s+)?(?:car|truck|suv|van|vehicle)\b/i.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (pending === 'transport' && !s.includes('?') && CAR_BROKEN.test(s)) push({ field: 'transport', value: 'no_vehicle', vehicleAvailable: false });
  else if (pending === 'transport' && !s.includes('?') && !QUESTION_START.test(s) && /\b(?:has|have|got|owns?|can (?:drive|bring))\s+(?:one|it|a ride|a vehicle|a car|a truck|an suv)\b|\b(?:do|does)\b|\bmy (?:car|truck)\b/i.test(s) && !/\b(?:no|nobody|none|don'?t|doesn'?t|not)\b/i.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (pending === 'transport' && !s.includes('?') && /\b(?:nobody|no ?one|none of us|neither of us|no)\b|\b(?:don'?t|doesn'?t|do not|does not)\s+(?:have|got|own)\b/i.test(s)) push({ field: 'transport', value: 'no_vehicle', vehicleAvailable: false });
  else if (!s.includes('?') && THIRD_PERSON_VEHICLE.test(s)) push({ field: 'transport', value: 'own_vehicle', vehicleAvailable: true });
  else if (/\bi\s+(?:don'?t|do not)\s+have\s+(?:a\s+)?(?:car|vehicle)\b|\bno car\b|\bi\s+(?:can'?t|cannot)\s+drive\b/i.test(s)) push({ field: 'transport', value: 'no_vehicle', vehicleAvailable: false });

  if (/\b(?:no (?:real )?preferences?|don'?t (?:really )?care(?!\s+(?:about|for)\b)|i'?m (?:easy|flexible|open to anything))\b/i.test(s)) {
    push({ field: 'preferences', value: ['no preference'] });
  } else if (!PICK_TALK.test(s) && !QUESTION_START.test(s) && (m = /\b(?:i|we)(?:\s+really)?(?:\s+|(?='))(?:prefer|like|love|enjoy|(?:am|are|'m|'re)\s+into|(?:want|'d like|would like) to (?:be able to )?(?:do|try|see|visit|explore|check out))\s+(.+)$/i.exec(s))) {
    // Stop at the next clause ("..., my max is $400", "... and I'm free Nov 14") so money and dates never end up as a liking.
    const liked = m[1]!.split(/\b(?:but|so|because)\b|[,;.]\s*(?:and\s+)?(?=(?:my|our|i|i'm|i'd|i'll|we|we're)\b)|\s+and\s+(?=(?:my|our|i|i'm|i'd|we|we're)\b)/i)[0]!;
    const items = splitItems(liked).filter((item) => !/\$|\d|\b(?:budget|max(?:imum)?)\b/i.test(item) && item.toLowerCase() !== visited?.toLowerCase());
    if (items.length) push({ field: 'preferences', value: items });
  }
  const musts: string[] = [];
  if ((m = /\b(?:must(?:[- ]do| see| have| include)|have to (?:do|see)|need to (?:do|see)|can'?t miss|dealbreaker)\s*:?\s+(.+)$/i.exec(s))) musts.push(...splitItems(m[1]!));
  if ((m = /\bi(?:'m| am)\s+(vegetarian|vegan|gluten[- ]free|lactose intolerant|pescatarian)\b/i.exec(s))) musts.push(m[1]!.toLowerCase());
  if ((m = /\b(halal|kosher|wheelchair|step[- ]free)\b/i.exec(s)) && !/\b(?:don'?t|do not|doesn'?t|no|not|without|n't)\b[^.!?]{0,25}\b(?:halal|kosher|wheelchair|step[- ]free)\b/i.test(s)) musts.push(m[1]!.toLowerCase());
  if (musts.length) push({ field: 'must_dos', value: [...new Set(musts)].slice(0, 10) });
}

/** Answers to the question we last asked this member: a bare "200", "2", "Chapel Hill". */
function pendingAnswer(text: string, reference: string, pending: ConstraintField): Extracted | null {
  const t = text.trim();
  const hedged = HEDGE.test(t);
  let m: RegExpExecArray | null;
  switch (pending) {
    case 'budget': {
      const bare = t.replace(new RegExp(HEDGE.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
      const cents = (m = BARE_AMOUNT.exec(bare)) ? parseDollarsToCents(m[1]!) : null;
      return cents === null ? null : { value: { field: 'budget', value: cents }, hedged };
    }
    case 'duration':
      return (m = /^(\d{1,2})\s*(?:nights?)?[.!]*$/i.exec(t)) && Number(m[1]) >= 1 && Number(m[1]) <= 30 ? { value: { field: 'duration', value: Number(m[1]) }, hedged } : null;
    case 'origin':
    case 'region': {
      // Only something that looks like a place: a few words, no pronouns/verbs ("Mason has a car for the trip" is not a destination).
      const place = t.replace(/[.!]+$/, '').replace(/^(?:(?:i'?m\s+)?(?:leaving\s+|coming\s+)?from\s+)+/i, '');   // "from Raleigh" is Raleigh
      const looksLikePlace = /^[A-Za-z][A-Za-z ,.'-]{1,40}$/.test(place) && place.split(/\s+/).length <= 4 && !NOT_A_PLACE.test(place) && !NOT_A_PLACE_ANSWER.test(place) && parseDateWindows(place, reference).length === 0;
      return looksLikePlace && !hedged ? { value: { field: pending, value: properCase(place) }, hedged } : null;
    }
    case 'preferences':
    case 'must_dos': {
      if (t.length > 200 || t.includes('?')) return null;
      // A question without its question mark, or a reaction ("everything looks good", "sounds great") is not something they like.
      if (/^(?:tell|ask|remind|nudge|ping|poke|text|message|start over|restart|reset)\b/i.test(t) || /^(?:lol|lmao|haha+|omg|wow|ha+)\b/i.test(t) || /^(?:how|what|when|where|why|who|which|can|could|do|does|did|is|are|will|would|should|any)\b/i.test(t) || /\b(?:looks?|sounds?|seems?|is|are)\s+(?:good|great|fine|perfect|right|correct|ok(?:ay)?|awesome)\b|^(?:ok(?:ay)?|sure|cool|great|perfect|nice|awesome|thanks|thank you|yes|yep|yeah|yup|no problem)[.!]*$/i.test(t)) return null;
      if (/^(?:none|nothing|no)[.!]*$/i.test(t)) return { value: { field: pending, value: pending === 'preferences' ? ['no preference'] : [] }, hedged: false };
      // "I want to have fun and learn about historical museums" is about historical museums, not the whole sentence.
      let core = t.replace(/^(?:i|we)(?:\s+really)?\s+(?:want to|wanna|would like to|'d like to|like to|like|love|enjoy|prefer|am into|are into|'m into|'re into)\s+/i, '');
      for (let i = 0; i < 3; i += 1) core = core.replace(/^(?:have fun(?:\s+and)?|have a good time(?:\s+and)?|just\s+|learn(?:ing)?(?:\s+about)?|see|visit|do|try|explore|check out|go to|going to)\s+/i, '');
      const items = splitItems(core.trim() === '' ? t : core);
      return items.length ? { value: { field: pending, value: items }, hedged } : null;
    }
    default:
      return null;
  }
}

/**
 * Deterministic extraction of constraints from one message (no AI, no side effects). Works per sentence so
 * "I can do $200. Maybe Oct 17-19?" keeps the plain budget and flags the tentative dates. The caller decides what
 * a hedged value means for each field.
 */
export function extractConstraints(text: string, reference: string, pending?: ConstraintField): Extracted[] {
  return extractWithCoverage(text, reference, pending).items;
}

/** Small talk that needs no interpretation (and therefore no model call). */
export const TRIVIAL = /^(?:(?:hi|hey|hello|hiya|howdy|hola|sup|wassup|what'?s up|whats up|what up|good (?:morning|afternoon|evening|night)|gm|there|everyone|everybody|all|guys|y'?all|team|hmm+|hm+|um+|uh+|test(?:ing)?|yo|thanks?|thank you|thx|ty|so much|very much|a lot|a ton|appreciate (?:it|that)|you(?:'re| are) (?:the best|awesome|great|amazing)|[a-z']+ (?:is|was|are) (?:the best|awesome|great|amazing|a legend)|the best|see (?:you|ya|u)(?: (?:there|soon|later|then))?|have fun|can'?t wait|so excited|excited|ok(?:ay)?|cool|nice|great|awesome|perfect|sweet|lol|haha+|lmao|got it|sounds good|no worries|np|please|pls|sorry|oops)\b[\s,.!?:)-]*)+$/i;

export interface Coverage {
  items: Extracted[];
  /** Sentences the rules did not recognize at all (minus small talk). These are what gets handed to the model. */
  unmatched: string[];
}

/**
 * Like extractConstraints, but also reports which sentences the rules did NOT understand, so the caller can hand
 * exactly those to the language model instead of dropping them or guessing.
 */
export function extractWithCoverage(text: string, reference: string, pending?: ConstraintField): Coverage {
  const out: Extracted[] = [];
  const unmatched: string[] = [];
  const sentences = text.split(/(?<=[!?\n;])\s+|(?<=[a-z0-9)])\.\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const before = out.length;
    extractSentence(s, reference, pending, out);
    if (out.length === before) {
      if (!TRIVIAL.test(s) && s.replace(/[^A-Za-z0-9]/g, '').length >= 3) unmatched.push(s);
      continue;
    }
    // Understood overall, but a long extra clause ("... and honestly anywhere with a good brewery works") may not be.
    for (const clause of s.split(/,|;|\band\b|\bbut\b|\balso\b|\bplus\b/i).map((c) => c.trim())) {
      if (clause.split(/\s+/).length < 4 || TRIVIAL.test(clause)) continue;
      const probe: Extracted[] = [];
      extractSentence(clause, reference, pending, probe);
      if (probe.length === 0) unmatched.push(clause);
    }
  }
  // A place named on its own in a list ("leaving from Chapel Hill, 2 nights, Washington DC, I have a car") is where they want to go.
  if (!out.some((e) => e.value.field === 'region')) {
    const clauses = text.split(',').map((c) => c.trim().replace(/[.!]+$/, ''));
    if (clauses.length >= 3) {
      const origin = out.find((e) => e.value.field === 'origin')?.value;
      const named = clauses.find((c) => c.length > 2 && !(origin && origin.field === 'origin' && c.toLowerCase() === origin.value.toLowerCase())
        && (/^(?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,3}$/.test(c) || /^(?:the\s+)?(?:[a-z]+\s+){0,2}(?:mountains?|coast|beach(?:es)?|lakes?|shore|countryside)$/i.test(c))
        && !/^(?:I|We|My|Our)\b/.test(c) && !NOT_A_PLACE.test(c) && !NOT_A_PLACE_ANSWER.test(c) && parseDateWindows(c, reference).length === 0);
      if (named) out.push({ value: { field: 'region', value: named.replace(/^the\s+/i, '') }, hedged: false });
    }
  }
  if (out.length === 0 && pending) {
    const a = pendingAnswer(text, reference, pending);
    if (a) { out.push(a); unmatched.length = 0; }
  }
  // A destination and a drive limit in separate sentences describe the same region: keep both.
  const regions = out.filter((e) => e.value.field === 'region');
  if (regions.length > 1) {
    const [first, ...rest] = regions as Array<Extracted & { value: { field: 'region'; value: string; maxTravelMinutes?: number } }>;
    const limit = rest.map((r) => r.value.maxTravelMinutes).find((n) => n !== undefined);
    if (first!.value.maxTravelMinutes === undefined && limit !== undefined) first!.value.maxTravelMinutes = limit;
  }
  // Dates said in separate sentences ("free Nov 14-16. Also Nov 21-23") are all kept.
  const avail = out.filter((e) => e.value.field === 'availability' && !e.negative && !e.hedged);   // a tentative window never joins a firm one
  if (avail.length > 1) {
    const first = avail[0]! as Extracted & { value: { field: 'availability'; value: Array<{ start: string; end: string }> } };
    for (const more of avail.slice(1) as Array<typeof first>) {
      first.value.value = [...first.value.value, ...more.value.value].filter((w, i, all) => all.findIndex((x) => x.start === w.start && x.end === w.end) === i).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6);
    }
  }
  // One value per field per message: keep the first.
  const seen = new Set<string>();
  return { items: out.filter((e) => !seen.has(e.value.field) && !!seen.add(e.value.field)), unmatched };
}
