// src/client/report.ts
var ERROR_ENDPOINT = "/.dsh-live2d-pet/client-error";
var LAST_MESSAGE_CHARS = 140;
var counters = {
  total: 0,
  delivered: 0,
  failed: 0,
  fetchTried: 0,
  fetchOk: 0,
  beaconTried: 0,
  beaconOk: 0
};
var lastScope = "";
var lastMessage = "";
var lastAt = 0;
function viaBeacon(payload) {
  try {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
    counters.beaconTried += 1;
    if (navigator.sendBeacon(ERROR_ENDPOINT, new Blob([payload], { type: "application/json" }))) {
      counters.beaconOk += 1;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
function settleFailed(payload) {
  if (viaBeacon(payload)) counters.delivered += 1;
  else counters.failed += 1;
}
function reportFailure(scope, error) {
  try {
    const err = error;
    const message = err?.message ?? String(error);
    const payload = JSON.stringify({
      scope,
      message,
      stack: typeof err?.stack === "string" ? err.stack : ""
    });
    counters.total += 1;
    lastScope = scope;
    lastMessage = message.length > LAST_MESSAGE_CHARS ? `${message.slice(0, LAST_MESSAGE_CHARS)}…` : message;
    lastAt = Date.now();
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      settleFailed(payload);
    };
    if (typeof fetch !== "function") {
      fail();
      return;
    }
    counters.fetchTried += 1;
    try {
      fetch(ERROR_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).then(
        (res) => {
          if (settled) return;
          settled = true;
          if (res.ok) {
            counters.fetchOk += 1;
            counters.delivered += 1;
          } else {
            settleFailed(payload);
          }
        },
        () => {
          fail();
        }
      );
    } catch {
      fail();
    }
  } catch {
  }
}
function reportQuerySuffix() {
  const c = counters;
  let out = `&rTotal=${String(c.total)}&rOk=${String(c.delivered)}&rFail=${String(c.failed)}&rFetchTry=${String(c.fetchTried)}&rFetchOk=${String(c.fetchOk)}&rBeaconTry=${String(c.beaconTried)}&rBeaconOk=${String(c.beaconOk)}`;
  if (lastScope !== "") {
    out += `&rLast=${encodeURIComponent(lastScope)}&rAt=${String(lastAt)}`;
    if (lastMessage !== "") out += `&rMsg=${encodeURIComponent(lastMessage)}`;
  }
  return out;
}
function reportSnapshot() {
  return { ...counters, lastScope, lastMessage, lastAt };
}
export {
  reportFailure,
  reportQuerySuffix,
  reportSnapshot
};
