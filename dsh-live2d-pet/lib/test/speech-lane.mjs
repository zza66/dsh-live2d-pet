// src/client/speech-lane.ts
function normalizeRequest(input) {
  if (typeof input === "string") {
    return input.trim() === "" ? null : { text: input };
  }
  if (input === null || typeof input !== "object") {
    return null;
  }
  if (typeof input.text !== "string" || input.text.trim() === "") {
    return null;
  }
  const request = { text: input.text };
  if (typeof input.voice === "string" && input.voice.trim() !== "") {
    request.voice = input.voice;
  }
  if (typeof input.rate === "string" && input.rate.trim() !== "") {
    request.rate = input.rate;
  }
  return request;
}
var WAIT_GRACE_MS = 2e3;
var WAIT_MAX_MS = 3e5;
function waitForPlayer(player, options) {
  if (player === null || player === void 0) return Promise.resolve();
  if (!player.state.speaking) return Promise.resolve();
  const graceMs = options?.graceMs ?? WAIT_GRACE_MS;
  const maxMs = options?.maxMs ?? WAIT_MAX_MS;
  const durationMs = Number(player.state.durationSeconds);
  const budget = Math.min(Math.max(Number.isFinite(durationMs) && durationMs > 0 ? durationMs * 1e3 : 0, graceMs), maxMs);
  return new Promise((resolve) => {
    let settled = false;
    let off = () => {
    };
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve();
    };
    off = player.subscribe(() => {
      if (!player.state.speaking) finish();
    });
    if (!player.state.speaking) finish();
    timer = setTimeout(finish, budget);
  });
}
function createSpeechLane(hooks) {
  const queue = [];
  let generation = 0;
  let running = false;
  const report = (error) => {
    try {
      hooks.onError?.(error);
    } catch {
    }
  };
  const notify = (hook, request) => {
    try {
      hook?.(request);
    } catch (error) {
      report(error);
    }
  };
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const gen = generation;
        const request = queue.shift();
        const isCancelled = () => gen !== generation;
        try {
          await hooks.speak(request, isCancelled);
        } catch (error) {
          report(error);
          continue;
        }
        if (isCancelled()) continue;
        notify(hooks.onStart, request);
        try {
          await hooks.waitUntilDone();
        } catch (error) {
          report(error);
        }
        notify(hooks.onSettled, request);
      }
    } finally {
      running = false;
    }
  }
  return {
    enqueue(input) {
      const request = normalizeRequest(input);
      if (request === null) return;
      queue.push(request);
      void pump();
    },
    stopAll() {
      generation += 1;
      queue.length = 0;
      try {
        hooks.stop();
      } catch (error) {
        report(error);
      }
    },
    queued: () => queue.length,
    busy: () => running
  };
}
function speakWithInterrupt(lane, text, options) {
  if (options?.interrupt !== false) {
    lane.stopAll();
  }
  lane.enqueue({ text, voice: options?.voice, rate: options?.rate });
}
export {
  createSpeechLane,
  speakWithInterrupt,
  waitForPlayer
};
