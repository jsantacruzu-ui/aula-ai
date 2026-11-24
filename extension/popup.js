
const SUPABASE_URL = "https://olkhplrgtcxrrnpmbjgd.supabase.co";
const SUPABASE_KEY = "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV";
const WORKER_URL = "https://aula-ai.jsantacruzu.workers.dev/api/solve";

const $ = id => document.getElementById(id);
let stopped = false;

async function getSession() {
  return await chrome.storage.local.get([
    "access_token",
    "refresh_token",
    "email"
  ]);
}

function status(text, busy = false) {
  $("state").textContent = text;
  $("state").classList.toggle("busy", busy);
}

async function show() {
  const session = await getSession();
  $("login").hidden = !!session.access_token;
  $("main").hidden = !session.access_token;

  if (session.access_token) {
    $("account").textContent = session.email || "Sesión activa";
  }
}

$("loginBtn").addEventListener("click", async () => {
  $("loginMsg").textContent = "Conectando…";

  try {
    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: $("email").value.trim(),
          password: $("password").value
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.msg || data.message || data.error_description ||
        "No se pudo iniciar sesión."
      );
    }

    await chrome.storage.local.set({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      email: data.user?.email || $("email").value.trim()
    });

    $("password").value = "";
    await show();
    status("Sesión activa");
  } catch (error) {
    $("loginMsg").textContent = error.message;
  }
});

$("logout").addEventListener("click", async () => {
  await chrome.storage.local.clear();
  await show();
  status("Sesión cerrada");
});

$("stop").addEventListener("click", () => {
  stopped = true;
  $("progress").textContent += "\nDetención solicitada.";
});

async function refreshToken(session) {
  if (!session.refresh_token) return session.access_token;

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        refresh_token: session.refresh_token
      })
    }
  );

  if (!response.ok) return session.access_token;

  const data = await response.json();

  await chrome.storage.local.set({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    email: data.user?.email || session.email
  });

  return data.access_token;
}

async function askAI(snapshot, token) {
  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(snapshot)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Error al consultar Aula AI");
  }

  return data;
}

// Inspeccionar cada marco de la página.
function collectFrame() {
  const selector = [
    'input:not([type="hidden"])',
    "textarea",
    "select",
    '[contenteditable="true"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="option"]',
    '[aria-checked]',
    '[aria-selected="true"], [aria-selected="false"]',
    '[aria-pressed]',
    '[tabindex]:not([tabindex="-1"])',
    "button",
    '[role="button"]'
  ].join(",");

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

  function getLabel(element) {
    const aria =
      element.getAttribute("aria-label") ||
      element.getAttribute("title");

    if (aria) return aria.trim();

    if (element.labels?.length) {
      return [...element.labels]
        .map(label => label.innerText || label.textContent || "")
        .join(" ")
        .trim()
        .slice(0, 250);
    }

    const parent = element.closest(
      "label,[role=radio],[role=checkbox],[role=option],button,[role=button]"
    );

    return (
      parent?.innerText ||
      element.innerText ||
      element.textContent ||
      element.parentElement?.innerText ||
      element.getAttribute("placeholder") ||
      ""
    ).trim().slice(0, 250);
  }

  const controls = [];
  const seen = new Set();
  const textParts = [];

  function scanRoot(root) {
    if (!root || !root.querySelectorAll) return;

    for (const element of root.querySelectorAll(selector)) {
      if (seen.has(element) || !isVisible(element)) continue;

      seen.add(element);

      const index = controls.length;

      element.setAttribute(
        "data-aula-ai-frame-index",
        String(index)
      );

      const tag = element.tagName.toLowerCase();

      const type = tag === "input"
        ? (element.type || "text")
        : tag === "textarea"
        ? "textarea"
        : tag === "select"
        ? "select"
        : element.getAttribute("role") ||
          (element.isContentEditable ? "contenteditable" : tag);

      const options = tag === "select"
        ? [...element.options]
            .map(option => ({
              text: option.text.trim(),
              value: option.value
            }))
            .filter(option => option.text)
        : [];

      controls.push({
        frame_control_index: index,
        type,
        label: getLabel(element),
        value: element.value || element.innerText || "",
        placeholder: element.getAttribute("placeholder") || "",
        options,
        disabled: !!element.disabled
      });
    }

    // Inspeccionar Shadow DOM abierto.
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        const shadowText = (
          element.shadowRoot.innerText ||
          element.shadowRoot.textContent ||
          ""
        ).trim();

        if (shadowText) {
          textParts.push(shadowText.slice(0, 6000));
        }

        scanRoot(element.shadowRoot);
      }
    }
  }

  const bodyText = (document.body?.innerText || "").trim();

  if (bodyText) {
    textParts.push(bodyText.slice(0, 12000));
  }

  scanRoot(document);

  const canvases = document.querySelectorAll("canvas").length;
  const images = [...document.images].filter(isVisible).length;
  const audios = document.querySelectorAll("audio").length;
  const videos = document.querySelectorAll("video").length;

  return {
    url: location.href,
    title: document.title,
    pageText: [...new Set(textParts)]
      .join("\n\n")
      .slice(0, 12000),
    controls,
    diagnostics: {
      canvases,
      images,
      audios,
      videos
    }
  };
}

// Aplicar respuestas dentro del marco correspondiente.
function applyFrameActions(actions) {
  function setValue(element, value) {
    if (element.isContentEditable) {
      element.textContent = value;

      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      }));

      element.dispatchEvent(
        new Event("change", { bubbles: true })
      );

      return;
    }

    const prototype = element.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const setter =
      Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (setter) setter.call(element, value);
    else element.value = value;

    element.dispatchEvent(
      new Event("input", { bubbles: true })
    );

    element.dispatchEvent(
      new Event("change", { bubbles: true })
    );
  }

  function safeOptionClick(element) {
    if (
      element.matches(
        'input[type="submit"],input[type="reset"]'
      )
    ) {
      return false;
    }

    const label = (
      element.innerText ||
      element.value ||
      element.getAttribute("aria-label") ||
      element.textContent ||
      ""
    ).trim().toLowerCase();

    if (
      /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|siguiente|next|continuar/i.test(label)
    ) {
      return false;
    }

    return element.matches(
      'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[role="option"],[aria-checked],[aria-selected],[aria-pressed],button,[role="button"],label,[tabindex]:not([tabindex="-1"])'
    );
  }

  let applied = 0;
  const details = [];

  for (const action of actions || []) {
    const element = document.querySelector(
      `[data-aula-ai-frame-index="${Number(action.frame_control_index)}"]`
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
      setValue(element, value);
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

    } else if (
      action.action === "click" &&
      safeOptionClick(element)
    ) {
      element.click();
      applied++;
      details.push(action.question || "opción marcada");
    }
  }

  return { applied, details };
}

// Buscar un botón seguro para avanzar.
function clickNextInFrame() {
  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  }

  const candidates = [
    ...document.querySelectorAll(
      "button,[role=button],input[type=button],a"
    )
  ].filter(visible);

  const next = candidates.find(element => {
    const label = (
      element.innerText ||
      element.value ||
      element.getAttribute("aria-label") ||
      ""
    ).trim().toLowerCase();

    if (!label) return false;

    if (
      /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|check answers|comprobar respuestas/i.test(label)
    ) {
      return false;
    }

    return /^(next|siguiente|continuar|continue|next question|próxima|avanzar|›|→)$/i.test(label) ||
      /^(next|siguiente|continuar|continue)\b/i.test(label);
  });

  if (!next) return { moved: false };

  next.click();

  return {
    moved: true,
    label: (next.innerText || next.value || "Siguiente").trim()
  };
}

// Recopilar datos de todos los marcos accesibles.
async function captureAllFrames(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: true
    },
    func: collectFrame
  });

  const controls = [];
  const textParts = [];
  const frameInfo = [];

  let globalIndex = 0;

  for (const item of injected) {
    const frameId = item.frameId;
    const frame = item.result;

    if (!frame) continue;

    frameInfo.push({
      frameId,
      url: frame.url,
      title: frame.title,
      controls: frame.controls?.length || 0,
      diagnostics: frame.diagnostics
    });

    if (frame.pageText) {
      textParts.push(
        `CONTENIDO DEL MARCO ${frameId}\nURL: ${frame.url}\n${frame.pageText}`
      );
    }

    for (const control of frame.controls || []) {
      controls.push({
        control_index: globalIndex,
        frame_id: frameId,
        frame_control_index: control.frame_control_index,
        type: control.type,
        label: control.label,
        value: control.value,
        placeholder: control.placeholder,
        options: control.options,
        disabled: control.disabled
      });

      globalIndex++;
    }
  }

  const mainFrame =
    injected.find(item => item.frameId === 0)?.result ||
    injected[0]?.result ||
    {};

  return {
    title: mainFrame.title || "Actividad web",
    url: mainFrame.url || "",
    pageText: textParts.join("\n\n").slice(0, 14000),
    controls: controls.slice(0, 100),
    frameInfo
  };
}

// Distribuir las respuestas entre los marcos correspondientes.
async function applyActionsToFrames(tabId, actions) {
  const groups = new Map();

  for (const action of actions || []) {
    const control = currentSnapshot.controls.find(
      item =>
        Number(item.control_index) === Number(action.control_index)
    );

    if (!control) continue;

    if (!groups.has(control.frame_id)) {
      groups.set(control.frame_id, []);
    }

    groups.get(control.frame_id).push({
      ...action,
      frame_control_index: control.frame_control_index
    });
  }

  let applied = 0;
  const details = [];

  for (const [frameId, frameActions] of groups.entries()) {
    try {
      const results = await chrome.scripting.executeScript({
        target: {
          tabId,
          frameIds: [frameId]
        },
        func: applyFrameActions,
        args: [frameActions]
      });

      const result = results?.[0]?.result;

      applied += result?.applied || 0;

      if (result?.details) {
        details.push(...result.details);
      }

    } catch (error) {
      details.push(
        `No se pudo aplicar en el marco ${frameId}: ${error.message}`
      );
    }
  }

  return { applied, details };
}

let currentSnapshot = { controls: [] };

// Iniciar el análisis y la ejecución automática.
$("run").addEventListener("click", async () => {
  stopped = false;
  $("run").disabled = true;
  $("stop").disabled = false;

  status("Inspeccionando página…", true);

  try {
    const session = await getSession();

    if (!session.access_token) {
      throw new Error("Inicia sesión primero en la extensión.");
    }

    const token = await refreshToken(session);

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw new Error(
        "Abre primero una página web con tu actividad."
      );
    }

    // Mantener el indicador visual en el marco principal.
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "AULA_PING"
      });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    }

    let done = 0;
    const max = Number($("max").value);
    const auto = $("auto").checked;

    while (!stopped && done < max) {
      $("progress").textContent =
        "Inspeccionando la página y sus marcos…";

      currentSnapshot = await captureAllFrames(tab.id);

      if (
        !currentSnapshot.controls.length &&
        !currentSnapshot.pageText.trim()
      ) {
        const frames = currentSnapshot.frameInfo || [];

        const diagnostic = frames.map(frame =>
          `Marco ${frame.frameId}: ${frame.controls} controles; ${frame.url}`
        ).join("\n");

        throw new Error(
          "No pude leer el contenido de la actividad. " +
          `Marcos inspeccionados: ${frames.length}. ` +
          "Puede estar dibujada en un reproductor, canvas o marco protegido.\n" +
          diagnostic
        );
      }

      $("progress").textContent =
        `Analizando contenido de ${currentSnapshot.frameInfo.length} marco(s) ` +
        `y ${currentSnapshot.controls.length} control(es)…`;

      const result = await askAI({
        title: currentSnapshot.title,
        url: currentSnapshot.url,
        pageText: currentSnapshot.pageText,
        controls: currentSnapshot.controls
      }, token);

      if (!result.actions?.length) {
        const frames = currentSnapshot.frameInfo || [];

        const details = frames.map(frame =>
          `Marco ${frame.frameId}: ${frame.controls} controles — ${frame.url}`
        ).join("\n");

        $("progress").textContent =
          `No se aplicaron respuestas. ${result.summary || "No se detectaron ejercicios interactivos."}\n` +
          `Marcos inspeccionados: ${frames.length}. Controles detectados: ${currentSnapshot.controls.length}.\n` +
          details +
          "\nSi la pregunta aparece como imagen, audio, vídeo o canvas, esta versión todavía no puede interpretarla directamente.";

        break;
      }

      const applied = await applyActionsToFrames(
        tab.id,
        result.actions
      );

      done++;

      $("progress").textContent =
        `Pregunta ${done}: ${applied.applied} respuesta(s) colocada(s).\n` +
        `${result.summary || ""}`;

      if (!auto || stopped) break;

      if (!applied.applied) {
        $("progress").textContent +=
          "\nNo se pudo aplicar ninguna respuesta. Se detuvo.";
        break;
      }

      const navResults = await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
          allFrames: true
        },
        func: clickNextInFrame
      });

      const moved = navResults.find(
        item => item.result?.moved
      );

      if (!moved) {
        $("progress").textContent +=
          "\nNo encontré un botón seguro para continuar. No se pulsó Enviar ni Finalizar.";
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1600));
    }

    if (done >= max) {
      $("progress").textContent +=
        `\nSe alcanzó el límite configurado (${max}).`;
    }

    status(stopped ? "Detenido" : "Finalizado");

  } catch (error) {
    $("progress").textContent = "Error: " + error.message;
    status("Revisar");

  } finally {
    $("run").disabled = false;
    $("stop").disabled = true;
  }
});

show();
