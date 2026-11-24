
// ==UserScript==
// @name         Aula AI - Asistente multimedia
// @namespace    https://aula-ai.jsantacruzu.workers.dev/
// @version      0.2.0
// @description  Tutor automático con lectura de texto, imágenes, audio y fotogramas de vídeo.
// @author       Aula AI
// @homepageURL  https://aula-ai.jsantacruzu.workers.dev/
// @supportURL   https://github.com/jsantacruzu-ui/aula-ai
// @updateURL    https://aula-ai.jsantacruzu.workers.dev/aula-ai.user.js
// @downloadURL  https://aula-ai.jsantacruzu.workers.dev/aula-ai.user.js
// @match        http://*/*
// @match        https://*/*
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

  const SUPABASE = "https://olkhplrgtcxrrnpmbjgd.supabase.co";
  const WORKER = "https://aula-ai.jsantacruzu.workers.dev/api/solve";

  const TOKEN_KEY = "aula_access_token";
  const REFRESH_KEY = "aula_refresh_token";
  const EMAIL_KEY = "aula_email";

  const MAX_IMAGES = 4;
  const MAX_IMAGE_CHARS = 1150000;
  const AUDIO_DURATION_MS = 12000;

  const TOP = window.top === window.self;

  let stopRequested = false;
  let activeRunId = "";
  let setPanelStatus = () => {};

  // ==========================================
  // CONEXIÓN CON AULA AI Y SUPABASE
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
            apikey: "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV"
          } : {})
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 90000,

        onload: response => {
          let data;

          try {
            data = JSON.parse(response.responseText || "{}");
          } catch {
            reject(
              new Error("El servidor devolvió una respuesta no válida.")
            );
            return;
          }

          if (response.status < 200 || response.status >= 300) {
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
          reject(new Error("No se pudo conectar con el servidor."));
        },

        ontimeout: () => {
          reject(new Error("La solicitud tardó demasiado."));
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

    await GM_setValue(TOKEN_KEY, data.access_token);
    await GM_setValue(REFRESH_KEY, data.refresh_token);
    await GM_setValue(EMAIL_KEY, data.user?.email || email);
  }

  async function getToken() {
    let token = await GM_getValue(TOKEN_KEY, "");
    const refresh = await GM_getValue(REFRESH_KEY, "");

    if (!token) {
      throw new Error("Primero inicia sesión en Aula AI.");
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
          "Tu sesión venció. Inicia sesión nuevamente."
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
  // UTILIDADES DEL DOCUMENTO
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
        if (seen.has(element) || !isVisible(element)) continue;

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
              ? (element.type || "text")
              : tag === "textarea"
              ? "textarea"
              : tag === "select"
              ? "select"
              : element.getAttribute("role") ||
                (element.isContentEditable
                  ? "contenteditable"
                  : tag),
          label: String(label).trim().slice(0, 220),
          value: element.value || "",
          placeholder: element.getAttribute("placeholder") || "",
          options,
          disabled: !!element.disabled
        });
      }
    }

    const frames = [...document.querySelectorAll("iframe,frame")]
      .map(frame => frame.src || "(marco sin dirección)");

    return {
      title: document.title || "Actividad",
      pageText: [...new Set(textParts)]
        .join("\n\n")
        .slice(0, 14000),
      controls: controls.slice(0, 100),
      diagnostics: {
        url: location.href,
        frames: frames.length,
        canvases: document.querySelectorAll("canvas").length,
        images: document.querySelectorAll("img").length,
        audios: document.querySelectorAll("audio").length,
        videos: document.querySelectorAll("video").length
      }
    };
  }

  // ==========================================
  // CONVERSIÓN DE IMÁGENES A JPEG
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

      const maxDimension = 1100;
      const scale = Math.min(
        1,
        maxDimension / Math.max(width, height)
      );

      const canvas = document.createElement("canvas");

      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      const context = canvas.getContext("2d");

      if (!context) return null;

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.drawImage(
        source,
        0,
        0,
        canvas.width,
        canvas.height
      );

      let dataUrl = canvas.toDataURL(
        "image/jpeg",
        0.72
      );

      if (dataUrl.length > MAX_IMAGE_CHARS) {
        const smaller = document.createElement("canvas");

        smaller.width = Math.round(canvas.width * 0.65);
        smaller.height = Math.round(canvas.height * 0.65);

        const smallerContext = smaller.getContext("2d");

        smallerContext.drawImage(
          canvas,
          0,
          0,
          smaller.width,
          smaller.height
        );

        dataUrl = smaller.toDataURL(
          "image/jpeg",
          0.58
        );
      }

      if (dataUrl.length > MAX_IMAGE_CHARS) {
        return null;
      }

      return {
        dataUrl,
        description
      };

    } catch (error) {
      console.warn(
        "Aula AI: imagen no accesible:",
        description,
        error.message
      );

      return null;
    }
  }

  function allElements(selector) {
    const elements = [];

    for (const root of getRoots()) {
      elements.push(...root.querySelectorAll(selector));
    }

    return [...new Set(elements)];
  }

  // ==========================================
  // CAPTURA DE IMÁGENES Y GRÁFICOS
  // ==========================================

  async function captureImages() {
    const images = [];
    const skipped = [];

    // Primero, imágenes visibles de la actividad.
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
        (image.alt || image.getAttribute("title") || "sin descripción")
      );

      if (result) {
        images.push(result);
      } else {
        skipped.push("Una imagen no permitió su captura.");
      }
    }

    // Capturar gráficos y ejercicios dibujados en canvas.
    const canvases = allElements("canvas")
      .filter(isVisible);

    for (const canvas of canvases) {
      if (images.length >= 3) break;

      const result = imageToDataUrl(
        canvas,
        "Gráfico o actividad dibujada en canvas."
      );

      if (result) {
        images.push(result);
      } else {
        skipped.push(
          "Un canvas está protegido o no permitió leer sus píxeles."
        );
      }
    }

    // Capturar fotogramas del vídeo.
    const videos = allElements("video")
      .filter(video =>
        isVisible(video) &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      );

    for (const video of videos) {
      if (images.length >= MAX_IMAGES) break;

      const originalTime = video.currentTime;
      const wasPlaying = !video.paused && !video.ended;

      const duration = video.duration;
      const sampleTimes = [originalTime];

      // Para vídeos que permiten desplazarse, tomar otros fotogramas.
      if (
        Number.isFinite(duration) &&
        duration > 4 &&
        video.seekable?.length
      ) {
        sampleTimes.push(
          duration * 0.35,
          duration * 0.70
        );
      }

      const uniqueTimes = [...new Set(
        sampleTimes.map(time =>
          Math.max(0, Math.min(time, duration || time))
        )
      )];

      try {
        if (wasPlaying) {
          video.pause();
        }

        for (const time of uniqueTimes) {
          if (images.length >= MAX_IMAGES) break;

          if (Math.abs(video.currentTime - time) > 0.35) {
            await new Promise(resolve => {
              let completed = false;

              const finish = () => {
                if (completed) return;
                completed = true;
                video.removeEventListener("seeked", finish);
                clearTimeout(timer);
                resolve();
              };

              const timer = setTimeout(finish, 1800);

              video.addEventListener(
                "seeked",
                finish,
                { once: true }
              );

              try {
                video.currentTime = time;
              } catch {
                finish();
              }
            });
          }

          if (video.readyState >= 2) {
            const result = imageToDataUrl(
              video,
              `Fotograma de vídeo en segundo ${Math.round(video.currentTime)}.`
            );

            if (result) {
              images.push(result);
            } else {
              skipped.push(
                "Un fotograma del vídeo no permitió captura por restricciones de origen."
              );
            }
          }
        }

      } catch (error) {
        skipped.push(
          "No se pudo extraer un fotograma: " + error.message
        );

      } finally {
        try {
          if (Number.isFinite(originalTime)) {
            video.currentTime = originalTime;
          }

          if (wasPlaying) {
            await video.play().catch(() => {});
          }
        } catch {}
      }
    }

    return {
      images: images.slice(0, MAX_IMAGES),
      skipped
    };
  }

  // ==========================================
  // CAPTURA DE AUDIO DEL REPRODUCTOR
  // ==========================================

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(
        new Error("No se pudo leer el archivo de audio.")
      );

      reader.readAsDataURL(blob);
    });
  }

  async function capturePlayingAudio() {
    if (
      typeof MediaRecorder === "undefined" ||
      typeof MediaStream === "undefined"
    ) {
      return {
        audioBase64: "",
        note: "Este navegador no admite grabación de audio mediante este método."
      };
    }

    const mediaElements = [
      ...allElements("audio,video")
    ];

    const playing = mediaElements.filter(media =>
      !media.paused &&
      !media.ended &&
      media.readyState >= 2
    );

    if (!playing.length) {
      return {
        audioBase64: "",
        note: "No hay audio reproduciéndose. Pulsa Play en el reproductor y vuelve a analizar."
      };
    }

    let lastError = "";

    for (const media of playing) {
      try {
        const capture =
          media.captureStream ||
          media.mozCaptureStream;

        if (!capture) {
          lastError = "El reproductor no permite capturar su audio.";
          continue;
        }

        const originalStream = capture.call(media);
        const audioTracks = originalStream.getAudioTracks();

        if (!audioTracks.length) {
          lastError = "El reproductor no expone una pista de audio.";
          continue;
        }

        const stream = new MediaStream(audioTracks);

        const mimeCandidates = [
          "audio/webm;codecs=opus",
          "audio/ogg;codecs=opus",
          "audio/webm",
          "audio/mp4"
        ];

        const mimeType = mimeCandidates.find(type =>
          MediaRecorder.isTypeSupported(type)
        );

        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        const chunks = [];

        const audioReady = new Promise((resolve, reject) => {
          recorder.ondataavailable = event => {
            if (event.data?.size) {
              chunks.push(event.data);
            }
          };

          recorder.onerror = event => {
            reject(
              event.error ||
              new Error("Error durante la grabación de audio.")
            );
          };

          recorder.onstop = resolve;

          recorder.start(500);

          setTimeout(() => {
            if (recorder.state === "recording") {
              recorder.stop();
            }
          }, AUDIO_DURATION_MS);
        });

        await audioReady;

        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm"
        });

        if (!blob.size) {
          lastError = "La grabación no contiene sonido.";
          continue;
        }

        if (blob.size > 1500000) {
          lastError = "El fragmento de audio es demasiado grande.";
          continue;
        }

        const dataUrl = await blobToDataUrl(blob);

        return {
          audioBase64: dataUrl,
          note: "Audio capturado durante hasta 12 segundos."
        };

      } catch (error) {
        lastError = error.message || "No se pudo capturar el audio.";
      }
    }

    return {
      audioBase64: "",
      note:
        lastError ||
        "No se pudo capturar el audio de los reproductores disponibles."
    };
  }

  // ==========================================
  // APLICAR RESPUESTAS A CONTROLES
  // ==========================================

  function applyActions(actions) {
    let applied = 0;
    const details = [];

    for (const action of actions || []) {
      const index = Number(action.control_index);

      const element = document.querySelector(
        `[data-aula-ai-index="${index}"]`
      );

      if (!element || element.disabled) continue;

      const value = String(action.value ?? "").trim();

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
            Object.getOwnPropertyDescriptor(prototype, "value")?.set;

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

        // Nunca pulsar botones de entrega, envío o finalización.
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
    const elements = [
      ...document.querySelectorAll(
        'button,[role="button"],input[type="button"],a'
      )
    ].filter(isVisible);

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
  // ESTADOS Y COMUNICACIÓN ENTRE MARCOS
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
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage(message, "*");
      } catch {}
    }
  }

  // ==========================================
  // ANÁLISIS DE LA ACTIVIDAD
  // ==========================================

  async function analyzeFrame(runId, maxQuestions, automatic, captureAudio) {
    stopRequested = false;

    try {
      const token = await getToken();

      for (
        let step = 1;
        step <= maxQuestions && !stopRequested;
        step++
      ) {
        const snapshot = collectPage();

        report(
          runId,
          `Leyendo «${snapshot.title}» y capturando material multimedia…`
        );

        // 1. Capturar imágenes y fotogramas.
        const visual = await captureImages();

        // 2. Capturar audio si hay un reproductor activo.
        let audio = {
          audioBase64: "",
          note: "Captura de audio desactivada."
        };

        if (captureAudio) {
          audio = await capturePlayingAudio();
        }

        report(
          runId,
          `Material encontrado: ${visual.images.length} imagen(es), ` +
          `${snapshot.controls.length} control(es). ${audio.note}`
        );

        if (
          !snapshot.pageText.trim() &&
          !snapshot.controls.length &&
          !visual.images.length &&
          !audio.audioBase64
        ) {
          report(
            runId,
            `No se pudo leer el contenido de este marco. URL: ${location.href}. ` +
            `Canvas: ${snapshot.diagnostics.canvases}; ` +
            `imágenes: ${snapshot.diagnostics.images}; ` +
            `audio: ${snapshot.diagnostics.audios}; ` +
            `vídeos: ${snapshot.diagnostics.videos}.`
          );

          return;
        }

        const requestBody = {
          title: snapshot.title,
          pageText: snapshot.pageText,
          controls: snapshot.controls,
          images: visual.images,
          audioBase64: audio.audioBase64 || undefined
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
            `No se propusieron respuestas. ` +
            `${result.summary || result.stop_reason || "No se reconoció una pregunta resoluble."}\n` +
            `Imágenes enviadas: ${visual.images.length}. ` +
            `Controles: ${snapshot.controls.length}. ` +
            `Audio: ${audio.audioBase64 ? "capturado" : audio.note}\n` +
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
            "Se colocaron respuestas, pero no se encontró un botón seguro para continuar. No se pulsó Entregar ni Enviar."
          );

          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1600));
      }

    } catch (error) {
      report(
        runId,
        `Error en «${document.title}»: ${error.message}`
      );
    }
  }

  // ==========================================
  // PANEL FLOTANTE
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

    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        * {
          box-sizing: border-box;
          font-family: Arial, sans-serif;
        }

        .launcher {
          background: #172238;
          color: #fff;
          border: 0;
          border-radius: 24px;
          padding: 12px 18px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 4px 18px #0004;
        }

        .panel {
          display: none;
          width: 320px;
          background: #fff;
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
          color: #fff;
          font-weight: 700;
          cursor: pointer;
        }

        button.secondary {
          background: #e9edf5;
          color: #23314a;
        }

        button:disabled {
          opacity: .5;
        }

        .status {
          white-space: pre-wrap;
          max-height: 150px;
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
          <input id="email" type="email" placeholder="Correo de Aula AI">
          <input id="password" type="password" placeholder="Contraseña">
          <button class="action" id="loginBtn">Iniciar sesión</button>
        </div>

        <div id="tools" style="display:none">
          <label class="small">Máximo de preguntas</label>

          <select id="max">
            <option>1</option>
            <option>3</option>
            <option selected>5</option>
            <option>10</option>
          </select>

          <label class="small">
            <input id="auto" type="checkbox" checked>
            Modo automático: avanzar cuando sea seguro
          </label>

          <p class="small">
            <input id="audio" type="checkbox" checked>
            Capturar audio de reproductores activos (12 segundos)
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
          Para ejercicios de audio, pulsa Play antes de analizar.
          No se pulsa Entregar ni Enviar.
        </p>
      </section>

      <button class="launcher" id="toggle">
        ✦ Aula AI
      </button>
    `;

    (document.body || document.documentElement)
      .appendChild(host);

    const el = id => shadow.getElementById(id);

    setPanelStatus = text => {
      el("status").textContent = text;
    };

    async function refreshPanel() {
      const token = await GM_getValue(TOKEN_KEY, "");
      const email = await GM_getValue(EMAIL_KEY, "");

      el("login").style.display = token ? "none" : "block";
      el("tools").style.display = token ? "block" : "none";

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

    el("run").addEventListener("click", () => {
      activeRunId =
        Date.now().toString(36) +
        Math.random().toString(36).slice(2);

      stopRequested = false;

      el("run").disabled = true;

      setPanelStatus(
        "Analizando texto, imágenes, vídeo y audio accesibles…"
      );

      const command = {
        source: "AULA_AI_COMMAND",
        type: "RUN",
        runId: activeRunId,
        maxQuestions: Number(el("max").value),
        automatic: el("auto").checked,
        captureAudio: el("audio").checked
      };

      // Analizar el marco principal.
      analyzeFrame(
        command.runId,
        command.maxQuestions,
        command.automatic,
        command.captureAudio
      );

      // Enviar la orden a todos los marcos internos.
      sendToChildFrames(command);

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
  // MENSAJES ENTRE DOCUMENTO Y MARCOS INTERNOS
  // ==========================================

  window.addEventListener("message", event => {
    const data = event.data;

    if (!data || typeof data !== "object") return;

    if (
      data.source === "AULA_AI_COMMAND" &&
      !TOP &&
      event.source === window.parent
    ) {
      sendToChildFrames(data);

      if (data.type === "RUN") {
        analyzeFrame(
          data.runId,
          data.maxQuestions,
          data.automatic,
          data.captureAudio
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
