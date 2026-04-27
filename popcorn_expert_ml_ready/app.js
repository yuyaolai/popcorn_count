const windowCountEl = document.getElementById("windowCount");
const totalCountEl = document.getElementById("totalCount");
const statusTextEl = document.getElementById("statusText");
const statusHintEl = document.getElementById("statusHint");
const classifierStateEl = document.getElementById("classifierState");
const alarmStateEl = document.getElementById("alarmState");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const silenceAlarmBtn = document.getElementById("silenceAlarmBtn");
const exportClipBtn = document.getElementById("exportClipBtn");
const clipLabelEl = document.getElementById("clipLabel");
const clipSecondsEl = document.getElementById("clipSeconds");
const meterFillEl = document.getElementById("meterFill");
const thresholdLineEl = document.getElementById("thresholdLine");
const thresholdMetaEl = document.getElementById("thresholdMeta");
const alertBox = document.getElementById("alertBox");
const silenceAlertBtn = document.getElementById("silenceAlertBtn");
const popChartCanvas = document.getElementById("popChart");
const chartMetaEl = document.getElementById("chartMeta");
const chartCtx = popChartCanvas.getContext("2d");

const SETTINGS = {
  windowSeconds: 10,
  stopThreshold: 3,
  armingPops: 10,
  minSecondsSinceStart: 60,
  calibrationSeconds: 3,
  sensitivity: 6
};

let audioContext = null;
let analyser = null;
let mediaStream = null;
let source = null;
let animationId = null;
let alarmLoopId = null;
let captureRecorder = null;
let capturedAudioWindows = [];
let classifierModel = null;
let classifierLoadPromise = null;

let totalPops = 0;
let popTimes = [];
let chartPoints = [];
let noiseFloor = 0.006;
let lastPopAt = 0;
let listeningStartedAt = 0;
let calibrationEndsAt = 0;
let didAlert = false;
let lastChartSampleAt = 0;

const minPopGapMs = 180;
const chartSampleIntervalMs = 250;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getSettings() {
  return SETTINGS;
}

function setStatus(text, hint = "") {
  statusTextEl.textContent = text;
  statusHintEl.textContent = hint;
}

function setClassifierState(text) {
  classifierStateEl.textContent = text;
}

function setExportEnabled(enabled) {
  exportClipBtn.disabled = !enabled;
}

function resizeChartCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = popChartCanvas.getBoundingClientRect();
  const targetWidth = Math.max(1, Math.floor(rect.width * dpr));
  const targetHeight = Math.max(1, Math.floor(rect.height * dpr));

  if (popChartCanvas.width !== targetWidth || popChartCanvas.height !== targetHeight) {
    popChartCanvas.width = targetWidth;
    popChartCanvas.height = targetHeight;
  }
}

function drawChart() {
  resizeChartCanvas();

  const width = popChartCanvas.width;
  const height = popChartCanvas.height;
  const pad = 34;

  chartCtx.clearRect(0, 0, width, height);
  chartCtx.fillStyle = "rgba(255, 255, 255, 0.78)";
  chartCtx.fillRect(0, 0, width, height);

  chartCtx.strokeStyle = "rgba(36, 23, 15, 0.18)";
  chartCtx.lineWidth = 1;
  chartCtx.beginPath();
  chartCtx.moveTo(pad, pad);
  chartCtx.lineTo(pad, height - pad);
  chartCtx.lineTo(width - pad, height - pad);
  chartCtx.stroke();

  const fontPx = 12 * (window.devicePixelRatio || 1);
  chartCtx.fillStyle = "rgba(36, 23, 15, 0.72)";
  chartCtx.font = `${fontPx}px Segoe UI`;
  chartCtx.textAlign = "center";
  chartCtx.fillText("Time (s)", width / 2, height - 8 * (window.devicePixelRatio || 1));

  chartCtx.save();
  chartCtx.translate(10 * (window.devicePixelRatio || 1), height / 2);
  chartCtx.rotate(-Math.PI / 2);
  chartCtx.textAlign = "center";
  chartCtx.fillText("Total Pops", 0, 0);
  chartCtx.restore();

  if (chartPoints.length < 2) {
    chartCtx.fillStyle = "rgba(36, 23, 15, 0.64)";
    chartCtx.font = `${fontPx}px Segoe UI`;
    chartCtx.textAlign = "left";
    chartCtx.fillText("Start analysis to draw the live pop plot", pad + 8, height / 2);
    return;
  }

  const maxTime = Math.max(chartPoints[chartPoints.length - 1].time, 1);
  const maxPops = Math.max(totalPops, 1);
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;

  chartCtx.strokeStyle = "#ef6c00";
  chartCtx.lineWidth = 2;
  chartCtx.beginPath();

  for (let i = 0; i < chartPoints.length; i += 1) {
    const point = chartPoints[i];
    const x = pad + (point.time / maxTime) * plotWidth;
    const y = height - pad - (point.total / maxPops) * plotHeight;

    if (i === 0) {
      chartCtx.moveTo(x, y);
    } else {
      chartCtx.lineTo(x, y);
    }
  }

  chartCtx.stroke();
}

function appendChartPoint(now, force = false) {
  if (!listeningStartedAt) {
    return;
  }

  if (!force && now - lastChartSampleAt < chartSampleIntervalMs) {
    return;
  }

  const seconds = (now - listeningStartedAt) / 1000;
  chartPoints.push({ time: seconds, total: totalPops });
  lastChartSampleAt = now;

  if (chartPoints.length > 1500) {
    chartPoints.shift();
  }

  chartMetaEl.textContent = `${seconds.toFixed(1)}s elapsed, ${totalPops} total pops`;
  drawChart();
}

function resetChart() {
  chartPoints = [];
  lastChartSampleAt = 0;
  chartMetaEl.textContent = "Waiting to start...";
  drawChart();
}

function updateCounts() {
  const { windowSeconds } = getSettings();
  const now = performance.now();
  const cutoff = now - windowSeconds * 1000;
  popTimes = popTimes.filter((t) => t >= cutoff);
  windowCountEl.textContent = String(popTimes.length);
  totalCountEl.textContent = String(totalPops);
  return popTimes.length;
}

function updateThresholdVisual(dynamicThreshold) {
  const thresholdPct = clamp((dynamicThreshold / 0.3) * 100, 0, 100);
  thresholdLineEl.style.left = `${thresholdPct}%`;
  thresholdMetaEl.textContent = `Trigger threshold: ${thresholdPct.toFixed(1)}% meter`;
}

function playAlarmSound() {
  const context = audioContext && audioContext.state !== "closed" ? audioContext : new AudioContext();
  const shouldClose = context !== audioContext;

  if (context.state === "suspended") {
    context.resume();
  }

  const now = context.currentTime;
  const pattern = [0, 0.28, 0.56, 0.84];

  for (let i = 0; i < pattern.length; i += 1) {
    const start = now + pattern[i];
    const osc = context.createOscillator();
    const gain = context.createGain();

    osc.type = "square";
    osc.frequency.value = 920;
    gain.gain.value = 0.0001;

    osc.connect(gain);
    gain.connect(context.destination);

    osc.start(start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
    osc.stop(start + 0.19);
  }

  if (shouldClose) {
    setTimeout(() => context.close(), 1400);
  }
}

function startAlarmLoop() {
  if (alarmLoopId) {
    return;
  }

  playAlarmSound();
  alarmLoopId = setInterval(playAlarmSound, 1300);
  alarmStateEl.textContent = "Alarming";
}

function stopAlarmLoop() {
  if (alarmLoopId) {
    clearInterval(alarmLoopId);
    alarmLoopId = null;
  }

  alarmStateEl.textContent = "Silent";
}

function createDownload(filename, blob) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatTimestampForFile(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function pruneAudioWindows(now) {
  const maxRetentionMs = 65000;
  capturedAudioWindows = capturedAudioWindows.filter((entry) => now - entry.timestamp <= maxRetentionMs);
}

function startRollingAudioCapture() {
  if (!mediaStream || captureRecorder) {
    return;
  }

  try {
    capturedAudioWindows = [];
    const mimeTypeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    const mimeType = mimeTypeCandidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
    captureRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

    captureRecorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) {
        return;
      }

      const chunk = { timestamp: performance.now(), blob: event.data };
      capturedAudioWindows.push(chunk);
      pruneAudioWindows(chunk.timestamp);
    };

    captureRecorder.start(1000);
    setExportEnabled(true);
  } catch (error) {
    console.warn("Audio capture for training export could not start", error);
    captureRecorder = null;
    setExportEnabled(false);
  }
}

function stopRollingAudioCapture() {
  if (captureRecorder && captureRecorder.state !== "inactive") {
    captureRecorder.stop();
  }

  captureRecorder = null;
  capturedAudioWindows = [];
  setExportEnabled(false);
}

function exportTrainingClip() {
  if (!capturedAudioWindows.length) {
    setStatus("No audio captured yet", "Start analysis and wait a few seconds before exporting.");
    return;
  }

  const exportSeconds = clamp(Number(clipSecondsEl.value) || 60, 10, 60);
  const now = performance.now();
  const cutoff = now - exportSeconds * 1000;
  const label = clipLabelEl.value;
  const selectedChunks = capturedAudioWindows.filter((entry) => entry.timestamp >= cutoff).map((entry) => entry.blob);

  if (!selectedChunks.length) {
    setStatus("Not enough recent audio", `Wait at least ${exportSeconds} seconds, then export again.`);
    return;
  }

  const audioBlob = new Blob(selectedChunks, { type: selectedChunks[0].type || "audio/webm" });
  const stamp = formatTimestampForFile(new Date());
  const baseName = `popcorn_${label}_${exportSeconds}s_${stamp}`;
  const metadata = {
    label,
    exportSeconds,
    exportedAt: new Date().toISOString(),
    sampleRate: audioContext?.sampleRate || null,
    clipType: audioBlob.type || "audio/webm",
    source: "Popcorn Expert ML Ready"
  };

  createDownload(`${baseName}.webm`, audioBlob);
  createDownload(`${baseName}.json`, new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }));
  setStatus("Training clip exported", `Label: ${label}, window: ${exportSeconds}s`);
}

async function loadClassifierModel() {
  if (classifierLoadPromise) {
    return classifierLoadPromise;
  }

  classifierLoadPromise = (async () => {
    if (!window.tf) {
      classifierModel = null;
      setClassifierState("Classifier: heuristic fallback");
      return null;
    }

    try {
      setClassifierState("Classifier: loading TensorFlow model...");
      classifierModel = await window.tf.loadLayersModel("./model/model.json");
      setClassifierState("Classifier: TensorFlow model loaded");
      return classifierModel;
    } catch (error) {
      classifierModel = null;
      setClassifierState("Classifier: heuristic fallback");
      console.warn("TensorFlow model could not be loaded", error);
      return null;
    }
  })();

  return classifierLoadPromise;
}

function extractFeatures(timeBuffer, frequencyData, rms, peak, noiseFloorValue, dynamicThreshold) {
  let zeroCrossings = 0;
  let highEnergy = 0;
  let totalEnergy = 0;

  for (let i = 1; i < timeBuffer.length; i += 1) {
    if ((timeBuffer[i - 1] < 0 && timeBuffer[i] >= 0) || (timeBuffer[i - 1] >= 0 && timeBuffer[i] < 0)) {
      zeroCrossings += 1;
    }
  }

  const nyquist = (audioContext?.sampleRate || 48000) / 2;
  const highCutBin = Math.floor((2200 / nyquist) * frequencyData.length);

  for (let i = 0; i < frequencyData.length; i += 1) {
    const linear = Math.pow(10, frequencyData[i] / 20);
    totalEnergy += linear;
    if (i >= highCutBin) {
      highEnergy += linear;
    }
  }

  const peakToNoise = peak / Math.max(noiseFloorValue, 0.0001);
  const thresholdHeadroom = peak / Math.max(dynamicThreshold, 0.0001);

  return [
    rms,
    peak,
    peakToNoise,
    thresholdHeadroom,
    zeroCrossings / timeBuffer.length,
    highEnergy / Math.max(totalEnergy, 0.0001),
    noiseFloorValue,
    peak - dynamicThreshold
  ];
}

function predictPopProbability(features, peak, dynamicThreshold, crest) {
  if (classifierModel && window.tf) {
    try {
      return window.tf.tidy(() => {
        const input = window.tf.tensor2d([features]);
        const output = classifierModel.predict(input);
        const tensor = Array.isArray(output) ? output[0] : output;
        const values = tensor.dataSync();
        return clamp(Number(values[0] ?? 0), 0, 1);
      });
    } catch (error) {
      classifierModel = null;
      setClassifierState("Classifier: heuristic fallback");
      console.warn("Classifier prediction failed", error);
    }
  }

  const amplitudeScore = clamp((peak / Math.max(dynamicThreshold, 0.0001) - 1) / 1.4, 0, 1);
  const crestScore = clamp((crest - 2.5) / 4.5, 0, 1);
  const energyScore = clamp(features[5] * 2, 0, 1);
  const transientScore = clamp(features[7] / 0.12, 0, 1);
  return clamp(0.45 * amplitudeScore + 0.35 * crestScore + 0.1 * energyScore + 0.1 * transientScore, 0, 1);
}

function triggerStopAlert() {
  if (didAlert) {
    return;
  }

  didAlert = true;
  alertBox.hidden = false;
  setStatus("Best time to stop", "The pop rate has dropped below the threshold.");

  if (navigator.vibrate) {
    navigator.vibrate([150, 100, 150]);
  }

  startAlarmLoop();
}

function silenceAlarm() {
  stopAlarmLoop();
  alertBox.hidden = true;
  didAlert = true;
  setStatus("Listening", "Alarm silenced.");
}

function silenceAllAlerts() {
  silenceAlarm();
}

function processAudio() {
  if (!analyser) {
    return;
  }

  const now = performance.now();
  const timeBuffer = new Float32Array(analyser.fftSize);
  const frequencyData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(timeBuffer);
  analyser.getFloatFrequencyData(frequencyData);

  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < timeBuffer.length; i += 1) {
    const value = Math.abs(timeBuffer[i]);
    sumSquares += value * value;
    if (value > peak) {
      peak = value;
    }
  }

  const rms = Math.sqrt(sumSquares / timeBuffer.length);

  if (now < calibrationEndsAt) {
    noiseFloor = noiseFloor * 0.95 + rms * 0.05;
    const remaining = Math.max(0, Math.ceil((calibrationEndsAt - now) / 1000));
    setStatus("Calibrating", `${remaining}s left, learning the room noise.`);
    meterFillEl.style.width = `${clamp((peak / 0.3) * 100, 0, 100)}%`;
    appendChartPoint(now);
    animationId = requestAnimationFrame(processAudio);
    return;
  }

  noiseFloor = noiseFloor * 0.995 + rms * 0.005;

  const { sensitivity, stopThreshold, armingPops, minSecondsSinceStart } = getSettings();
  const sensitivityScale = (11 - sensitivity) / 10;
  const dynamicThreshold = Math.max(0.055 * sensitivityScale, noiseFloor * (4.1 - sensitivity * 0.2));
  const crest = peak / Math.max(rms, 0.0001);
  const features = extractFeatures(timeBuffer, frequencyData, rms, peak, noiseFloor, dynamicThreshold);
  const popProbability = predictPopProbability(features, peak, dynamicThreshold, crest);

  updateThresholdVisual(dynamicThreshold);

  if (popProbability > 0.82 && now - lastPopAt > minPopGapMs) {
    lastPopAt = now;
    totalPops += 1;
    popTimes.push(now);
    appendChartPoint(now, true);
  }

  appendChartPoint(now);
  const windowCount = updateCounts();
  const elapsedFromStart = listeningStartedAt ? now - listeningStartedAt : 0;
  const hasMetMinStartTime = elapsedFromStart >= minSecondsSinceStart * 1000;
  const isArmed = totalPops >= armingPops;

  if (!didAlert && isArmed && hasMetMinStartTime && windowCount < stopThreshold) {
    triggerStopAlert();
  } else if (!didAlert) {
    if (!hasMetMinStartTime) {
      const remainingSeconds = Math.max(0, Math.ceil((minSecondsSinceStart * 1000 - elapsedFromStart) / 1000));
      setStatus("Listening", `Warmup timer: ${remainingSeconds}s remaining.`);
    } else if (isArmed) {
      setStatus("Listening", classifierModel ? "TensorFlow model is watching for the stop point." : "Heuristic classifier is watching for the stop point.");
    } else {
      setStatus("Listening", `${armingPops - totalPops} pops to arm.`);
    }
  }

  meterFillEl.style.width = `${clamp((peak / 0.3) * 100, 0, 100)}%`;
  animationId = requestAnimationFrame(processAudio);
}

async function startListening() {
  try {
    alertBox.hidden = true;
    didAlert = false;
    stopAlarmLoop();
    setStatus("Requesting microphone...", "Allow access so the app can hear popcorn pops.");
    setClassifierState("Classifier: loading...");

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
      }
    });

    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.1;

    source = audioContext.createMediaStreamSource(mediaStream);

    const highPass = audioContext.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = 1200;

    source.connect(highPass);
    highPass.connect(analyser);
    startRollingAudioCapture();

    totalPops = 0;
    popTimes = [];
    chartPoints = [];
    noiseFloor = 0.006;
    lastPopAt = 0;
    listeningStartedAt = performance.now();
    calibrationEndsAt = listeningStartedAt + getSettings().calibrationSeconds * 1000;
    didAlert = false;
    updateCounts();
    resetChart();

    await loadClassifierModel();
    startBtn.disabled = true;
    stopBtn.disabled = false;

    processAudio();
  } catch (error) {
    setStatus("Microphone unavailable", "Check permission and try again.");
    setClassifierState("Classifier: heuristic fallback");
    setExportEnabled(false);
    console.error(error);
  }
}

function stopListening() {
  stopAlarmLoop();
  stopRollingAudioCapture();

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (source) {
    source.disconnect();
    source = null;
  }

  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  meterFillEl.style.width = "0%";
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Stopped", "Tap Start Analysis to listen again.");
}

function updateInitialState() {
  updateCounts();
  resetChart();
  setClassifierState("Classifier: heuristic fallback");
  setExportEnabled(false);
  setStatus("Idle", "Tap Start Analysis to begin.");
}

window.addEventListener("resize", drawChart);
startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);
silenceAlarmBtn.addEventListener("click", silenceAllAlerts);
silenceAlertBtn.addEventListener("click", silenceAllAlerts);
exportClipBtn.addEventListener("click", exportTrainingClip);

updateInitialState();
