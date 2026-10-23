// OPTIONAL. Copy this file to secrets.h (gitignored) only if you want to pre-fill settings.
// Without it the board is set up wirelessly: Bluetooth for Wi-Fi, then Add node > Nearby
// devices on the website. Anything set over Bluetooth replaces these values.
#pragma once

#define WIFI_SSID      "your-wifi-name"        // 2.4 GHz network
#define WIFI_PASSWORD  "your-wifi-password"

// The website / API address. Either form works:
//   Deployed on Vercel:  "https://<your-project>.vercel.app"
//   PC on the same Wi-Fi: "http://<PC IPv4 from ipconfig>:8000"
#define API_URL        "https://your-project.vercel.app"

// Leave empty to connect the board from the website (recommended).
// Or paste DEVICE_SHARED_KEY from backend/.env, or a user's personal device key, to skip
// pairing; the board then uses NODE_ID and LOCATION from the sketch.
#define DEVICE_KEY     ""
