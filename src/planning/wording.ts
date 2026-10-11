/**
 * The questions the bot asks, in one place. To change what it asks or how it sounds, edit the text here: the
 * logic that decides WHEN and WHO to ask lives in readiness.ts and questions.ts and does not need to change.
 *
 * Keep each one short, casual and a single question, like a friend organizing a trip in a group chat.
 */
export const Q = {
  // The basics everyone shares
  origin: 'Where are you all leaving from?',
  originConfirm: 'Just to confirm: is that where you will all be leaving from?',
  duration: 'How many nights are you thinking?',
  durationConfirm: 'Just to confirm: how many nights is the trip?',
  region: 'Got a place in mind, or how far are you up for driving?',
  transport: 'Does anyone have a car we can take?',
  vehicle: 'I can only plan road trips for now, so I need a car. Could anyone drive or borrow one?',
  // Each person's own
  dates: 'Which dates could you do for the trip?',
  datesChanged: 'You mentioned some different dates. Are your usable dates still the ones you gave before, or have they changed?',
  budget: "What's your maximum total for this trip, including food and travel?",
  preferences: 'What would you like out of this trip? "No preference" is a fine answer.',
  mustHaveConfirm: 'You mentioned something that sounds like a must-have. Is it a firm requirement for the trip?',
} as const;
