// Imported first by the harness (before any server module) so the logger reads it at load time.
// Override with XAQ_LOG_LEVEL=info when debugging a failing E2E test.
process.env.XAQ_LOG_LEVEL ??= "error";

export {};
