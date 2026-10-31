// Test preloader: inherited driver/tool routes must never reach real conversations.
// Fixtures explicitly install their own private routes after this has run.
for (const key of [
  "STILL_AGENT_DRIVER", "STILL_AGENT_EXECUTABLE", "STILL_AGENT_CATALOG",
  "STILL_TODO_MODULE", "STILL_TODO_SOCKET", "STILL_TODO_TOKEN", "STILL_TODO_PI_EXTENSION",
  "STILL_PROVIDER_RUNTIME",
]) delete process.env[key]
