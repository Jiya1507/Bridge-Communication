import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';

/**
 * Browser-only MediaPipe hand tracker plus a small rule-based gesture demo.
 * IMPORTANT: this is not a trained/validated ISL recognition model.
 * For production, replace classifySequence() with an exported ML model trained
 * on a properly labelled ISL dataset while keeping the same callback contract.
 */
export class LiveSignMLEngine {
  constructor(config = {}) {
    this.videoElement = config.videoElement;
    this.canvasElement = config.canvasElement;
    this.ctx = this.canvasElement?.getContext('2d') ?? null;
    this.onPredictionCallback = config.onPredictionCallback;
    this.onStateChangeCallback = config.onStateChangeCallback;

    this.SEQUENCE_LENGTH = 24;
    this.FEATURE_COUNT = 63;
    this.CONFIDENCE_THRESHOLD = 0.74;
    this.STABILITY_FRAMES_REQUIRED = 5;
    this.COOLDOWN_MS = 1400;

    this.handLandmarker = null;
    this.labels = ['HELLO', 'THANK_YOU', 'HELP', 'WATER', 'YES', 'NO', 'NO_SIGN'];
    this.temporalBuffer = [];
    this.wristHistory = [];
    this.recentPredictions = [];
    this.lastTriggeredTime = 0;
    this.isProcessing = false;
    this.lastVideoTime = -1;
  }

  async initialize() {
    this.notifyState({ status: 'Loading MediaPipe hand model…', modelReady: false, handDetected: false });
    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );

      const commonOptions = {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55
      };

      try {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, commonOptions);
      } catch (gpuError) {
        console.warn('GPU delegate unavailable; retrying on CPU.', gpuError);
        commonOptions.baseOptions.delegate = 'CPU';
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, commonOptions);
      }

      this.notifyState({ status: 'Hand tracking ready', modelReady: true, handDetected: false });
      return true;
    } catch (error) {
      console.error('MediaPipe initialization failed:', error);
      this.notifyState({ status: 'Hand engine failed to load', modelReady: false, handDetected: false, error });
      return false;
    }
  }

  start() {
    if (this.isProcessing || !this.handLandmarker) return;
    this.isProcessing = true;
    this.processLoop();
  }

  stop() {
    this.isProcessing = false;
    this.temporalBuffer = [];
    this.wristHistory = [];
    this.recentPredictions = [];
    this.clearCanvas();
  }

  processLoop() {
    if (!this.isProcessing) return;

    const videoReady = this.videoElement && this.videoElement.readyState >= 2;
    if (videoReady && this.videoElement.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.videoElement.currentTime;
      try {
        const result = this.handLandmarker.detectForVideo(this.videoElement, performance.now());
        const landmarks = result?.landmarks?.[0];

        if (landmarks) {
          this.renderLandmarkSkeleton(landmarks);
          this.pushToBuffer(this.normalizeLandmarks(landmarks));
          this.pushWrist(landmarks[0]);
          this.notifyState({ status: 'Hand detected · demo gesture classifier active', modelReady: true, handDetected: true });

          if (this.temporalBuffer.length >= 8) this.classifySequence(landmarks);
        } else {
          this.clearCanvas();
          this.temporalBuffer = [];
          this.wristHistory = [];
          this.applyHysteresis('NO_SIGN', 0);
          this.notifyState({ status: 'Show one hand to the camera', modelReady: true, handDetected: false });
        }
      } catch (error) {
        console.error('Frame processing error:', error);
      }
    }

    requestAnimationFrame(() => this.processLoop());
  }

  normalizeLandmarks(landmarks) {
    const wrist = landmarks[0];
    const translated = landmarks.map((point) => ({
      x: point.x - wrist.x,
      y: point.y - wrist.y,
      z: point.z - wrist.z
    }));

    const maxDist = Math.max(
      1e-6,
      ...translated.map((point) => Math.hypot(point.x, point.y, point.z))
    );

    return translated.flatMap((point) => [point.x / maxDist, point.y / maxDist, point.z / maxDist]);
  }

  pushToBuffer(vector) {
    this.temporalBuffer.push(vector);
    while (this.temporalBuffer.length > this.SEQUENCE_LENGTH) this.temporalBuffer.shift();
  }

  pushWrist(wrist) {
    this.wristHistory.push({ x: wrist.x, y: wrist.y, t: performance.now() });
    while (this.wristHistory.length > 12) this.wristHistory.shift();
  }

  fingerExtended(landmarks, tip, pip) {
    return landmarks[tip].y < landmarks[pip].y;
  }

  classifySequence(landmarks) {
    const index = this.fingerExtended(landmarks, 8, 6);
    const middle = this.fingerExtended(landmarks, 12, 10);
    const ring = this.fingerExtended(landmarks, 16, 14);
    const pinky = this.fingerExtended(landmarks, 20, 18);

    const thumbTip = landmarks[4];
    const thumbIP = landmarks[3];
    const wrist = landmarks[0];
    const thumbUp = thumbTip.y < thumbIP.y && thumbTip.y < landmarks[5].y;
    const extendedCount = [index, middle, ring, pinky].filter(Boolean).length;

    let horizontalTravel = 0;
    let verticalTravel = 0;
    if (this.wristHistory.length >= 5) {
      const first = this.wristHistory[0];
      const last = this.wristHistory[this.wristHistory.length - 1];
      horizontalTravel = Math.abs(last.x - first.x);
      verticalTravel = Math.abs(last.y - first.y);
    }

    let predictedClass = 'NO_SIGN';
    let confidence = 0.48;

    // These are intentionally simple demo heuristics, not linguistic validation.
    if (extendedCount === 4 && horizontalTravel > 0.045) {
      predictedClass = 'HELLO';
      confidence = 0.90;
    } else if (extendedCount === 4 && wrist.y > 0.56 && verticalTravel > 0.02) {
      predictedClass = 'THANK_YOU';
      confidence = 0.82;
    } else if (index && middle && ring && !pinky) {
      predictedClass = 'WATER';
      confidence = 0.86;
    } else if (thumbUp && extendedCount === 0) {
      predictedClass = 'HELP';
      confidence = 0.89;
    } else if (!thumbUp && extendedCount === 0 && verticalTravel > 0.02) {
      predictedClass = 'YES';
      confidence = 0.80;
    } else if (index && middle && !ring && !pinky) {
      predictedClass = 'NO';
      confidence = 0.78;
    } else if (extendedCount === 4) {
      predictedClass = 'HELLO';
      confidence = 0.76;
    }

    this.applyHysteresis(predictedClass, confidence);
  }

  applyHysteresis(predictedClass, confidence) {
    const now = Date.now();

    if (confidence < this.CONFIDENCE_THRESHOLD || predictedClass === 'NO_SIGN') {
      this.recentPredictions = [];
      this.emitPrediction('NO_SIGN', 0, false);
      return;
    }

    this.recentPredictions.push(predictedClass);
    while (this.recentPredictions.length > this.STABILITY_FRAMES_REQUIRED) this.recentPredictions.shift();

    const isStable = this.recentPredictions.length === this.STABILITY_FRAMES_REQUIRED &&
      this.recentPredictions.every((value) => value === predictedClass);

    if (isStable && now - this.lastTriggeredTime > this.COOLDOWN_MS) {
      this.lastTriggeredTime = now;
      this.recentPredictions = [];
      this.emitPrediction(predictedClass, confidence, true);
    } else {
      this.emitPrediction(predictedClass, confidence, false);
    }
  }

  emitPrediction(predictedClass, confidence, isStable) {
    this.onPredictionCallback?.({
      predictedClass,
      confidence,
      isStable,
      distribution: this.labels.map((label) => ({
        label,
        confidence: label === predictedClass ? Math.round(confidence * 100) : (predictedClass === 'NO_SIGN' && label === 'NO_SIGN' ? 100 : 1)
      }))
    });
  }

  renderLandmarkSkeleton(landmarks) {
    if (!this.ctx || !this.canvasElement) return;
    const w = this.canvasElement.width;
    const h = this.canvasElement.height;
    this.ctx.clearRect(0, 0, w, h);

    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];

    this.ctx.strokeStyle = '#818cf8';
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = 'round';
    for (const [start, end] of connections) {
      const p1 = landmarks[start];
      const p2 = landmarks[end];
      this.ctx.beginPath();
      this.ctx.moveTo((1 - p1.x) * w, p1.y * h);
      this.ctx.lineTo((1 - p2.x) * w, p2.y * h);
      this.ctx.stroke();
    }

    this.ctx.fillStyle = '#34d399';
    for (const point of landmarks) {
      this.ctx.beginPath();
      this.ctx.arc((1 - point.x) * w, point.y * h, 4, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  clearCanvas() {
    if (this.ctx && this.canvasElement) {
      this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
    }
  }

  notifyState(state) {
    this.onStateChangeCallback?.(state);
  }
}
