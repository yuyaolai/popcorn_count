# Popcorn Expert Style

This is a separate project folder inspired by the Play Store description of a popcorn analyzer.

## What it does

- Uses your phone microphone to analyze popcorn popping sounds in real time
- Calibrates background noise briefly before counting
- Tracks total pops and a rolling window of pops
- Shows a live pop plot and a visible trigger threshold line
- Plays a looping alarm when the pop rate falls below your stop threshold

## How it differs from your current app

Your current app is more of a configurable popcorn counter with multiple tuning controls and a more exploratory layout.

This new folder is closer to the “Popcorn Expert” style:

- More focused, app-like UI
- Calibration step before detection starts
- Stronger emphasis on live status and automatic stop alerting
- Still lightweight and offline, using browser audio heuristics instead of a trained ML model

## Notes

The Play Store app description mentions machine learning. This project does not include a trained model. Instead, it uses adaptive sound analysis with calibration and thresholding so it stays simple, fast, and easy to run on Android.

## Run it

Open `index.html` in a browser, or host the folder over HTTPS for microphone access on Android Chrome.
