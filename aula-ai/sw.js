
const CACHE_NAME = "aula-ai-static-v2";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg"
];

// Instalar la nueva versión y preparar los archivos.
self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);

      // Activar la nueva versión sin esperar a cerrar todas las pestañas.
      await self.skipWaiting();
    })()
  );
});

// Eliminar las cachés antiguas.
self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter(name =>
            name.startsWith("aula-ai-static-") &&
            name !== CACHE_NAME
          )
          .map(name => caches.delete(name))
      );

      await self.clients.claim();
    })()
  );
});

// Buscar primero la versión actual en el servidor.
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // No interceptar solicitudes que no sean GET ni servicios externos.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      try {
        // Obtener la versión más reciente.
        const response = await fetch(request, {
          cache: "no-store"
        });

        // Guardar una copia para utilizarla sin conexión.
        if (response && response.ok) {
          await cache.put(request, response.clone());
        }

        return response;

      } catch (error) {
        // Si no hay Internet, utilizar la copia guardada.
        const cachedResponse = await cache.match(request);

        if (cachedResponse) {
          return cachedResponse;
        }

        // Si se abre la página sin conexión, mostrar el inicio guardado.
        if (request.mode === "navigate") {
          const offlinePage = await cache.match("./index.html");

          if (offlinePage) {
            return offlinePage;
          }
        }

        return new Response(
          "No hay conexión. Comprueba tu Internet e inténtalo nuevamente.",
          {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      }
    })()
  );
});
