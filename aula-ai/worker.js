
const SUPABASE_URL = "https://olkhplrgtcxrrnpmbjgd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const AUDIO_MODEL = "@cf/openai/whisper-large-v3-turbo";

const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 1200000;
const MAX_AUDIO_CHARS = 5600000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    }
  });
}

function textFromContent(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractModelText(result) {
  if (typeof result === "string") return result.trim();

  if (!result || typeof result !== "object") {
    return "";
  }

  const candidates = [
    result.response,
    result.output_text,
    result.generated_text,
    result.text,
    result.message?.content,
    result.choices?.[0]?.message?.content,
    result.choices?.[0]?.text,
    result.content
  ];

  for (const candidate of candidates) {
    const value = textFromContent(candidate).trim();
    if (value) return value;
  }

  return "";
}

async function authenticate(request) {
  const auth = request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    return {
      error: json({
        error: "Inicia sesión en Aula AI."
      }, 401)
    };
  }

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: auth
      }
    }
  );

  if (!response.ok) {
    return {
      error: json({
        error: "Tu sesión no es válida. Vuelve a iniciar sesión."
      }, 401)
    };
  }

  return {
    auth,
    user: await response.json()
  };
}

async function runModel(env, messages, maxTokens = 3000) {
  if (!env.AI) {
    throw new Error(
      "La conexión Workers AI (AI) no está disponible."
    );
  }

  const result = await env.AI.run(MODEL, {
    messages,
    max_completion_tokens: maxTokens,
    temperature: 0.2,
    chat_template_kwargs: {
      enable_thinking: false
    }
  });

  const answer = extractModelText(result);

  if (!answer) {
    const fields =
      result && typeof result === "object"
        ? Object.keys(result).join(", ")
        : typeof result;

    throw new Error(
      `El modelo no devolvió texto reconocible. Campos: ${fields || "ninguno"}.`
    );
  }

  return answer;
}

// Validar las imágenes enviadas por Tampermonkey.
function validateImages(rawImages) {
  if (!Array.isArray(rawImages)) return [];

  // Una imagen incorrecta no debe cancelar todo el ejercicio.
  // Se descartan solo las entradas dañadas o con MIME no admitido.
  return rawImages.slice(0, MAX_IMAGES).flatMap((item, index) => {
    const dataUrl =
      typeof item === "string"
        ? item
        : item?.dataUrl;

    const description =
      typeof item === "object"
        ? String(item.description || `Imagen ${index + 1}`)
        : `Imagen ${index + 1}`;

    const valid =
      typeof dataUrl === "string" &&
      dataUrl.length <= MAX_IMAGE_CHARS &&
      /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(dataUrl);

    if (!valid) {
      console.warn(
        `Aula AI: se omitió la imagen ${index + 1} por formato o tamaño no válido.`
      );
      return [];
    }

    return [{
      dataUrl,
      description: description.slice(0, 160)
    }];
  });
}

// Transcribir el audio del reproductor.
async function transcribeAudio(env, audioBase64) {
  if (!env.AI) {
    throw new Error("Workers AI no está disponible.");
  }

  if (
    typeof audioBase64 !== "string" ||
    !audioBase64.trim()
  ) {
    throw new Error("No se recibió el audio para transcribir.");
  }

  let encoded = audioBase64.trim();

  if (encoded.startsWith("data:")) {
    const comma = encoded.indexOf(",");

    if (comma < 0) {
      throw new Error("El archivo de audio no tiene un formato válido.");
    }

    encoded = encoded.slice(comma + 1);
  }

  if (encoded.length > MAX_AUDIO_CHARS) {
    throw new Error(
      "El audio supera el tamaño permitido. Graba un fragmento más corto."
    );
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new Error("El audio no está codificado correctamente.");
  }

  const result = await env.AI.run(AUDIO_MODEL, {
    audio: encoded,
    task: "transcribe",
    vad_filter: true
  });

  const transcript = String(
    result?.text ||
    result?.transcription_info?.text ||
    result?.response ||
    ""
  ).trim();

  if (!transcript) {
    throw new Error("No se reconocieron palabras en el audio.");
  }

  return transcript;
}

async function recordUsage(auth, userId) {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/ai_usage`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: auth,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          user_id: userId
        })
      }
    );
  } catch (error) {
    console.error(
      "No se pudo registrar el uso:",
      error?.message || error
    );
  }
}

// Actividades del panel principal.
async function handleStudy(body, env, session) {
  const title = String(body.title || "Consulta").slice(0, 160);
  const prompt = String(body.prompt || "").trim().slice(0, 12000);
  const subject = String(body.subject || "General").slice(0, 80);
  const mode = String(body.mode || "explain");

  if (!prompt) {
    return json({
      error: "Escribe una pregunta o ejercicio."
    }, 400);
  }

  const instructions = {
    explain:
      "Explica el tema paso a paso, desde los fundamentos y con ejemplos.",

    solve:
      "Resuelve el ejercicio paso a paso. Muestra procedimiento, operaciones y respuesta final.",

    review:
      "Revisa la respuesta del estudiante. Señala aciertos, errores y cómo corregirlos.",

    summarize:
      "Elabora un resumen organizado, fiel al contenido y con ideas principales.",

    practice:
      "Prepara una práctica breve con preguntas progresivas y respuestas explicadas al final."
  };

  const system =
    `Eres Aula AI, un tutor académico claro, paciente y riguroso. ` +
    `Responde en español salvo que pidan otro idioma. ` +
    `Materia: ${subject}. ` +
    `Objetivo: ${instructions[mode] || instructions.explain} ` +
    `Usa títulos y listas cuando ayuden. ` +
    `No inventes datos ni fuentes. Si falta información, dilo. ` +
    `En matemáticas y contabilidad muestra los cálculos y verifica el resultado.`;

  const answer = await runModel(
    env,
    [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: `Título: ${title}\n\nConsulta:\n${prompt}`
      }
    ],
    3000
  );

  await recordUsage(session.auth, session.user.id);

  return json({
    answer,
    model: MODEL
  });
}

// Resolver actividades que contienen texto, imágenes o audio.
async function handleSolve(body, env, session) {
  const pageText = String(
    body.pageText || ""
  ).slice(0, 14000);

  const controls = Array.isArray(body.controls)
    ? body.controls.slice(0, 100)
    : [];

  const title = String(
    body.title || "Actividad"
  ).slice(0, 200);

  const images = validateImages(body.images);

  let audioText = String(
    body.audioText || ""
  ).trim().slice(0, 12000);

  // Si se adjuntó audio, transcribirlo primero.
  if (body.audioBase64) {
    const transcript = await transcribeAudio(
      env,
      body.audioBase64
    );

    audioText = [
      audioText,
      transcript
    ].filter(Boolean).join("\n\n").slice(0, 12000);
  }

  if (
    !pageText.trim() &&
    !controls.length &&
    !images.length &&
    !audioText
  ) {
    return json({
      error: "No encontré texto, controles, imágenes ni audio que analizar."
    }, 400);
  }

  const prompt = `
Analiza una actividad educativa de una página web.

Puede contener:
- Texto normal.
- Imágenes de preguntas.
- Capturas de pantalla.
- Gráficos.
- Fotogramas de vídeo.
- Transcripciones de audio.

Lee cuidadosamente todo el material visual.

Si una pregunta aparece en una imagen, gráfico o fotograma, interprétala y resuélvela.

Si hay audio transcrito, úsalo como fuente de información y conserva el idioma de la actividad.

Devuelve SOLO JSON válido con esta estructura:

{
  "actions": [
    {
      "control_index": 0,
      "action": "fill|select|click|click_image|drag",
      "target_control_index": 0,
      "value": "respuesta exacta",
      "question": "pregunta breve",
      "explanation": "razón breve",
      "confidence": 0.0
    }
  ],
  "summary": "resumen breve",
  "stop_reason": ""
}

Reglas:
- Resuelve los ejercicios visibles con la información disponible.
- Para campos de texto usa fill.
- Para un select nativo, usa select y value debe coincidir con una opción.
- Para un control cuyo campo dropdown sea true, trata el control como un cuadro desplegable personalizado:
  - Si expanded no es "true" y aún no hay opciones visibles, devuelve click sobre ESE control para abrir la lista; no inventes la respuesta todavía.
  - Si ya hay opciones en options o hay controles visibles de tipo option/menuitem/data-value, elige la opción cuyo texto coincide con la respuesta y devuelve select sobre el control desplegable con el texto exacto de la opción, o click sobre el control_index exacto de esa opción.
  - No devuelvas click sobre el propio cuadro cuando ya está abierto y las opciones están visibles.
- Para radios, casillas y opciones interactivas usa click.
- En ejercicios de completar oraciones con un banco de palabras, identifica las palabras disponibles y cada espacio vacío.
- Si los controles incluyen type "draggable" con cambridgeInteraction "drag-source" y type "dropzone" con cambridgeInteraction "drop-target", esta es una actividad Cambridge de arrastrar y soltar.
- Para esa actividad devuelve action "drag": control_index debe ser el índice de la palabra que se arrastra y target_control_index debe ser el índice del espacio vacío correcto. No devuelvas click sobre la palabra ni sobre el espacio. Esta regla es prioritaria y reemplaza cualquier regla genérica posterior sobre hacer clic en palabras de un banco cuando los controles sean gap_match_drag/gap_match_gap_view.
- Usa el label del dropzone, que contiene la oración que rodea al espacio, para decidir el destino. Compara el sentido de la oración con las palabras del banco.
- Para "It's ___ today. Let's go to the swimming pool.", la palabra adecuada es "boiling"; devuelve un drag desde el control draggable cuyo label sea exactamente "boiling" hacia el dropzone de esa oración.
- Devuelve una acción por cada espacio que puedas resolver con certeza. No reutilices una palabra ya colocada, salvo que el ejercicio indique que puede reutilizarse.
- Los controles type button, clickable, word, token, choice o answer-option pueden ser opciones de clic en otras actividades, pero no confundas esos controles con los draggables de Cambridge gap-match.
- No elijas por parecido parcial ni inventes índices.
- Si el espacio se completa automáticamente al hacer clic en la palabra, no intentes escribir directamente en el espacio. Si hay que seleccionar primero el espacio y después la palabra, usa los controles del espacio y de la palabra en el orden que indique claramente la interfaz; no adivines.
- En una actividad donde se pide elegir o relacionar una descripción con una imagen, considera las opciones type "image" como respuestas seleccionables, aunque el HTML original no las llame botones.
- Compara el texto actual de la pregunta (por ejemplo, "a snowy day", "a rainy day" o "a hot day") con el contenido visual de CADA imagen enviada. Las imágenes se identifican en sus descripciones como "Opción visual número N".
- Cuando puedas determinar la correspondencia, devuelve una sola acción action "click_image" con el control_index del control type "image" cuyo image_number coincida con la opción visual correcta. No selecciones solo por el orden: interpreta la imagen.
- Si hay varias descripciones presentadas como una lista para emparejar todas, devuelve una acción por cada emparejamiento inequívoco, sin reutilizar la misma imagen salvo que la actividad lo permita.
- No descartes una imagen solo porque no tenga alt o no esté marcada como button: usa la imagen real y su image_number. Si no se puede interpretar el contenido visual, explica qué imagen no se puede leer en stop_reason.
- Si el enunciado está en una imagen, léelo junto con las opciones desplegables visibles.
- control_index debe corresponder exactamente a controls.
- Usa solo controles suministrados. No inventes índices.
- No propongas clics en enviar, entregar, finalizar, terminar, comprobar, submit o finish.
- Si una respuesta no está sustentada, no inventes. Deja actions vacío y explica qué dato falta.
- Conserva el idioma exigido por la actividad.

Título:
${title}

Texto de la página:
${pageText || "(No hay texto legible en el documento principal.)"}

Transcripción de audio:
${audioText || "(No se adjuntó audio.)"}

Controles detectados:
${JSON.stringify(controls)}
`;

  // Preparar mensaje multimodal para Gemma 4.
  const content = [
    {
      type: "text",
      text: prompt
    }
  ];

  for (const image of images) {
    content.push({
      type: "text",
      text: `Contenido visual: ${image.description}`
    });

    content.push({
      type: "image_url",
      image_url: {
        url: image.dataUrl
      }
    });
  }

  const raw = await runModel(
    env,
    [
      {
        role: "system",
        content:
          "Eres Aula AI, un asistente académico preciso. " +
          "Debes leer imágenes y texto conjuntamente. " +
          "Devuelve únicamente JSON válido, sin Markdown ni texto adicional."
      },
      {
        role: "user",
        content
      }
    ],
    2200
  );

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error(
      "El modelo no devolvió JSON válido para la extensión."
    );
  }

  const parsed = JSON.parse(
    raw.slice(start, end + 1)
  );

  await recordUsage(
    session.auth,
    session.user.id
  );

  return json({
    ...parsed,
    model: MODEL,
    media: {
      images: images.length,
      audioTranscribed: !!audioText,
      audioText: audioText || undefined
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return json({ ok: true });
      }

      const allowed = [
        "/api/solve",
        "/api/study",
        "/api/transcribe"
      ];

      if (
        request.method !== "POST" ||
        !allowed.includes(url.pathname)
      ) {
        return json({
          error: "Ruta no encontrada."
        }, 404);
      }

      const session = await authenticate(request);

      if (session.error) {
        return session.error;
      }

      let body;

      try {
        const rawBody = await request.text();

        if (rawBody.length > 9000000) {
          return json({
            error:
              "El material multimedia supera el tamaño permitido. " +
              "Reduce la duración del audio o la cantidad de imágenes."
          }, 413);
        }

        body = JSON.parse(rawBody);

      } catch {
        return json({
          error: "La solicitud no contiene JSON válido."
        }, 400);
      }

      try {
        if (url.pathname === "/api/study") {
          return await handleStudy(body, env, session);
        }

        if (url.pathname === "/api/transcribe") {
          const transcript = await transcribeAudio(
            env,
            body.audioBase64
          );

          await recordUsage(
            session.auth,
            session.user.id
          );

          return json({
            transcript,
            model: AUDIO_MODEL
          });
        }

        return await handleSolve(
          body,
          env,
          session
        );

      } catch (error) {
        console.error(
          "Aula AI multimedia error:",
          error?.stack || error?.message || error
        );

        return json({
          error:
            "No se pudo procesar el material: " +
            (error?.message || "error del modelo")
        }, 502);
      }
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return json({
      error: "Falta el binding ASSETS. Despliega este Worker desde el repositorio con wrangler.jsonc."
    }, 500);
  }
};
