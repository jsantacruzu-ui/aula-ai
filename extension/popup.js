
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
  const s = await getSession();
  $("login").hidden = !!s.access_token;
  $("main").hidden = !s.access_token;

  if (s.access_token) {
    $("account").textContent = s.email || "Sesión activa";
  }
}

$("loginBtn").addEventListener("click", async () => {
  $("loginMsg").textContent = "Conectando…";

  try {
    const r = await fetch(
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

    const d = await r.json();

    if (!r.ok) {
      throw new Error(
        d.msg || d.message || d.error_description ||
        "No se pudo iniciar sesión."
      );
    }

    await chrome.storage.local.set({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      email: d.user?.email || $("email").value.trim()
    });

    $("password").value = "";
    await show();
    status("Sesión activa");

  } catch (e) {
    $("loginMsg").textContent = e.message;
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

async function refreshToken(s) {
  if (!s.refresh_token) return s.access_token;

  const r = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        refresh_token: s.refresh_token
      })
    }
  );

  if (!r.ok) return s.access_token;

  const d = await r.json();

  await chrome.storage.local.set({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    email: d.user?.email || s.email
  });

  return d.access_token;
}

async function askAI(snapshot, token) {
  const r = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(snapshot)
  });

  const d = await r.json();

  if (!r.ok) {
    throw new Error(d.error || "Error al consultar Aula AI");
  }

  return d;
}

$("run").addEventListener("click", async () => {
  stopped = false;
  $("run").disabled = true;
  $("stop").disabled = false;
  status("Trabajando…", true);

  try {
    const s = await getSession();
    const token = await refreshToken(s);

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw new Error(
        "Abre primero una página web normal con tu actividad."
      );
    }

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
      const snapshot = await chrome.tabs.sendMessage(tab.id, {
        type: "AULA_CAPTURE"
      });

      if (!snapshot?.controls?.length && !snapshot?.pageText) {
        throw new Error(
          "No pude detectar preguntas en esta página."
        );
      }

      $("progress").textContent =
        `Analizando pregunta ${done + 1}…`;

      const result = await askAI(snapshot, token);

      if (!result.actions?.length) {
        $("progress").textContent =
          `No se aplicaron respuestas.\n${
            result.summary || "No se detectaron respuestas seguras."
          }`;
        break;
      }

      const applied = await chrome.tabs.sendMessage(tab.id, {
        type: "AULA_APPLY",
        actions: result.actions
      });

      done++;

      $("progress").textContent =
        `Pregunta ${done}: ${applied.applied} respuesta(s) colocada(s).\n${
          result.summary || ""
        }`;

      if (!auto || stopped) break;

      if (!applied.applied) {
        $("progress").textContent +=
          "\nNo se pudo aplicar ninguna respuesta. Se detuvo.";
        break;
      }

      const moved = await chrome.tabs.sendMessage(tab.id, {
        type: "AULA_NEXT"
      });

      if (!moved?.moved) {
        $("progress").textContent +=
          "\nNo encontré un botón seguro para continuar. No se pulsó Enviar ni Finalizar.";
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1300));
    }

    if (done >= max) {
      $("progress").textContent +=
        `\nSe alcanzó el límite configurado (${max}).`;
    }

    status(stopped ? "Detenido" : "Finalizado");

  } catch (e) {
    $("progress").textContent = "Error: " + e.message;
    status("Revisar");

  } finally {
    $("run").disabled = false;
    $("stop").disabled = true;
  }
});

show();
