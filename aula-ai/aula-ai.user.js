
// ==UserScript==
// @name         Aula AI - Asistente de tareas
// @namespace    https://aula-ai.jsantacruzu.workers.dev/
// @version      0.1.0
// @description  Asistente de estudio para páginas educativas.
// @author       Aula AI
// @homepageURL  https://aula-ai.jsantacruzu.workers.dev/
// @supportURL   https://github.com/jsantacruzu-ui/aula-ai
// @updateURL    https://aula-ai.jsantacruzu.workers.dev/aula-ai.user.js
// @downloadURL  https://aula-ai.jsantacruzu.workers.dev/aula-ai.user.js
// @match        http://*/*
// @match        https://*/*
// @all-frames
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
  const TOP = window.top === window.self;

  let stopRequested = false;
  let activeRunId = "";
  let setPanelStatus = () => {};

  function request(method, url, body, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(url.startsWith(SUPABASE) ? {
            apikey: "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV"
          } : {})
        },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 60000,
        onload: response => {
          let data;

          try {
            data = JSON.parse(response.responseText || "{}");
          } catch {
            reject(new Error("El servidor devolvió una respuesta no válida."));
            return;
          }

          if (response.status < 200 || response.status >= 300) {
            reject(new Error(
              data.error_description || data.msg || data.message ||
              data.error || `Error HTTP ${response.status}`
            ));
            return;
          }

          resolve(data);
        },
        onerror: () => reject(new Error("No se pudo conectar con el servidor.")),
        ontimeout: () => reject(new Error("La solicitud tardó demasiado."))
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
      throw new Error("Inicia sesión en el panel de Aula AI.");
    }

    try {
      await request("GET", `${SUPABASE}/auth/v1/user`, null, token);
      return token;
    } catch {
      if (!refresh) {
        throw new Error("Tu sesión venció. Vuelve a iniciar sesión.");
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

  function isVisible(element) {
    try {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0;
    } catch {
      return false;
    }
  }

  function collectPage() {
    const roots = [document];
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

    while (roots.length) {
      const root = roots.shift();

      if (!root?.querySelectorAll) continue;

      const text = (root.innerText || root.textContent || "").trim();

      if (text) {
        textParts.push(text.slice(0, 9000));
      }

      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element) || !isVisible(element)) continue;

        seen.add(element);

        const index = controls.length;
        element.setAttribute("data-aula-ai-index", String(index));

        const tag = element.tagName.toLowerCase();

        let label =
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          element.getAttribute("placeholder") ||
          "";

        if (!label && element.labels?.length) {
          label = [...element.labels]
            .map(x => x.innerText || x.textContent || "")
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
          ? [...element.options].map(option => ({
              text: option.text.trim(),
              value: option.value
            })).filter(option => option.text)
          : [];

        controls.push({
          control_index: index,
          type: tag === "input"
            ? (element.type || "text")
            : tag === "textarea"
            ? "textarea"
            : tag === "select"
            ? "select"
            : element.getAttribute("role") ||
              (element.isContentEditable ? "contenteditable" : tag),
          label: String(label).trim().slice(0, 220),
          value: element.value || "",
          placeholder: element.getAttribute("placeholder") || "",
          options,
          disabled: !!element.disabled
        });
      }

      // Examinar Shadow DOM abierto.
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      }
    }

    const frames = [...document.querySelectorAll("iframe,frame")].map(frame => {
      try {
        return frame.src || "(marco sin dirección)";
      } catch {
        return "(marco no accesible)";
      }
    });

    return {
      title: document.title || "Actividad",
      pageText: [...new Set(textParts)].join("\n\n").slice(0, 14000),
      controls: controls.slice(0, 100),
      diagnostics: {
        url: location.href,
        frameCount: frames.length,
        frames,
        canvases: document.querySelectorAll("canvas").length,
        images: [...document.images].filter(isVisible).length,
        audios: document.querySelectorAll("audio").length,
        videos: document.querySelectorAll("video").length
      }
    };
  }

  function applyActions(actions) {
    let applied = 0;
    const details = [];

    for (const action of actions || []) {
      const element = document.querySelector(
        `[data-aula-ai-index="${Number(action.control_index)}"]`
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

          element.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: value
          }));
        } else {
          const proto = element.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;

          const setter =
            Object.getOwnPropertyDescriptor(proto, "value")?.set;

          if (setter) setter.call(element, value);
          else element.value = value;

          element.dispatchEvent(
            new Event("input", { bubbles: true })
          );
        }

        element.dispatchEvent(
          new Event("change", { bubbles: true })
        );

        applied++;
        details.push(action.question || "campo completado");

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
          details.push(action.question || "opción seleccionada");
        }

      } else if (action.action === "click") {
        const label = (
          element.innerText ||
          element.value ||
          element.getAttribute("aria-label") ||
          element.textContent ||
          ""
        ).trim().toLowerCase();

        if (
          /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|next|siguiente|continuar/i.test(label)
        ) {
          continue;
        }

        if (
          element.matches(
            'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"],[aria-checked],[aria-selected],[aria-pressed],label,button,[role="button"]'
          )
        ) {
          element.click();
          applied++;
          details.push(action.question || "opción marcada");
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

      return /^(next|siguiente|continuar|continue|next question|próxima|avanzar|›|→)$/i.test(label) ||
        /^(next|siguiente|continuar|continue)\b/i.test(label);
    });

    if (!next) return false;

    next.click();
    return true;
  }

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

  async function analyzeFrame(runId, maxQuestions, automatic) {
    stopRequested = false;

    try {
      const token = await getToken();

      for (
        let step = 1;
        step <= maxQuestions && !stopRequested;
        step++
      ) {
        const snapshot = collectPage();

        if (!snapshot.pageText.trim() && !snapshot.controls.length) {
          report(runId,
            `Este marco no expone texto ni controles. URL: ${location.href}. ` +
            `Canvas: ${snapshot.diagnostics.canvases}; imágenes: ${snapshot.diagnostics.images}; ` +
            `audio: ${snapshot.diagnostics.audios}; video: ${snapshot.diagnostics.videos}.`
          );
          return;
        }

        report(runId,
          `Analizando «${snapshot.title}»: ` +
          `${snapshot.pageText.length} caracteres y ` +
          `${snapshot.controls.length} controles.`
        );

        const result = await request(
          "POST",
          WORKER,
          {
            title: snapshot.title,
            pageText: snapshot.pageText,
            controls: snapshot.controls
          },
          token
        );

        if (!result.actions?.length) {
          report(runId,
            `Sin respuestas en «${snapshot.title}». ` +
            `${result.summary || result.stop_reason || "La IA no identificó una pregunta que pueda resolver."} ` +
            `Controles: ${snapshot.controls.length}; ` +
            `marcos internos: ${snapshot.diagnostics.frameCount}; ` +
            `canvas: ${snapshot.diagnostics.canvases}; ` +
            `imágenes: ${snapshot.diagnostics.images}; ` +
            `audio: ${snapshot.diagnostics.audios}. URL: ${location.href}`
          );
          return;
        }

        const applied = applyActions(result.actions);

        report(runId,
          `«${snapshot.title}»: ${applied.applied} respuesta(s) colocada(s). ` +
          `${result.summary || ""}`
        );

        if (!automatic || !applied.applied || stopRequested) return;

        if (!clickNext()) {
          report(runId,
            `Respuestas colocadas en «${snapshot.title}». ` +
            `No se encontró un botón seguro para continuar; ` +
            `no se pulsó Entregar ni Enviar.`
          );
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1400));
      }
    } catch (error) {
      report(runId, `Error en «${document.title}»: ${error.message}`);
    }
  }

  function relayToChildFrames(message) {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage(message, "*");
      } catch {}
    }
  }

  // Recibir instrucciones y avisos de marcos internos.
  window.addEventListener("message", event => {
    const data = event.data;

    if (!data || typeof data !== "object") return;

    if (
      data.source === "AULA_AI_COMMAND" &&
      !TOP &&
      event.source === window.parent
    ) {
      relayToChildFrames(data);

      if (data.type === "RUN") {
        analyzeFrame(
          data.runId,
          data.maxQuestions,
          data.automatic
        );
      }

      if (data.type === "STOP") {
        stopRequested = true;
      }

    } else if (data.source === "AULA_AI_STATUS" && !TOP) {
      window.parent.postMessage(data, "*");

    } else if (data.source === "AULA_AI_STATUS" && TOP) {
      if (!activeRunId || data.runId === activeRunId) {
        setPanelStatus(data.message);
      }
    }
  });

  function createPanel() {
    if (!TOP || document.getElementById("aula-ai-userscript")) return;

    const host = document.createElement("div");
    host.id = "aula-ai-userscript";
    host.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px";

    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:Arial,sans-serif}
        .launcher{background:#172238;color:#fff;border:0;border-radius:24px;padding:12px 18px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px #0004}
        .panel{display:none;width:310px;background:#fff;color:#182338;border-radius:14px;padding:16px;margin-bottom:9px;box-shadow:0 8px 30px #0004;border:1px solid #dce3ef}
        .panel.open{display:block}
        h3{margin:0 0 6px;font-size:17px}
        p{font-size:12px;color:#657189;line-height:1.45}
        input,select{width:100%;padding:10px;margin:6px 0;border:1px solid #ccd4e2;border-radius:8px;font-size:13px}
        button.action{width:100%;padding:10px;margin-top:8px;border:0;border-radius:8px;background:#315bea;color:#fff;font-weight:700;cursor:pointer}
        button.secondary{background:#e9edf5;color:#23314a}
        button:disabled{opacity:.5}
        .status{white-space:pre-wrap;max-height:140px;overflow:auto;background:#f2f5fa;border-radius:8px;padding:10px;font-size:11px;line-height:1.45;margin-top:10px}
        .small{font-size:10px;color:#778198}
      </style>
      <section class="panel open" id="panel">
        <h3>Aula AI</h3>
        <p id="account">Asistente de estudio</p>
        <div id="login">
          <input id="email" type="email" placeholder="Correo de Aula AI">
          <input id="password" type="password" placeholder="Contraseña">
          <button class="action" id="loginBtn">Iniciar sesión</button>
        </div>
        <div id="tools" style="display:none">
          <label class="small">Preguntas máximas por ejecución</label>
          <select id="max">
            <option>1</option>
            <option>3</option>
            <option selected>5</option>
            <option>10</option>
          </select>
          <label class="small">
            <input id="auto" type="checkbox" checked style="width:auto">
            Modo automático: avanzar cuando sea seguro
          </label>
          <button class="action" id="run">Analizar y responder</button>
          <button class="action secondary" id="stop">Detener</button>
          <button class="action secondary" id="logout">Cerrar sesión</button>
        </div>
        <div class="status" id="status">Inicia sesión para utilizar Aula AI.</div>
        <p class="small">No pulsa Entregar ni Enviar. Revisa las respuestas antes de presentar tu actividad.</p>
      </section>
      <button class="launcher" id="toggle">✦ Aula AI</button>
    `;

    (document.body || document.documentElement).appendChild(host);

    const el = id => shadow.getElementById(id);

    setPanelStatus = text => {
      el("status").textContent = text;
    };

    const refreshPanel = async () => {
      const token = await GM_getValue(TOKEN_KEY, "");
      const email = await GM_getValue(EMAIL_KEY, "");

      el("login").style.display = token ? "none" : "block";
      el("tools").style.display = token ? "block" : "none";
      el("account").textContent = token
        ? `Sesión: ${email}`
        : "Inicia sesión con tu cuenta de Aula AI";
    };

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
        setPanelStatus("No se pudo iniciar sesión: " + error.message);

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
      setPanelStatus("Analizando la página y los marcos internos…");

      const command = {
        source: "AULA_AI_COMMAND",
        type: "RUN",
        runId: activeRunId,
        maxQuestions: Number(el("max").value),
        automatic: el("auto").checked
      };

      analyzeFrame(
        command.runId,
        command.maxQuestions,
        command.automatic
      );

      relayToChildFrames(command);

      setTimeout(() => {
        el("run").disabled = false;
      }, 12000);
    });

    el("stop").addEventListener("click", () => {
      stopRequested = true;

      relayToChildFrames({
        source: "AULA_AI_COMMAND",
        type: "STOP"
      });

      setPanelStatus("Detención solicitada.");
    });

    refreshPanel();
  }

  if (TOP) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", createPanel, { once: true });
    } else {
      createPanel();
    }
  }

  GM_registerMenuCommand("Aula AI: abrir panel", () => {
    const host = document.getElementById("aula-ai-userscript");
    host?.shadowRoot?.getElementById("toggle")?.click();
  });
})();
