/** Placeholder error for contract stubs; every use names its workstream in docs/calendar.md. Delete once none are left. */
export const notImplemented = (what: string, workstream: string): Error =>
  new Error(`Not implemented yet: ${what} (calendar workstream ${workstream}, docs/calendar.md)`);
