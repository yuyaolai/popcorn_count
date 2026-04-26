const windowCountEl = document.getElementById("windowCount");
const totalCountEl = document.getElementById("totalCount");
const statusTextEl = document.getElementById("statusText");
const windowSecondsEl = document.getElementById("windowSeconds");
const stopThresholdEl = document.getElementById("stopThreshold");
const armingPopsEl = document.getElementById("armingPops");
const minSecondsSinceStartEl = document.getElementById("minSecondsSinceStart");
const sensitivityEl = document.getElementById("sensitivity");
const sensitivityValueEl = document.getElementById("sensitivityValue");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const meterFillEl = document.getElementById("meterFill");
const alertBox = document.getElementById("alertBox");
const popChartCanvas = document.getElementById("popChart");
const chartMetaEl = document.getElementById("chartMeta");
const chartCtx = popChartCanvas.getContext("2d");

let audioContext = null;
let analyser = null;
let mediaStream = null;
let source = null;
let animationId = null;

let totalPops = 0;
let popTimes = [];
let noiseFloor = 0.006;
let lastPopAt = 0;
let firstPopAt = 0;
let listeningStartedAt = 0;
let didAlert = false;
let chartPoints = [];
let lastChartSampleAt = 0;

const minPopGapMs = 180;
const chartSampleIntervalMs = 250;

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
  const pad = 26;

  chartCtx.clearRect(0, 0, width, height);
  chartCtx.fillStyle = "#fffdf8";
  chartCtx.fillRect(0, 0, width, height);

  chartCtx.strokeStyle = "rgba(42, 31, 26, 0.2)";
  chartCtx.lineWidth = 1;
  chartCtx.beginPath();
  chartCtx.moveTo(pad, pad);
  chartCtx.lineTo(pad, height - pad);
  chartCtx.lineTo(width - pad, height - pad);
  chartCtx.stroke();

  if (chartPoints.length < 2) {
    chartCtx.fillStyle = "rgba(42, 31, 26, 0.6)";
    chartCtx.font = `${12 * (window.devicePixelRatio || 1)}px Segoe UI`;
    chartCtx.fillText("Start listening to draw live plot", pad + 8, height / 2);
    return;
  }

  const maxTime = Math.max(chartPoints[chartPoints.length - 1].time, 1);
  const maxPops = Math.max(totalPops, 1);
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;

  chartCtx.strokeStyle = "#e85d04";
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getSettings() {
  const windowSeconds = clamp(Number(windowSecondsEl.value) || 10, 5, 30);
  const stopThreshold = clamp(Number(stopThresholdEl.value) || 3, 1, 20);
  const armingPops = clamp(Number(armingPopsEl.value) || 10, 1, 50);
  const minSecondsSinceStart = clamp(Number(minSecondsSinceStartEl.value) || 60, 10, 300);
  const sensitivity = clamp(Number(sensitivityEl.value) || 6, 1, 10);
  return { windowSeconds, stopThreshold, armingPops, minSecondsSinceStart, sensitivity };
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

function setStatus(text, isWarning = false) {
  statusTextEl.textContent = text;
  statusTextEl.style.color = isWarning ? "#d62828" : "#2a1f1a";
}

function triggerStopAlert() {
  if (didAlert) {
    return;
  }

  didAlert = true;
  alertBox.hidden = false;
  setStatus("Stop now", true);

  if (navigator.vibrate) {
    navigator.vibrate([150, 100, 150]);
  }

  const beep = new AudioContext();
  const osc = beep.createOscillator();
  const gain = beep.createGain();
  osc.type = "triangle";
  osc.frequency.value = 880;
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(beep.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.12, beep.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, beep.currentTime + 0.22);
  osc.stop(beep.currentTime + 0.24);
  osc.onended = () => beep.close();
}

function processAudio() {
  if (!analyser) {
    return;
  }

  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < buffer.length; i += 1) {
    const v = Math.abs(buffer[i]);
    sumSquares += v * v;
    if (v > peak) {
      peak = v;
    }
  }

  const rms = Math.sqrt(sumSquares / buffer.length);
  noiseFloor = noiseFloor * 0.995 + rms * 0.005;

  const { sensitivity, stopThreshold, armingPops, minSecondsSinceStart } = getSettings();
  const sensitivityScale = (11 - sensitivity) / 10;
  const dynamicThreshold = Math.max(0.055 * sensitivityScale, noiseFloor * (4.1 - sensitivity * 0.2));
  const crest = peak / Math.max(rms, 0.0001);

  const now = performance.now();
  const likelyPop = peak > dynamicThreshold && crest > 3.5;

  if (likelyPop && now - lastPopAt > minPopGapMs) {
    lastPopAt = now;
    totalPops += 1;
    popTimes.push(now);

    if (!firstPopAt) {
      firstPopAt = now;
    }

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
      setStatus(`Warmup timer (${remainingSeconds}s remaining)`);
    } else if (isArmed) {
      setStatus("Listening (armed)");
    } else {
      const remaining = armingPops - totalPops;
      setStatus(`Warming up (${remaining} pops to arm)`);
    }
  }

  meterFillEl.style.width = `${clamp((peak / 0.3) * 100, 0, 100)}%`;
  animationId = requestAnimationFrame(processAudio);
}

async function startListening() {
  try {
    alertBox.hidden = true;
    didAlert = false;
    listeningStartedAt = 0;
    setStatus("Requesting microphone...");

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

    listeningStartedAt = performance.now();
    resetChart();
    appendChartPoint(listeningStartedAt, true);
    setStatus("Listening");
    startBtn.disabled = true;
    stopBtn.disabled = false;

    processAudio();
  } catch (error) {
    setStatus("Microphone access denied", true);
    console.error(error);
  }
}

function stopListening() {
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
  setStatus("Stopped");
}

function resetCounter() {
  totalPops = 0;
  popTimes = [];
  lastPopAt = 0;
  firstPopAt = 0;
  listeningStartedAt = 0;
  didAlert = false;
  alertBox.hidden = true;
  updateCounts();
  resetChart();
  if (startBtn.disabled) {
    setStatus("Listening");
  } else {
    setStatus("Idle");
  }
}

sensitivityEl.addEventListener("input", () => {
  sensitivityValueEl.value = sensitivityEl.value;
});

windowSecondsEl.addEventListener("change", updateCounts);
armingPopsEl.addEventListener("change", () => {
  const { armingPops } = getSettings();
  if (!didAlert && startBtn.disabled && totalPops < armingPops) {
    setStatus(`Warming up (${armingPops - totalPops} pops to arm)`);
  }
});
minSecondsSinceStartEl.addEventListener("change", () => {
  const { minSecondsSinceStart } = getSettings();
  if (!didAlert && startBtn.disabled) {
    const now = performance.now();
    const elapsedFromStart = listeningStartedAt ? now - listeningStartedAt : 0;
    const hasMetMinStartTime = elapsedFromStart >= minSecondsSinceStart * 1000;

    if (!hasMetMinStartTime) {
      const remainingSeconds = Math.max(0, Math.ceil((minSecondsSinceStart * 1000 - elapsedFromStart) / 1000));
      setStatus(`Warmup timer (${remainingSeconds}s remaining)`);
    }
  }
});
startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);
resetBtn.addEventListener("click", resetCounter);
window.addEventListener("resize", drawChart);

updateCounts();
resetChart();
