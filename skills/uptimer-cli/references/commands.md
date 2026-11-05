# Uptimer CLI commands and payloads

Use these examples for payload field names and edge cases. `uptimer --help` carries the same examples inline. Replace example hostnames, channel IDs, and monitor IDs with values for the selected instance.

## Command map

| Resource                 | Commands                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `monitors`               | `list [--limit N]`, `create --file F`, `update ID --file F`, `delete ID`, `pause ID`, `resume ID` |
| `monitors groups`        | `reorder --file F`, `assign --file F`                                                             |
| `notification-channels`  | `list [--limit N]`, `create --file F`, `update ID --file F`, `delete ID`                          |
| `status-pages`           | `list`, `create --file F`, `update ID --file F`, `delete ID`                                      |
| `settings`               | `get`, `update --file F`                                                                          |
| `settings uptime-rating` | `get`, `update --file F`                                                                          |

`F` is a JSON file path, or `-` for stdin. IDs are positive safe integers. Monitor/channel limits are 1–200, default 50; status-page lists have no `--limit` option. No command implements per-ID GET, pagination, export, or automatic synchronization.

## Monitors

### HTTP monitor

Save as `http-monitor.json` and invoke `uptimer monitors create --file http-monitor.json`:

```json
{
  "name": "API Health",
  "type": "http",
  "target": "https://api.example.com/health",
  "interval_sec": 60,
  "timeout_ms": 5000,
  "http_method": "GET",
  "expected_status_json": [200]
}
```

The API uses `target`, `interval_sec`, `timeout_ms`, and `http_method`, rather than `url`, `interval_seconds`, `timeout_seconds`, or `method`. `http_headers_json` is an object of header strings; its contents may contain credentials and must stay out of shared output.

### TCP monitor

Save as `tcp-monitor.json` and invoke `uptimer monitors create --file tcp-monitor.json`:

```json
{
  "name": "TLS Port",
  "type": "tcp",
  "target": "example.com:443",
  "interval_sec": 60,
  "timeout_ms": 5000
}
```

The target includes the host and port in one string. HTTP-only fields are invalid for TCP monitors.

### Patch a monitor

Save as `monitor-patch.json`, replacing ID 42 with an ID returned by the instance:

```json
{
  "show_on_status_page": false,
  "http_headers_json": null
}
```

```sh
uptimer monitors update 42 --file monitor-patch.json
uptimer monitors pause 42
uptimer monitors resume 42
```

PATCH omission preserves existing fields. `null` clears supported nullable fields such as `http_headers_json`, `http_body`, or `response_keyword`; it does not make every field nullable.

### Groups

Save as `group-assignment.json`, replacing 42 with an actual monitor ID:

```json
{
  "monitor_ids": [42],
  "group_name": "Core"
}
```

Use `uptimer monitors groups assign --file group-assignment.json`. Group reorder input is an object with a `groups` array; each entry has `group_name` (a string or null) and `group_sort_order` (an integer). It is not a `name`/`sort_order` pair.

`group_name: null` unassigns the group, and the CLI accepts that response.

## Notification channels

Notification input uses `config_json`, even though it is a JSON object. The channel's `type` is `webhook` for both custom webhooks and the Telegram preset.

### Custom webhook

Save as `webhook-channel.json` and use `uptimer notification-channels create --file webhook-channel.json`:

```json
{
  "name": "Operations Webhook",
  "type": "webhook",
  "config_json": {
    "preset": "custom",
    "url": "https://hooks.example.com/uptimer",
    "method": "POST",
    "payload_type": "json",
    "payload_template": {
      "text": "{{message}}"
    }
  }
}
```

A real webhook URL can contain a credential. CLI output masks `config_json.url`, `config_json.headers`, and `config_json.payload_template`, but input files and logs outside the CLI are still yours to protect.

### Telegram

Save as `telegram-channel.json` and use the same notification-channel create command with that file:

```json
{
  "name": "Telegram Alerts",
  "type": "webhook",
  "config_json": {
    "preset": "telegram",
    "chat_id": "@status_channel",
    "bot_token_secret_ref": "UPTIMER_TELEGRAM_BOT_TOKEN"
  }
}
```

The referenced secret binding must already exist on the Worker. The CLI does not create secrets. If an administrator explicitly chooses the direct-token input instead, inject the value privately as `config_json.bot_token` and omit `bot_token_secret_ref`; creation accepts exactly one credential source. Channel PATCH payloads do not include `type`.

## Status pages

Save as `status-page.json` and invoke `uptimer status-pages create --file status-page.json`:

```json
{
  "slug": "public-status",
  "name": "Public Status",
  "title": "Service status",
  "description": "Service availability",
  "is_public": true,
  "monitor_ids": []
}
```

Creation requires `name`, `slug`, and `title`. Replace the empty membership list with known monitor IDs to display those monitors. For updates, omitted `monitor_ids` preserves membership, while `[]` unlinks all monitors. Optional `logo_url` and `custom_hostname` accept `null` to clear their value. Setting `custom_hostname` records the application's routing hostname; it does not provision DNS or a Cloudflare domain.

Deleting a linked page can return HTTP 409. Explain its existing links and act only within the authorized request.

## Global settings

Save as `settings-patch.json` and invoke `uptimer settings update --file settings-patch.json`:

```json
{
  "site_timezone": "Asia/Shanghai",
  "site_locale": "en",
  "retention_check_results_days": 7
}
```

Global settings have no create/delete commands. Branding belongs to status pages; `site_title` is not a settings input. Use `retention_check_results_days`, not `retention_days`.

For the separate uptime-rating command, save as `uptime-rating.json`:

```json
{
  "uptime_rating_level": 4
}
```

```sh
uptimer settings uptime-rating get
uptimer settings uptime-rating update --file uptime-rating.json
```

The level is an integer from 1 to 5. Query settings again after an update to verify the saved values.

## Schema references

For a field not covered here, consult the matching deployed API version or these upstream schemas rather than inventing an option:

- [Monitors and groups](https://github.com/nexttylabs/Uptimer/blob/master/apps/worker/src/schemas/monitors.ts)
- [Notification channels](https://github.com/nexttylabs/Uptimer/blob/master/apps/worker/src/schemas/notification-channels.ts)
- [Status pages](https://github.com/nexttylabs/Uptimer/blob/master/apps/worker/src/schemas/status-pages.ts)
- [Settings](https://github.com/nexttylabs/Uptimer/blob/master/apps/worker/src/schemas/settings.ts)
