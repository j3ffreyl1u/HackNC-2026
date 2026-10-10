# Integration notes

`src/contracts/index.ts` is the shared contract source for application wiring. It matches the `InboundMessage`, `Command`, `OutboundMessage`, domain result, household snapshot/config, conversation context and service methods in `AGENTS.md`. Finance currently imports temporary local declarations; Finance should replace those with type-only imports from this module in its next owned change.

`src/app/events.ts` composes the conversation and finance interfaces: claim inbound event, parse once, execute commands or enqueue replies, complete the event, then drain the persisted outbox and record provider IDs. Provider clients are injected; no provider SDK is assumed here.

The HTTP server exposes the household snapshot and a demo-only local cycle route. It binds to loopback in `main.ts`. The browser receives no banking credentials or private messages. Mock integration is the only implemented startup mode in this scaffold.
