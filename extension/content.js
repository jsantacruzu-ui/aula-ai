
const AULA_MARK = "data-aula-ai";

function addOverlay() {
  if (document.getElementById("aula-ai-floating")) return;

  const host = document.createElement("div");
  host.id = "aula-ai-floating";
  host.style.cssText =
    "position:fixed;z-index:2147483647;right:18px;bottom:18px;font:13px Arial,sans-serif";

  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      .pill {
        border: 0;
        border-radius: 24px;
        background: #172238;
        color: white;
        padding: 11px 15px;
        box-shadow: 0 5px 22px #0003;
        font-weight: 700;
      }
      .dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        background: #79df9b;
        border-radius: 50%;
        margin-right: 7px;
      }
    </style>
    <button class="pill">
      <span class="dot"></span>Aula AI está conectado
    </button>
  `;

  shadow.querySelector("button").addEventListener("click", () => {
    alert("Aula AI está activo. Abre el icono de la extensión para iniciar el modo automático.");
  });

  document.documentElement.appendChild(host);
}

addOverlay();

function visible(el) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);

  return r.width > 0 &&
    r.height > 0 &&
    s.visibility !== "hidden" &&
    s.display !== "none";
}

function labelFor(el) {
  const aria =
    el.getAttribute("aria-label") ||
    el.getAttribute("title");

  if (aria) return aria.trim();

  if (el.labels?.length) {
    return [...el.labels]
      .map(x => x.innerText)
      .join(" ")
      .trim();
  }

  const parent = el.closest(
    "label,[role=radio],[role=checkbox],button"
  );

  return (
    parent?.innerText ||
    el.parentElement?.innerText ||
    el.placeholder ||
    ""
  ).trim().slice(0, 220);
}

function collect() {
  const root =
    document.querySelector("main,[role=main],#root,#app") ||
    document.body;

  const pageText = (
    root.innerText ||
    document.body.innerText ||
    ""
  ).replace(/\n{3,}/g, "\n\n").slice(0, 14000);

  const selector =
    'input:not([type=hidden]),textarea,select,button,[role=radio],[role=checkbox],[role=button]';

  const nodes = [...root.querySelectorAll(selector)]
    .filter(visible)
    .slice(0, 100);

  const controls = nodes.map((el, index) => {
    el.setAttribute(AULA_MARK, String(index));

    const type =
      el.tagName.toLowerCase() === "input"
        ? (el.type || "text")
        : el.tagName.toLowerCase() === "textarea"
        ? "textarea"
        : el.tagName.toLowerCase() === "select"
        ? "select"
        : el.getAttribute("role") || el.tagName.toLowerCase();

    const options =
      el.tagName === "SELECT"
        ? [...el.options]
            .map(o => o.text.trim())
            .filter(Boolean)
        : [];

    return {
      index,
      type,
      label: labelFor(el),
      value: el.value || "",
      placeholder: el.placeholder || "",
      options,
      disabled: !!el.disabled
    };
  });

  return {
    title: document.title,
    url: location.href,
    pageText,
    controls
  };
}

function findControl(index) {
  return document.querySelector(
    `[${AULA_MARK}="${CSS.escape(String(index))}"]`
  );
}

function setNativeValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const setter =
    Object.getOwnPropertyDescriptor(proto, "value")?.set;

  if (setter) setter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function apply(actions) {
  let applied = 0;
  const details = [];

  for (const a of actions || []) {
    const el = findControl(a.control_index);

    if (!el || el.disabled) continue;

    const val = String(a.value ?? "").trim();

    if (
      a.action === "fill" &&
      el.matches("input:not([type=radio]):not([type=checkbox]),textarea")
    ) {
      setNativeValue(el, val);
      applied++;
      details.push(a.question || "campo completado");

    } else if (a.action === "select" && el.tagName === "SELECT") {
      const opt = [...el.options].find(o =>
        o.text.trim().toLowerCase() === val.toLowerCase() ||
        o.value.toLowerCase() === val.toLowerCase()
      );

      if (opt) {
        el.value = opt.value;
        el.dispatchEvent(
          new Event("change", { bubbles: true })
        );
        applied++;
        details.push(a.question || "opción seleccionada");
      }

    } else if (a.action === "click") {
      const target = el.closest("label") || el;

      if (
        el.matches('input[type=radio],input[type=checkbox]')
      ) {
        el.click();
      } else {
        target.click();
      }

      applied++;
      details.push(a.question || "opción marcada");
    }
  }

  return { applied, details };
}

function nextQuestion() {
  const candidates = [
    ...document.querySelectorAll(
      "button,[role=button],input[type=button],input[type=submit],a"
    )
  ].filter(visible);

  const safe = candidates.find(el => {
    const t = (
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      ""
    ).trim().toLowerCase();

    if (!t) return false;

    if (
      /submit|finish|finalizar|entregar|enviar|terminar|salir|exit|complete|send/i.test(t)
    ) return false;

    return (
      /^(next|siguiente|continuar|continue|next question|próxima|avanzar|›|→)$/i.test(t) ||
      /^(next|siguiente|continuar|continue)\b/i.test(t)
    );
  });

  if (!safe) return { moved: false };

  safe.click();
  return { moved: true };
}

chrome.runtime.onMessage.addListener(
  (msg, _sender, sendResponse) => {
    try {
      if (msg.type === "AULA_PING") {
        sendResponse({ ready: true });

      } else if (msg.type === "AULA_CAPTURE") {
        sendResponse(collect());

      } else if (msg.type === "AULA_APPLY") {
        sendResponse(apply(msg.actions));

      } else if (msg.type === "AULA_NEXT") {
        sendResponse(nextQuestion());
      }

    } catch (e) {
      sendResponse({ error: e.message });
    }

    return true;
  }
);
