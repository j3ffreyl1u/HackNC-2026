# Run on A's branch after applying C's handoff commit.
$workspace = Split-Path -Parent $PSScriptRoot
$sharedExports = @'
/** Shared conversation contracts published by C. */
export type {
  InboundMessage, ConstraintField, OutboundMessage,
  DateWindow, ConstraintValue, PendingConfirmation, SendResult, TripMember, TripConfig,
  ActionableItem, TripConversationContext,
  ChatConstraintUpdate as ConstraintUpdate,
  ChatTripAction as TripAction,
  ChatTripCommand as TripCommand,
  ChatParseResult as ParseResult,
  ChatConversationService as ConversationService,
  ChatTopology as ChatMode,
} from '../contracts/index.js';
'@
[System.IO.File]::WriteAllText((Join-Path $workspace 'src/conversation/contracts-local.ts'), $sharedExports + "`n", [System.Text.UTF8Encoding]::new($false))
$spectrumPath = Join-Path $workspace 'src/conversation/spectrum.ts'
$spectrum = [System.IO.File]::ReadAllText($spectrumPath)
$spectrum = $spectrum.Replace('CHAT_MODE=photon requires PROJECT_ID and PROJECT_SECRET', 'CHAT_MODE=photon requires SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET')
[System.IO.File]::WriteAllText($spectrumPath, $spectrum, [System.Text.UTF8Encoding]::new($false))
