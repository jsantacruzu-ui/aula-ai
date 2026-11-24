
// ==UserScript==
// @name         Aula AI - Asistente multimedia
// @namespace    https://aula-ai.jsantacruzu.workers.dev/
// @version      0.3.1
// @description  Asistente que reproduce y escucha audio, analiza imágenes y vídeos y responde actividades.
// @author       Aula AI
// @homepageURL  https://aula-ai.jsantacruzu.workers.dev/
// @supportURL   https://github.com/jsantacruzu-ui/aula-ai
// @updateURL    https://aula-ai.jsantacruzu.workers.dev/aula-ai.user.js
// @downloadURL  https://aula-ai.jsantacruzu.workers.dev/aula-ai.user.js
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

  const TOP = window.top === window.self;

  let stopRequested = false;
  let activeRunId = "";
  let setPanelStatus = () => {};

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
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0
      );
    } catch {
      return false;
    }
  }

  function getRoots() {
    const roots = [document];
    const visited = new Set();

    while (roots.length) {
      const root = roots.shift();

      if (!root || visited.has(root)) continue;

      visited.add(root);

      if (!root.querySelectorAll) continue;

      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
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

  function collectPage() {
    const roots = getRoots();
    const textParts = [];
    const controls = [];
    const seen = new Set();

    const selector = [
      'input:not([type="hidden"])',
      "textarea",
      "select",
      '[contenteditable="true"]',
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="option"]',
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

        const options = tag === "select"
          ? [...element.options]
              .map(option => ({
                text: option.text.trim(),
                value: option.value
              }))
              .filter(option => option.text)
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
              : element.getAttribute("role") ||
                (
                  element.isContentEditable
                    ? "contenteditable"
                    : tag
                ),

          label: String(label).trim().slice(0, 220),
          value: element.value || "",
          placeholder:
            element.getAttribute("placeholder") || "",
          options,
          disabled: !!element.disabled
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
    const selectors = [
      "button",
      '[role="button"]',
      "[aria-label]",
      "[title]",
      '[data-testid*="play" i]',
      '[class*="play" i]'
    ].join(",");

    const candidates = allElements(selectors)
      .filter(isVisible);

    return candidates.find(element => {
      const label = (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("data-testid") ||
        element.innerText ||
        ""
      ).trim().toLowerCase();

      return (
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

  function startAudioCaptureFromClick() {
    // Primero intentamos localizar el reproductor.
    let media = findMedia();

    if (media) {
      return startRecording(media);
    }

    // Si todavía no hay elemento multimedia,
    // intentamos pulsar el control Play de la página.
    const playButton = findPlayButton();

    if (playButton) {
      playButton.click();
    }

    return waitForMedia().then(foundMedia => {
      if (!foundMedia) {
        return {
          audioBase64: "",
          note:
            "No encontré un reproductor de audio accesible. " +
            "Puede estar dentro de un reproductor protegido o externo."
        };
      }

      return startRecording(foundMedia);
    });
  }

  // ==========================================
  // CAPTURAR IMÁGENES Y FOTOGRAMAS
  // ==========================================

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

      const canvas = document.createElement("canvas");

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
        const smaller = document.createElement("canvas");

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

      if (dataUrl.length > MAX_IMAGE_SIZE) {
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

        return (
          rb.width * rb.height -
          ra.width * ra.height
        );
      });

    for (const image of imageElements) {
      if (images.length >= 2) break;

      const result = imageToDataUrl(
        image,
        "Imagen de la actividad: " +
        (image.alt || "sin descripción")
      );

      if (result) images.push(result);
      else skipped.push("Una imagen no permitió su captura.");
    }

    for (const canvas of allElements("canvas")) {
      if (!isVisible(canvas) || images.length >= 3) {
        continue;
      }

      const result = imageToDataUrl(
        canvas,
        "Gráfico o actividad dibujada en canvas."
      );

      if (result) {
        images.push(result);
      } else {
        skipped.push(
          "Un gráfico no permitió leer sus píxeles."
        );
      }
    }

    for (const video of allElements("video")) {
      if (
        images.length >= MAX_IMAGES ||
        !isVisible(video) ||
        video.readyState < 2
      ) {
        continue;
      }

      const result = imageToDataUrl(
        video,
        `Fotograma de vídeo en el segundo ${Math.round(video.currentTime)}.`
      );

      if (result) {
        images.push(result);
      } else {
        skipped.push(
          "Un fotograma de vídeo no permitió captura."
        );
      }
    }

    return {
      images: images.slice(0, MAX_IMAGES),
      skipped
    };
  }

  // ==========================================
  // APLICAR RESPUESTAS
  // ==========================================

  function applyActions(actions) {
    let applied = 0;
    const details = [];

    for (const action of actions || []) {
      const element = document.querySelector(
        `[data-aula-ai-index="${Number(action.control_index)}"]`
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

      } else if (action.action === "click") {
        const label = (
          element.innerText ||
          element.value ||
          element.getAttribute("aria-label") ||
          element.textContent ||
          ""
        ).trim().toLowerCase();

        // Prohibido accionar botones finales.
        if (
          /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|next|siguiente|continuar|check answers|comprobar/i.test(label)
        ) {
          continue;
        }

        if (
          element.matches(
            'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"],[aria-checked],[aria-selected],[aria-pressed],label'
          )
        ) {
          element.click();
          applied++;
          details.push(action.question || "Opción marcada");
        }
      }
    }

    return { applied, details };
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
    initialAudioPromise
  ) {
    stopRequested = false;

    try {
      const token = await getToken();

      let audioPromise = initialAudioPromise;

      for (
        let step = 1;
        step <= maxQuestions && !stopRequested;
        step++
      ) {
        const snapshot = collectPage();

        report(
          runId,
          `Leyendo la actividad: ${snapshot.title}`
        );

        // Capturar texto e imágenes.
        const visual = await captureImages();

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
            `Audio: ${audio.audioBase64 ? "transmitido para transcripción" : audio.note}\n` +
            `${visual.skipped.join(" ")}`
          );

          return;
        }

        const applied = applyActions(result.actions);

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
          report(
            runId,
            "Se colocaron respuestas, pero no encontré un botón seguro para continuar. No se pulsó Entregar ni Enviar."
          );

          return;
        }

        await new Promise(resolve =>
          setTimeout(resolve, 1500)
        );

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
    if (
      !TOP ||
      document.getElementById("aula-ai-userscript")
    ) {
      return;
    }

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
          Aula AI intenta reproducir el audio y escucharlo.
          No pulsa Entregar ni Enviar.
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

    el("logout").addEventListener("click", async () => {
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
        captureAudio
      };

      // Analizar el documento principal.
      analyzeFrame(
        command.runId,
        command.maxQuestions,
        command.automatic,
        captureAudio,
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
        // También se intenta activar el reproductor
        // en el marco donde está ejecutándose el script.
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
          audioPromise
        );
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
