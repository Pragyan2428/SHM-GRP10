// Copy this file to secrets.h (gitignored) and fill it in.
#pragma once

#define WIFI_SSID      "your-wifi-name"        // 2.4 GHz network the PC is also on
#define WIFI_PASSWORD  "your-wifi-password"

// The PC running the API: http://<PC IPv4 from ipconfig>:8000/api/ingest
// With the PC's Windows Mobile hotspot it is usually http://192.168.137.1:8000/api/ingest
// Deployed on Vercel: "https://<your-project>.vercel.app/api/ingest" (any Wi-Fi with internet works)
#define API_URL        "http://10.7.209.43:8000/api/ingest"

// DEVICE_SHARED_KEY from backend/.env (or this node's entry in DEVICE_KEYS)
#define DEVICE_KEY     "paste-device-key-here"
