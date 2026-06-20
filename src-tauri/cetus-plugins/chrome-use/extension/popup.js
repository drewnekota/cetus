const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");

function setOutput(value) {
  outputEl.textContent = JSON.stringify(value, null, 2);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  statusEl.textContent = response.nativeReady
    ? "Connected to Cetus native host."
    : "Extension loaded. Cetus native host is not connected yet.";
  setOutput(response);
}

document.getElementById("connect").addEventListener("click", () => {
  send({ type: "connect_native" }).catch((error) => setOutput({ error: String(error) }));
});

document.getElementById("snapshot").addEventListener("click", () => {
  send({ type: "active_tab_snapshot" }).catch((error) => setOutput({ error: String(error) }));
});

document.getElementById("tabs").addEventListener("click", () => {
  send({ type: "list_tabs" }).catch((error) => setOutput({ error: String(error) }));
});

send({ type: "status" }).catch((error) => setOutput({ error: String(error) }));
