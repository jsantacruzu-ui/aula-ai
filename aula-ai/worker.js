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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return json({ ok: true });
      if (url.pathname !== "/api/solve" || request.method !== "POST") {
        return json({ error: "Ruta no encontrada." }, 404);
      }

      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Inicia sesión en Aula AI." }, 401);

      const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: auth }
      });
      if (!userResponse.ok) return json({ error: "Sesión no válida. Vuelve a iniciar sesión." }, 401);
      const user = await userResponse.json();

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Solicitud no válida." }, 400); }

      const pageText = String(body.pageText || "").slice(0, 14000);
      const controls = Array.isArray(body.controls) ? body.controls.slice(0, 100) : [];
      const title = String(body.title || "Actividad").slice(0, 200);
      if (!pageText.trim() && !controls.length) return json({ error: "No encontré contenido que analizar." }, 400);

      const prompt = `Eres Aula AI, un tutor experto. Analiza la actividad educativa de una página web.
Responde SOLO con JSON válido, sin Markdown, con esta estructura:
{"actions":[{"control_index":0,"action":"fill|select|click","value":"respuesta exacta o texto de opción","question":"pregunta breve","explanation":"razón breve","confidence":0.0}],"summary":"resumen breve","stop_reason":""}
Reglas:
- Resuelve los ejercicios usando el contenido disponible.
- Para campos de texto usa action="fill" y escribe solo la respuesta que debe introducirse.
- Para select usa action="select" y value debe coincidir con una opción.
- Para radios, casillas y opciones clicables usa action="click"; control_index debe corresponder exactamente al índice de controls.
- No inventes controles. No propongas hacer clic en botones de navegación, enviar, terminar, finalizar, entregar o salir.
- Si no hay respuesta suficientemente sustentada, deja actions vacío y explica en summary.
- Conserva el idioma que exige la actividad.
- Si hay varias preguntas, resuelve todas las visibles.
Título de página: ${title}
Texto visible:
${pageText}
Controles detectados (índice, tipo, etiqueta, opciones):
${JSON.stringify(controls)}
`;

      try {
        const result = await env.AI.run(MODEL, {
          messages: [
            { role: "system", content: "Devuelve únicamente JSON válido. No añadas texto fuera del JSON." },
            { role: "user", content: prompt }
          ],
          max_tokens: 1800,
          temperature: 0.1
        });

        const raw = result?.response || result?.output_text || "";
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end <= start) throw new Error("El modelo no devolvió JSON.");
        const parsed = JSON.parse(raw.slice(start, end + 1));

        // Registrar consumo de forma segura y best-effort; RLS mantiene la propiedad del usuario.
        fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: auth,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ user_id: user.id })
        }).catch(() => {});

        return json({ ...parsed, model: MODEL });
      } catch (error) {
        return json({ error: "No se pudo analizar la actividad: " + (error?.message || "error de IA") }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
