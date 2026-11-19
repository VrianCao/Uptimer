# Notification System

English | [中文](notifications.zh-CN.md)

Uptimer's notification system sends webhook alerts when monitor states change or incidents are created/updated. This document covers event types, channel configuration, payload construction, template variables, webhook signing, and troubleshooting.

## Overview

The notification system:

- Sends alerts on critical state changes (UP->DOWN, DOWN->UP) and incident lifecycle events
- Supports per-channel configuration: HTTP method, timeout, headers, payload format, templates, event filtering, and optional signing
- Guarantees idempotent delivery: each event is sent to each channel at most once (via `notification_deliveries` unique constraint)

### Flow

1. System produces an event (eventType + eventKey + payload)
2. Find all active webhook channels
3. For each channel:
   - Filter by `enabled_events`
   - Claim a delivery slot in `notification_deliveries` (idempotent)
   - Render templates (message, payload, headers)
   - Build URL/body based on `payload_type`
   - Send via `fetch` (no-store + timeout)
   - Record delivery result (success/failed)

## Event Types

| Event                 | Description                                    |
| --------------------- | ---------------------------------------------- |
| `monitor.down`        | Monitor transitioned to DOWN state             |
| `monitor.up`          | Monitor transitioned to UP state               |
| `incident.created`    | New incident created                           |
| `incident.updated`    | Incident received an update                    |
| `incident.resolved`   | Incident marked as resolved                    |
| `maintenance.started` | Maintenance window started                     |
| `maintenance.ended`   | Maintenance window ended                       |
| `test.ping`           | Test button (always allowed, even if filtered) |

## Event Keys (Idempotency)

Each event has a unique `event_key` used for deduplication:

- Monitor: `monitor:<monitorId>:down|up:<timestamp>`
- Incident: `incident:<incidentId>:created|resolved:<...>` or `incident:<incidentId>:update:<updateId>`
- Test: `test:webhook:<channelId>:<now>`

> If you click the test button twice within the same second, the second request may be deduplicated. Wait 1 second and retry.

## Admin API

| Method | Endpoint                                       | Description              |
| ------ | ---------------------------------------------- | ------------------------ |
| GET    | `/api/v1/admin/notification-channels`          | List all channels        |
| POST   | `/api/v1/admin/notification-channels`          | Create a channel         |
| PATCH  | `/api/v1/admin/notification-channels/:id`      | Update a channel         |
| DELETE | `/api/v1/admin/notification-channels/:id`      | Delete a channel         |
| POST   | `/api/v1/admin/notification-channels/:id/test` | Send a test notification |

The test endpoint generates a `test.ping` event with sample data and returns the delivery record for debugging.

## Channel Configuration

Webhook channel `config_json` fields (validated by Zod):

| Field              | Required | Default | Description                                                                            |
| ------------------ | -------- | ------- | -------------------------------------------------------------------------------------- |
| `url`              | Yes      | —       | Webhook URL (`http://` or `https://` only)                                             |
| `method`           | No       | `POST`  | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`                           |
| `headers`          | No       | —       | Custom headers object `{ "Header-Name": "value" }`. Values support template rendering. |
| `timeout_ms`       | No       | —       | Request timeout (1–60000 ms)                                                           |
| `payload_type`     | No       | `json`  | `json`, `param`, or `x-www-form-urlencoded`                                            |
| `message_template` | No       | —       | Template for the `message` variable                                                    |
| `payload_template` | No       | —       | Custom payload template (see below)                                                    |
| `enabled_events`   | No       | —       | Event whitelist array. Empty = all events. `test.ping` always passes.                  |
| `signing`          | No       | —       | `{ enabled: boolean, secret_ref: string }` — HMAC-SHA256 signing                       |

## WPush Preset

WPush can be configured from the notification channel form without writing a custom webhook template.

The preset sends form-encoded requests to `https://api.wpush.cn/api/v1/send` and supports:

- an API key encrypted in D1 using `ADMIN_TOKEN`, or a Worker Secret reference
- one or more WPush channel values such as `wechat,app`
- optional WPush channel instance `option`
- optional message URL
- timeout, title template, message template, and event filtering

Example configuration using a Worker Secret:

```json
{
  "preset": "wpush",
  "api_key_secret_ref": "UPTIMER_WPUSH_API_KEY",
  "channel": "wechat",
  "option": "ops"
}
```

Store the actual API key as the Worker Secret named by `api_key_secret_ref`. When a key is entered directly in the Admin UI, Uptimer encrypts it before storing the channel configuration and never returns the ciphertext through the Admin API.

## Payload Modes

### Mode 1: Default JSON (no template)

When `payload_type = json` and no `payload_template` is set, Uptimer sends the full system payload:

```json
{
  "event": "monitor.down",
  "event_id": "monitor:1:down:1700000000",
  "timestamp": 1700000000,
  "monitor": { "id": 1, "name": "..." },
  "state": { "status": "down", "http_status": 500 }
}
```

All fields are present, and numeric types are preserved.

### Mode 2: Custom template

When `payload_template` is set, the rendered template becomes the payload. System fields are **not** auto-injected — include them explicitly:

```json
{
  "event": "{{event}}",
  "event_id": "{{event_id}}",
  "text": "{{message}}",
  "monitor_name": "{{monitor.name}}"
}
```

### Mode 3: Minimal flat payload (non-JSON, no template)

When `payload_type` is `param` or `x-www-form-urlencoded` and no template is set:

```
event, event_id, timestamp, message
```

## Template System

Templates can be used in `message_template`, all string fields in `payload_template`, and all header values.

### Syntax

- `{{path.to.field}}` — Dot-notation path lookup
- `{{checks[0].latency_ms}}` — Array index access
- `$MSG` — Alias for the rendered `message`

### Built-in Variables

| Variable          | Type   | Description                                             |
| ----------------- | ------ | ------------------------------------------------------- |
| `event`           | string | Event type                                              |
| `event_id`        | string | Idempotency key                                         |
| `timestamp`       | number | Unix seconds                                            |
| `channel.id`      | number | Channel ID                                              |
| `channel.name`    | string | Channel name                                            |
| `monitor.*`       | object | Monitor fields (if applicable)                          |
| `state.*`         | object | Monitor state fields (if applicable)                    |
| `default_message` | string | System-generated default message                        |
| `message`         | string | Final message (rendered from `message_template` if set) |

> The raw system payload is spread into top-level variables. If the payload contains `monitor`, you can access `{{monitor.name}}` directly.

### Missing Fields

If a path doesn't exist, the template resolves to an empty string.

### Security

Template paths reject access to `__proto__`, `prototype`, and `constructor` to prevent prototype pollution.

### Type Caveat

Template substitution produces strings. `"id": "{{monitor.id}}"` becomes `"id": "12"` (string), not `12` (number). If you need numeric types, use the default payload (no template) or convert on the receiving end.

## Payload Type Details

### `json`

- Body: `JSON.stringify(payload)`
- Default header: `Content-Type: application/json` (no `charset=utf-8` appended for compatibility)
- Custom `Content-Type` in `headers` takes precedence

### `param`

- Payload (must be a flat object) is converted to query parameters appended to the URL
- No request body

### `x-www-form-urlencoded`

- POST/PUT/PATCH/DELETE: body as `URLSearchParams`, header `Content-Type: application/x-www-form-urlencoded`
- GET/HEAD: falls back to query parameters (no body)

## Webhook Signing

When `signing.enabled = true`, Uptimer adds two headers to each request:

```
X-Uptimer-Timestamp: <unix_seconds>
X-Uptimer-Signature: sha256=<hmac_hex>
```

**Signature computation**:

- `message = "<timestamp>.<rawBody>"`
- `hmac = HMAC-SHA256(secret, message)` as hex

The secret is read from the Worker environment variable specified by `secret_ref`. It is never stored in the database.

### Verification Example (Node.js)

```js
import crypto from 'node:crypto';

function verify(req, secret) {
  const ts = req.headers['x-uptimer-timestamp'];
  const sig = req.headers['x-uptimer-signature']; // "sha256=..."
  const rawBody = req.rawBody ?? '';
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return sig === `sha256=${expected}`;
}
```

## Configuration Examples

### Discord / Slack / ntfy via Apprise

```json
{
  "url": "https://your-apprise-endpoint/notify",
  "method": "POST",
  "payload_type": "json",
  "message_template": "[{{event}}] {{monitor.name}} => {{state.status}}\n$MSG",
  "payload_template": {
    "urls": "ntfys://your-ntfy-topic",
    "body": "{{message}}"
  }
}
```

### Query Parameter Webhook (GET)

```json
{
  "url": "https://example.com/webhook",
  "method": "GET",
  "payload_type": "param",
  "payload_template": {
    "event": "{{event}}",
    "monitor": "{{monitor.name}}",
    "msg": "{{message}}"
  }
}
```

### Form-encoded Webhook (POST)

```json
{
  "url": "https://example.com/webhook",
  "method": "POST",
  "payload_type": "x-www-form-urlencoded",
  "payload_template": {
    "event": "{{event}}",
    "msg": "{{message}}"
  }
}
```

## Troubleshooting

### Check the Test API Response

Use the admin dashboard test button or call the API directly:

```
POST /api/v1/admin/notification-channels/:id/test
```

The response includes:

- `delivery.status` — `success` or `failed`
- `delivery.http_status` — HTTP status code (may be null on network errors)
- `delivery.error` — Error description

**Common errors**:

- `HTTP 400/415`: Receiver rejects the content-type or body structure
- `Timeout after XXXXms`: Receiver is slow or unreachable
- `Signing secret not configured: XXX`: Signing enabled but the referenced secret is missing

### Common "Looks Right But Doesn't Work" Issues

| Symptom                                  | Cause                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Receiver gets wrong fields               | `payload_template` field names don't match what the receiver expects                      |
| Content-Type rejected                    | Some receivers require exact `application/json` — don't override headers unless necessary |
| Real events not delivered                | `enabled_events` whitelist is active but doesn't include the event type                   |
| Channel appears active but no deliveries | `is_active = false` on the channel                                                        |
| Duplicate clicks do nothing              | Idempotent deduplication — same `event_key` within 1 second is skipped                    |

### Query Delivery Records

Check recent deliveries in your local D1:

```bash
wrangler d1 execute uptimer --local \
  --command="SELECT * FROM notification_deliveries ORDER BY created_at DESC LIMIT 20;"
```

## Known Limitations

- Built-in presets currently include Telegram and WPush; email is not built in
- Template substitution always produces strings (see Type Caveat above)
- `payload_template` JSON depth is capped at 32 levels

## Source Code Reference

| Component        | File                                 |
| ---------------- | ------------------------------------ |
| Webhook dispatch | `apps/worker/src/notify/webhook.ts`  |
| Idempotent dedup | `apps/worker/src/notify/dedupe.ts`   |
| Template engine  | `apps/worker/src/notify/template.ts` |
| Config schema    | `packages/db/src/json.ts`            |
| Test endpoint    | `apps/worker/src/routes/admin.ts`    |
