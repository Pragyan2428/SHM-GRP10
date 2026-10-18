# Smart Structural Health Monitoring System

Electronics Product Development (EPD) · HS30223 · Group 10: Laksha Mandiye (2430039), Pragyan Singh (2430048), Pranjal Gurnule (2430049), Kamayani Sinha (2430160).

Wireless ESP32 sensor nodes measure **strain** (HX711 strain gauge amplifier), **vibration** (ADXL345 3-axis accelerometer) and **temperature** (DS18B20) at several points of a building. The readings are sent over Wi-Fi to the cloud, checked against configurable limits, scored for trend-based anomalies and stored in MongoDB. Problems become alerts on the dashboard, in the browser, by email, SMS and WhatsApp, and in Google Sheets. The public **About the project** page (`/about`) opens with a 3D model of the sensor node (three.js) that comes apart as you scroll, naming each part, and presents the problem, solution, hardware, comparison, timeline and team from the project presentation. The demo structure is a G+3 building with six simulated nodes from the foundation to the roof.

```
React (Vite) ──/api──► FastAPI ──► MongoDB
                         ▲  ▲
        simulator ───────┘  ├── POST /api/ingest   (ESP32 over HTTP, X-Device-Key)
                            └── MQTT shm/{node_id}/telemetry
                         │
                         ├─► Email (Gmail SMTP / Resend / SendGrid)   ├─► SMS + WhatsApp (Twilio)   └─► Google Sheets
```

Simulated, HTTP and MQTT data all go through the same pipeline (`backend/app/services/pipeline.py`). Switching from the simulator to real hardware needs no frontend changes.

## Quick start (development)

Requirements: Python 3.11+, Node 18+, and MongoDB (or `MONGO_URL=mongomock://` for an in-memory database).

```bash
# backend
cd backend
pip install -r requirements-dev.txt
cp .env.example .env        # then fill in JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, DEVICE_SHARED_KEY
uvicorn app.main:create_app --factory --env-file .env --port 8000

# frontend (second terminal)
cd frontend
npm install
npm run dev                  # http://localhost:5173, /api is proxied to :8000
```

For plain-http local development, set `COOKIE_SECURE=false`. The first start seeds the administrator from `ADMIN_EMAIL`/`ADMIN_PASSWORD`. That only happens while the users collection is empty. To get a demo viewer, also set `SEED_VIEWER_EMAIL`/`SEED_VIEWER_PASSWORD`.

**Intro and sign-in.** Opening or refreshing the site plays a short intro (a building draws itself, sensor nodes light up, then the page is revealed); click or press a key to skip it. Automated test browsers skip it unless `?intro` is in the URL. Login and Sign up share one card: switching slides the orange panel across while the forms slide and fade, and phones slide the forms sideways.

**Profile card.** After login, hovering the round avatar at the top right (tap it on a phone) opens a card with the account details (name, email, role, member since, last login) and everything the user can do: pick one of four built-in avatars, upload a photo (cropped to 256x256 in the browser; PNG, JPEG or WebP; stored privately per user), remove it, change the display name, change the password (the current one is required), jump to their pages, and log out. API: `PATCH /api/profile`, `POST /api/profile/password`, `PUT|DELETE|GET /api/profile/avatar`.

**User dashboard.** `/user` uses a dashboard layout: a dark sidebar (structure, node search, sections, account) and a light main area with the highest strain / vibration / temperature cards, a bar chart per sensor, an online-and-status summary, the readings-by-node table with live trend lines, and the building map.

**One login, two destinations.** Everyone signs in on the same **Login** page.
- **Administrators** go to the full dashboard at `/`.
- **Everyone else (viewers)** goes to `/user`, the user dashboard of live readings for every node. It refreshes every 5 s, and each value is coloured normal, near limit or over limit against its safe limit. Viewers who open any dashboard URL are sent back to `/user`.
- **New users** click **Sign up** on the Login page (`/signup`) and enter name, a **Gmail address** (`name@gmail.com`, shown as the grey placeholder) and password (at least 10 characters). Other email domains are rejected by the page and by the API. `SIGNUP_EMAIL_DOMAIN` changes the allowed domain, and the admin and seeded accounts are not affected. The account is always a viewer, and they're signed in straight away and taken to `/user`. Sign-up is limited to 10 new accounts per IP per hour, and `ALLOW_SIGNUP=false` turns it off. Administrators are only ever created by another admin on the **Users** page.

## Configuration

All secrets come from environment variables. None are hard-coded, and none are sent to the browser. `backend/.env.example` documents every variable:

| Area | Variables |
|---|---|
| Core | `MONGO_URL`, `DB_NAME`, `JWT_SECRET` (≥32 chars), `JWT_EXPIRE_MINUTES`, `FRONTEND_URL` (explicit CORS origins), `COOKIE_SECURE`, `COOKIE_SAMESITE`, `STRUCTURE_NAME` |
| Accounts | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `SEED_VIEWER_*`, `ALLOW_SIGNUP` (default `true`), `SIGNUP_EMAIL_DOMAIN` (default `gmail.com`), `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`, `LOGIN_LOCKOUT_MINUTES` |
| Telemetry | `SIMULATOR_ENABLED`, `SIMULATOR_INTERVAL_SECONDS` (5), `NODE_OFFLINE_SECONDS` (30), `READING_RETENTION_DAYS` (TTL index) |
| Devices | `DEVICE_SHARED_KEY` or `DEVICE_KEYS=ESP32-01:key1,ESP32-02:key2` |
| Email | `EMAIL_PROVIDER` (`smtp`/`resend`/`sendgrid`), `EMAIL_FROM`; SMTP: `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (587, or 465 for SSL), `SMTP_USERNAME`, `SMTP_PASSWORD`; Resend/SendGrid: `EMAIL_API_KEY` |
| SMS | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| WhatsApp | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (sandbox `+14155238886`) |
| Google Sheets | Apps Script (no key): `GOOGLE_SHEETS_WEBHOOK_URL`, `GOOGLE_SHEETS_WEBHOOK_SECRET`. Or a service account: `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE`, `GOOGLE_SHEETS_SPREADSHEET_ID`. Both use `GOOGLE_SHEETS_WORKSHEET` |
| MQTT | `MQTT_BROKER_URL`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TOPIC`, `MQTT_TLS` |

If an integration is missing its credentials, it shows as **Not configured** in the UI and everything else keeps working. If the core configuration is missing (`MONGO_URL`, `JWT_SECRET`), the API refuses to start and prints a clear error.

## Connecting ESP32 nodes

**HTTP**: `POST /api/ingest` with header `X-Device-Key`:

```json
{ "node_id": "ESP32-07", "location": "Ground floor - column C2", "timestamp": "2026-01-01T12:00:00Z",
  "readings": { "strain": 340.5, "vibration": 0.62, "temperature": 29.5 },
  "battery": 94, "rssi": -48 }
```

`readings` takes any of the three sensors: `strain` (με, HX711), `vibration` (g, ADXL345) and `temperature` (°C, DS18B20). The response contains the processed readings (status, anomaly score, …), any alerts created, and `alert_triggered`. Payloads are validated: unknown parameters (anything other than those three), implausible values and future timestamps are rejected. A retry with the same `node_id` and `timestamp` is idempotent. Nodes register automatically on their first message.

**MQTT**: publish the same JSON to `shm/{node_id}/telemetry` (`node_id` in the body is optional). Set `MQTT_BROKER_URL` to enable it. Without it, MQTT stays disabled and HTTP and the simulator keep running. Administrators can test the broker connection from **System settings**. Calling `POST /api/mqtt/test` with a `payload` runs it through the MQTT handler without a broker.

```cpp
// Arduino / ESP32 sketch (HTTPClient)
http.begin("https://shm.example.com/api/ingest");
http.addHeader("Content-Type", "application/json");
http.addHeader("X-Device-Key", DEVICE_KEY);
http.POST(jsonBody);
```

**Ready-to-flash sketch**: `tools/esp32_shm_node/esp32_shm_node.ino` (open it in the Arduino IDE with the "esp32 by Espressif Systems" board package). Copy `secrets.example.h` to `secrets.h`, which is gitignored, and fill in the Wi-Fi details, the API URL and the device key.

The sketch reads the project hardware directly:
- **HX711** (DOUT GPIO 16, SCK GPIO 4) gives strain. It is zeroed at start-up, and you calibrate `STRAIN_COUNTS_PER_MICROSTRAIN` for your gauge.
- **ADXL345** (I2C on SDA 21 / SCL 22) gives vibration: the peak dynamic acceleration in g over about 0.2 s.
- **DS18B20** (GPIO 5 with a 4.7 kΩ pull-up) gives temperature.

Install the libraries "HX711 Arduino Library" (Bogdan Necula), "Adafruit ADXL345" with "Adafruit Unified Sensor", "OneWire" and "DallasTemperature". A missing sensor is left out of the message instead of sending a wrong value. Set `USE_REAL_SENSORS 0` to send made-up values without any hardware or libraries. Serial Monitor at 115200 baud prints `POST 200` for every accepted reading.

**Dummy node (no hardware)**: `tools/dummy_esp32.py` acts like an ESP32 on the network. It POSTs to `/api/ingest` with `X-Device-Key` every 5 s and reads the key from `backend/.env`. It uses only the Python standard library.

```bash
python tools/dummy_esp32.py --url http://<this-pc-ip>:8000/api/ingest --breach-every 60
```

`--node` sets the node ID (default `ESP32-DUMMY`), `--interval` sets the seconds between readings, and `--breach-every N` sends a strain value over the limit every Nth reading so you can watch an alert go through. Devices on the network can only reach the API when it listens on `0.0.0.0` (as `.claude/launch.json` does), and Windows Firewall must allow Python. Stop the dummy before the real board reports under the same node ID.

## Email and WhatsApp alerts

Alerts at or above the **minimum severity** (Notifications page) go to every configured channel. Each channel can be switched off there, and a cooldown stops repeats for the same node and sensor.

**Email from your Gmail**
1. In your Google Account, turn on **2-Step Verification**, then open **App passwords** and create one (16 characters).
2. In `backend/.env` set `EMAIL_PROVIDER=smtp`, `SMTP_USERNAME=you@gmail.com` and `SMTP_PASSWORD=<app password>`, then restart the API.
3. On **Notifications**, add the email recipients, click **Save settings**, then **Send test email**.

**WhatsApp (Twilio)**
1. Create a free Twilio account. Copy the **Account SID** and **Auth Token** into `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
2. In the Twilio console open **Messaging → Try it out → Send a WhatsApp message**. Set `TWILIO_WHATSAPP_FROM=+14155238886` (the sandbox number) and restart the API.
3. Every recipient sends the sandbox's `join <code>` message from their WhatsApp to +1 415 523 8886 once.
4. On **Notifications**, add their numbers with country code (e.g. `+919876543210`), save, then **Send test WhatsApp**.

WhatsApp only lets a business send free-form messages within 24 hours of the recipient's last message to that number. With the sandbox, recipients may need to message it again if alerts stop arriving. For always-on alerts, register your own WhatsApp sender in Twilio and use an approved message template. Every attempt and any error appear in the **Delivery log**.

## Google Sheets

Every alert gets one row in a Google Sheet, keyed by its Alert ID. The row is rewritten in place when the alert is **acknowledged** (Status, Acknowledged By, Acknowledged At), **escalated** to critical (Severity, Peak Value), **resolved** because the reading went back under the limit (Status `resolved`, Resolved At), or when its email/SMS/WhatsApp delivery finishes. Retries never add the same Alert ID twice. Each change marks the alert's row as out of date, and the next sync, which starts at once when auto-sync is on, rewrites it. A change made while a sync is running is kept for the following sync. Ordinary readings never touch the sheet. There are two ways to connect.

**Apps Script web app (recommended, no Google Cloud key)**. Use this when your organisation blocks service-account keys. The script is `backend/app/static/sheets_apps_script.gs`, and the **Google Sheets** page has a **Copy script** button.
1. Create a Google Sheet. Open **Extensions → Apps Script** in it, or in Google Drive choose **New → More → Google Apps Script**.
2. Replace the sample code with the script and click **Save**.
3. Open **Project Settings → Script properties** and add `SHM_SECRET`, set to `GOOGLE_SHEETS_WEBHOOK_SECRET` from `backend/.env`. If you created the script from Drive, also add `SPREADSHEET_ID`, set to the sheet's link.
4. Choose **Deploy → New deployment → Web app** with *Execute as: Me* and *Who has access: Anyone*. Deploy, allow the permissions, and copy the **Web app URL** (it ends in `/exec`).
5. Set `GOOGLE_SHEETS_WEBHOOK_URL=<that URL>` in `backend/.env`, restart the API, then click **Test connection** and **Sync to Google Sheets** on the Google Sheets page.

Every request must carry the secret, so the URL alone is not enough to write to the sheet. The API only sends to `script.google.com` URLs. After you change the script, publish it with **Deploy → Manage deployments → Edit → Version: New version**, so the URL stays the same. The script reports its version. If your deployment is older than the API expects (version 1 could only add rows), the Google Sheets page shows **Update your Apps Script** and nothing is written until you update it. A sheet made by version 1 keeps its rows and gets the three new columns. If **Anyone** is missing from the access list, your school or work account doesn't allow it; create the sheet and script with a personal Gmail account instead.

**Service account**. Set `GOOGLE_SERVICE_ACCOUNT_FILE` (or `_JSON`), share the sheet with the service account's email as Editor, and paste the sheet link on the Google Sheets page. If both methods are configured, Apps Script is used.

## How alerts work

| Value | Reading status | Alert |
|---|---|---|
| below warning threshold | nominal (green) | none |
| warning ≤ value < safe | warning (amber) | none (early warnings may fire) |
| value ≥ safe threshold | critical (red) | threshold alert, severity **major** |
| value ≥ critical threshold | critical (red) | the open alert escalates to **critical** |

- **No duplicate alerts:** while one excursion lasts, its alert is updated in place (occurrences, peak value). It clears when the value drops below 97% of the limit. After that, the per-parameter cooldown applies, and a unique `dedupe_key` index enforces this at the database level. Debounce requires a breach to persist for N seconds before it alerts.
- **Notifications:** every alert records email, SMS and WhatsApp status (`pending`/`sent`/`failed`/`disabled`) and the reason. Provider failures are logged in `notification_logs` and shown in the UI. They never block ingestion.
- **Early warnings** are a separate alert type (cyan, dashed, "predictive") and never a red breach. Their score (0–100) combines distance to the limit, rolling average and standard deviation, the slope of recent readings and projected readings until the limit, consecutive rises, deviation from a robust sensor-specific baseline, and correlated abnormal parameters on the same node. Bands: 0–39 normal, 40–69 watch, 70–89 warning, 90–100 critical. Each one comes with a confidence level and a human-readable reason, for example *"Displacement has increased for 8 consecutive readings and is now at 76% of the safe limit."*

## Security

- bcrypt password hashing (12 rounds) and a constant-time path for unknown users
- JWT in a `HttpOnly`, `SameSite` cookie, with `Secure` configurable. It expires, and logout revokes it on the server.
- Lockout after `LOGIN_MAX_ATTEMPTS` failures per account (a looser limit per IP), returning HTTP 429 with `Retry-After`
- State-changing requests require an `X-SHM-Client` header (CSRF defence), and CORS only allows the explicitly configured origins
- Role checks on every endpoint (admin vs viewer), plus the last-admin and self-demotion guards
- Device keys are compared in constant time. All input is validated with Pydantic. CSV export neutralises formula injection.
- MongoDB `_id` is never returned, and all timestamps are timezone-aware UTC

## Tests

```bash
cd backend && python -m pytest        # 90 API tests, in-memory MongoDB
```

End-to-end (Playwright, 46 tests in `frontend/e2e`):

```bash
cd frontend
npm install
npx playwright install chromium       # one-off browser download (~150 MB)
npx playwright test                   # or: npm run test:e2e
```

`playwright.config.js` starts its own API on port 8100 (`MONGO_URL=mongomock://`, simulator and email/SMS/Sheets/MQTT off)
and its own Vite server on port 5180, so a running dev stack is never reused and every run starts clean.
Admin/viewer credentials and `DEVICE_SHARED_KEY` are read from `backend/.env` (`ADMIN_*`, `SEED_VIEWER_*`, `DEVICE_SHARED_KEY` must be set).
Failures keep a trace and screenshot; `npx playwright show-report` opens the HTML report.

| Requirement | Covered by |
|---|---|
| Admin login / invalid login / lockout / logout / session expiry | `tests/test_auth.py`; UI flows in `e2e/auth.spec.js` |
| Sign-up: viewer-only accounts, Gmail-only emails, duplicate email, validation, rate limit, `ALLOW_SIGNUP` | `tests/test_signup.py`; UI flow in `e2e/signup.spec.js` |
| Viewer permissions, API authentication, CSRF header | `tests/test_auth.py`; in `e2e/auth.spec.js`, viewers land on the `/user` readings page, readings refresh live, and dashboard URLs redirect back to `/user` |
| Simulated telemetry, HTTP ingestion, device auth, validation | `tests/test_telemetry.py` |
| Threshold events, dedupe, cooldown, debounce, acknowledgement | `tests/test_telemetry.py`; alert toast after `POST /api/ingest` and acknowledgement in `e2e/alerts.spec.js` |
| Anomaly scoring and early warnings, node online/offline, MQTT handler | `tests/test_telemetry.py` |
| MongoDB persistence across an API restart | `tests/test_telemetry.py::test_data_persists_across_restart` |
| Email/SMS failure handling, CSV export, Google Sheets sync and retry without duplicates | `tests/test_integrations.py`; CSV download in `e2e/alerts.spec.js` |
| Google Sheets via Apps Script: secret check, retry without duplicates, rows updated on acknowledge/escalate/resolve, no lost change during a sync, old-script detection, `script.google.com`-only URLs, the real `.gs` file run under Node | `tests/test_sheets_apps_script.py` (needs `node` for the last test); setup guide and copy button in `e2e/sheets.spec.js` |
| Profile card: avatar presets and photo upload, name and password changes | `tests/test_profile.py`; `e2e/profile.spec.js` |
| WhatsApp via Twilio, Gmail SMTP (STARTTLS/SSL, App Password errors), per-channel on/off | `tests/test_notification_channels.py` (Twilio and SMTP are faked, no real messages) |
| Browser notification request and delivery | `e2e/alerts.spec.js` (permission granted with `context.grantPermissions`) |
| 390px mobile layout, no horizontal overflow | `e2e/mobile.spec.js`: `scrollWidth <= 390` on every dashboard route as admin, and on the `/user` readings page |

Headless Chromium pins `Notification.permission` at `"denied"` even after a grant, so the notification tests add a small
init script that reports the permission from the Permissions API, which follows the grant. The app's own request and notify code runs unchanged.

Every interactive element in the UI has a unique `data-testid`, which the Playwright suite selects on.

## Production notes

- Build the frontend with `npm run build`. Serve `frontend/dist` behind the same origin as the API (e.g. nginx proxying `/api`), or set `VITE_API_BASE` and add the frontend origin to `FRONTEND_URL`, using `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` across sites.
- Run one API worker while the simulator or MQTT is enabled, so ingestion isn't duplicated. Disable the simulator (`SIMULATOR_ENABLED=false`) once real devices are reporting.
- Readings expire after `READING_RETENTION_DAYS` through a TTL index. Alerts are kept.
