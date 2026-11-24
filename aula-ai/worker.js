const SUPABASE_URL = "https://olkhplrgtcxrrnpmbjgd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV";
const MODEL = "@cf/google/gemma-4-26b-a4b-it";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS"
    }
  });
}

async function authenticate(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return { error: json({ error: "Inicia sesión en Aula AI." }, 401) };
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: auth }
  });
  if (!response.ok) {
    return { error: json({ error: "Tu sesión no es válida. Vuelve a iniciar sesión." }, 401) };
  }
  return { auth, user: await response.json() };
}

async function runModel(env, messages, maxTokens = 3000) {
  if (!env.AI) {
    throw new Error("La conexión Workers AI (AI) no está disponible en este despliegue.");
  }
  const result = await env.AI.run(MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false }
  });
  const text = result?.response || result?.output_text || "";
  if (!text.trim()) throw new Error("El modelo no devolvió texto. Inténtalo nuevamente.");
  return text.trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (request.method !== "POST" || !["/api/solve", "/api/study"].includes(url.pathname)) {
        return json({ error: "Ruta no encontrada." }, 404);
      }

      const session = await authenticate(request);
      if (session.error) return session.error;

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Solicitud no válida." }, 400);
      }

      try {
        if (url.pathname === "/api/study") {
          const title = String(body.title || "Consulta").slice(0, 160);
          const prompt = String(body.prompt || "").trim().slice(0, 12000);
          const subject = String(body.subject || "General").slice(0, 80);
          const mode = String(body.mode || "explain");

          if (!prompt) return json({ error: "Escribe una pregunta o ejercicio." }, 400);

          const instructions = {
            explain: "Explica el tema paso a paso, desde los fundamentos y con ejemplos.",
            solve: "Resuelve el ejercicio paso a paso. Muestra procedimiento, operaciones y respuesta final.",
            review: "Revisa la respuesta del estudiante. Señala aciertos, errores y cómo corregirlos.",
            summarize: "Elabora un resumen organizado, fiel al contenido y con ideas principales.",
            practice: "Prepara una práctica breve con preguntas progresivas y respuestas explicadas al final."
          };

          const system = `Eres Aula AI, un tutor académico claro, paciente y riguroso. Responde en español salvo que pidan otro idioma. Materia: ${subject}. Objetivo: ${instructions[mode] || instructions.explain} Usa títulos y listas cuando ayuden. No inventes datos ni fuentes. Si falta información, dilo. En matemáticas y contabilidad muestra los cálculos y verifica el resultado.`;

          const answer = await runModel(env, [
            { role: "system", content: system },
            { role: "user", content: `Título: ${title}\n\nConsulta:\n${prompt}` }
          ], 3000);

          fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_PUBLISHABLE_KEY,
              Authorization: session.auth,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({ user_id: session.user.id })
          }).catch(() => {});

          return json({ answer, model: MODEL });
        }

        // Modo extensión: analizar preguntas y controles visibles en la página.
        const pageText = String(body.pageText || "").slice(0, 14000);
        const controls = Array.isArray(body.controls) ? body.controls.slice(0, 100) : [];
        const title = String(body.title || "Actividad").slice(0, 200);

        if (!pageText.trim() && !controls.length) {
          return json({ error: "No encontré contenido que analizar." }, 400);
        }

        const prompt = `Analiza la actividad educativa de una página web. Devuelve SOLO JSON válido con esta estructura:
{"actions":[{"control_index":0,"action":"fill|select|click","value":"respuesta exacta","question":"pregunta breve","explanation":"razón breve","confidence":0.0}],"summary":"resumen breve","stop_reason":""}
Reglas:
- Resuelve todos los ejercicios visibles con la información disponible.
- Para campos de texto usa fill; para select usa select y value debe coincidir con una opción.
- Para radios, casillas y opciones clicables usa click; control_index debe coincidir con el índice de controls.
- No inventes controles. No propongas clics en botones de navegación, enviar, terminar, finalizar, entregar o salir.
- Si no hay respuesta sustentada, deja actions vacío y explica por qué.
- Conserva el idioma exigido por la actividad.
Título de página: ${title}
Texto visible:
${pageText}
Controles:
${JSON.stringify(controls)}`;

        const raw = await runModel(env, [
          { role: "system", content: "Devuelve únicamente JSON válido, sin Markdown ni texto adicional." },
          { role: "user", content: prompt }
        ], 1800);

        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end <= start) throw new Error("El modelo no devolvió JSON válido.");
        const parsed = JSON.parse(raw.slice(start, end + 1));

        fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: session.auth,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ user_id: session.user.id })
        }).catch(() => {});

        return json({ ...parsed, model: MODEL });
      } catch (error) {
        console.error("Aula AI inference error:", error?.message || error);
        return json({
          error: "No se pudo generar la respuesta: " + (error?.message || "error del modelo")
        }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
