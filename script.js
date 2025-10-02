document.addEventListener('DOMContentLoaded', () => {
  // DOM
  const fileUpload         = document.getElementById('fileUpload');
  const gridSize           = document.getElementById('gridSize');
  const brightness         = document.getElementById('brightness');
  const contrast           = document.getElementById('contrast');
  const gamma              = document.getElementById('gamma');
  const smoothing          = document.getElementById('smoothing');
  const ditherType         = document.getElementById('ditherType');
  const resetButton        = document.getElementById('resetButton');
  const saveButton         = document.getElementById('saveButton');
  const exportType         = document.getElementById('exportType');

  const videoFrameControls = document.getElementById('videoFrameControls');
  const frameSlider        = document.getElementById('frameSlider');
  const frameTime          = document.getElementById('frameTime');
  const framePreview       = document.getElementById('framePreview');

  const gridSizeVal        = document.getElementById('gridSizeVal');
  const brightnessVal      = document.getElementById('brightnessVal');
  const contrastVal        = document.getElementById('contrastVal');
  const gammaVal           = document.getElementById('gammaVal');
  const smoothingVal       = document.getElementById('smoothingVal');

  const halftoneCanvas     = document.getElementById('halftoneCanvas');

  // State
  let imageElement = null;
  let videoElement = null;
  let isVideo = false;
  let animationFrameId = null;
  let isPaused = false;

  // Recording
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let recordingStartTime = 0;
  const recordingFPS = 60;

  // Defaults
  const defaults = {
    gridSize: 20,
    brightness: 20,
    contrast: 0,
    gamma: 1.0,
    smoothing: 0,
    ditherType: 'None'
  };

  /* ---------- helpers ---------- */
  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function updateRecordingUI(recording) {
    saveButton.textContent = recording ? 'Stop Recording' : 'Start Recording';
    saveButton.classList.toggle('recording', recording);
  }

  function setStaticExportUI(visible) {
    // Show frame controls when user wants PNG/SVG and a video is loaded
    videoFrameControls.style.display = (visible && isVideo) ? 'block' : 'none';
    saveButton.textContent = exportType.value === 'svg' ? 'Export SVG'
                         : exportType.value === 'png' ? 'Export PNG'
                         : (isRecording ? 'Stop Recording' : 'Start Recording');
  }

  /* ---------- sizing ---------- */
  function setupCanvasDimensions(originalWidth, originalHeight) {
    const container = document.querySelector('.canvas-container');
    const containerWidth  = container.clientWidth  - 32;
    const containerHeight = container.clientHeight - 32;

    const scale = Math.min(containerWidth / originalWidth, containerHeight / originalHeight);
    let newWidth = Math.round(originalWidth * scale);
    let newHeight = Math.round(originalHeight * scale);

    const minDimension = 200;
    if (newWidth < minDimension || newHeight < minDimension) {
      const minScale = minDimension / Math.min(newWidth, newHeight);
      newWidth = Math.round(newWidth * minScale);
      newHeight = Math.round(newHeight * minScale);
    }

    halftoneCanvas.width = newWidth;
    halftoneCanvas.height = newHeight;
    halftoneCanvas.style.width = `${newWidth}px`;
    halftoneCanvas.style.height = `${newHeight}px`;
    halftoneCanvas.style.position = 'absolute';
    halftoneCanvas.style.left = '50%';
    halftoneCanvas.style.top = '50%';
    halftoneCanvas.style.transform = 'translate(-50%, -50%)';

    return { width: newWidth, height: newHeight };
  }

  /* ---------- processing core (refactored for reuse) ---------- */
  function computeHalftoneData(targetWidth, targetHeight) {
    // Draw current source frame onto temp canvas
    const temp = document.createElement('canvas');
    temp.width = targetWidth;
    temp.height = targetHeight;
    const tctx = temp.getContext('2d');

    if (isVideo) tctx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);
    else tctx.drawImage(imageElement, 0, 0, targetWidth, targetHeight);

    const img = tctx.getImageData(0, 0, targetWidth, targetHeight);
    const data = img.data;

    // Adjustments
    const brightnessAdj = parseInt(brightness.value, 10);
    const contrastAdj   = parseInt(contrast.value, 10);
    const gammaValNum   = parseFloat(gamma.value);
    const contrastFactor = (259 * (contrastAdj + 255)) / (255 * (259 - contrastAdj));

    const grayData = new Float32Array(targetWidth * targetHeight);
    const lumR = 0.299, lumG = 0.587, lumB = 0.114;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      let gray = Math.pow(r/255, gammaValNum) * lumR +
                 Math.pow(g/255, gammaValNum) * lumG +
                 Math.pow(b/255, gammaValNum) * lumB;
      gray = ((gray * 255 - 128) * contrastFactor + 128 + brightnessAdj) / 255;
      gray = Math.max(0, Math.min(1, gray));
      gray = gray * (a / 255);
      grayData[i / 4] = gray * 255;
    }

    const grid = parseInt(gridSize.value, 10);
    const numCols = Math.ceil(targetWidth / grid);
    const numRows = Math.ceil(targetHeight / grid);
    let cellValues = new Float32Array(numRows * numCols);

    // Average per cell + simple edge soften
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        let sum = 0, count = 0, edgeValue = 0;
        const startY = row * grid;
        const startX = col * grid;
        const endY = Math.min(startY + grid, targetHeight);
        const endX = Math.min(startX + grid, targetWidth);

        for (let y = startY; y < endY; y++) {
          const base = y * targetWidth;
          for (let x = startX; x < endX; x++) {
            const idx = base + x;
            const val = grayData[idx];
            sum += val; count++;
            if (x < endX - 1 && y < endY - 1) {
              edgeValue += Math.abs(val - grayData[idx + 1]) + Math.abs(val - grayData[idx + targetWidth]);
            }
          }
        }
        const avgValue = sum / count;
        const edgeFactor = Math.min(1, edgeValue / (count * 255 * 0.5));
        cellValues[row * numCols + col] = avgValue * (1 - edgeFactor * 0.3);
      }
    }

    // Smoothing
    const smoothingStrength = parseFloat(smoothing.value);
    if (smoothingStrength > 0) {
      cellValues = applyEnhancedSmoothing(cellValues, numRows, numCols, smoothingStrength);
    }

    // Dithering
    const dither = ditherType.value;
    if (dither === 'FloydSteinberg') applyFloydSteinbergDithering(cellValues, numRows, numCols);
    else if (dither === 'Ordered')   applyOrderedDithering(cellValues, numRows, numCols);
    else if (dither === 'Noise')     applyNoiseDithering(cellValues, numRows, numCols);

    return { cellValues, numRows, numCols, grid, targetWidth, targetHeight };
  }

  function drawHalftoneOnCanvas(ctx, data) {
    const { cellValues, numRows, numCols, grid, targetWidth, targetHeight } = data;
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const brightnessValue = cellValues[row * numCols + col];
        const norm = brightnessValue / 255;
        const maxRadius = grid / 2;
        const radius = maxRadius * Math.pow(1 - norm, 1.2);
        if (radius > 0.5) {
          const cx = col * grid + grid / 2;
          const cy = row * grid + grid / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fillStyle = 'black';
          ctx.fill();
        }
      }
    }
  }

  function exportSVG(data) {
    const { cellValues, numRows, numCols, grid, targetWidth, targetHeight } = data;
    const parts = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${targetHeight}" viewBox="0 0 ${targetWidth} ${targetHeight}">`
    );
    parts.push(`<rect width="100%" height="100%" fill="white"/>`);

    // Build circles
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const val = cellValues[row * numCols + col];
        const norm = val / 255;
        const maxRadius = grid / 2;
        const r = maxRadius * Math.pow(1 - norm, 1.2);
        if (r > 0.5) {
          const cx = col * grid + grid / 2;
          const cy = row * grid + grid / 2;
          parts.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="black"/>`);
        }
      }
    }
    parts.push(`</svg>`);

    const blob = new Blob([parts.join('')], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'halftone.svg';
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------- dithering / smoothing ---------- */
  function applyEnhancedSmoothing(cellValues, numRows, numCols, strength) {
    let result = new Float32Array(cellValues);
    const passes = Math.floor(strength);
    const kernel = [
      [0.0625, 0.125, 0.0625],
      [0.125,  0.25,  0.125],
      [0.0625, 0.125, 0.0625]
    ];
    for (let p = 0; p < passes; p++) {
      const temp = new Float32Array(result.length);
      for (let row = 0; row < numRows; row++) {
        for (let col = 0; col < numCols; col++) {
          let sum = 0, wsum = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const r = row + ky, c = col + kx;
              if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
                const w = kernel[ky + 1][kx + 1];
                sum += result[r * numCols + c] * w;
                wsum += w;
              }
            }
          }
          temp[row * numCols + col] = sum / wsum;
        }
      }
      result = temp;
    }
    const frac = strength - Math.floor(strength);
    if (frac > 0) {
      for (let i = 0; i < result.length; i++) {
        result[i] = cellValues[i] * (1 - frac) + result[i] * frac;
      }
    }
    return result;
  }

  function applyFloydSteinbergDithering(cellValues, numRows, numCols) {
    const threshold = 128;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const idx = row * numCols + col;
        const oldVal = cellValues[idx];
        const newVal = oldVal < threshold ? 0 : 255;
        const err = oldVal - newVal;
        cellValues[idx] = newVal;
        if (col + 1 < numCols) cellValues[row * numCols + (col + 1)] += err * (7 / 16);
        if (row + 1 < numRows) {
          if (col - 1 >= 0) cellValues[(row + 1) * numCols + (col - 1)] += err * (3 / 16);
          cellValues[(row + 1) * numCols + col] += err * (5 / 16);
          if (col + 1 < numCols) cellValues[(row + 1) * numCols + (col + 1)] += err * (1 / 16);
        }
      }
    }
  }

  function applyOrderedDithering(cellValues, numRows, numCols) {
    const bayer = [[0,2],[3,1]];
    const n = 2;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const idx = row * numCols + col;
        const thr = ((bayer[row % n][col % n] + 0.5) * (255 / (n * n)));
        cellValues[idx] = cellValues[idx] < thr ? 0 : 255;
      }
    }
  }

  function applyNoiseDithering(cellValues, numRows, numCols) {
    const threshold = 128;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const idx = row * numCols + col;
        const noise = (Math.random() - 0.5) * 50;
        cellValues[idx] = (cellValues[idx] + noise) < threshold ? 0 : 255;
      }
    }
  }

  /* ---------- pipeline ---------- */
  function processFrame() {
    if (!imageElement && !videoElement) return;
    const { width, height } = halftoneCanvas;
    const data = computeHalftoneData(width, height);
    const ctx = halftoneCanvas.getContext('2d');
    drawHalftoneOnCanvas(ctx, data);
  }

  function loopVideo() {
    if (isVideo && !isPaused) processFrame();
    animationFrameId = requestAnimationFrame(loopVideo);
  }

  /* ---------- UI wiring ---------- */
  const debouncedUpdate = debounce(() => {
    gridSizeVal.textContent  = gridSize.value;
    brightnessVal.textContent = brightness.value;
    contrastVal.textContent   = contrast.value;
    gammaVal.textContent      = gamma.value;
    smoothingVal.textContent  = smoothing.value;
    processFrame();
  }, 150);

  [gridSize, brightness, contrast, gamma, smoothing].forEach(el =>
    el.addEventListener('input', debouncedUpdate)
  );
  ditherType.addEventListener('change', debouncedUpdate);

  // File upload
  fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);

    // reset UI
    exportType.value = file.type.startsWith('video/') ? 'video' : 'png';
    setStaticExportUI(exportType.value !== 'video');

    if (file.type.startsWith('video/')) {
      isVideo = true;
      if (!videoElement) videoElement = document.createElement('video');
      videoElement.src = url;
      videoElement.crossOrigin = 'anonymous';
      videoElement.autoplay = true;
      videoElement.loop = true;
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.setAttribute('webkit-playsinline', 'true');

      videoElement.addEventListener('loadedmetadata', () => {
        setupCanvasDimensions(videoElement.videoWidth, videoElement.videoHeight);
        frameSlider.min = 0;
        frameSlider.max = videoElement.duration;
        frameSlider.step = 0.1;

        if (exportType.value !== 'video') {
          videoElement.pause();
          isPaused = true;
          updateFramePreview();
          processFrame();
        } else {
          isPaused = false;
          videoElement.play();
          loopVideo();
        }
      }, { once: true });

      videoElement.addEventListener('timeupdate', () => {
        if (isPaused || exportType.value !== 'video') {
          updateFramePreview();
          processFrame();
        }
      });

    } else {
      // image
      isVideo = false;
      if (videoElement) {
        cancelAnimationFrame(animationFrameId);
        videoElement.pause();
      }
      imageElement = new Image();
      imageElement.src = url;
      imageElement.onload = () => {
        setupCanvasDimensions(imageElement.width, imageElement.height);
        processFrame();
      };
    }
  });

  // Frame controls for static exporting from videos
  function updateFramePreview() {
    if (!videoElement || !isVideo) return;
    const time = parseFloat(frameSlider.value);
    videoElement.currentTime = time;

    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    frameTime.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;

    const container = framePreview.parentElement;
    const cw = container.clientWidth - 16;
    const ch = container.clientHeight - 16;
    const ar = videoElement.videoWidth / videoElement.videoHeight;

    let pw, ph;
    if (cw / ch > ar) { ph = ch; pw = ch * ar; } else { pw = cw; ph = cw / ar; }

    framePreview.width = Math.round(pw);
    framePreview.height = Math.round(ph);
    framePreview.style.position = 'absolute';
    framePreview.style.left = '50%';
    framePreview.style.top = '50%';
    framePreview.style.transform = 'translate(-50%, -50%)';

    const ctx = framePreview.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, framePreview.width, framePreview.height);
  }

  frameSlider.addEventListener('input', () => {
    if (!videoElement) return;
    isPaused = true;
    videoElement.pause();
    requestAnimationFrame(updateFramePreview);
  });

  // Export type switch
  exportType.addEventListener('change', () => {
    const isStatic = exportType.value !== 'video';
    setStaticExportUI(isStatic);

    if (isVideo) {
      if (isStatic) {
        videoElement.pause();
        isPaused = true;
        updateFramePreview();
        processFrame();
      } else {
        isPaused = false;
        videoElement.play();
        loopVideo();
      }
    }
  });

  // Export button
  saveButton.addEventListener('click', () => {
    if (!imageElement && !videoElement) return;

    if (exportType.value === 'png') {
      // Render at 2x for crisper raster export
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = halftoneCanvas.width * 2;
      exportCanvas.height = halftoneCanvas.height * 2;
      const data = computeHalftoneData(exportCanvas.width, exportCanvas.height);
      const ctx = exportCanvas.getContext('2d');
      drawHalftoneOnCanvas(ctx, data);
      const url = exportCanvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'halftone.png';
      a.click();

    } else if (exportType.value === 'svg') {
      const data = computeHalftoneData(halftoneCanvas.width, halftoneCanvas.height);
      exportSVG(data);

    } else if (exportType.value === 'video' && isVideo) {
      if (!isRecording) startVideoRecording(); else stopVideoRecording();
    }
  });

  // Reset
  resetButton.addEventListener('click', () => {
    gridSize.value = defaults.gridSize;
    brightness.value = defaults.brightness;
    contrast.value = defaults.contrast;
    gamma.value = defaults.gamma;
    smoothing.value = defaults.smoothing;
    ditherType.value = defaults.ditherType;
    debouncedUpdate();
  });

  // Resize
  window.addEventListener('resize', debounce(() => {
    if (videoElement && isVideo) setupCanvasDimensions(videoElement.videoWidth, videoElement.videoHeight);
    else if (imageElement) setupCanvasDimensions(imageElement.width, imageElement.height);
    processFrame();
  }, 250));

  // Init canvas (blank)
  setupCanvasDimensions(800, 600);
  const initCtx = halftoneCanvas.getContext('2d');
  initCtx.fillStyle = '#fff';
  initCtx.fillRect(0, 0, halftoneCanvas.width, halftoneCanvas.height);

  /* ---------- recording (video) ---------- */
  function startVideoRecording() {
    if (!('MediaRecorder' in window)) {
      alert('MediaRecorder is not supported in this browser.');
      return;
    }
    // restart from beginning for consistency
    try { videoElement.currentTime = 0; } catch {}
    videoElement.play();

    const stream = halftoneCanvas.captureStream(recordingFPS);
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 5_000_000
    });

    recordedChunks = [];
    isRecording = true;
    recordingStartTime = Date.now();
    updateRecordingUI(true);

    // UI overlays
    const timeEl = document.createElement('div');
    timeEl.id = 'recordingTime';
    timeEl.style.cssText = 'position:absolute;top:10px;left:10px;background:rgba(0,0,0,.7);color:#fff;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:14px;';
    const infoEl = document.createElement('div');
    infoEl.id = 'recordingInfo';
    infoEl.style.cssText = 'position:absolute;top:10px;right:10px;background:rgba(0,0,0,.7);color:#fff;padding:8px 12px;border-radius:4px;font-family:monospace;font-size:14px;';
    halftoneCanvas.parentElement.appendChild(timeEl);
    halftoneCanvas.parentElement.appendChild(infoEl);

    function tick() {
      if (!isRecording) return;
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      const total = Math.floor(videoElement.duration || 0);
      const tm = Math.floor(total / 60);
      const ts = total % 60;
      timeEl.textContent = `Recording: ${m}:${s.toString().padStart(2,'0')} / ${tm}:${ts.toString().padStart(2,'0')}`;
      const sizeMB = (recordedChunks.reduce((sum, c) => sum + c.size, 0) / (1024*1024)).toFixed(1);
      infoEl.textContent = `FPS: ${recordingFPS} | Size: ${sizeMB}MB`;
      requestAnimationFrame(tick);
    }
    tick();

    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'halftone-video.webm';
      a.click();
      URL.revokeObjectURL(url);
      isRecording = false;
      updateRecordingUI(false);
      timeEl.remove(); infoEl.remove();
    };
    mediaRecorder.start(1000);
    loopVideo();
  }

  function stopVideoRecording() {
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
      updateRecordingUI(false);
      const t = document.getElementById('recordingTime');
      const i = document.getElementById('recordingInfo');
      if (t) t.remove();
      if (i) i.remove();
    }
  }
});
