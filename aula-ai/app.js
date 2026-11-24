
(() => {
  const SUPABASE_URL = "https://olkhplrgtcxrrnpmbjgd.supabase.co";
  const SUPABASE_KEY = "sb_publishable_0db7VfdBlXTrubYldbH_TQ_T0vrSbKV";

  const $ = id => document.getElementById(id);
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  let authMode = "login";
  let currentUser = null;

  $("year").textContent = new Date().getFullYear();
  $("today-label").textContent = new Intl.DateTimeFormat("es-PE", {
    dateStyle: "long"
  }).format(new Date());

  function msg(id, text, error = false) {
    const element = $(id);
    element.textContent = text;
    element.classList.toggle("error", error);
  }

  function showApp(user) {
    currentUser = user;
    $("auth-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("logout-btn").classList.remove("hidden");
    $("user-label").textContent = user.email || "Cuenta activa";
    loadTasks();
  }

  function showAuth() {
    $("auth-view").classList.remove("hidden");
    $("app-view").classList.add("hidden");
    $("logout-btn").classList.add("hidden");
    $("user-label").textContent = "";
    currentUser = null;
  }

  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      authMode = button.dataset.tab;

      document.querySelectorAll(".tab").forEach(tab => {
        tab.classList.toggle("active", tab === button);
      });

      $("auth-title").textContent =
        authMode === "login" ? "Bienvenido de nuevo" : "Crea tu cuenta";

      $("auth-description").textContent =
        authMode === "login"
          ? "Ingresa para continuar aprendiendo."
          : "Regístrate con tu correo y una contraseña segura.";

      $("auth-submit").textContent =
        authMode === "login" ? "Ingresar" : "Crear cuenta";

      $("password").autocomplete =
        authMode === "login" ? "current-password" : "new-password";

      msg("auth-message", "");
    });
  });

  $("auth-form").addEventListener("submit", async event => {
    event.preventDefault();

    const button = $("auth-submit");
    button.disabled = true;
    msg("auth-message", "Procesando…");

    try {
      const email = $("email").value.trim();
      const password = $("password").value;

      const result = authMode === "login"
        ? await client.auth.signInWithPassword({ email, password })
        : await client.auth.signUp({ email, password });

      if (result.error) throw result.error;

      if (authMode === "signup" && !result.data.session) {
        msg("auth-message", "Cuenta creada. Revisa tu correo para confirmar el registro.");
      } else if (result.data.user) {
        showApp(result.data.user);
      }
    } catch (error) {
      msg("auth-message", error.message || "No se pudo completar el acceso.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await client.auth.signOut();
    showAuth();
  });

  async function loadTasks() {
    if (!currentUser) return;

    const box = $("tasks-list");
    box.innerHTML = '<div class="empty-state">Cargando actividades…</div>';

    const { data, error } = await client
      .from("study_tasks")
      .select("id,title,prompt,subject,mode,status,answer,created_at")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      box.textContent = "No se pudo cargar el historial: " + error.message;
      return;
    }

    if (!data.length) {
      box.innerHTML = '<div class="empty-state">Todavía no tienes actividades. Crea la primera arriba.</div>';
      return;
    }

    box.replaceChildren(...data.map(task => {
      const article = document.createElement("article");
      article.className = "task-card";

      const body = document.createElement("div");
      const heading = document.createElement("h3");
      const question = document.createElement("p");
      const meta = document.createElement("div");
      const status = document.createElement("span");

      heading.textContent = task.title;
      question.textContent = task.prompt;
      meta.className = "task-meta";
      meta.textContent = [
        task.subject || "General",
        new Date(task.created_at).toLocaleString("es-PE")
      ].join(" · ");

      status.className = "status";

      if (task.status === "completed") {
        status.textContent = "Completada";
      } else if (task.status === "processing") {
        status.textContent = "Procesando";
      } else if (task.status === "error") {
        status.textContent = "Error";
      } else {
        status.textContent = "Guardada";
      }

      body.append(heading, question, meta);

      if (task.answer) {
        const answerTitle = document.createElement("h4");
        const answer = document.createElement("p");

        answerTitle.textContent = "Respuesta de Aula AI";
        answer.textContent = task.answer;
        answer.style.whiteSpace = "pre-wrap";
        answer.style.lineHeight = "1.65";
        answer.style.marginTop = "10px";

        body.append(answerTitle, answer);
      }

      article.append(body, status);
      return article;
    }));
  }

  $("task-form").addEventListener("submit", async event => {
    event.preventDefault();

    if (!currentUser) return;

    const button = $("save-task");
    button.disabled = true;
    msg("task-message", "Aula AI está preparando tu respuesta…");

    let taskId = null;

    try {
      const task = {
        user_id: currentUser.id,
        title: $("task-title").value.trim(),
        prompt: $("prompt").value.trim(),
        subject: $("subject").value,
        mode: $("mode").value,
        status: "processing"
      };

      if (!task.title || !task.prompt) {
        throw new Error("Completa el título y las instrucciones.");
      }

      // Guardar primero la actividad en el historial.
      const { data: savedTask, error: saveError } = await client
        .from("study_tasks")
        .insert(task)
        .select("id")
        .single();

      if (saveError) throw saveError;

      taskId = savedTask.id;

      // Enviar la consulta a la función segura de Supabase.
      const { data, error: aiError } = await client.functions.invoke(
        "study-assistant",
        {
          body: {
            title: task.title,
            prompt: task.prompt,
            subject: task.subject,
            mode: task.mode
          }
        }
      );

      if (aiError) throw aiError;

      if (!data || !data.answer) {
        throw new Error("La IA no devolvió una respuesta. Inténtalo nuevamente.");
      }

      // Guardar la respuesta generada.
      const { error: updateError } = await client
        .from("study_tasks")
        .update({
          answer: data.answer,
          status: "completed"
        })
        .eq("id", taskId)
        .eq("user_id", currentUser.id);

      if (updateError) throw updateError;

      $("task-form").reset();
      msg("task-message", "¡Respuesta generada y guardada correctamente!");
      await loadTasks();

    } catch (error) {
      const errorMessage = error.message || "No se pudo generar la respuesta.";

      if (taskId) {
        await client
          .from("study_tasks")
          .update({ status: "error" })
          .eq("id", taskId)
          .eq("user_id", currentUser.id);
      }

      msg("task-message", "No se pudo completar: " + errorMessage, true);
      await loadTasks();

    } finally {
      button.disabled = false;
    }
  });

  $("refresh-btn").addEventListener("click", loadTasks);

  client.auth.getSession().then(({ data, error }) => {
    if (error) {
      showAuth();
      return;
    }

    if (data.session) {
      showApp(data.session.user);
    } else {
      showAuth();
    }
  });

  client.auth.onAuthStateChange((_event, session) => {
    if (session && !currentUser) {
      showApp(session.user);
    } else if (!session && currentUser) {
      showAuth();
    }
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();
