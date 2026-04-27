"""Train a baseline popcorn classifier from exported labeled clips.

This script expects files created by the in-app export workflow:
- <name>.webm (or .wav)
- <name>.json with a label field of "pop" or "non-pop"

It converts each clip to mono PCM WAV with ffmpeg, splits audio into
overlapping 1-second windows, extracts a small feature vector, trains a
binary TensorFlow model, and saves the trained model artifacts.

The model is intentionally small so it can serve as a baseline and later
be converted to TensorFlow.js if desired.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import tensorflow as tf


DEFAULT_SAMPLE_RATE = 16000
WINDOW_SECONDS = 1.0
WINDOW_HOP_SECONDS = 0.5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a popcorn pop classifier baseline.")
    parser.add_argument("--data-dir", type=Path, default=Path("training_audio"), help="Folder containing exported .json/.webm pairs")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts"), help="Where to save the trained Keras model and metadata")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE, help="Target sample rate for decoding audio")
    parser.add_argument("--epochs", type=int, default=25, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=32, help="Training batch size")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    return parser.parse_args()


def ensure_ffmpeg() -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    if not ffmpeg_path:
        raise SystemExit("ffmpeg was not found. Install ffmpeg on PATH or install imageio-ffmpeg.")
    return ffmpeg_path


def read_metadata_pairs(data_dir: Path) -> list[tuple[Path, Path, dict]]:
    pairs: list[tuple[Path, Path, dict]] = []
    for metadata_path in sorted(data_dir.glob("*.json")):
        clip_info = json.loads(metadata_path.read_text(encoding="utf-8"))
        webm_path = metadata_path.with_suffix(".webm")
        wav_path = metadata_path.with_suffix(".wav")

        if webm_path.exists():
            audio_path = webm_path
        elif wav_path.exists():
            audio_path = wav_path
        else:
            continue

        label = clip_info.get("label")
        if label not in {"pop", "non-pop"}:
            continue

        pairs.append((metadata_path, audio_path, clip_info))

    return pairs


def decode_segment_to_pcm(segment_path: Path, sample_rate: int, ffmpeg_path: str) -> np.ndarray:
    command = [
        ffmpeg_path,
        "-v",
        "error",
        "-i",
        str(segment_path),
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "pipe:1",
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0 or not result.stdout:
        return np.empty(0, dtype=np.float32)
    return np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def recover_concatenated_webm(audio_path: Path, sample_rate: int, ffmpeg_path: str) -> np.ndarray:
    raw = audio_path.read_bytes()
    ebml_header = b"\x1a\x45\xdf\xa3"
    header_positions = []
    start = 0
    while True:
        idx = raw.find(ebml_header, start)
        if idx == -1:
            break
        header_positions.append(idx)
        start = idx + 1

    if len(header_positions) <= 1:
        return np.empty(0, dtype=np.float32)

    recovered_segments: list[np.ndarray] = []
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_root = Path(temp_dir)
        boundaries = header_positions + [len(raw)]
        for i in range(len(boundaries) - 1):
            seg_bytes = raw[boundaries[i] : boundaries[i + 1]]
            if len(seg_bytes) < 64:
                continue

            seg_path = temp_root / f"chunk_{i:04d}.webm"
            seg_path.write_bytes(seg_bytes)
            pcm = decode_segment_to_pcm(seg_path, sample_rate, ffmpeg_path)
            if pcm.size > 0:
                recovered_segments.append(pcm)

    if not recovered_segments:
        return np.empty(0, dtype=np.float32)

    return np.concatenate(recovered_segments)


def decode_audio_to_mono(audio_path: Path, sample_rate: int, ffmpeg_path: str) -> np.ndarray:
    if audio_path.suffix.lower() == ".wav":
        with wave.open(str(audio_path), "rb") as wav_file:
            source_rate = wav_file.getframerate()
            channels = wav_file.getnchannels()
            frames = wav_file.readframes(wav_file.getnframes())
            audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
            if channels > 1:
                audio = audio.reshape(-1, channels).mean(axis=1)
            audio /= 32768.0
        if source_rate != sample_rate:
            target_length = max(1, int(round(len(audio) * sample_rate / source_rate)))
            x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
            x_new = np.linspace(0.0, 1.0, num=target_length, endpoint=False)
            audio = np.interp(x_new, x_old, audio).astype(np.float32)
        return audio

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
        temp_wav_path = Path(temp_wav.name)

    try:
        command = [
            ffmpeg_path,
            "-y",
            "-i",
            str(audio_path),
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "wav",
            str(temp_wav_path),
        ]
        result = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        if result.returncode != 0 and audio_path.suffix.lower() == ".webm":
            recovered = recover_concatenated_webm(audio_path, sample_rate, ffmpeg_path)
            if recovered.size > 0:
                return recovered

        if result.returncode != 0:
            stderr_text = result.stderr.decode("utf-8", errors="ignore")
            raise RuntimeError(f"ffmpeg decode failed for {audio_path.name}: {stderr_text.strip()}")

        with wave.open(str(temp_wav_path), "rb") as wav_file:
            frames = wav_file.readframes(wav_file.getnframes())
            audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        return audio
    finally:
        if temp_wav_path.exists():
            temp_wav_path.unlink(missing_ok=True)


def sliding_windows(audio: np.ndarray, sample_rate: int) -> list[np.ndarray]:
    window_size = int(sample_rate * WINDOW_SECONDS)
    hop_size = int(sample_rate * WINDOW_HOP_SECONDS)
    if len(audio) < window_size:
        return []

    windows: list[np.ndarray] = []
    for start in range(0, len(audio) - window_size + 1, hop_size):
        windows.append(audio[start : start + window_size])
    return windows


def extract_features(window: np.ndarray, sample_rate: int) -> np.ndarray:
    window = window.astype(np.float32)
    abs_window = np.abs(window)
    rms = float(np.sqrt(np.mean(window ** 2) + 1e-12))
    peak = float(np.max(abs_window) + 1e-12)
    noise_floor = float(np.percentile(abs_window, 20) + 1e-12)
    peak_to_noise = peak / noise_floor
    threshold_est = noise_floor * 4.1
    threshold_headroom = peak / max(threshold_est, 1e-12)
    zero_crossings = float(np.mean(np.signbit(window[:-1]) != np.signbit(window[1:])) if len(window) > 1 else 0.0)

    spectrum = np.abs(np.fft.rfft(window))
    total_energy = float(np.sum(spectrum) + 1e-12)
    high_energy = float(np.sum(spectrum[int(len(spectrum) * 0.6):]))
    high_energy_ratio = high_energy / total_energy

    peak_minus_threshold = peak - threshold_est

    return np.array(
        [
            rms,
            peak,
            peak_to_noise,
            threshold_headroom,
            zero_crossings,
            high_energy_ratio,
            noise_floor,
            peak_minus_threshold,
        ],
        dtype=np.float32,
    )


def build_dataset(data_dir: Path, sample_rate: int, ffmpeg_path: str) -> tuple[np.ndarray, np.ndarray, list[str]]:
    feature_rows: list[np.ndarray] = []
    labels: list[int] = []
    clip_ids: list[str] = []

    pairs = read_metadata_pairs(data_dir)
    if not pairs:
        raise SystemExit(f"No labeled clip pairs found in {data_dir}")

    for metadata_path, audio_path, clip_info in pairs:
        label_name = str(clip_info.get("label"))
        label_value = 1 if label_name == "pop" else 0
        clip_id = metadata_path.stem

        audio = decode_audio_to_mono(audio_path, sample_rate, ffmpeg_path)
        windows = sliding_windows(audio, sample_rate)
        if not windows:
            continue

        for index, window in enumerate(windows):
            feature_rows.append(extract_features(window, sample_rate))
            labels.append(label_value)
            clip_ids.append(f"{clip_id}:{index}")

    if not feature_rows:
        raise SystemExit("No usable 1-second windows were produced from the training_audio folder.")

    x = np.stack(feature_rows, axis=0)
    y = np.asarray(labels, dtype=np.float32)
    return x, y, clip_ids


def split_dataset(x: np.ndarray, y: np.ndarray, clip_ids: list[str], seed: int) -> tuple[np.ndarray, ...]:
    rng = np.random.default_rng(seed)
    unique_clips = sorted({clip_id.split(":", 1)[0] for clip_id in clip_ids})
    rng.shuffle(unique_clips)

    if len(unique_clips) < 2:
        indices = np.arange(len(x))
        rng.shuffle(indices)
        split_index = max(1, int(0.8 * len(indices)))
        train_indices = indices[:split_index]
        val_indices = indices[split_index:]
        if len(val_indices) == 0:
            val_indices = train_indices[-1:]
            train_indices = train_indices[:-1]
        return x[train_indices], x[val_indices], y[train_indices], y[val_indices]

    val_clip_count = max(1, int(round(0.2 * len(unique_clips))))
    val_clips = set(unique_clips[:val_clip_count])
    train_mask = np.array([clip_id.split(":", 1)[0] not in val_clips for clip_id in clip_ids])
    val_mask = ~train_mask

    if not train_mask.any() or not val_mask.any():
        indices = np.arange(len(x))
        rng.shuffle(indices)
        split_index = max(1, int(0.8 * len(indices)))
        train_indices = indices[:split_index]
        val_indices = indices[split_index:]
        if len(val_indices) == 0:
            val_indices = train_indices[-1:]
            train_indices = train_indices[:-1]
        return x[train_indices], x[val_indices], y[train_indices], y[val_indices]

    return x[train_mask], x[val_mask], y[train_mask], y[val_mask]


def normalize_features(train_x: np.ndarray, val_x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    mean = train_x.mean(axis=0, keepdims=True)
    std = train_x.std(axis=0, keepdims=True) + 1e-6
    return (train_x - mean) / std, (val_x - mean) / std, mean.squeeze(0), std.squeeze(0)


def build_model(input_dim: int) -> tf.keras.Model:
    model = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(input_dim,)),
            tf.keras.layers.Dense(64, activation="relu"),
            tf.keras.layers.Dropout(0.25),
            tf.keras.layers.Dense(32, activation="relu"),
            tf.keras.layers.Dense(1, activation="sigmoid"),
        ]
    )
    model.compile(
        optimizer=tf.keras.optimizers.Adam(1e-3),
        loss="binary_crossentropy",
        metrics=["accuracy", tf.keras.metrics.AUC(name="auc")],
    )
    return model


def main() -> None:
    args = parse_args()
    ffmpeg_path = ensure_ffmpeg()
    tf.keras.utils.set_random_seed(args.seed)

    x, y, clip_ids = build_dataset(args.data_dir, args.sample_rate, ffmpeg_path)
    train_x, val_x, train_y, val_y = split_dataset(x, y, clip_ids, args.seed)
    train_x, val_x, mean, std = normalize_features(train_x, val_x)

    model = build_model(train_x.shape[1])
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    callbacks = [
        tf.keras.callbacks.EarlyStopping(monitor="val_auc", mode="max", patience=5, restore_best_weights=True),
        tf.keras.callbacks.ModelCheckpoint(
            filepath=str(output_dir / "best_model.keras"),
            monitor="val_auc",
            mode="max",
            save_best_only=True,
        ),
    ]

    history = model.fit(
        train_x,
        train_y,
        validation_data=(val_x, val_y),
        epochs=args.epochs,
        batch_size=args.batch_size,
        callbacks=callbacks,
        verbose=2,
    )

    model.save(output_dir / "final_model.keras")
    model.export(output_dir / "saved_model")

    metadata = {
        "sample_rate": args.sample_rate,
        "window_seconds": WINDOW_SECONDS,
        "window_hop_seconds": WINDOW_HOP_SECONDS,
        "feature_names": [
            "rms",
            "peak",
            "peak_to_noise",
            "threshold_headroom",
            "zero_crossing_rate",
            "high_energy_ratio",
            "noise_floor_estimate",
            "peak_minus_threshold_estimate",
        ],
        "feature_mean": mean.tolist(),
        "feature_std": std.tolist(),
        "train_examples": int(len(train_x)),
        "val_examples": int(len(val_x)),
        "history": history.history,
    }
    (output_dir / "training_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Saved final model to {output_dir / 'final_model.keras'}")
    print(f"Saved TensorFlow export to {output_dir / 'saved_model'}")
    print(f"Training metadata written to {output_dir / 'training_metadata.json'}")
    print("If you want TensorFlow.js artifacts, convert the SavedModel or Keras model with tensorflowjs_converter.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)