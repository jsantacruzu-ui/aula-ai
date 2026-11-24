
// ==UserScript==
// @name         Aula AI - Asistente multimedia
// @namespace    https://aula-ai.jsantacruzu.workers.dev/
// @version      0.3.17
// @description  Asistente que reproduce y escucha audio, analiza imágenes y vídeos y responde actividades.
// @author       Aula AI
// @homepageURL  https://aula-ai.jsantacruzu.workers.dev/
// @supportURL   https://github.com/jsantacruzu-ui/aula-ai
// @updateURL    https://raw.githubusercontent.com/jsantacruzu-ui/aula-ai/main/aula-ai/aula-ai.user.js
// @downloadURL  https://raw.githubusercontent.com/jsantacruzu-ui/aula-ai/main/aula-ai/aula-ai.user.js
// @match        http://*/*
// @match        https://*/*
// @exclude      https://app.hubspot.com/*
// @all-frames   true
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      olkhplrgtcxrrnpmbjgd.supabase.co
// @connect      aula-ai.jsantacruzu.workers.dev
// @connect      content.cambridgeone.org
// @connect      assets.cambridgeone.org
// @connect      www.cambridgeone.org
// ==/UserScript==

(() => {
  "use strict";

  const SUPABASE =
    "https://olkhplrgtcxrrnpmbjgd.supabase.co";

  const WORKER =
    "https://aula-ai.jsantacruzu.workers.dev/api/solve";

  const TOKEN_KEY = "aula_access_token";
  const REFRESH_KEY = "aula_refresh_token";
  const EMAIL_KEY = "aula_email";

  const MAX_IMAGES = 4;
  const MAX_IMAGE_SIZE = 1100000;
  const MAX_AUDIO_MS = 90000;
  const MAX_AUDIO_BYTES = 1800000;

  // Conserva referencias reales a controles, incluso si están dentro
  // de un iframe accesible. querySelector del documento principal no basta.
  const indexedControls = new Map();
  const dropdownElementIds = new WeakMap();
  let nextDropdownElementId = 1;

  const TOP = window.top === window.self;

  let stopRequested = false;
  let activeRunId = "";
  let setPanelStatus = () => {};
  let tabAudioStream = null;

  // ==========================================
  // CONEXIÓN CON AULA AI
  // ==========================================

  function request(method, url, body, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          "Content-Type": "application/json",

          ...(token ? {
            Authorization: `Bearer ${token}`
          } : {}),

          ...(url.startsWith(SUPABASE) ? {
            apikey:
              "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV"
          } : {})
        },

        data: body ? JSON.stringify(body) : undefined,
        timeout: 120000,

        onload: response => {
          let data;

          try {
            data = JSON.parse(
              response.responseText || "{}"
            );
          } catch {
            reject(
              new Error("El servidor devolvió una respuesta no válida.")
            );
            return;
          }

          if (
            response.status < 200 ||
            response.status >= 300
          ) {
            reject(
              new Error(
                data.error_description ||
                data.msg ||
                data.message ||
                data.error ||
                `Error HTTP ${response.status}`
              )
            );
            return;
          }

          resolve(data);
        },

        onerror: () => {
          reject(
            new Error("No se pudo conectar con el servidor.")
          );
        },

        ontimeout: () => {
          reject(
            new Error("La solicitud tardó demasiado.")
          );
        }
      });
    });
  }

  async function login(email, password) {
    const data = await request(
      "POST",
      `${SUPABASE}/auth/v1/token?grant_type=password`,
      { email, password }
    );

    await GM_setValue(
      TOKEN_KEY,
      data.access_token
    );

    await GM_setValue(
      REFRESH_KEY,
      data.refresh_token
    );

    await GM_setValue(
      EMAIL_KEY,
      data.user?.email || email
    );
  }

  async function getToken() {
    let token = await GM_getValue(TOKEN_KEY, "");
    const refresh = await GM_getValue(REFRESH_KEY, "");

    if (!token) {
      throw new Error("Inicia sesión en Aula AI.");
    }

    try {
      await request(
        "GET",
        `${SUPABASE}/auth/v1/user`,
        null,
        token
      );

      return token;

    } catch {
      if (!refresh) {
        throw new Error(
          "Tu sesión ha vencido. Inicia sesión nuevamente."
        );
      }

      const data = await request(
        "POST",
        `${SUPABASE}/auth/v1/token?grant_type=refresh_token`,
        { refresh_token: refresh }
      );

      token = data.access_token;

      await GM_setValue(TOKEN_KEY, token);
      await GM_setValue(REFRESH_KEY, data.refresh_token);

      return token;
    }
  }

  // ==========================================
  // ELEMENTOS Y DOCUMENTOS
  // ==========================================

  function isVisible(element) {
    try {
      // Importante: Cambridge One coloca la actividad dentro de un
      // iframe. Obtener estilos desde la ventana propietaria evita
      // problemas al consultar elementos de otro documento.
      const view = element.ownerDocument?.defaultView || window;
      const rect = element.getBoundingClientRect();
      const style = view.getComputedStyle(element);

      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) <= 0
      ) {
        return false;
      }

      // No exigimos que el INPUT interno esté visible: Cambridge dibuja
      // la opción en un DIV con role="radio" y oculta el input real.
      if (
        element.getAttribute("role") === "radio" ||
        element.getAttribute("role") === "checkbox" ||
        element.getAttribute("role") === "option"
      ) {
        return true;
      }

      return true;
    } catch {
      return false;
    }
  }

  // Recorre el documento actual, sus Shadow DOM abiertos y los
  // iframes del mismo origen. Así se puede leer la actividad de Cambridge
  // aunque esté incrustada dentro de otro marco.
  function getRoots() {
    const roots = [document];
    const visited = new Set();

    while (roots.length) {
      const root = roots.shift();

      if (!root || visited.has(root)) continue;
      visited.add(root);

      if (!root.querySelectorAll) continue;

      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);

        if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
          try {
            const childDocument = element.contentDocument;
            if (childDocument && !visited.has(childDocument)) {
              roots.push(childDocument);
            }
          } catch {
            // Los marcos de otro origen no se pueden inspeccionar desde aquí.
          }
        }
      }
    }

    return [...visited];
  }

  function allElements(selector) {
    const elements = [];

    for (const root of getRoots()) {
      elements.push(
        ...root.querySelectorAll(selector)
      );
    }

    return [...new Set(elements)];
  }

  function isCustomDropdown(element) {
    if (!element || !element.matches) return false;

    // Las opciones y elementos del menú no son cuadros que debamos abrir.
    if (element.matches('[role="option"],[role="menuitem"],[data-value],li[tabindex]')) {
      return false;
    }

    const role = (element.getAttribute("role") || "").toLowerCase();
    const popup = (element.getAttribute("aria-haspopup") || "").toLowerCase();
    const classes = String(element.className || "").toLowerCase();
    const testId = (element.getAttribute("data-testid") || "").toLowerCase();

    if (
      role === "combobox" ||
      popup === "listbox" ||
      popup === "menu"
    ) return true;

    // No confundir las filas de opciones con el botón que abre el menú.
    if (/option|menuitem|dropdown-item|select-item|list-item/.test(classes + " " + testId)) {
      return false;
    }

    const classSuggestsDropdown =
      /select|dropdown|combobox/.test(classes) ||
      /select|dropdown|combobox/.test(testId);

    if (!classSuggestsDropdown) return false;

    const interactive =
      element.matches('button,[role="button"],input,[tabindex]') ||
      element.ownerDocument?.defaultView?.getComputedStyle(element).cursor === "pointer";

    return !!interactive;
  }

  function dropdownStableKey(element) {
    const text = (
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.textContent ||
      ""
    ).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);

    let uniqueId = dropdownElementIds.get(element);
    if (!uniqueId) {
      uniqueId = nextDropdownElementId++;
      dropdownElementIds.set(element, uniqueId);
    }

    const id = element.id || "";
    const classes = String(element.className || "").toLowerCase().slice(0, 100);
    return [uniqueId, element.tagName, id, text, classes].join("|");
  }

  function getCustomDropdownOptions(element) {
    if (!element) return [];

    const doc = element.ownerDocument || document;
    const containers = [];
    const references = [
      element.getAttribute("aria-controls"),
      element.getAttribute("aria-owns")
    ].filter(Boolean);

    for (const reference of references) {
      for (const id of reference.split(/\s+/)) {
        const target = doc.getElementById(id);
        if (target) containers.push(target);
      }
    }

    if (!containers.length) {
      containers.push(
        ...[...doc.querySelectorAll(
          '[role="listbox"],[role="menu"],[class*="dropdown-menu" i],[class*="select-menu" i]'
        )].filter(isVisible)
      );
    }

    const seen = new Set();
    const options = [];

    for (const container of containers) {
      const candidates = container.matches(
        '[role="option"],[role="menuitem"],option,li,[data-value],button'
      )
        ? [container]
        : [...container.querySelectorAll(
            '[role="option"],[role="menuitem"],option,li,[data-value],button'
          )];

      for (const option of candidates) {
        if (seen.has(option) || !isVisible(option)) continue;
        seen.add(option);

        const text = String(
          option.innerText ||
          option.textContent ||
          option.getAttribute("aria-label") ||
          option.getAttribute("data-value") ||
          ""
        ).trim();

        if (!text) continue;

        options.push({
          text: text.slice(0, 180),
          value: String(
            option.value ??
            option.getAttribute("data-value") ??
            option.getAttribute("aria-label") ??
            text
          ).slice(0, 180)
        });
      }
    }

    return options.slice(0, 40);
  }

  function openNextDropdown(openedDropdownKeys) {
    // No abrir otra lista mientras ya haya un menú de opciones visible.
    const visibleMenu = allElements(
      '[role="listbox"],[role="menu"],[class*="dropdown-menu" i],[class*="select-menu" i]'
    ).some(isVisible);

    if (visibleMenu) return "";

    const candidates = allElements(
      'select,[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="menu"],button,[role="button"],[class*="dropdown" i],[class*="select" i]'
    ).filter(element =>
      isVisible(element) &&
      isCustomDropdown(element) &&
      element.getAttribute("aria-expanded") !== "true" &&
      !openedDropdownKeys.has(dropdownStableKey(element))
    );

    const dropdown = candidates[0];
    if (!dropdown) return "";

    const label = (
      dropdown.getAttribute("aria-label") ||
      dropdown.innerText ||
      dropdown.textContent ||
      "lista de respuestas"
    ).trim().slice(0, 120);

    dropdown.click();
    openedDropdownKeys.add(dropdownStableKey(dropdown));
    return label;
  }

  function collectPage() {
    const roots = getRoots();
    const textParts = [];
    const controls = [];
    const seen = new Set();

    // Los índices se reconstruyen en cada pregunta para no reutilizar
    // referencias antiguas cuando Cambridge cambia de ejercicio.
    indexedControls.clear();

    const selector = [
      'input:not([type="hidden"])',
      "textarea",
      "select",
      '[contenteditable="true"]',
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="combobox"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listbox"] li',
      '[role="menu"] li',
      '[class*="dropdown-menu" i] li',
      '[class*="select-menu" i] li',
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="menu"]',
      '[data-value]',
      'li[tabindex]',
      "[aria-checked]",
      "[aria-selected]",
      "[aria-pressed]",
      "button",
      '[role="button"]'
    ].join(",");

    for (const root of roots) {
      const text = (
        root.innerText ||
        root.textContent ||
        ""
      ).trim();

      if (text) {
        textParts.push(text.slice(0, 9000));
      }

      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element) || !isVisible(element)) {
          continue;
        }

        seen.add(element);

        const index = controls.length;

        element.setAttribute(
          "data-aula-ai-index",
          String(index)
        );
        indexedControls.set(index, element);

        const tag = element.tagName.toLowerCase();

        let label =
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("placeholder") ||
          "";

        if (!label && element.labels?.length) {
          label = [...element.labels]
            .map(item =>
              item.innerText || item.textContent || ""
            )
            .join(" ");
        }

        if (!label) {
          const parent = element.closest(
            'label,[role="radio"],[role="checkbox"],[role="option"],button,[role="button"]'
          );

          label =
            parent?.innerText ||
            element.innerText ||
            element.textContent ||
            element.parentElement?.innerText ||
            "";
        }

        const customDropdown = isCustomDropdown(element);

        const options = tag === "select"
          ? [...element.options]
              .map(option => ({
                text: option.text.trim(),
                value: option.value
              }))
              .filter(option => option.text)
          : customDropdown
          ? getCustomDropdownOptions(element)
          : [];

        controls.push({
          control_index: index,

          type:
            tag === "input"
              ? element.type || "text"
              : tag === "textarea"
              ? "textarea"
              : tag === "select"
              ? "select"
              : customDropdown
              ? "combobox"
              : element.getAttribute("role") ||
                (
                  element.isContentEditable
                    ? "contenteditable"
                    : tag
                ),

          dropdown: customDropdown,
          expanded: element.getAttribute("aria-expanded"),
          label: String(label).trim().slice(0, 220),
          value: element.value || "",
          placeholder:
            element.getAttribute("placeholder") || "",
          options,
          disabled: !!element.disabled,
          checked:
            element.getAttribute("aria-checked") === "true" ||
            element.getAttribute("aria-selected") === "true" ||
            !!element.checked
        });
      }
    }

    return {
      title: document.title || "Actividad",
      pageText: [...new Set(textParts)]
        .join("\n\n")
        .slice(0, 14000),

      controls: controls.slice(0, 100),

      diagnostics: {
        url: location.href,
        frames:
          document.querySelectorAll("iframe,frame").length,
        images: allElements("img").length,
        canvases: allElements("canvas").length,
        audios: allElements("audio").length,
        videos: allElements("video").length
      }
    };
  }

  // ==========================================
  // DETECCIÓN DEL REPRODUCTOR
  // ==========================================

  function findMedia() {
    const candidates = allElements("audio,video")
      .filter(media =>
        !media.error &&
        (
          media.currentSrc ||
          media.src ||
          media.readyState > 0
        )
      );

    candidates.sort((a, b) => {
      const score = media =>
        (!media.paused ? 100 : 0) +
        (media.currentSrc ? 30 : 0) +
        (media.readyState >= 2 ? 20 : 0) +
        (!media.muted ? 10 : 0);

      return score(b) - score(a);
    });

    return candidates[0] || null;
  }

  function findPlayButton() {
    // Cambridge One usa un reproductor propio:
    // <figure class="audio v_a_media"> con <button class="play"
    // aria-label="Play/pause:">. Lo priorizamos antes que otros botones.
    const playerButtons = allElements(
      ".audio.v_a_media button.play, .audio button.play, button.play"
    ).filter(isVisible);

    if (playerButtons.length) return playerButtons[0];

    const selectors = [
      "button",
      '[role="button"]',
      "[aria-label]",
      "[title]",
      '[data-testid*="play" i]',
      '[class*="play" i]'
    ].join(",");

    const candidates = allElements(selectors).filter(isVisible);

    return candidates.find(element => {
      const label = (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("data-testid") ||
        element.className ||
        element.innerText ||
        ""
      ).trim().toLowerCase();

      return (
        /\b(play|listen|reproducir|escuchar)\s*(\/|\-|and)?\s*(pause|pausar)?\b/i.test(label) ||
        /^(play|play audio|listen|listen audio|reproducir|reproducir audio|escuchar|iniciar audio)$/i.test(label) ||
        /^(play|listen|reproducir|escuchar)[-_ ]button$/i.test(label)
      );
    }) || null;
  }

  // ==========================================
  // CONVERSIÓN DE AUDIO
  // ==========================================

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        resolve(reader.result);
      };

      reader.onerror = () => {
        reject(
          new Error("No se pudo convertir la grabación.")
        );
      };

      reader.readAsDataURL(blob);
    });
  }

  // Cambridge One usa Sound/Howler y no crea etiquetas <audio>.
  // Localizamos el MP3 descargado por el reproductor en cada marco.
  function findCambridgeAudioUrl(player) {
    const rawId = player?.getAttribute("data-playable-media") || "";
    const mediaId = rawId.replace(/^ID_/, "");
    if (!mediaId) return "";

    for (const root of getRoots()) {
      const doc = root.nodeType === 9 ? root : root.ownerDocument;
      const win = doc?.defaultView;
      if (!win?.performance) continue;

      const match = win.performance.getEntriesByType("resource").find(entry =>
        (entry.name || "").includes(mediaId) &&
        /\.mp3(?:[?#]|$)/i.test(entry.name || "")
      );

      if (match) return match.name;
    }
    return "";
  }

  function downloadCambridgeAudio(url) {
    return new Promise(resolve => {
      if (!url) {
        resolve({ audioBase64: "", note: "No se encontró el MP3 del reproductor Cambridge." });
        return;
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 30000,
        onload: async response => {
          if (response.status < 200 || response.status >= 300) {
            resolve({ audioBase64: "", note: `Cambridge no permitió descargar el audio (HTTP ${response.status}).` });
            return;
          }

          try {
            const blob = response.response instanceof Blob
              ? response.response
              : new Blob([response.response], { type: "audio/mpeg" });

            if (!blob.size) {
              resolve({ audioBase64: "", note: "El archivo de audio llegó vacío." });
              return;
            }
            if (blob.size > MAX_AUDIO_BYTES) {
              resolve({ audioBase64: "", note: "El audio supera el límite permitido de tamaño." });
              return;
            }

            resolve({
              audioBase64: await blobToDataUrl(blob),
              note: `Audio MP3 de Cambridge capturado (${Math.round(blob.size / 1024)} KB).`
            });
          } catch (error) {
            resolve({ audioBase64: "", note: "No se pudo preparar el MP3: " + error.message });
          }
        },
        onerror: () => resolve({ audioBase64: "", note: "No se pudo acceder al archivo MP3 de Cambridge." }),
        ontimeout: () => resolve({ audioBase64: "", note: "La descarga del audio de Cambridge tardó demasiado." })
      });
    });
  }

  // ==========================================
  // REPRODUCIR Y ESCUCHAR AUTOMÁTICAMENTE
  // ==========================================

  async function startRecording(media) {
    if (typeof MediaRecorder === "undefined") {
      return {
        audioBase64: "",
        note: "El navegador no permite grabar este reproductor."
      };
    }

    if (media.ended) {
      try {
        media.currentTime = 0;
      } catch {}
    }

    // MUY IMPORTANTE:
    // Se llama a play() antes de cualquier espera.
    // Así aprovechamos el clic del usuario en Analizar.
    let playPromise;

    try {
      playPromise = media.paused
        ? media.play()
        : Promise.resolve();

    } catch (error) {
      return {
        audioBase64: "",
        note:
          "No se pudo iniciar la reproducción: " +
          error.message
      };
    }

    const capture =
      media.captureStream ||
      media.mozCaptureStream;

    if (!capture) {
      return {
        audioBase64: "",
        note:
          "El reproductor no permite capturar su audio. " +
          "Necesitamos probar una captura de pestaña autorizada."
      };
    }

    let originalStream;

    try {
      originalStream = capture.call(media);

    } catch (error) {
      return {
        audioBase64: "",
        note:
          "No se pudo acceder al sonido del reproductor: " +
          error.message
      };
    }

    let tracks = originalStream.getAudioTracks();

    // Algunos reproductores crean la pista después de iniciar Play.
    if (!tracks.length) {
      try {
        await playPromise;

        await new Promise(resolve =>
          setTimeout(resolve, 400)
        );

        originalStream = capture.call(media);
        tracks = originalStream.getAudioTracks();

      } catch (error) {
        return {
          audioBase64: "",
          note:
            "Chrome no permitió iniciar el audio automáticamente: " +
            error.message +
            ". En ese reproductor tendrás que pulsar Play una vez."
        };
      }
    }

    if (!tracks.length) {
      return {
        audioBase64: "",
        note:
          "El reproductor no está exponiendo una pista de audio."
      };
    }

    const stream = new MediaStream(tracks);

    const formats = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm"
    ];

    const mimeType = formats.find(type =>
      MediaRecorder.isTypeSupported(type)
    );

    let recorder;

    try {
      recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
            audioBitsPerSecond: 48000
          })
        : new MediaRecorder(stream, {
            audioBitsPerSecond: 48000
          });

    } catch (error) {
      return {
        audioBase64: "",
        note:
          "No se pudo iniciar la grabación: " +
          error.message
      };
    }

    const chunks = [];

    return new Promise(resolve => {
      let completed = false;
      let stopReason = "";

      let timer;

      const finish = reason => {
        if (completed) return;

        stopReason = reason || stopReason;
        completed = true;

        clearTimeout(timer);

        if (recorder.state === "recording") {
          recorder.stop();
        }
      };

      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onerror = event => {
        finish(
          event.error?.message ||
          "Error durante la grabación."
        );
      };

      recorder.onstop = async () => {
        media.removeEventListener(
          "ended",
          onEnded
        );

        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm"
        });

        if (!blob.size) {
          resolve({
            audioBase64: "",
            note:
              stopReason ||
              "No se capturó sonido del reproductor."
          });
          return;
        }

        if (blob.size > MAX_AUDIO_BYTES) {
          resolve({
            audioBase64: "",
            note:
              "El audio es demasiado grande. " +
              "Se necesita un fragmento más corto."
          });
          return;
        }

        try {
          const dataUrl = await blobToDataUrl(blob);

          resolve({
            audioBase64: dataUrl,
            note:
              "Audio capturado y listo para transcribir. " +
              `Duración aproximada de grabación: ${Math.round(blob.size / 6000)} segundos.`
          });

        } catch (error) {
          resolve({
            audioBase64: "",
            note: error.message
          });
        }
      };

      function onEnded() {
        finish("El audio terminó de reproducirse.");
      }

      try {
        recorder.start(500);

        media.addEventListener(
          "ended",
          onEnded,
          { once: true }
        );

        // Grabar hasta que termine el audio.
        // Máximo 90 segundos por ejecución.
        timer = setTimeout(() => {
          finish(
            "Se alcanzó el límite de 90 segundos de grabación."
          );
        }, MAX_AUDIO_MS);

        playPromise.catch(error => {
          finish(
            "Chrome bloqueó la reproducción automática: " +
            error.message +
            ". Pulsa Play una vez en ese reproductor."
          );
        });

      } catch (error) {
        resolve({
          audioBase64: "",
          note:
            "No se pudo grabar el audio: " +
            error.message
        });
      }
    });
  }

  function waitForMedia() {
    return new Promise(resolve => {
      let attempts = 0;

      const timer = setInterval(() => {
        attempts++;

        const media = findMedia();

        if (media) {
          clearInterval(timer);
          resolve(media);
          return;
        }

        if (attempts >= 15) {
          clearInterval(timer);
          resolve(null);
        }
      }, 200);
    });
  }

  function isCambridgePlayerPlaying(player) {
    if (!player) return false;

    const stateText = [
      player.className || "",
      ...[...player.querySelectorAll("[class]")].map(el => String(el.className || "")),
      ...[...player.querySelectorAll("[aria-label]")].map(el => el.getAttribute("aria-label") || "")
    ].join(" ").toLowerCase();

    if (/(^|\s)(playing|is-playing|pause|pausar)(\s|$)/i.test(stateText)) {
      return true;
    }

    const times = [...(player.innerText || "").matchAll(/\b(\d{1,2}):(\d{2})\b/g)]
      .map(match => Number(match[1]) * 60 + Number(match[2]));

    return times.length >= 2 &&
      times[0] > 0 &&
      times[0] < times[times.length - 1];
  }

  function cambridgeDurationMs(player) {
    const times = [...(player?.innerText || "").matchAll(/\b(\d{1,2}):(\d{2})\b/g)]
      .map(match => Number(match[1]) * 60 + Number(match[2]));

    const duration = times.length >= 2
      ? times[times.length - 1]
      : 0;

    return duration > 0
      ? Math.min(MAX_AUDIO_MS, duration * 1000 + 1200)
      : 12000;
  }

  function recordCambridgeTabAudio(player) {
    if (!tabAudioStream || typeof MediaRecorder === "undefined") {
      return Promise.resolve({
        audioBase64: "",
        note: "No hay una captura de audio de pestaña conectada."
      });
    }

    const tracks = tabAudioStream.getAudioTracks()
      .filter(track => track.readyState === "live");

    if (!tracks.length) {
      return Promise.resolve({
        audioBase64: "",
        note: "La captura de pestaña ya no tiene una pista de audio activa. Vuelve a conectarla."
      });
    }

    const stream = new MediaStream(tracks);
    const formats = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm"
    ];
    const mimeType = formats.find(type =>
      MediaRecorder.isTypeSupported(type)
    );

    let recorder;

    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 })
        : new MediaRecorder(stream, { audioBitsPerSecond: 64000 });
    } catch (error) {
      return Promise.resolve({
        audioBase64: "",
        note: "No se pudo iniciar la grabación de la pestaña: " + error.message
      });
    }

    return new Promise(resolve => {
      const chunks = [];
      let finished = false;
      let timer;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        if (recorder.state === "recording") {
          recorder.stop();
        }
      };

      recorder.ondataavailable = event => {
        if (event.data?.size) chunks.push(event.data);
      };

      recorder.onerror = event => {
        finish();
        resolve({
          audioBase64: "",
          note: event.error?.message || "Falló la grabación del audio de la pestaña."
        });
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm"
        });

        if (!blob.size) {
          resolve({
            audioBase64: "",
            note: "Chrome no entregó sonido. Comprueba que seleccionaste la pestaña de Cambridge y activaste compartir audio."
          });
          return;
        }

        if (blob.size > MAX_AUDIO_BYTES) {
          resolve({
            audioBase64: "",
            note: "El audio capturado supera el tamaño permitido."
          });
          return;
        }

        try {
          resolve({
            audioBase64: await blobToDataUrl(blob),
            note: `Audio de la pestaña capturado (${Math.round(blob.size / 1024)} KB).`
          });
        } catch (error) {
          resolve({
            audioBase64: "",
            note: "No se pudo preparar el audio de la pestaña: " + error.message
          });
        }
      };

      try {
        recorder.start();
        // La grabación comienza antes del clic para no perder el inicio.
        const playButton = player?.querySelector("button.play");
        if (playButton && !isCambridgePlayerPlaying(player)) {
          playButton.click();
        }

        timer = setTimeout(
          finish,
          cambridgeDurationMs(player)
        );
      } catch (error) {
        finish();
        resolve({
          audioBase64: "",
          note: "No se pudo comenzar a grabar la pestaña: " + error.message
        });
      }
    });
  }

  async function startAudioCaptureFromClick() {
    const media = findMedia();
    if (media) return startRecording(media);

    // Cambridge One usa un reproductor propio dentro de un iframe.
    // El botón .play es un conmutador: un segundo clic lo PAUSA.
    const players = allElements("figure.audio.v_a_media");
    const player = players.find(isVisible) || players[0];

    if (player) {
      if (tabAudioStream) {
        return recordCambridgeTabAudio(player);
      }

      let audioUrl = findCambridgeAudioUrl(player);

      if (!isCambridgePlayerPlaying(player)) {
        player.querySelector("button.play")?.click();
      }

      if (!audioUrl) {
        for (let attempt = 0; attempt < 25; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 200));

          const createdMedia = findMedia();
          if (createdMedia) {
            return startRecording(createdMedia);
          }

          audioUrl = findCambridgeAudioUrl(player);
          if (audioUrl) break;
        }
      }

      if (audioUrl) {
        const downloaded = await downloadCambridgeAudio(audioUrl);
        if (downloaded.audioBase64) return downloaded;

        return {
          audioBase64: "",
          note: downloaded.note +
            " El reproductor recibió un único clic de Play y no se volvió a pulsar para evitar pausarlo."
        };
      }

      const createdMedia = findMedia();
      if (createdMedia) return startRecording(createdMedia);

      return {
        audioBase64: "",
        note: "Pulsé Play una sola vez en Cambridge y dejé el reproductor activo, pero el sitio no expuso un archivo de audio ni una pista capturable. Puedes conectar el audio de la pestaña para que Aula AI escuche lo que suena."
      };
    }

    const playButton = findPlayButton();

    if (playButton) {
      playButton.click();

      const foundMedia = await waitForMedia();
      if (foundMedia) return startRecording(foundMedia);
    }

    return {
      audioBase64: "",
      note: "No encontré un reproductor de audio capturable. Puede ser externo o estar protegido por el sitio."
    };
  }

// ==========================================
  // CAPTURAR IMÁGENES Y FOTOGRAMAS
  // ==========================================

  function isValidImageDataUrl(dataUrl) {
    return (
      typeof dataUrl === "string" &&
      dataUrl.length <= MAX_IMAGE_SIZE &&
      /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(dataUrl)
    );
  }

  function imageToDataUrl(source, description) {
    try {
      const width =
        source.videoWidth ||
        source.naturalWidth ||
        source.width ||
        0;

      const height =
        source.videoHeight ||
        source.naturalHeight ||
        source.height ||
        0;

      if (!width || !height) return null;

      const scale = Math.min(
        1,
        1100 / Math.max(width, height)
      );

      const ownerDocument = source.ownerDocument || document;
      const canvas = ownerDocument.createElement("canvas");

      canvas.width = Math.max(
        1,
        Math.round(width * scale)
      );

      canvas.height = Math.max(
        1,
        Math.round(height * scale)
      );

      const context = canvas.getContext("2d");

      if (!context) return null;

      context.fillStyle = "#ffffff";

      context.fillRect(
        0,
        0,
        canvas.width,
        canvas.height
      );

      context.drawImage(
        source,
        0,
        0,
        canvas.width,
        canvas.height
      );

      let dataUrl = canvas.toDataURL(
        "image/jpeg",
        0.70
      );

      if (dataUrl.length > MAX_IMAGE_SIZE) {
        const smaller = ownerDocument.createElement("canvas");

        smaller.width = Math.round(canvas.width * 0.65);
        smaller.height = Math.round(canvas.height * 0.65);

        smaller.getContext("2d").drawImage(
          canvas,
          0,
          0,
          smaller.width,
          smaller.height
        );

        dataUrl = smaller.toDataURL(
          "image/jpeg",
          0.55
        );
      }

      // No enviar nunca "data:," ni un MIME inesperado al servidor.
      if (!isValidImageDataUrl(dataUrl)) {
        return null;
      }

      return {
        dataUrl,
        description
      };

    } catch (error) {
      console.warn(
        "Aula AI: no se pudo capturar una imagen:",
        error.message
      );

      return null;
    }
  }

  // Convierte cualquier imagen descargada (incluidos GIF y SVG) a JPEG.
  // El servidor de Aula AI solo admite JPEG, PNG y WebP.
  async function drawableToJpeg(drawable, ownerDocument) {
    const doc = ownerDocument || document;
    const width =
      drawable.naturalWidth ||
      drawable.videoWidth ||
      drawable.width ||
      0;
    const height =
      drawable.naturalHeight ||
      drawable.videoHeight ||
      drawable.height ||
      0;

    if (!width || !height) return "";

    const scale = Math.min(1, 1100 / Math.max(width, height));
    const canvas = doc.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    if (!context) return "";

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);

    let dataUrl = canvas.toDataURL("image/jpeg", 0.78);

    // Reducir tamaño cuando la imagen siga siendo demasiado pesada.
    for (let attempt = 0; dataUrl.length > MAX_IMAGE_SIZE && attempt < 3; attempt++) {
      const smaller = doc.createElement("canvas");
      smaller.width = Math.max(1, Math.round(canvas.width * Math.pow(0.72, attempt + 1)));
      smaller.height = Math.max(1, Math.round(canvas.height * Math.pow(0.72, attempt + 1)));

      const smallerContext = smaller.getContext("2d");
      if (!smallerContext) return "";

      smallerContext.fillStyle = "#ffffff";
      smallerContext.fillRect(0, 0, smaller.width, smaller.height);
      smallerContext.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      dataUrl = smaller.toDataURL("image/jpeg", 0.68);
    }

    return /^data:image\/jpeg;base64,/i.test(dataUrl) &&
      dataUrl.length <= MAX_IMAGE_SIZE
      ? dataUrl
      : "";
  }

  async function blobToJpegDataUrl(blob, ownerDocument) {
    const doc = ownerDocument || document;
    let bitmap = null;
    let objectUrl = "";

    try {
      if (typeof createImageBitmap === "function") {
        try {
          bitmap = await createImageBitmap(blob);
          return await drawableToJpeg(bitmap, doc);
        } catch (error) {
          console.warn("Aula AI: createImageBitmap no pudo decodificar la imagen; se probará Image().", error.message);
        }
      }

      // Alternativa para navegadores o formatos que no soportan createImageBitmap.
      objectUrl = URL.createObjectURL(blob);
      const image = doc.createElement("img");

      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("El navegador no pudo abrir el archivo de imagen."));
        image.src = objectUrl;
      });

      return await drawableToJpeg(image, doc);
    } catch (error) {
      console.warn("Aula AI: no se pudo convertir la imagen a JPEG:", error.message);
      return "";
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  // Si el navegador bloquea el canvas por una imagen de otro origen,
  // descargamos el recurso con el permiso de Tampermonkey.
  async function captureImageElement(image, description) {
    const direct = imageToDataUrl(image, description);
    if (direct && isValidImageDataUrl(direct.dataUrl)) return direct;

    const url = image.currentSrc || image.src || "";
    if (!/^https?:\/\//i.test(url)) return null;

    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 20000,
        onload: async response => {
          if (response.status < 200 || response.status >= 300) {
            console.warn("Aula AI: descarga de imagen no permitida:", response.status, url);
            resolve(null);
            return;
          }

          try {
            const blob = response.response instanceof Blob
              ? response.response
              : new Blob([response.response], { type: "image/jpeg" });

            if (!blob.size || blob.size > 850000) {
              console.warn("Aula AI: imagen vacía o demasiado grande:", blob.size, url);
              resolve(null);
              return;
            }

            const dataUrl = await blobToJpegDataUrl(
              blob,
              image.ownerDocument || document
            );

            if (!dataUrl) {
              console.warn("Aula AI: no se pudo convertir la imagen descargada a JPEG:", url);
              resolve(null);
              return;
            }

            // Nunca enviar SVG, GIF, AVIF u otro MIME no admitido.
            resolve({ dataUrl, description });
          } catch (error) {
            console.warn("Aula AI: error al preparar imagen:", error.message, url);
            resolve(null);
          }
        },
        onerror: error => {
          console.warn("Aula AI: no se pudo descargar imagen:", url, error);
          resolve(null);
        },
        ontimeout: () => {
          console.warn("Aula AI: tiempo agotado al descargar imagen:", url);
          resolve(null);
        }
      });
    });
  }

  async function captureImages() {
    const images = [];
    const skipped = [];

    const imageElements = allElements("img")
      .filter(element =>
        isVisible(element) &&
        element.complete &&
        element.naturalWidth > 0
      )
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });

    for (const image of imageElements) {
      if (images.length >= 3) break;

      const description =
        "Imagen de la actividad: " +
        (image.alt || "sin descripción");

      const result = await captureImageElement(image, description);

      if (result && isValidImageDataUrl(result.dataUrl)) {
        images.push(result);
      } else {
        skipped.push(
          `No se pudo capturar en formato válido: ${image.alt || "sin descripción"} (${image.naturalWidth}x${image.naturalHeight})`
        );
      }
    }

    for (const canvas of allElements("canvas")) {
      if (!isVisible(canvas) || images.length >= MAX_IMAGES) continue;

      const result = imageToDataUrl(
        canvas,
        "Gráfico o actividad dibujada en canvas."
      );

      if (result && isValidImageDataUrl(result.dataUrl)) images.push(result);
      else skipped.push("Se omitió un gráfico porque no se pudo convertir a una imagen válida.");
    }

    for (const video of allElements("video")) {
      if (
        images.length >= MAX_IMAGES ||
        !isVisible(video) ||
        video.readyState < 2
      ) continue;

      const result = imageToDataUrl(
        video,
        `Fotograma de vídeo en el segundo ${Math.round(video.currentTime)}.`
      );

      if (result && isValidImageDataUrl(result.dataUrl)) images.push(result);
      else skipped.push("Se omitió un fotograma porque no se pudo convertir a una imagen válida.");
    }

    return {
      images: images.slice(0, MAX_IMAGES),
      skipped
    };
  }

  // ==========================================
  // APLICAR RESPUESTAS
  // ==========================================

  function applyActions(actions, openedDropdownKeys = new Set()) {
    let applied = 0;
    const details = [];
    const openedDropdowns = [];

    for (const action of actions || []) {
      const element = indexedControls.get(
        Number(action.control_index)
      );

      if (!element || element.disabled) continue;

      const value = String(
        action.value ?? ""
      ).trim();

      if (
        action.action === "fill" &&
        (
          element.matches(
            'input:not([type="radio"]):not([type="checkbox"]):not([type="submit"]),textarea'
          ) ||
          element.isContentEditable
        )
      ) {
        if (element.isContentEditable) {
          element.textContent = value;

          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: value
            })
          );

        } else {
          const prototype =
            element.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;

          const setter =
            Object.getOwnPropertyDescriptor(
              prototype,
              "value"
            )?.set;

          if (setter) {
            setter.call(element, value);
          } else {
            element.value = value;
          }

          element.dispatchEvent(
            new Event("input", { bubbles: true })
          );
        }

        element.dispatchEvent(
          new Event("change", { bubbles: true })
        );

        applied++;
        details.push(action.question || "Campo completado");

      } else if (
        action.action === "select" &&
        element.tagName === "SELECT"
      ) {
        const option = [...element.options].find(item =>
          item.text.trim().toLowerCase() === value.toLowerCase() ||
          item.value.toLowerCase() === value.toLowerCase()
        );

        if (option) {
          element.value = option.value;

          element.dispatchEvent(
            new Event("input", { bubbles: true })
          );

          element.dispatchEvent(
            new Event("change", { bubbles: true })
          );

          applied++;
          details.push(action.question || "Opción seleccionada");
        }

      } else if (
        action.action === "select" &&
        isCustomDropdown(element)
      ) {
        const key = dropdownStableKey(element);
        const expanded = element.getAttribute("aria-expanded") === "true";

        if (!expanded && !openedDropdownKeys.has(key)) {
          element.click();
          openedDropdownKeys.add(key);
          openedDropdowns.push("lista desplegable");
        } else {
          const doc = element.ownerDocument || document;
          const references = [
            element.getAttribute("aria-controls"),
            element.getAttribute("aria-owns")
          ].filter(Boolean).flatMap(reference => reference.split(/\s+/));

          let containers = references
            .map(id => doc.getElementById(id))
            .filter(Boolean);

          if (!containers.length) {
            containers = [...doc.querySelectorAll(
              '[role="listbox"],[role="menu"],[class*="dropdown-menu" i],[class*="select-menu" i]'
            )].filter(isVisible);
          }

          const candidates = containers.flatMap(container => [
            ...(container.matches('[role="option"],[role="menuitem"],option,li,[data-value],button') ? [container] : []),
            ...container.querySelectorAll('[role="option"],[role="menuitem"],option,li,[data-value],button')
          ]);

          const optionElement = candidates.find(candidate =>
            isVisible(candidate) &&
            String(candidate.innerText || candidate.textContent || "").trim().toLowerCase() === value.toLowerCase()
          );

          if (optionElement) {
            optionElement.click();
            applied++;
            details.push(action.question || "Opción seleccionada");
          }
        }

      } else if (action.action === "click") {
        const label = (
          element.innerText ||
          element.value ||
          element.getAttribute("aria-label") ||
          element.textContent ||
          ""
        ).trim().toLowerCase();

        // Primero se abre el cuadro desplegable; la opción se elige
        // en una segunda lectura, cuando la lista ya esté visible.
        if (isCustomDropdown(element)) {
          const expanded = element.getAttribute("aria-expanded") === "true";
          const key = dropdownStableKey(element);

          if (!expanded && !openedDropdownKeys.has(key)) {
            element.click();
            openedDropdownKeys.add(key);
            openedDropdowns.push(label || "lista desplegable");
            break;
          }

          continue;
        }

        // Prohibido accionar botones finales.
        if (
          /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|next|siguiente|continuar|check answers|comprobar/i.test(label)
        ) {
          continue;
        }

        if (
          element.matches(
            'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"],[role="menuitem"],[role="listbox"] li,[role="menu"] li,[class*="dropdown-menu" i] li,[class*="select-menu" i] li,[data-value],li[tabindex],[aria-checked],[aria-selected],[aria-pressed],label'
          )
        ) {
          element.click();
          applied++;
          details.push(action.question || "Opción marcada");
        }
      }
    }

    return { applied, details, openedDropdowns };
  }

  function clickNext() {
    const elements = allElements(
      'button,[role="button"],input[type="button"],a'
    ).filter(isVisible);

    const next = elements.find(element => {
      const label = (
        element.innerText ||
        element.value ||
        element.getAttribute("aria-label") ||
        ""
      ).trim().toLowerCase();

      if (!label) return false;

      if (
        /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|check answers|comprobar/i.test(label)
      ) {
        return false;
      }

      return (
        /^(next|siguiente|continuar|continue|next question|próxima|avanzar|›|→)$/i.test(label) ||
        /^(next|siguiente|continuar|continue)\b/i.test(label)
      );
    });

    if (!next) return false;

    next.click();
    return true;
  }

  // Envía o comprueba las respuestas únicamente al llegar al final,
  // cuando ya no existe un control seguro para pasar a otra pregunta.
  function clickSubmitAnswers() {
    const elements = allElements(
      'button,[role="button"],input[type="button"],input[type="submit"]'
    ).filter(isVisible);

    const exactAction =
      /^(check|check answer|check answers|check my answers|submit|submit answer|submit answers|send|send answers|enviar|enviar respuesta|enviar respuestas|entregar|entregar respuesta|entregar respuestas|comprobar|comprobar respuesta|comprobar respuestas|verificar|verificar respuestas|finish|finish activity|finalizar|finalizar actividad)$/i;

    const candidates = elements.map(element => ({
      element,
      labels: [
        element.innerText,
        element.value,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid")
      ]
        .filter(Boolean)
        .map(label => String(label).replace(/\s+/g, " ").trim())
    }));

    // Comprobar cada etiqueta por separado: el texto visible y aria-label
    // pueden repetir el mismo nombre y no deben invalidar la coincidencia.
    const submit = candidates.find(({ labels }) =>
      labels.some(label => exactAction.test(label))
    );

    if (!submit) return null;

    submit.element.click();
    return submit.label || "Enviar / comprobar respuestas";
  }

  // ==========================================
  // COMUNICACIÓN ENTRE MARCOS
  // ==========================================

  function report(runId, message) {
    if (TOP) {
      setPanelStatus(message);
    } else {
      window.parent.postMessage({
        source: "AULA_AI_STATUS",
        runId,
        message
      }, "*");
    }
  }

  function sendToChildFrames(message) {
    for (
      let index = 0;
      index < window.frames.length;
      index++
    ) {
      try {
        window.frames[index].postMessage(
          message,
          "*"
        );
      } catch {}
    }
  }

  // ==========================================
  // ANÁLISIS DE CADA ACTIVIDAD
  // ==========================================

  async function analyzeFrame(
    runId,
    maxQuestions,
    automatic,
    captureAudio,
    submitOnFinish,
    initialAudioPromise
  ) {
    stopRequested = false;

    try {
      const token = await getToken();

      let audioPromise = initialAudioPromise;
      const openedDropdownKeys = new Set();

      for (
        let step = 1;
        step <= maxQuestions && !stopRequested;
        step++
      ) {
        // Abrir el siguiente cuadro de respuesta antes de analizar:
        // así la IA recibe también las opciones que estaban ocultas.
        const openedDropdown = openNextDropdown(openedDropdownKeys);
        if (openedDropdown) {
          report(
            runId,
            `Abriendo la lista de respuestas: ${openedDropdown}…`
          );
          await new Promise(resolve => setTimeout(resolve, 400));
        }

        const snapshot = collectPage();

        report(
          runId,
          `Leyendo la actividad: ${snapshot.title}`
        );

        // Capturar texto e imágenes.
        const visual = await captureImages();

        // Última barrera: una imagen incorrecta nunca debe cancelar
        // el análisis completo. Solo se envían JPEG/PNG/WebP base64 válidos.
        const countBeforeValidation = visual.images.length;
        visual.images = visual.images.filter(item =>
          isValidImageDataUrl(item?.dataUrl)
        );
        if (visual.images.length < countBeforeValidation) {
          visual.skipped.push(
            `Se omitieron ${countBeforeValidation - visual.images.length} imagen(es) con formato no compatible.`
          );
        }

        // Esperar el audio que comenzó al pulsar Analizar.
        let audio = {
          audioBase64: "",
          note: "No se solicitó captura de audio."
        };

        if (captureAudio) {
          report(
            runId,
            "Aula AI está escuchando el reproductor. " +
            "Espera mientras termina el audio…"
          );

          audio = audioPromise
            ? await audioPromise
            : await startAudioCaptureFromClick();
        }

        if (!snapshot.pageText.trim() &&
            !snapshot.controls.length &&
            !visual.images.length &&
            !audio.audioBase64) {

          report(
            runId,
            `No se pudo obtener contenido de la actividad. ` +
            `Página: ${location.href}. ` +
            `Audio: ${audio.note}`
          );

          return;
        }

        report(
          runId,
          `Material preparado: ${visual.images.length} imágenes, ` +
          `${snapshot.controls.length} controles. ` +
          `${audio.audioBase64 ? "Audio capturado." : audio.note}`
        );

        const requestBody = {
          title: snapshot.title,
          pageText: snapshot.pageText,
          controls: snapshot.controls,
          images: visual.images,

          audioBase64:
            audio.audioBase64 || undefined
        };

        const result = await request(
          "POST",
          WORKER,
          requestBody,
          token
        );

        if (!result.actions?.length) {
          report(
            runId,
            `No se encontraron respuestas aplicables. ` +
            `${result.summary || result.stop_reason || "La IA no identificó una pregunta resoluble."}\n` +
            `Imágenes: ${visual.images.length}. ` +
            `Controles: ${snapshot.controls.length}. ` +
            `Listas detectadas: ${snapshot.controls.filter(control => control.dropdown || control.type === "select").map(control => {
              const choices = (control.options || []).map(option => option.text).join(" / ");
              return `${control.label || control.type}${control.expanded ? " (abierta)" : ""}${choices ? ": " + choices : ""}`;
            }).join("; ") || "ninguna"}\n` +
            `Audio: ${audio.audioBase64 ? "transmitido para transcripción" : audio.note}\n` +
            `${visual.skipped.join(" ")}`
          );

          return;
        }

        const applied = applyActions(
          result.actions,
          openedDropdownKeys
        );

        if (applied.openedDropdowns.length) {
          report(
            runId,
            `Abrí el cuadro desplegable: ${applied.openedDropdowns.join(", ")}. Leyendo las opciones disponibles…`
          );

          // Esperar a que Cambridge renderice la lista de opciones.
          await new Promise(resolve => setTimeout(resolve, 450));

          // Volver a analizar la misma pregunta, sin consumir un paso.
          step--;
          continue;
        }

        report(
          runId,
          `Pregunta ${step}: ${applied.applied} respuesta(s) colocada(s). ` +
          `${result.summary || ""}`
        );

        if (
          !automatic ||
          !applied.applied ||
          stopRequested
        ) {
          return;
        }

        if (!clickNext()) {
          if (submitOnFinish) {
            const submittedLabel = clickSubmitAnswers();

            if (submittedLabel) {
              report(
                runId,
                `Se colocaron las respuestas y se pulsó "${submittedLabel}". Esperando la confirmación de Cambridge One…`
              );
              await new Promise(resolve => setTimeout(resolve, 1800));
              report(
                runId,
                `Aula AI hizo clic en "${submittedLabel}" al llegar al final de la actividad. Revisa el resultado o la confirmación que muestre Cambridge One.`
              );
            } else {
              report(
                runId,
                "Se respondieron las preguntas visibles, pero no encontré un botón final identificable como Check answers, Submit, Enviar o Entregar. No se hizo clic en controles desconocidos."
              );
            }
          } else {
            report(
              runId,
              "Se respondieron las preguntas visibles. La opción de envío automático está desactivada."
            );
          }

          return;
        }

        await new Promise(resolve =>
          setTimeout(resolve, 1500)
        );
        openedDropdownKeys.clear();

        // Para la siguiente pregunta, intentar escuchar
        // el siguiente reproductor automáticamente.
        audioPromise = captureAudio
          ? startAudioCaptureFromClick()
          : null;
      }

    } catch (error) {
      report(
        runId,
        `Error en ${document.title}: ${error.message}`
      );
    }
  }

  // ==========================================
  // PANEL FLOTANTE DE AULA AI
  // ==========================================

  function createPanel() {
    if (!TOP) return;

    // Retirar el botón flotante legado de la extensión antigua si existe.
    document.getElementById("aula-ai-floating")?.remove();

    if (document.getElementById("aula-ai-userscript")) return;

    const host = document.createElement("div");

    host.id = "aula-ai-userscript";

    host.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px";

    const shadow = host.attachShadow({
      mode: "open"
    });

    shadow.innerHTML = `
      <style>
        * {
          box-sizing: border-box;
          font-family: Arial, sans-serif;
        }

        .launcher {
          background: #172238;
          color: white;
          border: 0;
          border-radius: 24px;
          padding: 12px 18px;
          font-weight: bold;
          cursor: pointer;
          box-shadow: 0 4px 18px #0004;
        }

        .panel {
          display: none;
          width: 320px;
          background: white;
          color: #182338;
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 9px;
          box-shadow: 0 8px 30px #0004;
          border: 1px solid #dce3ef;
        }

        .panel.open {
          display: block;
        }

        h3 {
          margin: 0 0 6px;
          font-size: 17px;
        }

        p {
          font-size: 12px;
          color: #657189;
          line-height: 1.45;
        }

        input:not([type="checkbox"]), select {
          width: 100%;
          padding: 10px;
          margin: 6px 0;
          border: 1px solid #ccd4e2;
          border-radius: 8px;
          font-size: 13px;
        }

        input[type="checkbox"] {
          accent-color: #315bea;
          vertical-align: middle;
        }

        button.action {
          width: 100%;
          padding: 10px;
          margin-top: 8px;
          border: 0;
          border-radius: 8px;
          background: #315bea;
          color: white;
          font-weight: bold;
          cursor: pointer;
        }

        button.secondary {
          background: #e9edf5;
          color: #23314a;
        }

        button:disabled {
          opacity: .5;
          cursor: not-allowed;
        }

        .status {
          white-space: pre-wrap;
          max-height: 170px;
          overflow: auto;
          background: #f2f5fa;
          border-radius: 8px;
          padding: 10px;
          font-size: 11px;
          line-height: 1.45;
          margin-top: 10px;
        }

        .small {
          font-size: 10px;
          color: #778198;
          line-height: 1.5;
        }
      </style>

      <section class="panel open" id="panel">
        <h3>Aula AI multimedia</h3>

        <p id="account">Asistente académico</p>

        <div id="login">
          <input
            id="email"
            type="email"
            placeholder="Correo de Aula AI"
          >

          <input
            id="password"
            type="password"
            placeholder="Contraseña"
          >

          <button class="action" id="loginBtn">
            Iniciar sesión
          </button>
        </div>

        <div id="tools" style="display:none">

          <label class="small">
            Máximo de preguntas por ejecución
          </label>

          <select id="max">
            <option>1</option>
            <option>3</option>
            <option selected>5</option>
            <option>10</option>
          </select>

          <p class="small">
            <input id="auto" type="checkbox" checked>
            Modo automático: avanzar cuando sea seguro
          </p>

          <p class="small">
            <input id="audio" type="checkbox" checked>
            Reproducir y escuchar audio automáticamente
          </p>

          <p class="small">
            <input id="submit" type="checkbox" checked>
            Enviar / comprobar respuestas al finalizar la actividad
          </p>

          <button class="action secondary" id="connectAudio">
            Conectar audio de esta pestaña (opcional)
          </button>

          <p class="small">
            Solo cuando Cambridge no permite capturar el audio directamente.
            Chrome pedirá elegir esta pestaña y compartir su sonido.
          </p>

          <button class="action" id="run">
            Analizar y responder
          </button>

          <button class="action secondary" id="stop">
            Detener
          </button>

          <button class="action secondary" id="logout">
            Cerrar sesión
          </button>
        </div>

        <div class="status" id="status">
          Inicia sesión para utilizar Aula AI.
        </div>

        <p class="small">
          Aula AI reproduce el audio, analiza el contenido y coloca las respuestas.
          Con el envío automático activado, pulsa Comprobar / Enviar al llegar al final.
        </p>
      </section>

      <button class="launcher" id="toggle">
        ✦ Aula AI
      </button>
    `;

    (document.body || document.documentElement)
      .appendChild(host);

    const el = id => shadow.getElementById(id);

    setPanelStatus = message => {
      el("status").textContent = message;
    };

    async function refreshPanel() {
      const token = await GM_getValue(TOKEN_KEY, "");
      const email = await GM_getValue(EMAIL_KEY, "");

      el("login").style.display =
        token ? "none" : "block";

      el("tools").style.display =
        token ? "block" : "none";

      el("account").textContent = token
        ? `Sesión: ${email}`
        : "Inicia sesión con tu cuenta de Aula AI";
    }

    el("toggle").addEventListener("click", () => {
      el("panel").classList.toggle("open");
    });

    el("loginBtn").addEventListener("click", async () => {
      el("loginBtn").disabled = true;

      setPanelStatus("Conectando con Aula AI…");

      try {
        await login(
          el("email").value.trim(),
          el("password").value
        );

        el("password").value = "";

        setPanelStatus("Sesión iniciada correctamente.");

        await refreshPanel();

      } catch (error) {
        setPanelStatus(
          "No se pudo iniciar sesión: " + error.message
        );

      } finally {
        el("loginBtn").disabled = false;
      }
    });

    el("connectAudio").addEventListener("click", async () => {
      if (tabAudioStream) {
        tabAudioStream.getTracks().forEach(track => track.stop());
        tabAudioStream = null;
        el("connectAudio").textContent = "Conectar audio de esta pestaña (opcional)";
        setPanelStatus("Captura de audio desconectada.");
        return;
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        setPanelStatus("Este navegador no permite capturar el audio de la pestaña.");
        return;
      }

      el("connectAudio").disabled = true;
      setPanelStatus("En Chrome, elige la pestaña de Cambridge y activa la opción para compartir su audio.");

      try {
        // getDisplayMedia se llama directamente desde el clic del usuario.
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });

        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach(track => track.stop());
          throw new Error("No se recibió audio. Selecciona una pestaña y activa compartir audio.");
        }

        tabAudioStream = stream;
        stream.getTracks().forEach(track => {
          track.addEventListener("ended", () => {
            if (tabAudioStream === stream) {
              tabAudioStream = null;
              el("connectAudio").textContent = "Conectar audio de esta pestaña (opcional)";
              setPanelStatus("La captura de audio terminó. Puedes volver a conectarla cuando la necesites.");
            }
          }, { once: true });
        });

        el("connectAudio").textContent = "Desconectar audio de pestaña";
        setPanelStatus("Audio de la pestaña conectado. Ahora pulsa Analizar y responder.");
      } catch (error) {
        setPanelStatus("No se conectó el audio de la pestaña: " + error.message);
      } finally {
        el("connectAudio").disabled = false;
      }
    });

    el("logout").addEventListener("click", async () => {
      if (tabAudioStream) {
        tabAudioStream.getTracks().forEach(track => track.stop());
        tabAudioStream = null;
      }

      await GM_setValue(TOKEN_KEY, "");
      await GM_setValue(REFRESH_KEY, "");
      await GM_setValue(EMAIL_KEY, "");

      await refreshPanel();

      setPanelStatus("Sesión cerrada.");
    });

    // IMPORTANTE:
    // La captura de audio comienza aquí, dentro del
    // clic real del usuario, antes de cualquier await.
    el("run").addEventListener("click", () => {
      activeRunId =
        Date.now().toString(36) +
        Math.random().toString(36).slice(2);

      stopRequested = false;

      el("run").disabled = true;

      const captureAudio = el("audio").checked;

      setPanelStatus(
        captureAudio
          ? "Aula AI está buscando el reproductor e intentando iniciar Play automáticamente…"
          : "Aula AI está analizando la actividad…"
      );

      // Esta llamada inicia play() inmediatamente.
      const audioPromise = captureAudio
        ? startAudioCaptureFromClick()
        : Promise.resolve({
            audioBase64: "",
            note: "Captura de audio desactivada."
          });

      const command = {
        source: "AULA_AI_COMMAND",
        type: "RUN",
        runId: activeRunId,
        maxQuestions: Number(el("max").value),
        automatic: el("auto").checked,
        captureAudio,
        submitOnFinish: el("submit").checked
      };

      // Analizar el documento principal.
      analyzeFrame(
        command.runId,
        command.maxQuestions,
        command.automatic,
        captureAudio,
        command.submitOnFinish,
        audioPromise
      );

      // Enviar orden a marcos internos.
      sendToChildFrames(command);

      // Liberar el botón después de iniciar el proceso.
      // El análisis continúa aunque el popup esté cerrado.
      setTimeout(() => {
        el("run").disabled = false;
      }, 12000);
    });

    el("stop").addEventListener("click", () => {
      stopRequested = true;

      if (tabAudioStream) {
        tabAudioStream.getTracks().forEach(track => track.stop());
        tabAudioStream = null;
        el("connectAudio").textContent = "Conectar audio de esta pestaña (opcional)";
      }

      sendToChildFrames({
        source: "AULA_AI_COMMAND",
        type: "STOP"
      });

      setPanelStatus("Detención solicitada.");
    });

    refreshPanel();
  }

  // ==========================================
  // COMUNICACIÓN CON MARCOS INTERNOS
  // ==========================================

  window.addEventListener("message", event => {
    const data = event.data;

    if (!data || typeof data !== "object") {
      return;
    }

    if (
      data.source === "AULA_AI_COMMAND" &&
      !TOP &&
      event.source === window.parent
    ) {
      sendToChildFrames(data);

      if (data.type === "RUN") {
        // Si el documento padre puede leer este marco, el análisis
        // principal ya lo incluye. Evitamos enviar dos veces la misma
        // actividad a la IA. Los marcos de otro origen se analizan aquí.
        let parentCanReadThisFrame = false;

        try {
          parentCanReadThisFrame = !!window.parent.document;
        } catch {
          parentCanReadThisFrame = false;
        }

        if (!parentCanReadThisFrame) {
          const audioPromise = data.captureAudio
            ? startAudioCaptureFromClick()
            : Promise.resolve({
                audioBase64: "",
                note: "Captura desactivada."
              });

          analyzeFrame(
            data.runId,
            data.maxQuestions,
            data.automatic,
            data.captureAudio,
            data.submitOnFinish,
            audioPromise
          );
        }
      }

      if (data.type === "STOP") {
        stopRequested = true;
      }

    } else if (
      data.source === "AULA_AI_STATUS" &&
      !TOP
    ) {
      window.parent.postMessage(data, "*");

    } else if (
      data.source === "AULA_AI_STATUS" &&
      TOP
    ) {
      if (
        !activeRunId ||
        data.runId === activeRunId
      ) {
        setPanelStatus(data.message);
      }
    }
  });

  // ==========================================
  // INICIALIZACIÓN
  // ==========================================

  if (TOP) {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        createPanel,
        { once: true }
      );
    } else {
      createPanel();
    }
  }

  GM_registerMenuCommand(
    "Aula AI: abrir panel",
    () => {
      const host = document.getElementById(
        "aula-ai-userscript"
      );

      host?.shadowRoot
        ?.getElementById("toggle")
        ?.click();
    }
  );

})();
