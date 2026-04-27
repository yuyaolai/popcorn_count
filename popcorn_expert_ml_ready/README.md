# Popcorn Expert ML Ready

This is a separate, one-tap-style popcorn app inspired by the Play Store description.

## What it does

- Starts with one tap and calibrates the room automatically
- Listens to microwave pops in real time
- Uses adaptive heuristics by default
- Can load a TensorFlow.js model later if you add one to the `model/` folder
- Shows a live pop plot and a visible trigger threshold line
- Plays a looping alarm until the user silences it

## Why it is different from your current app

Your current app is a tuning-heavy, exploratory detector with many controls and debug aids.

This version is closer to the Play Store style:

- Fewer visible controls
- More consumer-app feel
- Auto-calibration on start
- Optional ML model hook instead of only manual tuning

## About the ML layer

The Play Store app description suggests a TensorFlow-based classifier trained on labeled pop sounds.

This project includes an ML-ready hook, but it does not ship with a trained model. To make it genuinely classifier-based, you still need labeled training data and a model exported to TensorFlow.js format.

## Labeled clip workflow

Use the in-app Training Clip Export panel to collect audio clips:

1. Tap Start Analysis.
2. Let it run for a few seconds so the rolling capture buffer fills.
3. Pick a label: `pop` or `non-pop`.
4. Choose the export window, usually 10, 30, or 60 seconds.
5. Tap Export Training Clip.

The app downloads two files:

- an audio clip such as `.webm`
- a matching `.json` metadata file with the label and window length

Label `pop` for clips where a pop is clearly present. Label `non-pop` for microwave hum, room noise, bag rustle, or other sounds that should not count as a pop.

## How to use a trained model later

1. Train a model on labeled popcorn audio clips.
2. Export it as a TensorFlow.js Layers model.
3. Place the generated `model.json` and weight files in `model/`.
4. Start the app and it will try to load the model automatically.

If no model is present, the app falls back to the built-in adaptive detector.

## Recommended TensorFlow training setup

This app is best used with a small binary classifier trained on short audio windows.

Recommended target:

- Input: a short audio feature vector extracted from 1-second windows
- Output: two classes, `pop` and `non-pop`
- Architecture: small dense network or a compact CNN over log-mel features

Practical setup:

1. Collect lots of labeled clips from your own microwave and from users.
2. Split audio into short windows, for example 1 second with 50% overlap.
3. Convert each window into features such as:
   - log-mel spectrogram
   - MFCCs
   - spectral centroid / bandwidth / rolloff
   - short-time energy
4. Train a binary classifier in TensorFlow.
5. Export the model as TensorFlow.js Layers format.
6. Put `model.json` and weight shards in the `model/` folder.

Suggested baseline model:

```python
import tensorflow as tf

model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(num_features,)),
    tf.keras.layers.Dense(64, activation="relu"),
    tf.keras.layers.Dropout(0.25),
    tf.keras.layers.Dense(32, activation="relu"),
    tf.keras.layers.Dense(1, activation="sigmoid")
])

model.compile(
    optimizer=tf.keras.optimizers.Adam(1e-3),
    loss="binary_crossentropy",
    metrics=["accuracy", tf.keras.metrics.AUC(name="auc")]
)
```

If you want a more audio-native approach, a small 2D CNN on log-mel spectrograms is also a strong baseline.

Important data tips:

- Include many hard negatives: microwave hum, bag shaking, people talking, kitchen clatter.
- Keep the classes balanced if possible.
- Hold out some recording sessions entirely for validation so the model does not memorize one microwave.
- If pops are rare, use class weighting or oversampling.

## Runtime note

The current app already includes a TensorFlow.js model hook. When you add a compatible model to `model/`, it will try to use that model first and fall back to the heuristic detector if loading fails.

## Run the trainer

1. Install Python dependencies from `requirements.txt`.
2. Make sure `ffmpeg` is installed and available on your `PATH`.
3. Put your labeled exports in `training_audio/` as matching `.json` and `.webm` pairs.
4. Run the trainer from this folder:

```bash
python train_pop_classifier.py --data-dir training_audio --output-dir artifacts
```

The script writes:

- `artifacts/final_model.keras`
- `artifacts/best_model.keras`
- `artifacts/saved_model/`
- `artifacts/training_metadata.json`

The exported model is a baseline binary classifier trained on audio-derived features from 1-second windows. You can convert the SavedModel to TensorFlow.js after training if you want it to load in the web app.

## Run it

Open `index.html` in a browser, or host the folder over HTTPS for microphone access on Android Chrome.
