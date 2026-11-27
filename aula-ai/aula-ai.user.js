
// ==UserScript==
// @name         Aula AI - Asistente multimedia
// @namespace    https://aula-ai.jsantacruzu.workers.dev/
// @version      0.3.43
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
  const PRECISION_KEY = "aula_precision_mode";
  const VERIFY_KEY = "aula_verify_answers";
  const ERROR_HISTORY_KEY = "aula_error_history";
  const DEFAULT_PRECISION = "high";

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
  async function getAulaSettings() {
    return { precision: await GM_getValue(PRECISION_KEY, DEFAULT_PRECISION), verify: await GM_getValue(VERIFY_KEY, true) };
  }
  async function saveAnswerHistory(entry) {
    try {
      const old = await GM_getValue(ERROR_HISTORY_KEY, []);
      const history = Array.isArray(old) ? old : [];
      history.unshift({ id: Date.now().toString(36), date: new Date().toISOString(), ...entry });
      await GM_setValue(ERROR_HISTORY_KEY, history.slice(0, 300));
      return history.length;
    } catch { return 0; }
  }
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
    if (isDropdownOption(element)) return false;

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

  function isDropdownOption(element) {
    if (!element) return false;

    if (element.matches(
      '[role="option"],[role="menuitem"],[data-value],li[tabindex]'
    )) return true;

    const classes = String(element.className || "").toLowerCase();
    if (!/(option|choice)/.test(classes)) return false;

    let parent = element.parentElement;
    for (let level = 0; level < 6 && parent; level++, parent = parent.parentElement) {
      if (parent.matches(
        '[role="listbox"],[role="menu"],[class*="dropdown-menu" i],[class*="select-menu" i]'
      )) return true;
    }

    return false;
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
        '[role="option"],[role="menuitem"],option,li,[data-value],button,[class*="option" i],[class*="choice" i]'
      )
        ? [container]
        : [...container.querySelectorAll(
            '[role="option"],[role="menuitem"],option,li,[data-value],button,[class*="option" i],[class*="choice" i]'
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
    ).some(isVisible) || allElements(
      '[role="option"],[role="menuitem"]'
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
      '[role="textbox"]',
      '[draggable="true"]',
      '[data-draggable="true"]',
      '[data-testid*="word" i]',
      '[data-testid*="token" i]',
      '[class*="word" i]',
      '[class*="token" i]',
      '[class*="answer-option" i]',
      '[class*="word-option" i]',
      '[class*="choice" i]',
      '[onclick]',
      '[tabindex]',
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="combobox"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listbox"] li',
      '[role="menu"] li',
      '[class*="dropdown-menu" i] li',
      '[class*="select-menu" i] li',
      '[role="listbox"] [class*="option" i]',
      '[role="listbox"] [class*="choice" i]',
      '[role="menu"] [class*="option" i]',
      '[class*="dropdown-menu" i] [class*="option" i]',
      '[class*="select-menu" i] [class*="option" i]',
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="menu"]',
      '[aria-haspopup="true"]',
      // Cambridge y otras plataformas dibujan los desplegables como DIV.
      // Incluir el cuadro para poder abrirlo y luego leer sus opciones.
      '[class*="dropdown" i]',
      '[class*="select" i]',
      '[class*="combobox" i]',
      '[data-drop-target="true"]',
      '[data-testid*="blank" i]',
      '[data-testid*="gap" i]',
      '[class*="drop-target" i]',
      '[class*="answer-slot" i]',
      '[class*="blank" i]',
      '[class*="gap" i]',
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

      const candidates = new Set(root.querySelectorAll(selector));

      // Cambridge puede dibujar el banco de palabras con DIV/SPAN sin
      // button, role ni clases reconocibles. Incluir los elementos visibles
      // que realmente tienen cursor de clic y contienen una etiqueta corta.
      const pointerCandidates = [...root.querySelectorAll("*")].filter(element => {
        if (seen.has(element) || !isVisible(element)) return false;

        const view = element.ownerDocument?.defaultView || window;
        if (view.getComputedStyle(element).cursor !== "pointer") return false;

        const label = String(element.innerText || element.textContent || "").trim();
        return label.length > 0 && label.length <= 100;
      });

      // Preferir el descendiente más interno cuando el cursor pointer se
      // hereda, para que el clic burbujee hacia el contenedor de Cambridge.
      const pointerLeaves = pointerCandidates.filter(element => {
        const ownText = String(element.innerText || element.textContent || "")
          .replace(/\\s+/g, " ").trim();

        return ![...element.querySelectorAll("*")].some(child => {
          const childView = child.ownerDocument?.defaultView || window;
          if (childView.getComputedStyle(child).cursor !== "pointer") return false;

          const childText = String(child.innerText || child.textContent || "")
            .replace(/\\s+/g, " ").trim();

          return childText === ownText;
        });
      });

      for (const element of pointerLeaves) candidates.add(element);

      // Cambridge puede ocultar el input checkbox y dibujar la casilla
      // dentro de un LABEL. Registrar el contenedor visible para poder marcarlo.
      const checkboxCandidates = [...root.querySelectorAll('label,[role="checkbox"]')]
        .filter(element =>
          isVisible(element) &&
          (element.getAttribute("role") === "checkbox" ||
            element.control?.type === "checkbox" ||
            !!element.querySelector('input[type="checkbox"]'))
        );
      for (const element of checkboxCandidates) candidates.add(element);

      for (const element of candidates) {
        if (seen.has(element) || !isVisible(element)) {
          continue;
        }

        // Si el input checkbox tiene una etiqueta visible asociada, usar
        // esa etiqueta como único control para evitar índices duplicados.
        if (element.matches('input[type="checkbox"]')) {
          const associatedLabel = element.labels?.[0] || element.closest("label");
          if (associatedLabel && isVisible(associatedLabel)) continue;
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
        const view = element.ownerDocument?.defaultView || window;
        const pointerClickable = view.getComputedStyle(element).cursor === "pointer";
        const className = String(element.className || "");
        const checkboxStateElement =
          element.matches('input[type="checkbox"],[role="checkbox"]')
            ? element
            : element.querySelector?.('input[type="checkbox"],[role="checkbox"]') ||
              (element.control?.type === "checkbox" ? element.control : null);
        const isCheckboxControl =
          !!checkboxStateElement ||
          element.getAttribute("role") === "checkbox" ||
          (tag === "label" && (
            element.control?.type === "checkbox" ||
            !!element.querySelector('input[type="checkbox"]')
          ));
        const cambridgeDraggable =
          element.classList?.contains("gap_match_drag") &&
          element.classList?.contains("drag_element");
        const cambridgeDropzone =
          element.classList?.contains("gap_match_gap_view") &&
          element.classList?.contains("drop_area");

        if (cambridgeDropzone) {
          const sentence = element.closest("p") ||
            element.closest(".contentblock") ||
            element.parentElement?.parentElement;
          const sentenceText = String(
            sentence?.innerText || sentence?.textContent || ""
          ).replace(/\\s+/g, " ").trim();
          if (sentenceText) label = sentenceText;
        }

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

        // Añadir contexto de oración a cada campo de escritura. En Cambridge
        // el input a veces está anidado en varios SPAN/DIV y no tiene label.
        let nearbyText = "";
        const isTextEntry =
          tag === "textarea" ||
          (tag === "input" && !/^(hidden|radio|checkbox|submit|button|file|image|reset)$/i.test(element.type || "")) ||
          element.isContentEditable ||
          element.getAttribute("role") === "textbox";
        if (isTextEntry) {
          let ancestor = element.parentElement;
          for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
            const candidateText = String(ancestor.innerText || ancestor.textContent || "")
              .replace(/\\s+/g, " ").trim();
            const fieldsInside = ancestor.querySelectorAll(
              'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]),textarea,[contenteditable="true"],[role="textbox"]'
            ).length;
            if (candidateText.length >= 8 && candidateText.length <= 900 && fieldsInside <= 3) {
              nearbyText = candidateText;
              break;
            }
          }
        } else if (isCheckboxControl) {
          let ancestor = element.parentElement;
          for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
            const candidateText = String(ancestor.innerText || ancestor.textContent || "")
              .replace(/\\s+/g, " ").trim();
            const checkboxCount = ancestor.querySelectorAll(
              'input[type="checkbox"],[role="checkbox"]'
            ).length;
            if (candidateText.length >= 12 && candidateText.length <= 900 && checkboxCount >= 2) {
              nearbyText = candidateText;
              break;
            }
          }
        }

        controls.push({
          control_index: index,

          type:
            tag === "input"
              ? element.type || "text"
              : element.getAttribute("role") === "checkbox" ||
                (tag === "label" && !!element.querySelector('input[type="checkbox"]'))
              ? "checkbox"
              : isCheckboxControl
              ? "checkbox"
              : tag === "textarea"
              ? "textarea"
              : tag === "select"
              ? "select"
              : customDropdown
              ? "combobox"
              : element.getAttribute("role") === "textbox"
              ? "textbox"
              : cambridgeDraggable
              ? "draggable"
              : cambridgeDropzone
              ? "dropzone"
              : pointerClickable
              ? "clickable"
              : element.getAttribute("role") ||
                (
                  element.isContentEditable
                    ? "contenteditable"
                    : tag
                ),

          // Señal explícita para el Worker: algunos controles editables de
          // Cambridge se presentan como DIV/SPAN y no como input type=text.
          editable: isTextEntry,
          dropdown: customDropdown,
          clickable: pointerClickable,
          cambridgeInteraction: cambridgeDraggable
            ? "drag-source"
            : cambridgeDropzone
            ? "drop-target"
            : "",
          className: className.slice(0, 180),
          modelId: element.getAttribute("data-model-id") || "",
          expanded: element.getAttribute("aria-expanded"),
          label: String(label).trim().slice(0, 300),
          nearby_text: nearbyText.slice(0, 600),
          value: element.value || "",
          placeholder:
            element.getAttribute("placeholder") || "",
          options,
          disabled: !!element.disabled,
          checked:
            checkboxStateElement
              ? checkboxStateElement.checked === true ||
                checkboxStateElement.getAttribute("aria-checked") === "true" ||
                checkboxStateElement.getAttribute("aria-selected") === "true"
              : element.getAttribute("aria-checked") === "true" ||
                element.getAttribute("aria-selected") === "true" ||
                !!element.checked
        });
      }
    }

    // Las actividades de asociación visual pueden usar imágenes como
    // respuestas. Registrar las cuatro imágenes principales aunque Cambridge
    // no las etiquete como botones: el clic en IMG también burbujea al wrapper.
    // Mantener exactamente el mismo orden que captureImages().
    const imageOptions = allElements("img")
      .filter(image =>
        isVisible(image) &&
        image.complete &&
        image.naturalWidth > 0
      )
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })
      .slice(0, MAX_IMAGES);

    imageOptions.forEach((image, position) => {
      let target = image.closest('button,[role="button"],a,[tabindex]');
      if (!target) {
        let parent = image.parentElement;
        for (let level = 0; level < 5 && parent; level++, parent = parent.parentElement) {
          const view = parent.ownerDocument?.defaultView || window;
          if (view.getComputedStyle(parent).cursor === "pointer") {
            target = parent;
            break;
          }
        }
      }

      // Si no hay un wrapper semántico/pointer, se hace clic en la propia imagen.
      // El evento click burbujea y activa los manejadores delegados de Cambridge.
      if (!target) target = image;

      const index = controls.length;
      indexedControls.set(index, target);

      const surroundingText = String(
        target.innerText ||
        target.getAttribute("aria-label") ||
        target.getAttribute("title") ||
        ""
      ).trim();

      const label = [
        image.alt || image.getAttribute("aria-label") || image.getAttribute("title") || "",
        surroundingText
      ].filter(Boolean).join(" — ");

      controls.push({
        control_index: index,
        type: "image",
        image_number: position + 1,
        label: (label || `Opción visual número ${position + 1}`).slice(0, 300),
        value: "",
        options: [],
        disabled: !!target.disabled
      });
    });

    // Identificar el orden visual de los campos de escritura para que
    // el Worker pueda emparejar la primera, segunda y tercera respuesta.
    const writingControls = controls.filter(control =>
      !control.disabled &&
      (
        control.editable === true ||
        /^(text|number|textarea|textbox|contenteditable)$/i.test(String(control.type || ""))
      ) &&
      !/(search|email|password|username|login|correo|contraseña|buscar)/i.test(
        String(control.label || "") + " " + String(control.placeholder || "")
      )
    );
    writingControls.forEach((control, index) => {
      control.text_field_order = index + 1;
      control.text_field_count = writingControls.length;
    });

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

  // Cambridge One usa un reproductor propio y el identificador del
  // reproductor puede terminar en "__43888", mientras que el MP3 termina
  // en "_" (sin ese sufijo numérico). Comparamos el identificador base.
  function findCambridgeAudioUrl(player) {
    const rawId = player?.getAttribute("data-playable-media") || "";
    const mediaId = rawId.replace(/^ID_/, "");
    if (!mediaId) return "";

    const assetStem = mediaId.replace(/__\d+$/, "");
    const candidates = [];

    for (const root of getRoots()) {
      const doc = root.nodeType === 9 ? root : root.ownerDocument;
      const win = doc?.defaultView;
      if (!win?.performance) continue;

      let entries = [];
      try {
        entries = win.performance.getEntriesByType("resource");
      } catch {}

      for (const entry of entries) {
        const url = entry.name || "";
        if (!/\.mp3(?:[?#]|$)/i.test(url)) continue;

        let pathname = url;
        try {
          pathname = new URL(url, doc.baseURI).pathname;
        } catch {}

        const filename = pathname.split("/").pop() || "";
        const normalizedFilename = filename.replace(/__\d+(?=\.mp3$)/i, "");
        const normalizedStem = assetStem.replace(/__\d+$/, "");

        if (
          filename.includes(assetStem) ||
          normalizedFilename.startsWith(normalizedStem + "_") ||
          normalizedFilename.startsWith(normalizedStem + ".")
        ) {
          candidates.push({
            url,
            score: filename.includes(assetStem) ? 2 : 1
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.url || "";
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

    for (let imagePosition = 0; imagePosition < imageElements.length; imagePosition++) {
      if (images.length >= MAX_IMAGES) break;
      const image = imageElements[imagePosition];
      const imageNumber = imagePosition + 1;

      const description =
        `Opción visual número ${imageNumber} de ${Math.min(imageElements.length, MAX_IMAGES)}. ` +
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

  function resolveTextEntry(element) {
    if (!element) return null;

    const selector = 'textarea,input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="file"]):not([type="image"]):not([type="reset"]),[contenteditable="true"],[role="textbox"]';
    const isTextEntry = candidate =>
      candidate &&
      (
        candidate.matches?.(selector) ||
        candidate.isContentEditable ||
        candidate.getAttribute?.("role") === "textbox"
      );

    if (isTextEntry(element)) return element;

    // Si el modelo indicó un contenedor en vez del campo, resolverlo
    // únicamente cuando haya un único campo de texto en ese contenedor.
    const descendants = [...(element.querySelectorAll?.(selector) || [])]
      .filter(candidate => isVisible(candidate) && !candidate.disabled);
    if (descendants.length === 1) return descendants[0];

    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parentElement) {
      const fields = [...ancestor.querySelectorAll(selector)]
        .filter(candidate => isVisible(candidate) && !candidate.disabled);
      if (fields.length === 1) return fields[0];
      if (fields.length > 1) break;
    }

    return null;
  }

  function applyActions(actions, openedDropdownKeys = new Set()) {
    let applied = 0;
    const details = [];
    const openedDropdowns = [];
    const skipped = [];
    const dragChecks = [];
    const cambridgeClickChecks = [];
    const checkboxChecks = [];

    for (const action of actions || []) {
      const element = indexedControls.get(
        Number(action.control_index)
      );

      if (!element) {
        skipped.push("control " + action.control_index + ": índice no disponible");
        continue;
      }
      if (element.disabled) {
        skipped.push("control " + action.control_index + ": está deshabilitado");
        continue;
      }

      const value = String(
        action.value ?? ""
      ).trim();

      if (action.action === "drag") {
        const targetIndex = Number(
          action.target_control_index ?? action.drop_control_index
        );
        const dropTarget = indexedControls.get(targetIndex);

        if (!dropTarget) {
          skipped.push("zona destino " + targetIndex + ": índice no disponible");
          continue;
        }

        if (
          !element.matches(".drag_element.gap_match_drag") ||
          !dropTarget.matches(".drop_area.gap_match_gap_view")
        ) {
          skipped.push("la acción drag requiere una palabra gap_match_drag y un espacio gap_match_gap_view");
          continue;
        }

        const sourceRect = element.getBoundingClientRect();
        const targetRect = dropTarget.getBoundingClientRect();
        if (
          sourceRect.width < 2 || sourceRect.height < 2 ||
          targetRect.width < 2 || targetRect.height < 2
        ) {
          skipped.push("la palabra o el espacio destino no están visibles");
          continue;
        }

        const doc = element.ownerDocument;
        const view = doc.defaultView || window;
        const sx = sourceRect.left + sourceRect.width / 2;
        const sy = sourceRect.top + sourceRect.height / 2;
        const tx = targetRect.left + targetRect.width / 2;
        const ty = targetRect.top + targetRect.height / 2;
        const word = String(element.innerText || element.textContent || "").trim();

        const mouse = (target, type, x, y, buttons) => {
          target.dispatchEvent(new view.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view,
            button: 0,
            buttons,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            detail: 1
          }));
        };

        try {
          element.focus({ preventScroll: true });

          // Cambridge One registra mousedown en la palabra y después
          // escucha mousemove/mouseup a nivel del documento.
          mouse(element, "mousedown", sx, sy, 1);

          const mx = sx + (tx - sx) * 0.55;
          const my = sy + (ty - sy) * 0.55;
          mouse(doc, "mousemove", mx, my, 1);
          mouse(doc, "mousemove", tx, ty, 1);
          mouse(dropTarget, "mousemove", tx, ty, 1);
          mouse(dropTarget, "mouseup", tx, ty, 0);

          dragChecks.push({
            source: element,
            target: dropTarget,
            word
          });
          applied++;
          details.push("Arrastre enviado: " + word);
        } catch (error) {
          skipped.push("no se pudo simular el arrastre de " + word + ": " + (error?.message || "error"));
        }

      } else if (action.action === "fill") {
        const textEntry = resolveTextEntry(element);

        if (!textEntry) {
          skipped.push(
            "control " + action.control_index +
            ": no es un campo de escritura ni contiene un único input identificable"
          );
          continue;
        }

        const doc = textEntry.ownerDocument || document;
        const view = doc.defaultView || window;

        try {
          textEntry.focus({ preventScroll: true });

          if (textEntry.isContentEditable ||
              textEntry.getAttribute("role") === "textbox") {
            textEntry.textContent = value;
            const InputEventCtor = view.InputEvent || InputEvent;
            textEntry.dispatchEvent(new InputEventCtor("input", {
              bubbles: true,
              composed: true,
              inputType: "insertText",
              data: value
            }));
          } else {
            // Utilizar el setter del iframe propietario del input.
            const prototype = textEntry.tagName === "TEXTAREA"
              ? view.HTMLTextAreaElement?.prototype
              : view.HTMLInputElement?.prototype;
            const setter = prototype
              ? Object.getOwnPropertyDescriptor(prototype, "value")?.set
              : null;

            if (setter) setter.call(textEntry, value);
            else textEntry.value = value;

            textEntry.dispatchEvent(new view.Event("input", {
              bubbles: true,
              composed: true
            }));
          }

          textEntry.dispatchEvent(new view.Event("change", {
            bubbles: true,
            composed: true
          }));

          const resultingValue =
            textEntry.isContentEditable || textEntry.getAttribute("role") === "textbox"
              ? String(textEntry.textContent || "").trim()
              : String(textEntry.value || "").trim();

          if (resultingValue.toLowerCase() !== value.toLowerCase()) {
            skipped.push("Cambridge no conservó el texto escrito en el control " + action.control_index);
            continue;
          }

          applied++;
          details.push(action.question || "Respuesta escrita: " + value);
        } catch (error) {
          skipped.push(
            "No se pudo escribir en el control " + action.control_index +
            ": " + (error?.message || "error desconocido")
          );
        }

      } else if (
        action.action === "select" &&
        element.tagName === "SELECT"
      ) {
        const option = [...element.options].find(item =>
          item.text.trim().toLowerCase() === value.toLowerCase() ||
          String(item.value || "").trim().toLowerCase() === value.toLowerCase()
        );

        if (!option) {
          skipped.push("control " + action.control_index + ": la opción \"" + value + "\" no existe en ese desplegable");
          continue;
        }

        const doc = element.ownerDocument || document;
        const view = doc.defaultView || window;
        element.focus({ preventScroll: true });
        element.value = option.value;
        element.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new view.Event("change", { bubbles: true, composed: true }));

        const selected = element.options[element.selectedIndex];
        if (!selected || (
          selected.text.trim().toLowerCase() !== value.toLowerCase() &&
          String(selected.value || "").trim().toLowerCase() !== value.toLowerCase()
        )) {
          skipped.push("Cambridge no confirmó la selección en el desplegable " + action.control_index);
          continue;
        }

        applied++;
        details.push(action.question || ("Opción seleccionada: " + option.text));

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
            ...(container.matches('[role="option"],[role="menuitem"],option,li,[data-value],button,[class*="option" i],[class*="choice" i]') ? [container] : []),
            ...container.querySelectorAll('[role="option"],[role="menuitem"],option,li,[data-value],button,[class*="option" i],[class*="choice" i]')
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

      } else if (
        action.action === "click_image" &&
        element.tagName !== "INPUT" &&
        !element.disabled
      ) {
        // Selección visual: el índice apunta al contenedor interactivo
        // de la imagen (botón, enlace o wrapper con cursor pointer).
        element.click();
        applied++;
        details.push(action.question || `Imagen ${action.image_number || ""} seleccionada`);

      } else if (action.action === "click") {
        // Resolver el elemento interactivo real. En Cambridge, la palabra
        // visible puede estar dentro de un DIV/SPAN cuyo padre recibe el clic.
        const clickableSelector =
          'button,[role="button"],[role="option"],[role="menuitem"],' +
          '[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"],' +
          '[onclick],[tabindex],[data-value],[draggable="true"],[data-draggable="true"],' +
          '[data-drop-target="true"],[data-testid*="word" i],[data-testid*="token" i],' +
          '[data-testid*="blank" i],[data-testid*="gap" i],' +
          '[class*="word" i],[class*="token" i],[class*="word-option" i],' +
          '[class*="answer-option" i],[class*="choice" i],[class*="option" i],' +
          '[class*="blank" i],[class*="gap" i],[class*="drop-target" i],' +
          '[class*="answer-slot" i],[class*="dropdown" i],[class*="select" i],[class*="combobox" i]';

        let target = element.matches(clickableSelector) ? element : null;

        // Un LABEL que contiene un checkbox oculto es también su control real.
        if (!target && element.matches("label") &&
            (element.control?.type === "checkbox" ||
              element.querySelector('input[type="checkbox"]'))) {
          target = element;
        }

        // Si el índice apunta al texto interno, buscar su contenedor clicable.
        if (!target) {
          let parent = element.parentElement;
          for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
            const view = parent.ownerDocument?.defaultView || window;
            const cursorPointer = view.getComputedStyle(parent).cursor === "pointer";
            if (parent.matches(clickableSelector) || cursorPointer) {
              target = parent;
              break;
            }
          }
        }

        if (!target) {
          skipped.push("control " + action.control_index + ": no se encontró un elemento clicable para \"" +
            String(element.innerText || element.textContent || "").trim().slice(0, 45) + "\"");
          continue;
        }

        const label = (
          target.innerText ||
          target.value ||
          target.getAttribute("aria-label") ||
          target.textContent ||
          element.innerText ||
          element.textContent ||
          ""
        ).trim().toLowerCase();

        // Primero se abre el cuadro desplegable; la opción se elige
        // en una segunda lectura, cuando la lista ya esté visible.
        if (isCustomDropdown(target)) {
          const expanded = target.getAttribute("aria-expanded") === "true";
          const key = dropdownStableKey(target);

          if (!expanded && !openedDropdownKeys.has(key)) {
            target.click();
            openedDropdownKeys.add(key);
            openedDropdowns.push(label || "lista desplegable");
            break;
          }

          continue;
        }

        // Prohibido accionar botones finales o salir de la actividad.
        if (
          /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send|next|siguiente|continuar|check answers|comprobar/i.test(label)
        ) {
          skipped.push("control " + action.control_index + ": se bloqueó un control de navegación/finalización");
          continue;
        }

        // Cambridge gap-match: el usuario confirma que basta un clic
        // sobre la palabra del banco para colocarla en el espacio activo.
        // Activar el elemento drag con la secuencia de clic (sin arrastrarlo).
        if (target.matches(".drag_element.gap_match_drag")) {
          const doc = target.ownerDocument;
          const view = doc.defaultView || window;
          const rect = target.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const init = {
            bubbles: true, cancelable: true, composed: true,
            view, button: 0, buttons: 1,
            clientX: x, clientY: y, detail: 1
          };

          try {
            target.focus({ preventScroll: true });
            target.dispatchEvent(new view.MouseEvent("mousedown", init));
            target.dispatchEvent(new view.MouseEvent("mouseup", {
              ...init, buttons: 0
            }));
            target.dispatchEvent(new view.MouseEvent("click", {
              ...init, buttons: 0
            }));
            target.click();

            // La respuesta solo se considera colocada si Cambridge la
            // retira del banco o la inserta en un espacio gap-match.
            cambridgeClickChecks.push({
              source: target,
              word: String(target.innerText || target.textContent || "").trim()
            });
            applied++;
            details.push("Clic de selección enviado: " +
              String(target.innerText || target.textContent || "").trim());
          } catch (error) {
            skipped.push("No se pudo seleccionar la palabra: " +
              (error?.message || "error"));
          }
          continue;
        }

        // Evitar desmarcar casillas que ya están seleccionadas.
        const checkbox = target.matches('input[type="checkbox"],[role="checkbox"]')
          ? target
          : target.querySelector?.('input[type="checkbox"],[role="checkbox"]') ||
            target.closest?.('label')?.querySelector?.('input[type="checkbox"]');
        if (checkbox && (
          checkbox.checked === true ||
          checkbox.getAttribute("aria-checked") === "true" ||
          checkbox.getAttribute("aria-selected") === "true"
        )) {
          details.push("Casilla ya marcada: " + (label.slice(0, 60) || "opción"));
          continue;
        }

        // Simular la secuencia normal de puntero y ratón que precede
        // al clic. Todos los eventos siguen siendo sintéticos (no trusted),
        // pero cubren interfaces que escuchan pointerdown/mousedown además
        // de click.
        const targetView = target.ownerDocument?.defaultView || window;
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const pointerInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX,
          clientY
        };
        const mouseDownInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
          view: targetView
        };

        try {
          if (targetView.PointerEvent) {
            target.dispatchEvent(new targetView.PointerEvent("pointerover", pointerInit));
            target.dispatchEvent(new targetView.PointerEvent("pointermove", pointerInit));
            target.dispatchEvent(new targetView.PointerEvent("pointerdown", pointerInit));
          }
          target.dispatchEvent(new targetView.MouseEvent("mouseover", mouseDownInit));
          target.dispatchEvent(new targetView.MouseEvent("mousemove", mouseDownInit));
          target.dispatchEvent(new targetView.MouseEvent("mousedown", mouseDownInit));

          const pointerUpInit = { ...pointerInit, buttons: 0 };
          const mouseUpInit = { ...mouseDownInit, buttons: 0 };
          if (targetView.PointerEvent) {
            target.dispatchEvent(new targetView.PointerEvent("pointerup", pointerUpInit));
          }
          target.dispatchEvent(new targetView.MouseEvent("mouseup", mouseUpInit));
          target.click();

          const checkboxControl = target.matches('input[type="checkbox"],[role="checkbox"]')
            ? target
            : target.querySelector?.('input[type="checkbox"],[role="checkbox"]') ||
              (target.control?.type === "checkbox" ? target.control : null) ||
              target.closest?.('label')?.querySelector?.('input[type="checkbox"],[role="checkbox"]');
          const isCheckboxAction = !!checkboxControl ||
            target.getAttribute("role") === "checkbox" ||
            element.getAttribute("role") === "checkbox";

          if (isCheckboxAction) {
            checkboxChecks.push({
              target,
              checkbox: checkboxControl,
              label: label.slice(0, 100)
            });
          }

          applied++;
          details.push(action.question || ("Clic enviado a: " + (label.slice(0, 60) || "opción")));
        } catch (error) {
          skipped.push("control " + action.control_index + ": error al simular el clic (" + (error?.message || "desconocido") + ")");
        }
      }
    }

    return { applied, details, openedDropdowns, skipped, dragChecks, cambridgeClickChecks, checkboxChecks };
  }

  async function clickNext() {
    const normalize = value =>
      String(value || "").replace(/\\s+/g, " ").trim();

    const labelValues = element => [
      element.innerText,
      element.textContent,
      element.value,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-testid")
    ].map(normalize).filter(Boolean);

    const isClickable = element => {
      if (!element || !element.matches) return false;
      if (element.matches('button,[role="button"],input[type="button"],input[type="submit"],a,[tabindex]')) return true;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      return style.cursor === "pointer" ||
        /button|btn|next|check|continue|action/i.test(String(element.className || ""));
    };

    const findAction = (kind) => {
      const pattern = kind === "check"
        ? /^(check|check answer|check answers|check my answers|comprobar|comprobar respuesta|comprobar respuestas)$/i
        : /^(next|next question|siguiente|continuar|continue|próxima|avanzar|›|→)$/i;

      const selectors = 'button,[role="button"],input[type="button"],input[type="submit"],a,[tabindex],[aria-label],[title],[data-testid]';
      const interactive = allElements(selectors)
        .filter(isVisible)
        .find(element => labelValues(element).some(label => pattern.test(label)));

      if (interactive) return interactive;

      // Cambridge a veces dibuja Check/Next como DIV o SPAN sin role=button.
      // Buscar el texto exacto y subir hasta el contenedor que recibe el clic.
      const textMatches = allElements("*")
        .filter(element => isVisible(element))
        .filter(element => {
          const text = normalize(element.innerText || element.textContent);
          return text && pattern.test(text) && text.length <= 50;
        })
        .sort((a, b) =>
          normalize(a.innerText || a.textContent).length -
          normalize(b.innerText || b.textContent).length
        );

      for (const match of textMatches) {
        let current = match;
        for (let level = 0; level < 7 && current; level++, current = current.parentElement) {
          if (!isVisible(current)) continue;
          if (isClickable(current)) return current;
        }
        if (match) return match;
      }

      return null;
    };

    // Cambridge crea el botón Check DESPUÉS de colocar las respuestas.
    // Esperar a que la página termine de actualizarse antes de concluir
    // que no existe. Puede ser un DIV/SPAN, no necesariamente BUTTON.
    let checkButton = null;
    const checkDeadline = Date.now() + 6000;
    while (Date.now() < checkDeadline) {
      checkButton = findAction("check");
      if (checkButton) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (checkButton) {
      // No pulsar si Cambridge todavía lo mantiene deshabilitado.
      if (checkButton.disabled ||
          checkButton.getAttribute("aria-disabled") === "true") {
        const enabledDeadline = Date.now() + 4000;
        while (Date.now() < enabledDeadline) {
          await new Promise(resolve => setTimeout(resolve, 200));
          if (!checkButton.disabled &&
              checkButton.getAttribute("aria-disabled") !== "true") break;
        }
      }

      checkButton.click();

      // El botón azul Next aparece solamente DESPUÉS de Check.
      const nextDeadline = Date.now() + 12000;
      while (Date.now() < nextDeadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const nextButton = findAction("next");
        if (nextButton) {
          nextButton.click();
          return true;
        }
      }

      // Se pulsó Check; no confundir la espera de Next con el final.
      return true;
    }

    // Algunas actividades muestran Next directamente, sin Check.
    const nextButton = findAction("next");
    if (nextButton) {
      nextButton.click();
      return true;
    }

    return false;
  }

  // Envía o comprueba las respuestas únicamente al llegar al final,
  // cuando ya no existe un control seguro para pasar a otra pregunta.
  function clickSubmitAnswers() {
    // Incluir controles Cambridge representados como DIV/SPAN interactivos.
    const elements = allElements(
      'button,[role="button"],input[type="button"],input[type="submit"],a,[tabindex],[onclick],[aria-label],[title],[data-testid]'
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
    let submit = candidates.find(({ labels }) =>
      labels.some(label => exactAction.test(label))
    );

    // Buscar también texto exacto dentro de DIV/SPAN, subiendo al control
    // interactivo más cercano. Nunca se pulsa una etiqueta aproximada.
    if (!submit) {
      const matches = allElements("*")
        .filter(isVisible)
        .filter(element => {
          const text = String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
          return text && text.length <= 70 && exactAction.test(text);
        })
        .sort((x, y) => String(x.innerText || x.textContent || "").length - String(y.innerText || y.textContent || "").length);

      for (const match of matches) {
        let current = match;
        for (let depth = 0; current && depth < 6; depth++, current = current.parentElement) {
          if (!isVisible(current)) continue;
          const text = String(current.innerText || current.textContent || "").replace(/\\s+/g, " ").trim();
          const view = current.ownerDocument?.defaultView || window;
          const interactive = current.matches('button,[role="button"],input[type="button"],input[type="submit"],a,[tabindex],[onclick]') ||
            view.getComputedStyle(current).cursor === "pointer" ||
            /button|btn|check|submit|action/i.test(String(current.className || ""));
          if (exactAction.test(text) && interactive) {
            submit = { element: current, label: text };
            break;
          }
        }
        if (submit) break;
      }
    }

    if (!submit || submit.element.disabled || submit.element.getAttribute("aria-disabled") === "true") return null;
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

        const aulaSettings = await getAulaSettings();
        const requestBody = {
          title: snapshot.title, pageText: snapshot.pageText,
          controls: snapshot.controls, images: visual.images,
          precision: aulaSettings.precision, verifyAnswers: aulaSettings.verify,
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
            `No se encontraron respuestas aplicables. ` +
            `${result.summary || result.stop_reason || "La IA no identificó una pregunta resoluble."}\n` +
            `Imágenes capturadas: ${visual.images.length}. ` +
            `Opciones de imagen detectadas: ${snapshot.controls.filter(control => control.type === "image").length}. ` +
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

        // Comprobar que cada casilla seleccionada realmente quedó marcada.
        if (applied.checkboxChecks.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
          for (const check of applied.checkboxChecks) {
            const control = check.checkbox || check.target;
            const marked =
              control?.checked === true ||
              control?.getAttribute?.("aria-checked") === "true" ||
              control?.getAttribute?.("aria-selected") === "true" ||
              control?.getAttribute?.("aria-pressed") === "true" ||
              control?.getAttribute?.("data-state") === "checked" ||
              /(^|\\s)(checked|selected|is-checked|active)(\\s|$)/i.test(String(control?.className || ""));

            if (!marked) {
              applied.applied = Math.max(0, applied.applied - 1);
              applied.skipped.push(
                "Cambridge no confirmó que la casilla \"" +
                check.label + "\" quedara marcada."
              );
            }
          }
        }

        const answerSummary = result.actions.map(action => {
          const control = snapshot.controls.find(item => Number(item.control_index) === Number(action.control_index));
          return { question: action.question || control?.nearby_text || control?.label || "", answer: action.value || control?.label || "" };
        });
        await saveAnswerHistory({
          page: location.hostname, activity: snapshot.title,
          question: answerSummary.map(item=>item.question).filter(Boolean).join(" | ").slice(0,1200),
          answers: answerSummary.map(item=>item.answer).filter(Boolean).join(" | ").slice(0,500),
          applied: applied.applied, skipped: applied.skipped.slice(0,8),
          outcome: applied.skipped.length ? "needs-review" : "awaiting-check"
        });


        if (applied.cambridgeClickChecks.length) {
          await new Promise(resolve => setTimeout(resolve, 700));
          for (const check of applied.cambridgeClickChecks) {
            const stillInPool = !!check.source.closest(".wordpool");
            const placedInGap = [...check.source.ownerDocument.querySelectorAll(
              ".drop_area.gap_match_gap_view .drag_element"
            )].some(item =>
              String(item.innerText || item.textContent || "")
                .trim().toLowerCase() === check.word.toLowerCase()
            );
            if (stillInPool && !placedInGap) {
              applied.applied = Math.max(0, applied.applied - 1);
              applied.skipped.push(
                "Cambridge no confirmó que el clic colocara la palabra \"" +
                check.word + "\"."
              );
            }
          }
        }

        if (applied.dragChecks.length) {
          await new Promise(resolve => setTimeout(resolve, 750));

          for (const check of applied.dragChecks) {
            const placed = [...check.target.querySelectorAll(".drag_element")]
              .filter(item => !item.closest(".width-measure"))
              .some(item =>
                String(item.innerText || item.textContent || "")
                  .trim().toLowerCase() === check.word.toLowerCase()
              );

            if (!placed) {
              applied.applied = Math.max(0, applied.applied - 1);
              applied.skipped.push(
                "Cambridge no confirmó que la palabra \"" + check.word +
                "\" quedara dentro del espacio destino."
              );
            }
          }
        }

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

        // Cambridge puede presentar varios desplegables personalizados en
        // una misma conversación. Después de elegir una opción, abrir el
        // siguiente cuadro cerrado y volver a analizar la MISMA actividad.
        // Así no se intenta pulsar Check hasta completar todos los espacios.
        if (applied.applied > 0) {
          const nextDropdown = openNextDropdown(openedDropdownKeys);
          if (nextDropdown) {
            report(
              runId,
              `Respuesta seleccionada. Abriendo el siguiente desplegable: ${nextDropdown}. Leyendo sus opciones…`
            );
            await new Promise(resolve => setTimeout(resolve, 450));
            step--;
            continue;
          }
        }

        const applyDiagnostic = applied.skipped.length
          ? "\nDetalle técnico: " + applied.skipped.slice(0, 4).join("; ")
          : "";

        report(
          runId,
          `Pregunta ${step}: ${applied.applied} respuesta(s) colocada(s). ` +
          `${result.summary || ""}${applyDiagnostic}`
        );

        if (
          !automatic ||
          !applied.applied ||
          stopRequested
        ) {
          return;
        }

        if (!(await clickNext())) {
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
            Alcance de la ejecución
          </label>

          <select id="max">
            <option value="1">1 tarea</option>
            <option value="3">3 tareas</option>
            <option value="5">5 tareas</option>
            <option value="10">10 tareas</option>
            <option value="20">20 tareas</option>
            <option value="100" selected>Toda la sesión (hasta 100 tareas)</option>
          </select>

          <p class="small">
            <input id="auto" type="checkbox" checked>
            Modo automático: responder, pulsar Check y Next, y analizar la siguiente tarea
          </p>

          <p class="small">
            <input id="audio" type="checkbox" checked>
            Reproducir y escuchar audio automáticamente
          </p>
          <label class="small" for="precision">Precisión de respuestas</label>
          <select id="precision"><option value="normal">Normal</option><option value="high" selected>Alta (revisión adaptativa)</option></select>
          <p class="small">La segunda revisión se activa en ejercicios complejos o dudosos para ahorrar consumo sin descuidar las preguntas difíciles.</p>
          <p class="small"><input id="verifyAnswers" type="checkbox" checked> Verificar que las respuestas queden colocadas</p>
          <p class="small">Historial de errores activado. Se guarda localmente en este navegador.</p>
          <button class="action secondary" id="showHistory">Ver historial de respuestas</button>
          <div class="status" id="historyStatus" style="display:none;max-height:130px"></div>

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
          Inicia una sola vez para que Aula AI analice y responda cada tarea después de Next.
          Continúa automáticamente hasta completar la sesión o llegar al límite seleccionado.
          Puedes detener el proceso con el botón Detener.
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
      el("precision").value = await GM_getValue(PRECISION_KEY, DEFAULT_PRECISION);
      el("verifyAnswers").checked = await GM_getValue(VERIFY_KEY, true);

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

    el("precision").addEventListener("change", async () => {
      await GM_setValue(PRECISION_KEY, el("precision").value);
      setPanelStatus("Nivel de precisión guardado.");
    });
    el("verifyAnswers").addEventListener("change", async () => {
      await GM_setValue(VERIFY_KEY, el("verifyAnswers").checked);
      setPanelStatus("Verificación de respuestas " + (el("verifyAnswers").checked ? "activada." : "desactivada."));
    });
    el("showHistory").addEventListener("click", async () => {
      const box = el("historyStatus"), history = await GM_getValue(ERROR_HISTORY_KEY, []);
      box.style.display = "block";
      box.textContent = !history.length ? "Todavía no hay respuestas guardadas." :
        history.slice(0,12).map(item => new Date(item.date).toLocaleString()+" · "+item.outcome+" · "+String(item.question||"").slice(0,100)+" · "+String(item.answers||"").slice(0,80)).join("\\n");
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
