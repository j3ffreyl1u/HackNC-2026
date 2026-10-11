# Devpost draft and two-minute walkthrough

## Project description

Weekend, together is an iMessage trip-planning agent that helps friends turn a group conversation into a weekend everyone can attend and afford. It gathers private constraints, compares plans, and requires every participant to accept the same revision. Changing a material constraint cancels the old approvals.

The read-only companion page brings the plan into a Frutiger Aero landscape: luminous skies, reflective water, glass bubbles and glossy desktop controls. Outdoor stops and recorded driving comparisons make the nature connection visible in the actual plan. Unknown drive legs stay unknown; driving home is excluded, and the app does not estimate emissions.

The optional Capital One Nessie sandbox tracker reads each friend's own simulated account, adds up what each person covered in shared categories (lodging, gas, activities), compares it with the approved plan, and shows who would owe whom, so nobody splits a bill on the spot. The agent only reads transactions. A separate, explicitly simulated script provisions demo objects and transactions. All funding is simulated, and nothing is booked or paid with real money.

## Track descriptions to adapt in Devpost

- Frutiger Aero Tech: nature-oriented trip planning with a deliberately glossy blue/green interface, visible outdoor stops, and comparisons of recorded driving time.
- Capital One / Nessie: read-only "who covered what" tracking across one simulated Nessie account per friend, plan-versus-actual spending by category, and a settle-up calculation (the bot never moves money), plus an isolated simulator. Include a live sandbox screenshot only after combined verification.
- Photon: Spectrum-powered iMessage conversation. Current coordinated live demonstrations are direct-message mode; do not claim verified group delivery.
- Gemini: language interpretation and the private grounded research display. State exactly which mode the recorded demonstration uses. Mock plans and prices are explicitly synthetic.

These are submission drafts, not a confirmation of track eligibility. Choose the organizer's actual track names in Devpost. The Frutiger Aero prizes supplied by the organizer are Ocean Mechanical Keyboard and JBL Go 5 Speaker for first; Jellyfish Lamp, Aqua Mouse and Ocean Lamp for second. Prizes are event details, not app features.

## Two-minute video outline

0:00–0:15: State the problem: coordinating dates, individual limits and agreement among friends in chat.

0:15–0:45: Show a multi-fact DM and the bot gathering only the remaining details. Keep phone numbers, keys and private budget values off screen unless every participant explicitly consents.

0:45–1:10: Show two synthetic options, the Aero page, outdoor stops and the recorded driving comparison. Clearly label fixture data.

1:10–1:30: Show a changed constraint invalidating prior acceptance, then all participants accepting the current revision.

1:30–1:50: Show the sandbox fund's collected/needed, completed spending and remaining amount. Mention the bot has no write path. Use an offline labeled fund view if the live sandbox has not been verified; never present invented data as a provider response.

1:50–2:00: Summarize: friends agree in chat, the page displays the shared plan, outdoor choices are visible, and the fund is simulated.

Jeffrey coordinates the only Photon listener, records the video, checks repository visibility and submits. The local backup `data/backup-combined-demo.txt` is a successful offline transcript, not a video. No submission or external publication was performed by C.
