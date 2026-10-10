# Demo limitations

The web page and routes are scaffolding around FinanceService. Some finance state transitions are still under implementation on the finance branch. There is no live chat or intent provider wired into startup here, and no real or simulated transfer should be represented as complete unless reconciliation confirms it. MockBank is process-local, so its balances do not survive restart.
