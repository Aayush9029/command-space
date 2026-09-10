const api = globalThis.browser || chrome;
api.runtime.sendMessage({type:"status"}).then(result => {
  document.querySelector("#status").textContent = result.connected ? "Connected to your desktop" : "Install Super Space on this computer to connect";
});
