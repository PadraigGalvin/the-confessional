// Camera and microphone helpers shared by the booth and the settings page,
// so the settings preview hears exactly what the booth records.

import { STRINGS } from './strings.js';

export function mediaConstraints(cameraId, microphoneId) {
  return {
    video: { deviceId: cameraId && { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    // Nothing plays through the speakers, so echo cancellation would only degrade the audio.
    // Auto gain is off because Chrome implements it by turning up the system mic volume,
    // which over a weekend ends up maxed out and recording mostly fan noise.
    // Noise suppression stays on to tame fan hum and party chatter.
    audio: {
      deviceId: microphoneId && { exact: microphoneId },
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: true,
    },
  };
}

// `name` is part of a device label, as set in config.json. An exact match wins, so the
// full label saved by the settings page never picks Windows' "Default - <label>" entry.
export function findDevice(devices, kind, name) {
  if (!name) return undefined;
  const candidates = devices.filter((d) => d.kind === kind);
  return candidates.find((d) => d.label === name) ??
    candidates.find((d) => d.label.toLowerCase().includes(name.toLowerCase()));
}

// `text` is the guest's strings from strings.js. The settings page leaves it as English.
export function cameraErrorMessage(err, text = STRINGS.en) {
  switch (err?.name) {
    case 'NotAllowedError':
      return text.cameraBlocked;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return text.cameraMissing;
    case 'NotReadableError':
      return text.cameraBusy;
    default:
      return text.cameraFailed(err?.message ?? text.unknownError);
  }
}
