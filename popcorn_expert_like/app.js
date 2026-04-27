const windowCountEl = document.getElementById("windowCount");
const totalCountEl = document.getElementById("totalCount");
const statusTextEl = document.getElementById("statusText");
const statusHintEl = document.getElementById("statusHint");
const alarmStateEl = document.getElementById("alarmState");
const windowSecondsEl = document.getElementById("windowSeconds");
const stopThresholdEl = document.getElementById("stopThreshold");
const armingPopsEl = document.getElementById("armingPops");
const minSecondsSinceStartEl = document.getElementById("minSecondsSinceStart");
const calibrationSecondsEl = document.getElementById("calibrationSeconds");
const sensitivityEl = document.getElementById("sensitivity");
const sensitivityValueEl = document.getElementById("sensitivityValue");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const testAlarmBtn = document.getElementById("testAlarmBtn");
const silenceAlarmBtn = document.getElementById("silenceAlarmBtn");
const silenceAlertBtn = document.getElementById("silenceAlertBtn");
const meterFillEl = document.getElementById("meterFill");
const thresholdLineEl = document.getElementById("thresholdLine");
const thresholdMetaEl = document.getElementById("thresholdMeta");
const alertBox = document.getElementById("alertBox");
const popChartCanvas = document.getElementById("popChart");
const chartMetaEl = document.getElementById("chartMeta");
const chartCtx = popChartCanvas.getContext("2d");

let audioContext = null;
let analyser = null;
let mediaStream = null;
let source = null;
let animationId = null;
let alarmLoopId = null;

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
  return {
    windowSeconds: clamp(Number(windowSecondsEl.value) || 10, 5, 30),
    stopThreshold: clamp(Number(stopThresholdEl.value) || 3, 1, 20),
    armingPops: clamp(Number(armingPopsEl.value) || 10, 1, 50),
    minSecondsSinceStart: clamp(Number(minSecondsSinceStartEl.value) || 60, 10, 300),
    calibrationSeconds: clamp(Number(calibrationSecondsEl.value) || 3, 2, 10),
    sensitivity: clamp(Number(sensitivityEl.value) || 6, 1, 10)
  };
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

function setStatus(text, hint = "") {
  statusTextEl.textContent = text;
  statusHintEl.textContent = hint;
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

function updateThresholdVisual(dynamicThreshold) {
  const thresholdPct = clamp((dynamicThreshold / 0.3) * 100, 0, 100);
  thresholdLineEl.style.left = `${thresholdPct}%`;
  thresholdMetaEl.textContent = `Trigger threshold: ${thresholdPct.toFixed(1)}% meter`;
}

function playAlarmSound() {
  const activeContext = audioContext && audioContext.state !== "closed" ? audioContext : new AudioContext();
  const shouldCloseContext = activeContext !== audioContext;

  if (activeContext.state === "suspended") {
    activeContext.resume();
  }

  const now = activeContext.currentTime;
  const pattern = [0, 0.28, 0.56, 0.84];

  for (let i = 0; i < pattern.length; i += 1) {
    const start = now + pattern[i];
    const osc = activeContext.createOscillator();
    const gain = activeContext.createGain();

    osc.type = "square";
    osc.frequency.value = 920;
    gain.gain.value = 0.0001;

    osc.connect(gain);
    gain.connect(activeContext.destination);

    osc.start(start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
    osc.stop(start + 0.19);
  }

  if (shouldCloseContext) {
    setTimeout(() => activeContext.close(), 1400);
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

function triggerStopAlert() {
  if (didAlert) {
    return;
  }

  didAlert = true;
  alertBox.hidden = false;
  setStatus("Best time to stop", "The pop rate has dropped below your threshold.");

  if (navigator.vibrate) {
    navigator.vibrate([150, 100, 150]);
  }

  startAlarmLoop();
}

function testAlarm() {
  if (navigator.vibrate) {
    navigator.vibrate([120, 80, 120]);
  }

  playAlarmSound();
}

function silenceAlarm() {
  stopAlarmLoop();
  alertBox.hidden = true;
  setStatus("Listening", "Alarm silenced.");
}

function processAudio() {
  if (!analyser) {
    return;
  }

  const now = performance.now();
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < buffer.length; i += 1) {
    const value = Math.abs(buffer[i]);
    sumSquares += value * value;
    if (value > peak) {
      peak = value;
    }
  }

  const rms = Math.sqrt(sumSquares / buffer.length);
  const { sensitivity, stopThreshold, armingPops, minSecondsSinceStart, calibrationSeconds } = getSettings();
  const sensitivityScale = (11 - sensitivity) / 10;
  const dynamicThreshold = Math.max(0.055 * sensitivityScale, noiseFloor * (4.1 - sensitivity * 0.2));
  const crest = peak / Math.max(rms, 0.0001);
  updateThresholdVisual(dynamicThreshold);

  if (now < calibrationEndsAt) {
    noiseFloor = noiseFloor * 0.97 + rms * 0.03;
    const remaining = Math.max(0, Math.ceil((calibrationEndsAt - now) / 1000));
    setStatus("Calibrating", `${remaining}s left, learning the room noise.`);
    meterFillEl.style.width = `${clamp((peak / 0.3) * 100, 0, 100)}%`;
    appendChartPoint(now);
    animationId = requestAnimationFrame(processAudio);
    return;
  }

  noiseFloor = noiseFloor * 0.995 + rms * 0.005;

  const likelyPop = peak > dynamicThreshold && crest > 3.5;

  if (likelyPop && now - lastPopAt > minPopGapMs) {
    lastPopAt = now;
    totalPops += 1;
    popTimes.push(now);
    appendChartPoint(now, true);
  }

  appendChartPoint(now);

  const windowCount = updateCounts();
  const elapsedFromStart = listeningStartedAt ? now - listeningStartedAt : 0;
  const isArmed = totalPops >= armingPops;
  const hasMetMinStartTime = elapsedFromStart >= minSecondsSinceStart * 1000;

  if (!didAlert && isArmed && hasMetMinStartTime && windowCount < stopThreshold) {
    triggerStopAlert();
  } else if (!didAlert) {
    if (isArmed) {
      setStatus("Listening", "Armed and watching the pop rate.");
    } else {
      const remaining = armingPops - totalPops;
      setStatus("Listening", `${remaining} pops to arm.`);
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

    totalPops = 0;
    popTimes = [];
    noiseFloor = 0.006;
    lastPopAt = 0;
    listeningStartedAt = performance.now();
    calibrationEndsAt = listeningStartedAt + getSettings().calibrationSeconds * 1000;
    updateCounts();
    resetChart();

    setStatus("Calibrating", "Learning your microwave and room noise.");
    startBtn.disabled = true;
    stopBtn.disabled = false;

    processAudio();
  } catch (error) {
    setStatus("Microphone unavailable", "Check permission and try again.");
    console.error(error);
  }
}

function stopListening() {
  stopAlarmLoop();

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

function resetCounter() {
  stopAlarmLoop();
  totalPops = 0;
  popTimes = [];
  chartPoints = [];
  lastPopAt = 0;
  listeningStartedAt = 0;
  calibrationEndsAt = 0;
  didAlert = false;
  alertBox.hidden = true;
  updateCounts();
  resetChart();
  thresholdMetaEl.textContent = "Trigger threshold: --";
  alarmStateEl.textContent = "Silent";
  setStatus("Idle", "Tap Start Analysis to calibrate and begin.");
}

sensitivityEl.addEventListener("input", () => {
  sensitivityValueEl.value = sensitivityEl.value;
});

window.addEventListener("resize", drawChart);
windowSecondsEl.addEventListener("change", updateCounts);
stopBtn.addEventListener("click", stopListening);
resetBtn.addEventListener("click", resetCounter);
testAlarmBtn.addEventListener("click", testAlarm);
silenceAlarmBtn.addEventListener("click", silenceAlarm);
silenceAlertBtn.addEventListener("click", silenceAlarm);
startBtn.addEventListener("click", startListening);

updateCounts();
resetChart();
setStatus("Idle", "Tap Start Analysis to calibrate and begin.");
