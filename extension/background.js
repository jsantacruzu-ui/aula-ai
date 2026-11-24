
"use strict";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Aula AI: extensión instalada correctamente.");
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Aula AI: Chrome iniciado.");
});

// Comprueba que el servicio de fondo esté activo.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AULA_BACKGROUND_PING") {
    sendResponse({
      ready: true,
      name: "Aula AI"
    });
  }

  return false;
});
