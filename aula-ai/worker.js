
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

function parseFirstJsonObject(raw) {
  const source = String(raw || "").replace(/^\uFEFF/, "");
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          try { return JSON.parse(candidate); }
          catch {
            try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")); }
            catch { break; }
          }
        }
      }
    }
  }
  throw new Error("La IA generó una respuesta estructurada, pero no se pudo interpretar como JSON. Se descartó el texto adicional para evitar ejecutar respuestas incompletas.");
}

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
 
  // Un ejercicio explícitamente basado en listening no debe resolverse
  // a ciegas. Detener antes de llamar al modelo si no hay transcripción.
  const isListeningChoiceTask =
    /listen[\s\S]{0,120}choose\s+the\s+correct\s+answers?/i.test(pageText);

  if (isListeningChoiceTask && !audioText.trim()) {
    return json({
      actions: [],
      summary: "Se detectó una pregunta de listening, pero no se recibió una transcripción del audio.",
      stop_reason: "No se marcaron casillas para evitar adivinar. Comprueba que el audio se haya reproducido y capturado correctamente.",
      model: MODEL,
      precisionReview: "not-run",
      media: {
        images: images.length,
        audioTranscribed: false
      }
    });
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
- Identifica los campos que se pueden escribir por type "text", "search", "email", "number", "tel", "url", "textarea", "textbox" o "contenteditable". No confundas un campo de texto con un botón o una zona de arrastre.
- El control de destino debe ser exactamente el control_index de la caja de escritura; consulta label, placeholder, nearby_text y type para emparejarlo con la oración correspondiente.
- Si el control tiene nearby_text, úsalo para comprobar que esa caja pertenece a la oración que estás resolviendo. En actividades de imagen + oración, devuelve fill sobre el campo de esa oración, no sobre la imagen ni sobre un contenedor decorativo.
- Si hay un solo campo de escritura visible y una sola oración incompleta, utiliza ese campo para la respuesta. No dejes actions vacío solamente porque el campo no tenga placeholder o label.
- NUEVO TIPO: actividad con hasta TRES respuestas por escrito en una misma pregunta.
  - Detecta todos los campos de respuesta editables visibles (input de texto, textarea, textbox o contenteditable) que pertenezcan a la actividad. Si hay entre dos y tres campos, resuelve cada apartado y devuelve una acción "fill" independiente para cada campo que tenga una respuesta sustentada.
  - Relaciona cada campo con su enunciado, frase, número de apartado o texto cercano; usa nearby_text, label y placeholder. Respeta el orden de lectura de los apartados cuando no haya otra asociación más clara.
  - No escribas las tres respuestas en el primer campo cuando Cambridge muestra casillas separadas. No repitas una respuesta en diferentes campos ni envíes dos acciones fill al mismo control.
  - Si el enunciado pide hasta tres ejemplos o respuestas pero solo hay UN campo de escritura, escribe en ese campo como máximo tres respuestas breves, separadas claramente (por ejemplo, con punto y coma), siempre que el enunciado permita varias.
  - Si hay audio, imagen o vídeo, usa ese material junto con el texto para resolver cada apartado. No inventes información que no se escucha ni aparece.
  - No confundas cuadros de respuesta con campos de búsqueda, inicio de sesión, navegación o controles decorativos. Usa solamente los control_index que correspondan a campos editables de la actividad.
  - Devuelve hasta tres acciones fill, una por cada respuesta inequívoca. Si una parte no se puede resolver, deja esa casilla sin completar y explica qué información falta en stop_reason.
- NUEVO TIPO DE ACTIVIDAD: imagen + oración con espacio para escribir.
  - Analiza conjuntamente la imagen real enviada y el texto de la oración; no resuelvas usando solo una de las dos fuentes.
  - Lee la oración completa antes y después del espacio vacío para identificar qué tipo de palabra falta (sustantivo, verbo, adjetivo, número, etc.).
  - Observa la imagen para reconocer el objeto, persona, animal, acción, lugar o concepto que representa.
  - Usa la imagen como pista semántica y la gramática/contexto de la oración para determinar la palabra exacta que completa la frase.
  - Si la actividad muestra varias imágenes, identifica cuál corresponde a la oración que contiene el campo de texto; no confundas imágenes decorativas con respuestas.
  - Cuando la respuesta sea una palabra o frase que debe escribirse, devuelve action "fill" con el control_index del input o textarea visible correspondiente y value con la respuesta exacta, respetando el idioma de la actividad.
  - No devuelvas click_image para este tipo de ejercicio si la respuesta solicitada debe escribirse en un campo de texto.
  - No escribas explicaciones dentro del campo: solo la respuesta.
  - Si hay varias casillas de texto, relaciona cada una con su oración cercana y devuelve una acción fill para cada respuesta inequívoca.
  - Si la imagen o la oración no se capturó/leyó con suficiente claridad, no adivines; indica qué pista falta en stop_reason.
- NUEVO TIPO: completar conversaciones o diálogos mediante VARIOS menús desplegables.
  - Lee todas las intervenciones de la conversación y conserva el contexto entre las frases (por ejemplo, una pregunta sobre el verano y la respuesta "It'll be busy").
  - Cada control type "select" es un desplegable HTML nativo independiente. Revisa su lista options y elige la opción exacta más adecuada para ESE espacio.
  - Devuelve una acción "select" por CADA desplegable que puedas resolver, no solo para el primero. No dejes sin responder los demás espacios de la misma conversación.
  - Usa gramática y significado conjuntamente: tiempo verbal, concordancia, estructura de la pregunta y respuesta de la otra persona. No elijas una opción solo porque aparece primero.
  - Si un control type "select" no contiene options, no inventes la respuesta: indica en stop_reason que faltan las opciones de ese menú.
  - No confundas el menú de opciones abierto con otro espacio; cada acción debe apuntar al control_index del desplegable correspondiente, nunca al índice de una opción de menú si es un select nativo.
- Para un select nativo, usa select y value debe coincidir exactamente con el texto o value de una opción.
- Para un control cuyo campo dropdown sea true (combobox personalizado de Cambridge), trátalo como un espacio de respuesta independiente:
  - Si el cuadro está cerrado y no hay opciones visibles, devuelve click sobre el control_index de ESE cuadro para abrir su menú.
  - Cuando el menú esté abierto, compara sus opciones visibles con la gramática y el contexto de la oración. Selecciona la opción correcta haciendo click sobre el control_index exacto de la opción visible; si la estructura de options del propio cuadro contiene las opciones, puedes devolver select sobre el control del cuadro con el texto exacto.
  - En una conversación con dos o más cuadros, resuelve TODOS los espacios, uno por uno. No consideres terminada la tarea después del primer desplegable.
  - No confundas el menú de un cuadro con el de otro; nunca selecciones una opción perteneciente a un menú distinto.
  - No devuelvas click sobre el propio cuadro cuando sus opciones ya están abiertas y visibles.
- Para radios, casillas y opciones interactivas usa click.
- NUEVO TIPO: selección múltiple mediante casillas (checkbox).
  - La instrucción "Listen and choose the correct answers" (answers en plural) indica una actividad de selección múltiple: evalúa cada opción y marca TODAS las que coincidan con el audio. No presupongas que solo hay una ni que deben marcarse todas.
  - Lee el enunciado completo y todas las opciones visibles. Si hay audio, utiliza también la transcripción.
  - Si la consigna pide varias respuestas (por ejemplo, "Choose all that apply", "Select all correct answers", "Which statements are true?" o "Marca todas las correctas"), evalúa cada opción por separado y devuelve una acción click por cada casilla correcta.
  - No marques opciones incorrectas ni opciones que solo parezcan relacionadas. Si no puedes confirmar una opción, déjala sin marcar.
  - Usa el control_index exacto de cada control type checkbox o role checkbox; revisa label, nearby_text y checked.
  - Si checked ya es true, no devuelvas click: hacer clic otra vez desmarcaría la casilla.
  - Si la consigna pide una sola respuesta, selecciona únicamente una opción.
  - Asocia cada casilla con su pregunta y devuelve todas las selecciones seguras de las preguntas visibles.
- NUEVO CASO: listening + completar una oración con palabras de ayuda debajo.
  - Si el enunciado dice "Listen and complete the response" y "Use one of the words below", escucha/transcribe el audio, interpreta la oración y compara las palabras de ayuda.
  - En este formato, las palabras debajo son PISTAS TEXTUALES, no botones. No devuelvas action "click" para ellas aunque aparezcan en los controles.
  - Devuelve action "fill" con la palabra correcta en el único control type text/textarea/textbox/contenteditable asociado a la oración incompleta. Usa nearby_text para reconocerlo.
  - Si hay un único campo de texto visible y un espacio vacío, utiliza ese campo y no informes que la tarea está resuelta sin devolver fill.
  - No confundas este formato con el banco interactivo gap-match: solo haz clic en palabras cuando la actividad realmente las presenta como controles interactivos para colocar/seleccionar.
  - Escribe únicamente la palabra o frase que completa la oración, no la transcripción completa del audio.
- En ejercicios de completar oraciones con un banco de palabras, identifica las palabras disponibles y cada espacio vacío.
- Cuando detectes controles Cambridge con clases gap_match_drag y gap_match_gap_view, NO uses action "drag". El usuario confirma que en esta actividad basta hacer un clic en la palabra del banco para que Cambridge la coloque en el espacio activo.
- Devuelve action "click" con el control_index exacto de la palabra correcta del banco. No envíes target_control_index ni intentes arrastrar.
- Usa la oración asociada al espacio para decidir qué palabra elegir. Para "It's ___ today. Let's go to the swimming pool.", selecciona "boiling".
- Devuelve una acción de clic por cada palabra que se pueda colocar con certeza; no pulses espacios ni botones de navegación.
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

  const parsed = parseFirstJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("La IA no devolvió un objeto de respuestas válido.");
  }
  let precisionReview = "normal";
  if (body.precision === "high") {
    try {
      const reviewRaw = await runModel(env, [
        { role:"system", content:"Eres un segundo revisor independiente. Resuelve de nuevo la actividad desde cero usando el material fuente. No aceptes automáticamente la propuesta inicial. Comprueba contexto, gramática, audio, imágenes y opciones. Si el enunciado dice 'Listen and choose the correct answers' (plural), evalúa cada casilla y devuelve un clic por cada respuesta correcta según el audio; no asumas que solo hay una. En una tarea con dos o tres campos de escritura, devuelve una acción fill independiente por cada campo que puedas resolver con certeza, asociándola a nearby_text y sin repetir control_index. No pulses casillas que ya estén marcadas. Devuelve únicamente JSON válido con actions, summary y stop_reason. Usa exclusivamente los control_index proporcionados." },
        { role:"user", content:[...content,{type:"text",text:"\\nPropuesta inicial (puede contener errores):\\n"+JSON.stringify(parsed)+"\\nResuelve independientemente y devuelve las acciones finales corregidas."}] }
      ],2200);
      const reviewed=parseFirstJsonObject(reviewRaw);
      if(reviewed && Array.isArray(reviewed.actions) && reviewed.actions.length) {
        parsed.actions=reviewed.actions;
        parsed.summary=reviewed.summary || "Respuesta revisada por un segundo análisis independiente.";
        parsed.stop_reason=reviewed.stop_reason || "";
        precisionReview="double-checked";
      } else precisionReview="review-unavailable";
    } catch(error) {
      console.warn("Aula AI second review failed:",error?.message||error);
      precisionReview="review-unavailable";
    }
  }

  // Normalizar actividades que presentan hasta tres respuestas escritas.
  // Cada casilla recibe como máximo una acción fill, sin permitir índices
  // de otros controles ni duplicar escrituras en el mismo campo.
  const writableResponseControls = controls.filter(control =>
    !control.disabled &&
    (
      control.editable === true ||
      /^(text|search|email|number|tel|url|textarea|textbox|contenteditable)$/i.test(String(control.type || ""))
    )
  );
  const multiWrittenInstruction =
    /(write|type|complete|answer|fill in|give|describe|write down|escribe|completa|responde|contesta)/i.test(pageText);
  const isMultiWrittenResponse =
    writableResponseControls.length >= 2 &&
    writableResponseControls.length <= 3 &&
    multiWrittenInstruction;

  if (isMultiWrittenResponse) {
    const allowedIndices = new Set(
      writableResponseControls.map(control => Number(control.control_index))
    );
    const usedIndices = new Set();
    const normalizedActions = [];

    for (const action of Array.isArray(parsed.actions) ? parsed.actions : []) {
      if (action.action !== "fill") {
        normalizedActions.push(action);
        continue;
      }

      const index = Number(action.control_index);
      if (!allowedIndices.has(index)) continue;
      if (usedIndices.has(index)) continue;
      if (!String(action.value || "").trim()) continue;
      if (usedIndices.size >= 3) continue;

      usedIndices.add(index);
      normalizedActions.push(action);
    }

    parsed.actions = normalizedActions;
    if (usedIndices.size < writableResponseControls.length) {
      parsed.summary = (parsed.summary || "Actividad de respuestas escritas.") +
        " Campos escritos con respuesta confirmada: " + usedIndices.size +
        " de " + writableResponseControls.length + ".";
    }
  }

  // Listening + oración incompleta con palabras de ayuda:
  // identificar campos editables reales aunque Cambridge los etiquete
  // como DIV/SPAN y pedir una respuesta escrita, nunca un clic en las pistas.
  const isListeningTextGap =
    /listen\s+and\s+complete/i.test(pageText) &&
    /use\s+one\s+of\s+the\s+words\s+below/i.test(pageText);

  if (isListeningTextGap) {
    const textControls = controls.filter(control =>
      control.editable === true ||
      /^(text|search|email|number|tel|url|textarea|textbox|contenteditable)$/i.test(String(control.type || ""))
    );

    const target = textControls.length === 1
      ? textControls[0]
      : textControls.find(control =>
          /listen|complete|response|____|east|trip/i.test(String(control.nearby_text || ""))
        );

    if (target) {
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const hasFill = actions.some(action =>
        action.action === "fill" &&
        Number(action.control_index) === Number(target.control_index) &&
        String(action.value || "").trim()
      );

      if (!hasFill) {
        const hintClick = actions.find(action =>
          action.action === "click" &&
          controls.some(control => Number(control.control_index) === Number(action.control_index))
        );
        const hintControl = hintClick
          ? controls.find(control => Number(control.control_index) === Number(hintClick.control_index))
          : null;
        let candidate = String(
          hintClick?.value ||
          hintControl?.label ||
          ""
        ).trim();

        // Si el primer análisis no produjo la palabra, solicitar una
        // resolución breve usando la transcripción real y las pistas.
        if (!candidate && audioText) {
          const hints = controls
            .filter(control =>
              control.control_index !== target.control_index &&
              !control.editable &&
              String(control.label || "").trim().length > 0 &&
              String(control.label || "").trim().length <= 50
            )
            .map(control => String(control.label).trim())
            .filter((value, index, list) => list.indexOf(value) === index)
            .slice(0, 20);

          const answerRaw = await runModel(
            env,
            [
              {
                role: "system",
                content: "Eres un asistente de listening de inglés. Resuelve el espacio usando el audio transcrito y la oración. Devuelve únicamente la palabra o frase que debe escribirse, sin explicación, comillas ni Markdown."
              },
              {
                role: "user",
                content:
                  "Instrucción: " + pageText.slice(0, 5000) +
                  "\\nTranscripción del audio: " + audioText +
                  "\\nPalabras de ayuda visibles: " + hints.join(", ") +
                  "\\nContexto del campo: " + String(target.nearby_text || target.label || "") +
                  "\\nEscribe solamente la respuesta exacta."
              }
            ],
            120
          );
          candidate = String(answerRaw || "")
            .trim()
            .replace(/^["'\s]+|["'\\s.,;:!?]+$/g, "");
          if (candidate.startsWith("{")) {
            try {
              const answerObject = parseFirstJsonObject(candidate);
              candidate = String(answerObject.answer || answerObject.value || "").trim();
            } catch {}
          }
        }

        if (candidate && candidate.length <= 100) {
          parsed.actions = actions.filter(action =>
            !(action.action === "click" &&
              controls.some(control =>
                Number(control.control_index) === Number(action.control_index) &&
                control.control_index !== target.control_index
              ))
          );
          parsed.actions.push({
            control_index: target.control_index,
            action: "fill",
            value: candidate,
            question: "Completar la oración escuchando el audio",
            explanation: "Las palabras inferiores son pistas; la respuesta se escribe en el campo editable.",
            confidence: 0.9
          });
          parsed.summary = "Respuesta identificada a partir del audio y preparada para escribir en el campo.";
        } else if (!hasFill) {
          parsed.actions = actions.filter(action => action.action !== "click");
          parsed.stop_reason = audioText
            ? "Se detectó el campo editable, pero no se pudo determinar con suficiente seguridad la palabra que debe escribirse."
            : "Se detectó el ejercicio de audio y el campo editable, pero no llegó una transcripción del audio. Revisa la captura de audio antes de responder.";
          parsed.summary = "No se escribió una respuesta porque faltó confirmar la palabra correcta.";
        }
      }
    } else {
      parsed.actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
        .filter(action => action.action !== "click");
      parsed.stop_reason = "Se detectó el ejercicio de listening, pero no se pudo identificar un campo editable único asociado a la oración.";
      parsed.summary = "No se pulsaron las palabras de ayuda; falta identificar el campo de escritura.";
    }
  }

  await recordUsage(
    session.auth,
    session.user.id
  );

  return json({
    ...parsed,
    model: MODEL,
    precisionReview,
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
