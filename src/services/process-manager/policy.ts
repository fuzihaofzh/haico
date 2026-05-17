export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes with no output = stuck
export const FINAL_RESULT_KILL_DELAY_MS = 2 * 60 * 1000; // 2 minutes after Final Result = force kill
export const RESTART_COOLDOWN_MS = 0; // no cooldown; restart immediately when issues are assigned

export const CPU_STALE_THRESHOLD = 3; // 3 unchanged scans (= 15 min at 5-min interval) = stuck

// Codex-mini pricing (USD per token) used when Codex CLI does not report cost_usd.
export const CODEX_INPUT_PRICE = 1.50 / 1_000_000;
export const CODEX_OUTPUT_PRICE = 6.00 / 1_000_000;
export const CODEX_CACHED_PRICE = 0.375 / 1_000_000;

export const TOOL_INPUT_LOG_CHAR_LIMIT = 4000;
export const RESUME_MISSING_FILE_RE = /no such file or directory/i;
export const CLOSED_STDIN_SESSION_RE = /stdin is closed for this session|write_stdin failed/i;
export const PROMPT_ENV_MAX_CHARS = 16000;

