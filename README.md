# Popcorn Pop Counter (Android-Friendly Web App)

This app uses your phone microphone to estimate popcorn pops in real time.

## What it does

- Counts likely pops detected from audio spikes
- Tracks pops in a rolling window (default: 10 seconds)
- Draws a live plot of total pops over elapsed time
- Uses an arming stage so stop alerts are disabled until a chosen number of pops is detected
- Requires a minimum elapsed time since pressing Start before stop alerts are allowed
- Alerts you when pop rate drops below your threshold (default: less than 3 pops in 10s)

## Use on Android

1. Open Chrome on your Android phone.
2. Open this page (host it or open locally with a simple web server).
3. Tap **Start Listening** and allow microphone permission.
4. Put your phone close to the microwave (not touching it).
5. Adjust sensitivity if needed:
   - Higher sensitivity catches quieter pops but may false-trigger in noisy rooms.
   - Lower sensitivity reduces false triggers but may miss quieter pops.

## Suggested settings to start

- Window length: 10 seconds
- Stop threshold: 3
- Arming pops: 10 (adjust between about 8 and 12 to reduce false starts)
- Minimum seconds since Start: 60
- Sensitivity: 6

## Notes

- This is a heuristic detector, not a perfect audio classifier.
- Very loud kitchens, TV, or music can affect accuracy.
- Best results come from consistent phone placement and low background noise.
