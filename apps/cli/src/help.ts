const example = (value: Record<string, unknown>): string =>
  JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

const HTTP_MONITOR = example({
  name: 'Production API',
  type: 'http',
  target: 'https://api.example.com/health',
  interval_sec: 60,
  timeout_ms: 5000,
  http_method: 'GET',
  expected_status_json: [200],
});

const TCP_MONITOR = example({
  name: 'Database Port',
  type: 'tcp',
  target: 'db.example.com:5432',
  interval_sec: 60,
  timeout_ms: 5000,
});

const WEBHOOK_CHANNEL = example({
  name: 'Operations Webhook',
  type: 'webhook',
  config_json: {
    preset: 'custom',
    url: 'https://hooks.example.com/uptimer',
    method: 'POST',
    payload_type: 'json',
    payload_template: { text: '{{message}}' },
  },
});

const TELEGRAM_CHANNEL = example({
  name: 'Telegram Alerts',
  type: 'webhook',
  config_json: {
    preset: 'telegram',
    chat_id: '@status_channel',
    bot_token_secret_ref: 'UPTIMER_TELEGRAM_BOT_TOKEN',
  },
});

const STATUS_PAGE = example({
  slug: 'public-status',
  name: 'Public Status',
  title: 'Service status',
  is_public: true,
  monitor_ids: [1, 2],
});

const SETTINGS = example({
  site_timezone: 'Asia/Shanghai',
  site_locale: 'en',
  retention_check_results_days: 7,
});

const UPTIME_RATING = example({ uptime_rating_level: 4 });

export function getHelpText(): string {
  return `Uptimer Agent Configuration CLI (uptimer-cli)

A CLI for coding agents and terminal automation to manage Uptimer
configuration via existing Admin APIs.

USAGE:
  uptimer <resource> <command> [arguments...] [options...]

ENVIRONMENT VARIABLES:
  UPTIMER_URL          Instance origin URL (e.g. https://uptimer.workers.dev or http://localhost:8787).
                       HTTPS required for remote origins. HTTP only allowed on loopback (localhost, 127.0.0.1, [::1]).
                       Must be a root path without query, fragment, or userinfo.
  UPTIMER_ADMIN_TOKEN  Bearer token for Admin API authentication.

COMMANDS:
  monitors
    list [--limit N]                   List monitors (limit 1-200, default 50).
    create --file <file|->             Create a new monitor from JSON payload.
    update <id> --file <file|->        Update an existing monitor (PATCH semantics).
    delete <id>                        Delete a monitor by ID.
    pause <id>                         Pause monitoring for a monitor.
    resume <id>                        Resume monitoring for a monitor.
  monitors groups
    reorder --file <file|->            Reorder monitor groups.
    assign --file <file|->             Assign monitors to a group.

  notification-channels
    list [--limit N]                   List notification channels (limit 1-200, default 50).
    create --file <file|->             Create a notification channel.
    update <id> --file <file|->        Update a notification channel (PATCH semantics).
    delete <id>                        Delete a notification channel by ID.

  status-pages
    list                               List all status pages.
    create --file <file|->             Create a status page.
    update <id> --file <file|->        Update a status page (PATCH semantics).
    delete <id>                        Delete a status page by ID.

  settings
    get                                Retrieve current global settings.
    update --file <file|->             Update global settings (PATCH semantics).
  settings uptime-rating
    get                                Retrieve uptime rating level (1-5).
    update --file <file|->             Update uptime rating level (PUT).

  skill
    install [--dir <path>] [--force]   Install the agent skill locally (default dir: ./skills).

OPTIONS:
  --file <path|->     Path to a UTF-8 JSON file containing the payload object, or '-' for stdin.
  --limit <number>    Max items to return for list operations (1-200, default 50).
  --dir <path>        Base directory for "skill install"; the skill is written to <path>/uptimer-cli.
  --force             Replace an existing "skill install" target.
  --help, -h          Show this help text without requiring credentials.

PAYLOAD FORMAT:
  All payload inputs via --file must be valid UTF-8 JSON objects.
  PATCH update operations preserve field values; explicit null, false, 0, [], and omissions are respected.
  Each option may be given at most once.

BOUNDED LIST INVENTORY:
  List commands return up to --limit items (1-200, default 50).
  These listings are explicitly bounded slices and do not claim to represent a complete inventory.

PAYLOAD EXAMPLES:
  HTTP Monitor:
${HTTP_MONITOR}

  TCP Monitor (target is host:port):
${TCP_MONITOR}

  Custom Webhook Channel:
${WEBHOOK_CHANNEL}

  Telegram Channel (type stays "webhook"):
${TELEGRAM_CHANNEL}

  Status Page:
${STATUS_PAGE}

  Global Settings:
${SETTINGS}

  Uptime Rating:
${UPTIME_RATING}

EXIT CODES & OUTPUT:
  0: Success. Single JSON value printed to stdout followed by newline. (Help is the only human text).
  1: Transport, HTTP, deadline, redirect, or response-contract failure. Emits JSON error envelope to stderr.
  2: Usage, input, local validation, or environment configuration failure. Emits JSON error envelope to stderr.

SECURITY & REDACTION:
  Output is a sanitized/redacted management view: credentials, header/body blobs, and
  notification channel URLs, headers, and payload templates are replaced with [REDACTED].
  Returned configuration is administrative data and should not be published.
`;
}

// Payload examples are contract surfaces; keep them valid against the server schemas.
export const HELP_PAYLOAD_EXAMPLES: Record<string, string> = {
  httpMonitor: HTTP_MONITOR,
  tcpMonitor: TCP_MONITOR,
  webhookChannel: WEBHOOK_CHANNEL,
  telegramChannel: TELEGRAM_CHANNEL,
  statusPage: STATUS_PAGE,
  settings: SETTINGS,
  uptimeRating: UPTIME_RATING,
};
